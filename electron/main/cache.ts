/**
 * 本机占用与清理（设置→通用→本地缓存）。
 *
 * 扫描范围只包含**应用自己产生、删了不丢人**的东西：
 * - net      Chromium 网络缓存（session 磁盘缓存，解析与线上回落的 HTTP 副本）
 * - partials 下载目录里没人认领的 `.part` / `.part.meta` 断点
 * - junk     userData 里的 `*.corrupt-<ts>`（坏档备份）与残留 `*.tmp`（原子写半成品）
 * - logs     日志目录（见 logger.ts）
 * - update   更新包缓存 —— **只报占用，永不清理**
 * - records  本机记录 config/queue/history —— **只报占用，永不清理**（那是用户数据不是缓存）
 *
 * 两条硬规矩：
 * 1. 绝不对目录做递归删除。更新包缓存目录的路径来自 electron-updater 的拼接公式
 *    （`baseCachePath/<name>`），本机是什么形态无法在此断言，因此它既不进清理名单、
 *    扫描也只在「确认存在」时进行；其余项全部是「具名文件逐个删」。
 * 2. 正在用的断点不能删。活任务（queued/downloading/paused/error，与 downloader
 *    的 isTargetClaimed 同一把尺）占用的 `.part` 及其 `.meta` 从候选里排除，
 *    否则清一次缓存就把进行中的下载打断、把续传身份抹掉。
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import type { CacheClearResult, CacheItem, CacheItemKey, CacheStatus } from "../../types/ipc";
import type { AppLogger } from "./logger";

/** session 的最小面（真源是 Electron，测试用假对象顶替，不依赖 Electron runtime） */
export interface CacheSessionLike {
  getCacheSize(): Promise<number>;
  clearCache(): Promise<void>;
}

export interface CacheProbeDeps {
  /** 取不到会话（理论上不会）时网络缓存按 0 报、不进清理名单 */
  session: () => CacheSessionLike | null;
  userDataDir: () => string;
  downloadDir: () => string;
  /** electron-updater 的落点：`join(app.baseCachePath, updaterCacheDirName || app.name)`；拿不到则 null */
  updaterCacheDir: () => string | null;
  /** 活任务占用的 `.part` 绝对路径（清理避让） */
  livePartPaths: () => string[];
  logs: AppLogger;
}

interface FileEntry {
  path: string;
  bytes: number;
}

/** 大小写不敏感路径比较（Windows 主战场；macOS/Linux 走同一函数不误判） */
const keyOf = (p: string): string => resolve(p).toLowerCase();

const sum = (entries: FileEntry[]): number => entries.reduce((n, e) => n + e.bytes, 0);

/** 单层扫描：downloadDir 与 userData 都是用户可能很大的目录，只按名字挑，不递归 */
function scanTop(dir: string, accept: (name: string) => boolean): FileEntry[] {
  const out: FileEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // 目录不存在/无权限 = 该项无占用
  }
  for (const name of names) {
    if (!accept(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) out.push({ path, bytes: st.size });
    } catch {
      /* 扫描瞬间被移走：跳过 */
    }
  }
  return out;
}

/** 更新包缓存目录：只在目录确实存在时统计（路径公式对不上就什么也不报，而不是猜） */
function scanTree(dir: string, depth = 3): FileEntry[] {
  const out: FileEntry[] = [];
  const step = (current: string, level: number): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(current, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue; // 扫描瞬间被移走
      }
      if (st.isDirectory()) {
        if (level < depth) step(path, level + 1);
        continue;
      }
      out.push({ path, bytes: st.size });
    }
  };
  step(dir, 0);
  return out;
}

/** 断点文件（含身份 meta），再剔除活任务占用的那一份 */
function orphanPartials(dir: string, liveParts: string[]): FileEntry[] {
  const live = new Set(liveParts.map((p) => keyOf(p)));
  const liveMeta = new Set(liveParts.map((p) => keyOf(`${p}.meta`)));
  return scanTop(dir, (n) => n.endsWith(".part") || n.endsWith(".part.meta")).filter(
    (e) => !live.has(keyOf(e.path)) && !liveMeta.has(keyOf(e.path))
  );
}

/** store.ts 的原子写残留：`${file}.${pid}.tmp`；坏档：`${file}.corrupt-${ts}` */
const isJunk = (name: string): boolean =>
  /\.corrupt-\d+$/.test(name) || (/\.tmp$/.test(name) && !name.includes(`.${process.pid}.tmp`));

export interface CacheProbe {
  /** 扫描当下的占用快照（点开设置→通用才调，不在启动路径上） */
  status(): Promise<CacheStatus>;
  /** 按点名清理；不可清项（update/records）与删不净项一律进 skipped */
  clear(keys: CacheItemKey[]): Promise<CacheClearResult>;
}

export function createCacheProbe(deps: CacheProbeDeps): CacheProbe {
  const netBytes = async (): Promise<number> => {
    const s = deps.session();
    if (!s) return 0;
    try {
      return await s.getCacheSize();
    } catch {
      return 0;
    }
  };

  async function status(): Promise<CacheStatus> {
    const partialEntries = orphanPartials(deps.downloadDir(), deps.livePartPaths());
    const junkEntries = scanTop(deps.userDataDir(), isJunk);
    const recordEntries = scanTop(deps.userDataDir(), (n) =>
      ["config.json", "history.json", "queue.json"].includes(n)
    );
    const updateDir = deps.updaterCacheDir();
    const net = await netBytes();
    const items: CacheItem[] = [
      { key: "net", bytes: net, clearable: deps.session() !== null },
      { key: "update", bytes: updateDir ? sum(scanTree(updateDir)) : 0, clearable: false },
      { key: "partials", bytes: sum(partialEntries), clearable: true },
      { key: "junk", bytes: sum(junkEntries), clearable: true },
      { key: "logs", bytes: deps.logs.sizeBytes(), clearable: true },
      { key: "records", bytes: sum(recordEntries), clearable: false },
    ];
    const totalBytes = items.reduce((n, i) => n + i.bytes, 0);
    const clearableBytes = items.reduce((n, i) => n + (i.clearable ? i.bytes : 0), 0);
    return { items, totalBytes, clearableBytes };
  }

  /** 逐个具名文件删除；失败不抛（清不干净要如实报，而不是让设置页以为全清了） */
  function removeEntries(entries: FileEntry[]): boolean {
    let ok = true;
    for (const e of entries) {
      try {
        unlinkSync(e.path);
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  async function clear(keys: CacheItemKey[]): Promise<CacheClearResult> {
    const before = await status();
    const bytesOf = (key: CacheItemKey): number =>
      before.items.find((i) => i.key === key)?.bytes ?? 0;
    const skipped: CacheItemKey[] = [];

    for (const key of keys) {
      if (key === "net") {
        const s = deps.session();
        if (!s || bytesOf("net") <= 0) {
          if (!s) skipped.push(key);
          continue;
        }
        try {
          await s.clearCache();
        } catch {
          skipped.push(key);
        }
        continue;
      }
      // 其余可清项一律按「重新扫一遍当下的具名文件」处理：
      // 从 status 到 clear 之间文件可能增减，以删除那一刻的真实清单为准，
      // 也顺带让「update/records 不在 clearable 里」这条红线无法被入参绕过。
      let ok = true;
      if (key === "partials") {
        ok = removeEntries(orphanPartials(deps.downloadDir(), deps.livePartPaths()));
      } else if (key === "junk") {
        ok = removeEntries(scanTop(deps.userDataDir(), isJunk));
      } else if (key === "logs") {
        deps.logs.clear();
      } else {
        skipped.push(key); // update / records：不可清理项
        continue;
      }
      if (!ok) skipped.push(key);
    }

    const report = await status();
    return {
      freed: Math.max(0, before.totalBytes - report.totalBytes),
      skipped,
      report,
    };
  }

  return { status, clear };
}

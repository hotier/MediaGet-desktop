/**
 * yt-dlp / ffmpeg 资源定位 + SHA-256 完整性校验
 * （docs/ARCHITECTURE.md §2 resources.ts, §7）
 *
 * - dev：默认仓库 resources/bin（MG_BIN_DIR 可覆盖）
 * - prod 首启：从打包 extraResources（`process.resourcesPath/bin`）校验 SHA-256
 *   后释放到 `userData/bin/`
 * - 支持用户自备路径覆盖（设置 kernel.YTDLP_BIN / FFMPEG_BIN 指向本地文件）
 *
 * 完整性链路（P0-2 打通，端到端闭合）：
 *   `scripts/fetch-binaries.cjs` 下载 → 比对 pin 的 size/sha256 → 写
 *   `<binDir>/manifest.json` → 随 extraResources 打包 → 本模块 `readManifest()`
 *   读出后作为 `expectedHashes` 注入 `createResources` → `locate()` 在释放前后
 *   强校验，不匹配即拒绝使用（返回 null，该平台回落线上通道）。
 *   CI 用 `fetch-binaries.cjs --verify-only` 在打包前断言清单在位且自洽，
 *   使「清单缺失」在构建期暴露，而不是拖到用户机器上降级。
 *
 * 校验强度分档（诚实标注，不假装有防护）：
 * - 有 manifest → 强校验，哈希不符一律不用；
 * - 无 manifest（dev 用户自备、旧包）→ 只定位不校验，并在日志明示降级。
 *   降级不是隐形的：`describe()` 把每个二进制的实际强度报给设置页。
 *
 * 性能约定：sha256 是同步 CPU 操作，ffmpeg 82.8 MB 本机实测 110.8 ms（读 48.6 +
 * 算 62.2），yt-dlp 17.8 MB 24.3 ms。这段计算发生在**建窗之前**（index.ts 顶层
 * publishKernelEnv）与首帧的 `app:getMeta` 里，每次启动都付一遍就是白扣的启动延迟。
 * 两层记忆化把它压成「每台机器一次」：
 * - 进程内：`verifyCache` 按 `路径 + size + mtimeMs` 记结论；
 * - 跨进程：`<userData>/bin/verify.json` 落同一把尺（路径 + size + mtimeMs +
 *   当时的期望哈希），命中即免哈希。期望哈希变了（升 manifest）或文件被换
 *   （size/mtime 变）自动失效重算。
 * 这份磁盘记忆的强度与进程内记忆**完全一致**：它证明的是「这个路径的这个
 * size+mtime 曾对这条基线校验通过」，挡得住截断下载与意外损坏，挡不住能同时
 * 改写二进制和这个 json 的本机攻击者 —— 那是威胁模型之外（本机已沦陷时
 * Cookie 也在盘上）。校验失败仍按拒绝使用处理，不让「记过」冒充「验过」。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type BinName = "yt-dlp" | "ffmpeg";

export interface ResourcesDeps {
  /** userData 根目录 */
  userDataDir: string;
  /** extraResources 落点（prod：process.resourcesPath/bin；dev：默认仓库 resources/bin，MG_BIN_DIR 可覆盖） */
  packagedDir: string | null;
  /** 用户自备路径（kernel 配置 YTDLP_BIN / FFMPEG_BIN） */
  readKernelConfig: (key: string) => string | undefined;
  /**
   * 期望 SHA-256 清单（发布时由 CI 生成随包 manifest.json；缺省只告警不阻断）。
   * Partial：清单可以只含其中一个二进制（例如只随包 yt-dlp），缺的那个退回降级。
   */
  expectedHashes?: Partial<Record<BinName, string>>;
  /**
   * 哈希实现（默认 sha256File）。仅作为测试接缝：让「同一文件只算一次」这条
   * 性能约定可以被确定性地断言，而不是靠计时猜测。
   */
  hashFile?: (path: string) => string;
  /**
   * 降级留痕的去向（默认 console.warn；主进程注入文件日志）。
   * 存在的理由：「无基线」「哈希不符」都是只在启动那一刻发生一次的事，
   * 没有终端的打包版若不落盘就等于没发生 —— 降级必须可回看。
   */
  warn?: (message: string) => void;
}

export interface ResolvedBin {
  name: BinName;
  path: string;
  /** 来源：user=用户自备 / extracted=首启释放 / packaged=直接使用（dev） */
  origin: "user" | "extracted" | "packaged";
}

/**
 * 跨进程校验记忆的一条记录：`<userData>/bin/verify.json`
 * `{ "ffmpeg": { path, size, mtimeMs, expected } }`。
 * 四个字段全对上才免哈希，任一不符即重算（升基线 / 换文件都会失效）。
 */
interface VerifyRecord {
  path: string;
  size: number;
  mtimeMs: number;
  expected: string;
}
type VerifyMemo = Partial<Record<BinName, VerifyRecord>>;

/** 单个二进制的可汇报状态（设置页 / 日志用，如实反映校验强度） */
export interface BinStatus {
  name: BinName;
  available: boolean;
  origin?: ResolvedBin["origin"];
  path?: string;
  /**
   * 完整性结论：
   * - verified   有基线且哈希匹配
   * - degraded   无基线（未随包清单 / 用户自备），只定位不校验
   * - rejected   有基线但哈希不符或读取失败，已拒绝使用
   * - missing    三处都没有
   */
  integrity: "verified" | "degraded" | "rejected" | "missing";
  /** 期望哈希（有基线时） */
  expected?: string;
}

const FILENAMES: Record<BinName, string> = {
  "yt-dlp": process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  ffmpeg: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
};

const KERNEL_KEYS: Record<BinName, string> = {
  "yt-dlp": "YTDLP_BIN",
  ffmpeg: "FFMPEG_BIN",
};

export const BIN_NAMES: readonly BinName[] = ["yt-dlp", "ffmpeg"] as const;

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createResources(deps: ResourcesDeps) {
  const binDir = join(deps.userDataDir, "bin");
  const hashFile = deps.hashFile ?? sha256File;
  const warn = deps.warn ?? ((message: string): void => console.warn(message));

  /**
   * 校验结果记忆化：key = `${name}\u0000${path}\u0000${size}\u0000${mtimeMs}`。
   * 只缓存「是否通过」这一个布尔，不缓存文件内容（内存友好）。
   */
  const verifyCache = new Map<string, boolean>();

  /**
   * 跨进程的校验记忆（<userData>/bin/verify.json，每档二进制只留最近一条）。
   * 读失败/坏 JSON 一律按「没有记忆」处理：这层是启动加速，不是校验本身。
   */
  const memoFile = join(binDir, "verify.json");
  let memo: VerifyMemo | null = null;

  function readMemo(): VerifyMemo {
    if (memo) return memo;
    try {
      memo = JSON.parse(readFileSync(memoFile, "utf8")) as VerifyMemo;
    } catch {
      memo = {};
    }
    return memo;
  }

  /** 记忆命中 = 路径与期望基线都对得上，且文件的 size+mtime 与记录时一致 */
  function memoHit(name: BinName, path: string, expected: string): boolean {
    const rec = readMemo()[name];
    if (!rec || rec.expected !== expected || rec.path !== path) return false;
    try {
      const st = statSync(path);
      return st.isFile() && st.size === rec.size && st.mtimeMs === rec.mtimeMs;
    } catch {
      return false;
    }
  }

  /** 记账（只在通过时写：失败结论不值得留给下次启动） */
  function memoPut(name: BinName, path: string, expected: string): void {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    readMemo()[name] = { path, size: st.size, mtimeMs: st.mtimeMs, expected };
    try {
      mkdirSync(dirname(memoFile), { recursive: true });
      writeFileSync(memoFile, JSON.stringify(memo, null, 2), "utf8");
    } catch {
      /* 写不进去只影响下次启动的耗时，不影响本次校验结论 */
    }
  }

  function cacheKey(name: BinName, path: string): string | null {
    try {
      const st = statSync(path);
      // 目录不是二进制（existsSync 对目录同样返回 true，必须显式挡掉）
      if (!st.isFile()) return null;
      return `${name}\u0000${path}\u0000${st.size}\u0000${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** 解析二进制路径：用户自备 > userData/bin（已释放）> packaged（首启校验后释放） */
  function locate(name: BinName): ResolvedBin | null {
    const userPath = deps.readKernelConfig(KERNEL_KEYS[name]);
    if (userPath && isUsableFile(userPath)) {
      // 用户自备：按设计不校验哈希（我们不知道他放的哪个构建），但仍拒绝目录/不可读路径
      return { name, path: userPath, origin: "user" };
    }

    const local = join(binDir, FILENAMES[name]);
    if (isUsableFile(local)) {
      return verify(local, name) ? { name, path: local, origin: "extracted" } : null;
    }

    if (deps.packagedDir) {
      const src = join(deps.packagedDir, FILENAMES[name]);
      if (isUsableFile(src)) {
        if (!verify(src, name)) return null;
        mkdirSync(binDir, { recursive: true });
        try {
          copyFileSync(src, local);
          // 源已按基线验过、字节是我们自己复制的，副本无需再哈希一遍；
          // 直接把「已校验」记到副本身份上，下次启动 locate 命中即走。
          const expected = deps.expectedHashes?.[name];
          if (expected) memoPut(name, local, expected);
          return { name, path: local, origin: "extracted" };
        } catch {
          // 释放失败直接用 packaged（asar.unpacked 场景可读）
          return { name, path: src, origin: "packaged" };
        }
      }
    }
    return null;
  }

  /** 存在且是普通文件（挡掉目录、断链） */
  function isUsableFile(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  }

  function verify(path: string, name: BinName): boolean {
    const expected = deps.expectedHashes?.[name];
    if (!expected) {
      // 无清单 = 无完整性基线（dev 自备二进制 / 旧包）。降级但留痕，
      // 不要静默假装校验过。
      warn(`[resources] ${name} 无 SHA-256 基线，跳过完整性校验（降级）`);
      return true;
    }
    const key = cacheKey(name, path);
    if (key) {
      const hit = verifyCache.get(key);
      if (hit !== undefined) return hit;
    }
    // 进程内没记到，再看上一次启动记没记到（命中即省掉上百毫秒的同步哈希）
    if (memoHit(name, path, expected)) {
      if (key) verifyCache.set(key, true);
      return true;
    }
    let ok: boolean;
    try {
      const actual = hashFile(path);
      ok = actual === expected;
      if (!ok) {
        warn(`[resources] ${name} SHA-256 不匹配，拒绝使用: ${actual} ≠ ${expected}`);
      }
    } catch (e) {
      warn(
        `[resources] ${name} 哈希计算失败，拒绝使用: ${e instanceof Error ? e.message : String(e)}`
      );
      ok = false;
    }
    if (key) verifyCache.set(key, ok);
    if (ok) memoPut(name, path, expected);
    return ok;
  }

  /**
   * 逐个二进制的实际状态（设置页 / 诊断日志用）。
   * 这是「降级可见」的落点：调用方据此把 integrity 如实展示给用户，
   * 而不是让「无基线」悄悄发生。
   */
  function describe(): BinStatus[] {
    return BIN_NAMES.map((name) => {
      const expected = deps.expectedHashes?.[name];
      const hit = locate(name);
      if (!hit) {
        // locate 返回 null 有两种可能：压根没有，或有基线但被拒
        const rejected = !!expected && hasAnyCandidate(name);
        return {
          name,
          available: false,
          integrity: rejected ? "rejected" : "missing",
          ...(expected ? { expected } : {}),
        };
      }
      return {
        name,
        available: true,
        origin: hit.origin,
        path: hit.path,
        integrity: expected ? "verified" : "degraded",
        ...(expected ? { expected } : {}),
      };
    });
  }

  /** 三处候选位置里是否至少存在一个普通文件（区分 missing 与 rejected） */
  function hasAnyCandidate(name: BinName): boolean {
    const userPath = deps.readKernelConfig(KERNEL_KEYS[name]);
    if (userPath && isUsableFile(userPath)) return true;
    if (isUsableFile(join(binDir, FILENAMES[name]))) return true;
    if (deps.packagedDir && isUsableFile(join(deps.packagedDir, FILENAMES[name]))) return true;
    return false;
  }

  return {
    locate,
    describe,
    binDir,
    /** 本次是否带完整性基线（设置页/日志据此如实汇报校验强度） */
    verified: Object.keys(deps.expectedHashes ?? {}).length > 0,
  };
}

/**
 * 读二进制 SHA-256 清单（由 `scripts/fetch-binaries.cjs` 在下载校验通过后写入
 * `<dir>/manifest.json`，随 extraResources 一起打包）。
 *
 * 返回 null 表示「无清单」——dev 下用户自备二进制、或旧包未带清单。调用方据此
 * 决定是否启用严格校验：有清单就强校验，没有就退回「只定位不校验」。
 *
 * 清单内容形如 `{ "yt-dlp": "<sha256>", "ffmpeg": "<sha256>" }`，只信任其中
 * 64 位十六进制字符串的条目，其余（手改、截断、注入）一律丢弃。
 */
export function readManifest(
  dir: string | null,
  warn: (message: string) => void = (message) => console.warn(message)
): Partial<Record<BinName, string>> | null {
  if (!dir) return null;
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Partial<Record<BinName, string>> = {};
    for (const name of BIN_NAMES) {
      const v = raw?.[name];
      if (typeof v === "string" && /^[0-9a-f]{64}$/i.test(v)) out[name] = v.toLowerCase();
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    warn(
      `[resources] manifest.json 解析失败（按无清单处理）: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/**
 * 生命周期计数器（userData/stats.json）。
 *
 * 存在的理由：history.json 是「下过的文件」清单，逐条明细且被窗口截断，
 * 拿它算失败率与生命周期累计会得到两种错 —— 失败根本不在里面（done 路径才追加），
 * 而窗口外的成功记录已被丢弃。计数器只加不删、不受行数窗口约束，才是统计页的真源。
 *
 * 隐私红线（AGENTS.md「隐私红线」）：这里**只落计数、字节、时长**。
 * 不写 url、不写文件名、不写作者名、不写 Cookie —— 逐条明细要去看 history，
 * 统计面看不出任何人下过什么。
 *
 * 落盘交给 JsonStore 的节流口（与 queue 同一套 pending + 定时器 + flush 语义）：
 * 批量下载收尾时一秒内几十次累加，不该钉几十次整档重写。
 */
import type { HistoryEntry, StatsDateRange, StatsQueryResult, StatsSnapshot } from "../../types/ipc";
import { resolveKey } from "../../shared/platforms";
import type { StatsEventInput } from "./repositories";

/** byDay 保留的自然日数：再多就丢最旧的（趋势图最长要看的就是这一年） */
export const STATS_DAY_RETENTION = 366;

/** 星期×小时的热力格数（7×24，索引 = getDay()*24 + getHours()） */
export const STATS_HOUR_SLOTS = 168;

const NON_NEGATIVE_INT = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本机时区的自然日键：跨时区不迁移，如实按记录当下的本机日历 */
function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function hourSlot(at: number): number {
  const d = new Date(at);
  return d.getDay() * 24 + d.getHours();
}

/**
 * 读侧迁移：`byPlatform` 里的老键（上游 web 的路由目录名 `xhs`）并到契约键上、计数相加。
 * 写入口归一只管得住今后，盘上存量必须在这里归一 —— 否则平台榜会把同一个平台摆成两行。
 * （`ppxia` 这类已下线平台的键随内核 1.0.0 变成「未登记键」，按注册表纪律原样留着。）
 */
function migratePlatformKeys(rows: StatsSnapshot["byPlatform"]): StatsSnapshot["byPlatform"] {
  const zero = { downloads: 0, failures: 0, bytes: 0, parses: 0, parseFailures: 0 };
  const out: StatsSnapshot["byPlatform"] = {};
  for (const [raw, row] of Object.entries(rows)) {
    const key = resolveKey(raw);
    const acc = out[key] ?? zero;
    out[key] = {
      downloads: acc.downloads + (row.downloads ?? 0),
      failures: acc.failures + (row.failures ?? 0),
      bytes: acc.bytes + (row.bytes ?? 0),
      parses: acc.parses + (row.parses ?? 0),
      parseFailures: acc.parseFailures + (row.parseFailures ?? 0),
    };
  }
  return out;
}

export function emptyStats(now: number): StatsSnapshot {
  return {
    schema: 1,
    since: now,
    updatedAt: now,
    totals: {
      downloads: 0,
      failures: 0,
      canceled: 0,
      bytes: 0,
      elapsedMs: 0,
      elapsedCount: 0,
      elapsedBytes: 0,
    },
    parse: { total: 0, failures: 0, local: 0, online: 0, mock: 0, durationMs: 0 },
    byDay: {},
    byPlatform: {},
    byKind: {},
    byHour: new Array<number>(STATS_HOUR_SLOTS).fill(0),
  };
}

export interface StatsDoneInput {
  at: number;
  platform?: string;
  kind?: string;
  bytes: number;
  /** 单任务**实际传输时长**（v18：`transferMs`，暂停/排队不计）；缺样本时只计字节不计耗时 */
  elapsedMs?: number;
  workKey?: string;
  historyEntry?: HistoryEntry;
}

export interface StatsFailureInput {
  at: number;
  platform?: string;
  kind?: string;
  workKey?: string;
}

export interface StatsParseInput {
  at: number;
  platform?: string;
  via: "local" | "mock";
  ok: boolean;
  durationMs: number;
  workKey?: string;
  historyEntry?: HistoryEntry;
}

export interface StatsRecorder {
  done(input: StatsDoneInput): void;
  failure(input: StatsFailureInput): void;
  cancel(input?: { at: number; platform?: string; kind?: string; workKey?: string }): void;
  parse(input: StatsParseInput): void;
  query(range: StatsDateRange): StatsQueryResult;
  /** 当前内存态（`stats:get` 的唯一出口，避免 UI 与盘各读一份对不上） */
  snapshot(): StatsSnapshot;
}

export interface StatsOptions {
  /** 盘上的旧档；null / 形状不认识 → 从零起算 */
  load(): StatsSnapshot | null;
  /** 累加后交给落盘（实现方自己节流） */
  save(snapshot: StatsSnapshot): void;
  now?: () => number;
  /** 档被丢弃重来时的留痕口（形状不认识 / 读盘失败） */
  onReset?: (reason: string) => void;
  recordEvent?: (event: StatsEventInput, historyEntry?: HistoryEntry) => void;
  query?: (range: StatsDateRange) => StatsQueryResult;
  onEventError?: () => void;
}

export function createStats(opts: StatsOptions): StatsRecorder {
  const now = opts.now ?? (() => Date.now());
  let cur: StatsSnapshot | null = null;

  const bumpDay = (at: number, patch: (d: StatsSnapshot["byDay"][string]) => void): void => {
    const key = dayKey(at);
    const day = cur!.byDay[key] ?? { downloads: 0, failures: 0, bytes: 0, parses: 0 };
    patch(day);
    cur!.byDay[key] = day;
    // 超出保留窗就丢最旧的：键是零填充 YYYY-MM-DD，字典序即时间序
    const keys = Object.keys(cur!.byDay);
    if (keys.length <= STATS_DAY_RETENTION) return;
    for (const old of keys.sort().slice(0, keys.length - STATS_DAY_RETENTION)) delete cur!.byDay[old];
  };

  const bumpPlatform = (
    platform: string | undefined,
    patch: (p: StatsSnapshot["byPlatform"][string]) => void
  ): void => {
    if (!platform) return;
    // 别名归一到契约键后计数：同一平台的旧名与新名并排两行，平台榜就是错的
    const key = resolveKey(platform);
    const row = cur!.byPlatform[key] ?? {
      downloads: 0,
      failures: 0,
      bytes: 0,
      parses: 0,
      parseFailures: 0,
    };
    patch(row);
    cur!.byPlatform[key] = row;
  };

  const commit = (): void => {
    if (!cur) return;
    cur.updatedAt = now();
    opts.save(cur);
  };

  const recordEvent = (event: StatsEventInput, entry?: HistoryEntry): void => {
    try {
      opts.recordEvent?.(event, entry);
    } catch {
      // Storage errors must never bubble through downloader/parse lifecycle callbacks or expose secrets.
      opts.onEventError?.();
    }
  };

  const ensure = (): StatsSnapshot => {
    if (cur) return cur;
    const loaded = opts.load();
    if (!loaded || loaded.schema !== 1 || !Array.isArray(loaded.byHour)) {
      if (loaded) opts.onReset?.("stats.json 结构版本不认识，按空档起算");
      cur = emptyStats(now());
      return cur;
    }
    // 盘上的档可能缺桶（老版本只统计过一部分维度）：补齐后原样续用，不清空用户的历史计数
    const blank = emptyStats(loaded.since);
    cur = {
      ...loaded,
      totals: { ...blank.totals, ...loaded.totals },
      parse: { ...blank.parse, ...loaded.parse },
      byDay: { ...loaded.byDay },
      byPlatform: migratePlatformKeys(loaded.byPlatform ?? {}),
      byKind: { ...loaded.byKind },
      byHour: loaded.byHour.slice(0, STATS_HOUR_SLOTS),
    };
    while (cur.byHour.length < STATS_HOUR_SLOTS) cur.byHour.push(0);
    return cur;
  };

  return {
    done({ at, platform, kind, bytes, elapsedMs, workKey, historyEntry }) {
      recordEvent({ type: "download", at, platform, kind: kind || "unknown", outcome: "success", bytes, transferMs: elapsedMs, workKey }, historyEntry);
      const s = ensure();
      const size = NON_NEGATIVE_INT(bytes);
      s.totals.downloads += 1;
      s.totals.bytes += size;
      const elapsed = NON_NEGATIVE_INT(elapsedMs ?? 0);
      if (elapsed > 0) {
        s.totals.elapsedMs += elapsed;
        s.totals.elapsedCount += 1;
        // 与 elapsedMs 同总线：平均速度只能在这批样本里算（契约注释已钉这条）
        s.totals.elapsedBytes += size;
      }
      const k = kind || "unknown";
      const kindRow = s.byKind[k] ?? { downloads: 0, bytes: 0 };
      kindRow.downloads += 1;
      kindRow.bytes += size;
      s.byKind[k] = kindRow;
      bumpPlatform(platform, (p) => {
        p.downloads += 1;
        p.bytes += size;
      });
      bumpDay(at, (d) => {
        d.downloads += 1;
        d.bytes += size;
      });
      s.byHour[hourSlot(at)] += 1;
      commit();
    },

    failure({ at, platform, kind, workKey }) {
      recordEvent({ type: "download", at, platform, kind: kind ?? "unknown", outcome: "failure", bytes: 0, workKey });
      const s = ensure();
      s.totals.failures += 1;
      bumpPlatform(platform, (p) => {
        p.failures += 1;
      });
      bumpDay(at, (d) => {
        d.failures += 1;
      });
      commit();
    },

    cancel(input?) {
      if (input) recordEvent({ type: "cancel", ...input });
      ensure().totals.canceled += 1;
      commit();
    },

    parse({ at, platform, via, ok, durationMs, workKey, historyEntry }) {
      recordEvent({ type: "parse", at, platform, via, ok, durationMs, workKey }, historyEntry);
      const s = ensure();
      s.parse.total += 1;
      s.parse[via] += 1;
      s.parse.durationMs += NON_NEGATIVE_INT(durationMs);
      if (!ok) s.parse.failures += 1;
      bumpPlatform(platform, (p) => {
        p.parses += 1;
        if (!ok) p.parseFailures += 1;
      });
      bumpDay(at, (d) => {
        d.parses += 1;
      });
      commit();
    },

    query(range) {
      if (!opts.query) throw new Error("Statistics query is unavailable");
      return opts.query(range);
    },

    snapshot() {
      return ensure();
    },
  };
}

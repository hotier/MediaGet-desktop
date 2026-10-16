/**
 * 统计页的聚合出口：把两份原始数据（计数档 StatsSnapshot + 历史明细行）
 * 变成图表能直接画的视图模型。纯函数、无副作用、不读盘不发 IPC ——
 * 所有口径都在这一个文件里定，页面只负责摆。
 *
 * 两条数据源各有边界，页面的标题措辞跟着这里走：
 * - **计数档**（stats.json）：从 `since` 起累加、不随行数窗口截断，失败/取消/解析只在它里面有。
 *   趋势、成功率、平台榜、热力图、解析统计都是它的口径。
 * - **历史明细**（history.json 最近 HISTORY_MAX 行）：逐文件粒度，作者榜与单文件大小分布
 *   只有它给得出。失败不在里面（只有 done 才追加），所以任何比率都不许从明细行算。
 *
 * 除零一律现算不猜：比率类返回 `null`（页面渲染「—」），份额类返回 0（条形宽度为 0）。
 * 把 0/0 显示成 0% 是最容易骗过自己眼睛的错 —— 那等于对用户说「一条都没失败过」。
 */
import type { HistoryEntry, StatsSnapshot } from "../../../types/ipc";
import { kindLabel } from "./format";

/** 趋势图窗口档位（页面直接铺成切换按钮，顺序即展示顺序） */
export const TREND_WINDOWS = [7, 30, 90, 365] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

/** 热力图的星期轴：索引与 `getDay()` 对齐（0 = 周日），与 byHour 的排布同一条约定 */
export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本机日历日键：与主进程 stats.ts 的 dayKey 同一算法，跨时区不迁移 */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/** 比率：分母为 0 时是「不知道」，不是 0 —— 交给页面渲染「—」 */
const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

// —— 趋势 ——

export interface TrendPoint {
  /** YYYY-MM-DD，用于 tooltip 与盘上键对齐 */
  key: string;
  /** MM-DD，用于 x 轴刻度（整图同一年，跨年由窗口说明承担） */
  label: string;
  downloads: number;
  failures: number;
  bytes: number;
  parses: number;
}

/**
 * 最近 `days` 天的连续序列：没记录的日子补零而不是跳过。
 * 跳过空缺会让「周末一条没下」画成「周五紧接周一」，趋势图的横轴就此失真。
 */
export function trendByDay(s: StatsSnapshot, days: number, now: number = Date.now()): TrendPoint[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const out: TrendPoint[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const key = dayKey(d.getTime());
    const row = s.byDay[key];
    out.push({
      key,
      label: `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      downloads: row?.downloads ?? 0,
      failures: row?.failures ?? 0,
      bytes: row?.bytes ?? 0,
      parses: row?.parses ?? 0,
    });
  }
  return out;
}

/** 窗口内合计：卡片右上那句「近 30 天 · 下载 128 / 失败 3」 */
export function trendTotal(points: TrendPoint[]): Omit<TrendPoint, "key" | "label"> {
  return points.reduce(
    (acc, p) => ({
      downloads: acc.downloads + p.downloads,
      failures: acc.failures + p.failures,
      bytes: acc.bytes + p.bytes,
      parses: acc.parses + p.parses,
    }),
    { downloads: 0, failures: 0, bytes: 0, parses: 0 }
  );
}

// —— 排行 ——

export interface RankRow {
  key: string;
  downloads: number;
  failures: number;
  bytes: number;
  parses: number;
  parseFailures: number;
  /** 占全部下载的份额（0..1）；总下载为 0 时是 0 */
  downloadShare: number;
  byteShare: number;
  /** 该平台自己的失败率；没有分母时 null */
  failureRate: number | null;
}

export type RankMetric = "downloads" | "bytes" | "failures" | "parses";

/** 并列时按 key 升序：切换窗口或重算后顺序不该莫名跳动 */
function toRankRows(
  rows: Record<string, { downloads?: number; failures?: number; bytes?: number; parses?: number; parseFailures?: number }>,
  totalDownloads: number,
  totalBytes: number,
  metric: RankMetric
): RankRow[] {
  const list = Object.entries(rows).map(([key, r]) => ({
    key,
    downloads: r.downloads ?? 0,
    failures: r.failures ?? 0,
    bytes: r.bytes ?? 0,
    parses: r.parses ?? 0,
    parseFailures: r.parseFailures ?? 0,
    downloadShare: share(r.downloads ?? 0, totalDownloads),
    byteShare: share(r.bytes ?? 0, totalBytes),
    failureRate: rate(r.failures ?? 0, (r.downloads ?? 0) + (r.failures ?? 0)),
  }));
  return list.sort((a, b) => b[metric] - a[metric] || a.key.localeCompare(b.key));
}

/** 平台榜：`s.byPlatform` 是唯一有 parses 维度的榜，所以带上解析失败 */
export function platformRank(s: StatsSnapshot, metric: RankMetric = "downloads"): RankRow[] {
  return toRankRows(s.byPlatform, s.totals.downloads, s.totals.bytes, metric);
}

/** 类型榜：桶里没有 failures/parses，相应字段恒 0（不是缺数据，是这维度不成立） */
export function kindRank(s: StatsSnapshot, metric: RankMetric = "downloads"): RankRow[] {
  // 桶键换成中文标签再排，页面不必每行再查一次表；键缺失时 kindLabel 原样透传
  const rows = Object.fromEntries(
    Object.entries(s.byKind).map(([k, v]) => [kindLabel(k), v] as const)
  );
  return toRankRows(rows, s.totals.downloads, s.totals.bytes, metric);
}

// —— 成功率 / 速度 / 解析 ——

export interface DownloadHealth {
  done: number;
  failed: number;
  canceled: number;
  /** done / (done + failed)；一条都没结束过时 null */
  successRate: number | null;
  bytes: number;
}

export function downloadHealth(s: StatsSnapshot): DownloadHealth {
  const { downloads, failures, canceled, bytes } = s.totals;
  return {
    done: downloads,
    failed: failures,
    canceled,
    successRate: rate(downloads, downloads + failures),
    bytes,
  };
}

/**
 * 平均速度与平均耗时。分子用的是 `elapsedBytes`（有耗时样本的那部分字节），
 * 不是全部字节：把两条总线相除会造出一个偏高的假速度，且无从发现。
 */
export function speedStats(s: StatsSnapshot): {
  avgBytesPerSec: number | null;
  avgElapsedMs: number | null;
  /** 有多少条记录带耗时样本；为 0 时上面两个都是 null，页面要说明原因 */
  sampled: number;
} {
  const { elapsedMs, elapsedCount, elapsedBytes } = s.totals;
  return {
    avgBytesPerSec: elapsedMs > 0 ? elapsedBytes / (elapsedMs / 1000) : null,
    avgElapsedMs: elapsedCount > 0 ? elapsedMs / elapsedCount : null,
    sampled: elapsedCount,
  };
}

export interface ParseStats {
  total: number;
  failures: number;
  successRate: number | null;
  byVia: { local: number; online: number; mock: number };
  /** 各通道占比（0..1），分母是解析总次数 */
  viaShare: { local: number; online: number; mock: number };
  avgDurationMs: number | null;
}

export function parseStats(s: StatsSnapshot): ParseStats {
  const p = s.parse;
  return {
    total: p.total,
    failures: p.failures,
    successRate: rate(p.total - p.failures, p.total),
    byVia: { local: p.local, online: p.online, mock: p.mock },
    viaShare: {
      local: share(p.local, p.total),
      online: share(p.online, p.total),
      mock: share(p.mock, p.total),
    },
    avgDurationMs: p.total > 0 ? p.durationMs / p.total : null,
  };
}

// —— 热力（星期 × 小时）——

export interface Heat {
  /** 168 格，索引 = 星期(0=周日)*24 + 小时 */
  cells: number[];
  max: number;
  peak: { weekday: number; hour: number; value: number } | null;
}

export function heat(s: StatsSnapshot): Heat {
  const cells = s.byHour;
  let max = 0;
  let at = -1;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] > max) {
      max = cells[i];
      at = i;
    }
  }
  return {
    cells,
    max,
    peak: at < 0 ? null : { weekday: Math.floor(at / 24), hour: at % 24, value: cells[at] },
  };
}

/** 热力单元格的悬浮文案：`周三 21:00 · 12 次` */
export function heatSlotLabel(weekday: number, hour: number): string {
  return `${WEEKDAYS[weekday] ?? "?"} ${pad2(hour)}:00`;
}

// —— 历史明细口径 ——

export interface HistoryScope {
  files: number;
  /** 只有带字节记录的行进入这个合计（口径与 sizeHistogram 的 counted 一致） */
  bytes: number;
  /** 明细窗口覆盖的时间跨度，空表时 null */
  span: { from: number; to: number } | null;
}

/** 明细窗口的实话：行数、字节合计、时间跨度 —— 页面用它标「统计窗口」而不是假装是全量 */
export function historyScope(rows: HistoryEntry[]): HistoryScope {
  let bytes = 0;
  let from: number | null = null;
  let to: number | null = null;
  for (const r of rows) {
    if (typeof r.bytes === "number" && Number.isFinite(r.bytes) && r.bytes > 0) bytes += r.bytes;
    const at = r.createdAt;
    if (typeof at === "number" && Number.isFinite(at)) {
      if (from === null || at < from) from = at;
      if (to === null || at > to) to = at;
    }
  }
  return { files: rows.length, bytes, span: from !== null ? { from, to: to ?? from } : null };
}

export interface SizeBucket {
  label: string;
  from: number;
  to: number | null;
  count: number;
  /** 占有字节记录行数的份额（0..1） */
  share: number;
}

/** 档位边界写死在测试之外只有一处：直方图要跨版本可比，所以不做自适应分位 */
const SIZE_EDGES: { label: string; from: number; to: number | null }[] = [
  { label: "< 10 MB", from: 0, to: 10 * MB },
  { label: "10–50 MB", from: 10 * MB, to: 50 * MB },
  { label: "50–200 MB", from: 50 * MB, to: 200 * MB },
  { label: "200 MB–1 GB", from: 200 * MB, to: 1000 * MB },
  { label: "≥ 1 GB", from: 1000 * MB, to: null },
];

export function sizeHistogram(rows: HistoryEntry[]): {
  buckets: SizeBucket[];
  counted: number;
  /** 老记录缺 bytes，或不可能是「一个文件」的 0 值 —— 页面要说这些没计入 */
  skipped: number;
} {
  const hits = SIZE_EDGES.map((e) => ({ ...e, count: 0 }));
  let counted = 0;
  for (const r of rows) {
    const b = r.bytes;
    if (typeof b !== "number" || !Number.isFinite(b) || b <= 0) continue;
    counted += 1;
    const slot = hits.find((h) => b >= h.from && (h.to === null || b < h.to));
    if (slot) slot.count += 1;
  }
  return {
    buckets: hits.map((h) => ({ ...h, share: share(h.count, counted) })),
    counted,
    skipped: rows.length - counted,
  };
}

export interface AuthorRow {
  name: string;
  /** 作品数：按 groupId 去重（图集的一个组算一条），缺组时退回行 id */
  works: number;
  /** 文件数：明细行本身是逐文件的 */
  files: number;
  bytes: number;
}

/**
 * 作者榜。明细行是逐文件粒度，所以「文件数」与「作品数」必须分开报，
 * 否则一个 30 张图的图集会被读成关注了 30 个作品。
 * 匿名（既无 id 又无 name）不参与排名，单独给个数。
 */
export function authorTop(rows: HistoryEntry[], limit = 10): { list: AuthorRow[]; anonymous: number } {
  const by = new Map<string, { name: string; groups: Set<string>; files: number; bytes: number }>();
  let anonymous = 0;
  for (const r of rows) {
    const key = r.author?.id || r.author?.name;
    if (!key) {
      anonymous += 1;
      continue;
    }
    const cur = by.get(key) ?? { name: r.author?.name || key, groups: new Set<string>(), files: 0, bytes: 0 };
    cur.groups.add(r.groupId || r.id);
    cur.files += 1;
    if (typeof r.bytes === "number" && Number.isFinite(r.bytes) && r.bytes > 0) cur.bytes += r.bytes;
    by.set(key, cur);
  }
  const list = [...by.values()]
    .map((v) => ({ name: v.name, works: v.groups.size, files: v.files, bytes: v.bytes }))
    .sort((a, b) => b.files - a.files || b.works - a.works || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { list, anonymous };
}

/** 空态判定：计数档一条都没记过（页面据此显示引导而不是满屏 0） */
export function isEmptyStats(s: StatsSnapshot): boolean {
  return s.totals.downloads + s.totals.failures + s.parse.total === 0;
}

/** 本机日历日序号：UTC 折叠掉时区/夏令时，只留「哪一天」（与 format.ts 的 dayNo 同一手法） */
const calendarDayNo = (ts: number): number => {
  const d = new Date(ts);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
};

/**
 * 累计口径的起点文案：`自 2026-09-30 · 第 17 天`。
 * 天数按日历日算不是按毫秒差算 —— 昨天装的，今天看就是「第 2 天」，
 * 用时长下取整会把隔夜的两格显示成「1 天」，读起来像应用昨天才装好。
 */
export function sinceLabel(s: StatsSnapshot, now: number = Date.now()): { date: string; days: number } {
  return {
    date: dayKey(s.since),
    days: Math.max(1, calendarDayNo(now) - calendarDayNo(s.since) + 1),
  };
}

/**
 * 统计页的聚合出口：把主进程的范围查询结果（StatsQueryResult）摊成图表能直接画的视图模型。
 * 纯函数、无副作用、不读盘不发 IPC —— 所有口径都在这一个文件里定，页面只负责摆。
 *
 * 日期范围是**本机自然日、首尾都含**；未来日不可选，开始日不能晚于结束日。
 * 范围跨过统计数据覆盖起点时，覆盖起点之前不补零：那段日期没有事件，不是「那天没人用」。
 *
 * 除零一律现算不猜：比率类返回 `null`（页面渲染「—」），份额类返回 0（条形宽度为 0）。
 * 把 0/0 显示成 0% 是最容易骗过自己眼睛的错 —— 那等于对用户说「一条都没失败过」。
 */
import type { HistoryEntry, StatsDateRange, StatsQueryResult } from "../../../types/ipc";
import { kindLabel } from "./format";

/** 统计页顶部预设档位（顺序即按钮顺序；近 N 天含今天） */
export const STATS_RANGE_PRESETS = [7, 30, 90] as const;
export type StatsRangePreset = (typeof STATS_RANGE_PRESETS)[number];

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

/** 本机日历日序号：UTC 折叠掉时区/夏令时，只留「哪一天」（与 format.ts 的 dayNo 同一手法） */
const calendarDayNo = (ts: number): number => {
  const d = new Date(ts);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
};

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 严格解析 YYYY-MM-DD 为本机日历日。
 * Date 构造器会把 2026-02-30 滚到 3 月，所以必须把年月日再对一遍才算合法。
 */
export function parseDateKey(key: string): Date | null {
  const match = DATE_KEY_RE.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
}

export function todayKey(now: number = Date.now()): string {
  return dayKey(now);
}

/**
 * 本机日历上加减天数：交给 Date 构造器进位，不用 86_400_000 毫秒 ——
 * 固定毫秒差在夏令时切换日会漂一小时，跨过午夜就变成前一天/后一天。
 */
export function addDays(key: string, days: number): string | null {
  const date = parseDateKey(key);
  if (!date) return null;
  return dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime());
}

/** 近 N 天（含今天）：to = 今天，from = 今天 - (N - 1) */
export function presetRange(days: number, now: number = Date.now()): StatsDateRange {
  const to = todayKey(now);
  const span = Math.max(1, Math.floor(days));
  return { from: addDays(to, 1 - span) ?? to, to };
}

/** 含首尾两天的日历天数；非法键返回 0 */
export function rangeDays(range: StatsDateRange): number {
  const from = parseDateKey(range.from);
  const to = parseDateKey(range.to);
  if (!from || !to) return 0;
  return Math.max(0, calendarDayNo(to.getTime()) - calendarDayNo(from.getTime()) + 1);
}

/** 本机自然日的半开区间 `[startAt, endAt)`：起止日都含，跨月/闰日由 Date 进位 */
export function localDayBounds(key: string): { startAt: number; endAt: number } | null {
  const date = parseDateKey(key);
  if (!date) return null;
  return {
    startAt: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
    endAt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
  };
}

export type RangeProblem = "invalid" | "order" | "future";

/** 自定义范围的拒绝理由；通过返回 null。未来日期只可能出现在 to 上（order 先被拦下） */
export function rangeProblem(from: string, to: string, now: number = Date.now()): RangeProblem | null {
  if (!parseDateKey(from) || !parseDateKey(to)) return "invalid";
  if (from > to) return "order";
  if (to > todayKey(now)) return "future";
  return null;
}

/** 当前已应用范围命中哪个预设档；自定义范围返回 null */
export function activePreset(range: StatsDateRange, now: number = Date.now()): StatsRangePreset | null {
  for (const days of STATS_RANGE_PRESETS) {
    const preset = presetRange(days, now);
    if (preset.from === range.from && preset.to === range.to) return days;
  }
  return null;
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
 * 范围查询的连续日序列。起点取 `max(范围起点, 覆盖起点)`：
 * 覆盖起点之前没有事件可查，不能补成 0；覆盖起点之后缺记录的日子才是真的 0。
 * 范围整体早于覆盖起点、或库里还没有任何事件时返回空数组。
 */
export function queryTrend(result: StatsQueryResult): TrendPoint[] {
  const first = result.availableFrom;
  if (first === null) return [];
  let key = result.range.from < first ? first : result.range.from;
  if (key > result.range.to) return [];
  const out: TrendPoint[] = [];
  while (key <= result.range.to) {
    const row = result.byDay[key];
    out.push({
      key,
      label: key.slice(5),
      downloads: row?.downloads ?? 0,
      failures: row?.failures ?? 0,
      bytes: row?.bytes ?? 0,
      parses: row?.parses ?? 0,
    });
    const next = addDays(key, 1);
    if (!next) break;
    key = next;
  }
  return out;
}

/**
 * 年视图热力的连续日序列：**整段范围逐日出格**，不向覆盖起点收缩。
 * 覆盖起点之前的日子标 `missing`（那里没有事件可查，画成空格而不是 0 ——
 * 与 queryTrend 的「不补零」是同一条语义，只是格子保留在轴上撑满一年）。
 * 库里还没有任何事件时返回空数组。
 */
export interface TrendCell extends TrendPoint {
  /** true = 覆盖起点之前，无账可查：热力图画空格 */
  missing?: boolean;
}

export function queryTrendYear(result: StatsQueryResult): TrendCell[] {
  const first = result.availableFrom;
  if (first === null) return [];
  const out: TrendCell[] = [];
  let key = result.range.from;
  while (key <= result.range.to) {
    const row = result.byDay[key];
    out.push({
      key,
      label: key.slice(5),
      downloads: row?.downloads ?? 0,
      failures: row?.failures ?? 0,
      bytes: row?.bytes ?? 0,
      parses: row?.parses ?? 0,
      missing: key < first,
    });
    const next = addDays(key, 1);
    if (!next) break;
    key = next;
  }
  return out;
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

/** 平台榜：`byPlatform` 是唯一有 parses 维度的榜，所以带上解析失败 */
export function platformRank(
  data: {
    byPlatform: Record<string, { downloads?: number; failures?: number; bytes?: number; parses?: number; parseFailures?: number }>;
    totals: { downloads: number; bytes: number };
  },
  metric: RankMetric = "downloads"
): RankRow[] {
  return toRankRows(data.byPlatform, data.totals.downloads, data.totals.bytes, metric);
}

/** 类型榜：桶里没有 failures/parses，相应字段恒 0（不是缺数据，是这维度不成立） */
export function kindRank(
  data: {
    byKind: Record<string, { downloads?: number; bytes?: number }>;
    totals: { downloads: number; bytes: number };
  },
  metric: RankMetric = "downloads"
): RankRow[] {
  // 桶键换成中文标签再排，页面不必每行再查一次表；键缺失时 kindLabel 原样透传
  const rows = Object.fromEntries(
    Object.entries(data.byKind).map(([k, v]) => [kindLabel(k), v] as const)
  );
  return toRankRows(rows, data.totals.downloads, data.totals.bytes, metric);
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

export function downloadHealth(data: {
  totals: { downloads: number; failures: number; canceled: number; bytes: number };
}): DownloadHealth {
  const { downloads, failures, canceled, bytes } = data.totals;
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
export function speedStats(data: {
  totals: { elapsedMs: number; elapsedCount: number; elapsedBytes: number };
}): {
  avgBytesPerSec: number | null;
  avgElapsedMs: number | null;
  /** 有多少条记录带耗时样本；为 0 时上面两个都是 null，页面要说明原因 */
  sampled: number;
} {
  const { elapsedMs, elapsedCount, elapsedBytes } = data.totals;
  return {
    avgBytesPerSec: elapsedMs > 0 ? elapsedBytes / (elapsedMs / 1000) : null,
    avgElapsedMs: elapsedCount > 0 ? elapsedMs / elapsedCount : null,
    sampled: elapsedCount,
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

export interface ParsedAuthorRow {
  name: string;
  /** 按作品键去重；一位作者一条作品只记一次，即使作品落地了多个文件 */
  works: number;
}

/** 解析作者榜按作品数排名，不按文件数排名；历史是解析记录，一条作品可以对应多个文件行。 */
export function parsedAuthorTop(rows: HistoryEntry[], limit = 10): { list: ParsedAuthorRow[]; anonymous: number } {
  const by = new Map<string, { name: string; works: Set<string> }>();
  const seenWorks = new Map<string, string>();
  const anonymousWorks = new Set<string>();
  for (const row of rows) {
    const work = row.groupId || row.id;
    const authorKey = row.author?.id || row.author?.name;
    if (!authorKey) {
      if (!seenWorks.has(work)) anonymousWorks.add(work);
      continue;
    }
    anonymousWorks.delete(work);
    if (seenWorks.has(work)) continue;
    seenWorks.set(work, authorKey);
    const author = by.get(authorKey) ?? { name: row.author?.name || authorKey, works: new Set<string>() };
    author.works.add(work);
    by.set(authorKey, author);
  }
  const list = [...by.values()]
    .map(({ name, works }) => ({ name, works: works.size }))
    .sort((a, b) => b.works - a.works || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { list, anonymous: anonymousWorks.size };
}

export interface AuthorUsageRow {
  name: string;
  /** 最近历史窗口中按 groupId 去重的解析作品数 */
  parsedWorks: number;
  /** 已落地文件数；一张图集可以包含多个文件 */
  downloadedFiles: number;
  downloadedBytes: number;
}

/** 作者解析与下载维度共用同一份最近历史窗口；解析按作品去重，下载按实际文件计数。 */
export function authorUsage(rows: HistoryEntry[], limit = 10): { list: AuthorUsageRow[]; anonymous: number } {
  const by = new Map<string, { name: string; works: Set<string>; files: number; bytes: number }>();
  const seenAuthorByWork = new Map<string, string>();
  const anonymousWorks = new Set<string>();

  for (const row of rows) {
    const work = row.groupId || row.id;
    const authorKey = row.author?.id || row.author?.name;
    if (!authorKey) {
      if (!seenAuthorByWork.has(work)) anonymousWorks.add(work);
      continue;
    }
    anonymousWorks.delete(work);
    const owner = seenAuthorByWork.get(work);
    if (owner && owner !== authorKey) continue;
    seenAuthorByWork.set(work, authorKey);
    const author = by.get(authorKey) ?? { name: row.author?.name || authorKey, works: new Set<string>(), files: 0, bytes: 0 };
    author.works.add(work);
    const fileCount = row.files?.length ?? 0;
    if (fileCount > 0) {
      author.files += fileCount;
      if (typeof row.bytes === "number" && Number.isFinite(row.bytes) && row.bytes > 0) author.bytes += row.bytes;
    }
    by.set(authorKey, author);
  }

  const list = [...by.values()]
    .map((author) => ({ name: author.name, parsedWorks: author.works.size, downloadedFiles: author.files, downloadedBytes: author.bytes }))
    .sort((a, b) => b.parsedWorks - a.parsedWorks || b.downloadedFiles - a.downloadedFiles || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { list, anonymous: anonymousWorks.size };
}

/** 范围查询里的作者榜：表头先列「解析作品」，同分再比落地文件数与名字 */
export function queryAuthors(result: StatsQueryResult, limit = 10): StatsQueryResult["authors"] {
  return result.authors
    .filter((row) => row.parsedWorks > 0 || row.downloadedFiles > 0)
    .sort(
      (a, b) =>
        b.parsedWorks - a.parsedWorks ||
        b.downloadedFiles - a.downloadedFiles ||
        a.name.localeCompare(b.name)
    )
    .slice(0, limit);
}


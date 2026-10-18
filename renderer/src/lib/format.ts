/**
 * 数字、时间与类型标签的全站唯一格式化出口。
 * 之前 fmtBytes 住在队列页、时间格式化住在历史页，首页想复用只能去 import 另一个页面，
 * 结果同一时间戳在两页渲染成两种宽度，宽的那版把标题挤到 99px。统一走这里，长文本才有稳定可读宽度。
 * 时间口径全站只有一个 fmtCreated（今天/昨天 + 带年份 + 到秒）：两处列表若各用一档精度，
 * 同一批记录在首页和「全部历史」里会显示成两个时刻。
 */

/** 0 B / 12.3 MB / 1.4 GB */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 1.2万 / 3.4亿 —— 计数类字段（粉丝、获赞、播放）的统一量级 */
export function fmtCount(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return n.toLocaleString("zh-CN");
}

/**
 * 比率：入参是 0..1 的份额。null 是「没有分母」，报「—」而不是 0% ——
 * 一条都没下过时把失败率写成 0%，等于向用户保证「从没失败过」，这是最贵的一种错。
 */
export function fmtPercent(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

/** 耗时：亚秒用整数 ms，秒级留一位小数（解析耗时与下载耗时同一把尺，跨页可比） */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 速率：字节/秒。null = 速度还没采到（首块前），不许显示 0 B/s —— 那是「停了」不是「不知道」 */
export function fmtSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  return `${fmtBytes(bytesPerSec)}/s`;
}

/**
 * 完成行的**平均速度**：已下字节 ÷ 耗时（毫秒）。
 * 分母由调用方给，且必须是**实际传输时长**（队列页给 `transferMs`，统计页的 `elapsedMs`
 * 也是同一口径，契约 v18）—— 拿 `finishedAt − createdAt` 当分母会把暂停与排队算成下载时间，
 * 暂停一晚上的文件会被算成几十 KB/s。
 * 缺样本（旧档没这两个计数器）/ 耗时为 0 时返回 null，由调用方渲染「—」而不是编一个 Infinity。
 */
export function avgSpeed(bytes: number, elapsedMs: number | null): number | null {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes / (elapsedMs / 1000);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地日历日序号；用 UTC 折叠掉时区/夏令时，只留「哪一天」 */
const dayNo = (d: Date): number => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400_000);

/**
 * 创建/完成时间：今天 / 昨天 换成相对日，其余带年份，一律到秒、单行输出。
 * 相对日只覆盖「昨天」为止 —— 再往前「前天 12:30:04」并不比「10-13 12:30:04」更好读，
 * 而带年份是必需的：历史留 5000 条，跨年记录只剩 MM-DD 时会把去年的记录读成今年的。
 * 队列页九列并排也要求单行：拆成「日期一行 + 时刻一行」会把行高从 37px 抬到 49px。
 */
export function fmtCreated(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const diff = dayNo(new Date(now)) - dayNo(d);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `昨天 ${time}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/**
 * 发布日只到天（`2026-10-17`）。结果卡那行是「作品什么时候发的」，秒级精度没有信息量；
 * 本机记下的解析时刻另走 `fmtCreated` —— 两个时间各叫各的，不合并成一列。
 */
export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 文件名用的紧凑时刻：`20261019000047`（年+月+日+时+分+秒，14 位）。
 * 与 `fmtDate` / `fmtCreated` 分家：那两个是**给人读**的（带分隔符、可含中文字），
 * 这个要进文件名 —— 不带空格、冒号与中文，也不会被文件系统的非法字符规则咬到。
 * 精确到秒（业主指令 2026-10-19）：同一分钟内连导两档格式也会撞名，多两位就没这回事。
 */
export function fmtFileStamp(ts: number): string {
  const d = new Date(ts);
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return `${date}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * 到秒的时刻（HH:mm:ss）。结果卡用它报「解析于什么时候」——只陈述到手时刻，
 * 不推断那条直链还剩多久：各家 CDN 的有效期差异极大（抖音播放链串上没有时间签名，
 * 封面签名约 14 天），任何「还剩几分钟」的估算都是猜。
 */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 剩余时间：按当前速度估到完成还要多久，一律 HH:mm:ss。
 * 不换「5 秒」这种短形态是因为队列九列里它是单行的一格，
 * 两种字宽（「5 秒」/「03:05:30」）来回跳会让那一列的边缘对不齐。
 * 估不出就一律「—」而不是猜 —— 排队中/暂停/速度尚未采到（首块前）都给数字的话，
 * 用户会以为队列在动。上限 99:59:59，再长（≈4 天）说明速度不可信，同样不报。
 */
export function fmtEta(remainingBytes: number, bytesPerSec: number): string {
  if (!(remainingBytes > 0) || !(bytesPerSec > 0)) return "—";
  const s = Math.ceil(remainingBytes / bytesPerSec);
  const h = Math.floor(s / 3600);
  if (h > 99) return "—";
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

/**
 * 媒体类型标签。历史页、结果卡与统计页必须同词，否则同一批数据在两页显示成两种类型。
 * 键是**下载项的 kind**（video/image/audio/file）；解析结果的 `type` 是另一套枚举
 * （含 music/text，住在 ResultCard 的 TYPE_LABEL），两者别merge成一张表。
 * `unknown` 不是契约里的 kind，是计数档（stats.json）给缺类型记录的兜底桶名。
 */
export const KIND_LABEL: Record<string, string> = {
  video: "视频",
  image: "图集",
  audio: "音频",
  file: "文件",
  unknown: "未分类",
};

/** 认不出的 kind 原样显示（内核新增类型时统计页不该把它说成「未分类」） */
export const kindLabel = (kind?: string): string =>
  (kind && KIND_LABEL[kind]) || kind || "—";


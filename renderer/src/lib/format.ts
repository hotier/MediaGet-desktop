/**
 * 数字与时间的全站唯一格式化出口。
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

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地日历日序号；用 UTC 折叠掉时区/夏令时，只留「哪一天」 */
const dayNo = (d: Date): number => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400_000);

/**
 * 创建/完成时间：今天 / 昨天 换成相对日，其余带年份，一律到秒、单行输出。
 * 相对日只覆盖「昨天」为止 —— 再往前「前天 12:30:04」并不比「10-13 12:30:04」更好读，
 * 而带年份是必需的：历史留 500 条，跨年记录只剩 MM-DD 时会把去年的记录读成今年的。
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

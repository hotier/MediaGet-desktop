/**
 * 历史页多选的纯函数面（选择状态机 + 导出文本拼装）。
 *
 * 为什么单独成模块：多选的全部正确性风险都在这几行里——锚点随行筛选失效、
 * 越界点击、CSV 转义（逗号/引号/换行）与 Excel 公式注入、四档导出共用同一张列表。
 * 它们是纯变形，抽出来才能用纯 Node 测试覆盖，不必拉 DOM（docs/TESTING.md §6：不引 jsdom）；
 * 唯一例外是 xlsx 档要动 exceljs，那条是 async 且只在按下去时才动态 import。
 *
 * 状态模型：`keys` 存**行键**（groupId ?? id，与 UI 行同构），选择集合不随筛选缩水
 * （Windows 资源管理器口径：选中后再筛掉某行，它仍在集合里、仍可被删/导出）；
 * `anchor` 存**键**不存下标 —— 锚点若是下标，筛选一变就指错行。
 */
import type { AuthorSnapshot, WorkStat } from "../../../types/ipc";
import { WORK_STAT_SLOTS } from "../../../shared/work-stat";

export interface SelState {
  keys: string[];
  /** 最近一次点选的行键（Shift 范围选的原点） */
  anchor: string | null;
}

export const EMPTY_SEL: SelState = { keys: [], anchor: null };

export function isSelected(s: SelState, key: string): boolean {
  return s.keys.includes(key);
}

/** Ctrl/⌘+点：切换该行。锚点移到该行。index 越界（列表刚变过）原样返回 */
export function clickToggle(s: SelState, visibleKeys: string[], index: number): SelState {
  const key = visibleKeys[index];
  if (key === undefined) return s;
  return {
    keys: s.keys.includes(key) ? s.keys.filter((k) => k !== key) : [...s.keys, key],
    anchor: key,
  };
}

/**
 * Shift+点：锚点到当前行的**可见范围**并入选择集（端点含）。
 * - 无锚点（第一次就按 Shift）：只选这一行，并立为锚点；
 * - 锚点已被筛掉/已不在可见区：范围无从谈起 —— 只选目标行，**锚点保留**
 *   （资源管理器同款退化：宁可保守单选，不猜用户要哪一段）；
 * - 锚点不动：连续 Shift 点按 Explorer 习惯始终以第一次点行为原点扩展。
 */
export function clickRange(s: SelState, visibleKeys: string[], index: number): SelState {
  const key = visibleKeys[index];
  if (key === undefined) return s;
  if (s.anchor === null) return { keys: [...new Set([...s.keys, key])], anchor: key };
  const a = visibleKeys.indexOf(s.anchor);
  if (a < 0) return { keys: [...new Set([...s.keys, key])], anchor: s.anchor };
  const [lo, hi] = a <= index ? [a, index] : [index, a];
  return { keys: [...new Set([...s.keys, ...visibleKeys.slice(lo, hi + 1)])], anchor: s.anchor };
}

/** Ctrl/⌘+A：**替换**为可见全部行。不并入既有选择 —— 全选表达的是「就要操作我看到的这些」，
 *  并入会把此前选中、已被筛掉的行偷偷带进批量删除（业主在 spec §1 认可）。锚点原样保留。 */
export function selectAllVisible(s: SelState, visibleKeys: string[]): SelState {
  return { keys: [...visibleKeys], anchor: s.anchor };
}

/**
 * 表头那枚全选框的三态。`s` 里可能带着**已被筛掉**的选中行，所以只看可见行的命中比例：
 * 一条没选 = 空，全选了 = 勾，选了一部分必须显示成 indeterminate —— 部分态若画成勾，
 * 下一次点就是「清空」，用户会以为自己刚才全选过。
 */
export function headerCheckState(s: SelState, visibleKeys: string[]): boolean | "indeterminate" {
  const picked = visibleKeys.reduce((n, k) => n + (s.keys.includes(k) ? 1 : 0), 0);
  if (picked === 0) return false;
  return picked === visibleKeys.length ? true : "indeterminate";
}

/**
 * 多选「重新解析」：只交得出**带分享链接**的行。
 * 历史不存媒体直链（ARCHITECTURE §3），分享链接是把作品交回内核的唯一入口；
 * v8 起的解析行必然有，而更早的下载行可能没有 —— 缺了不能猜，跳过并如实报数。
 */
export function reparseLinks(rows: Array<{ sourceUrl?: string }>): string[] {
  return rows.map((r) => r.sourceUrl).filter((u): u is string => Boolean(u));
}

// ————————————————————————————————————————————————
// 导出文本
// ————————————————————————————————————————————————

/** txt 多条之间的分隔行（全角破折号成串：正文里没有自发的这玩意，肉眼也数得清几条） */
export const WORK_SEPARATOR = "————";

/** 多条「作品信息」拼接：单条不加任何前后缀（复制一条时不该看见分隔线） */
export function concatWorkInfo(texts: string[]): string {
  return texts.join(`\n${WORK_SEPARATOR}\n`);
}

/** RFC 4180：含逗号/引号/换行的值用双引号包裹，内嵌引号翻倍。
 *  Excel 的 CSV 行分隔规范是 CRLF，别发裸 \n（老 Excel 会把整表挤成一行）。 */
export function csvCell(v: string): string {
  // 公式注入防御：以 = + - @ 开头的单元格会被 Excel 当公式求值（标题来自平台数据，
  // 属不可信输入）。前缀单引号强制文本 —— 代价是该标题多了个可见字符，比注入被执行划算。
  const body = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

/** CSV 的一行 = 一个作品（与 UI 行同构）；字段全可选，缺项落空格而非「—」——
 *  「—」进表格是脏数据，空串才是「没这个信息」。
 *  这一份行形状是 csv / xlsx / json 三档共用的**唯一**输入（txt 走另一条：它拼的是「作品信息」全文）。
 *
 *  计数与发布时间（业主指令 2026-10-17「导出的信息应该是完整信息」）来自**解析那一刻**的快照：
 *  本版本之前落盘的老记录没有这些字段，那就是空 —— 空是「当时没记」，不是「这个作品零赞」。 */
export interface ExportWork {
  title: string;
  authorName?: string;
  /** 作者快照整份带上：昵称之外的 ID/主页/粉丝关注获赞投稿 都由它出，
   *  逐项摊平会让页面那侧多六行映射，而快照本来就是一个整体。 */
  author?: AuthorSnapshot;
  platformName?: string;
  kindLabel?: string;
  count: number;
  /** 原始字节数（Excel 里要的是可排序的数字，不是格式化串） */
  bytes?: number;
  /** 本机解析/落地那一刻 */
  createdAt: number;
  /** 作品在平台上的发布时刻 */
  publishedAt?: number;
  /** 互动计数快照 */
  stat?: WorkStat;
  sourceUrl?: string;
  /** 落地目录（dirOf(files[0])；单元格里塞 N 条全路径没法看，「在哪」够用） */
  dir?: string;
}

/** 一格的原始值：数字留给表格档排序筛选，Date 由 xlsx 写成日期单元格 */
type ExportCell = string | number | Date | null;

/** 表格三档（csv / xlsx / json）共用这一张列表：**加一列只改这里**，三档不会互相漂。
 *  `key` 是 json 的字段名（ASCII，给程序读），`header` 是表格首行（给人看）。
 *
 *  分组顺序 = 作品本身 → 时间 → 链接与落点 → 作者 → 互动计数。计数各档由
 *  `WORK_STAT_SLOTS` 展开（内核里叫 `view`/`danmaku`，界面上叫「播放」/「弹幕」是**平台无关**的
 *  语义映射，所以列序也归那张表管，加一档只改 shared 一处）。
 *
 *  两个时间都留着且各叫各的：`发布时间` 是作品在平台上的时刻，`解析时间` 是本机记下这条的时刻——
 *  合成一列就再也分不出「三年前发的、今天解析的」和「今天发的、今天解析的」。 */
export const EXPORT_COLUMNS: Array<{
  key: string;
  header: string;
  width: number;
  value: (r: ExportWork) => ExportCell;
}> = [
  { key: "title", header: "标题", width: 40, value: (r) => r.title },
  { key: "platformName", header: "平台", width: 12, value: (r) => r.platformName ?? null },
  { key: "kindLabel", header: "类型", width: 8, value: (r) => r.kindLabel ?? null },
  { key: "count", header: "文件数", width: 8, value: (r) => r.count },
  { key: "bytes", header: "大小(字节)", width: 12, value: (r) => r.bytes ?? null },
  {
    key: "publishedAt",
    header: "发布时间",
    width: 18,
    value: (r) => (r.publishedAt != null ? new Date(r.publishedAt) : null),
  },
  { key: "createdAt", header: "解析时间", width: 18, value: (r) => new Date(r.createdAt) },
  { key: "sourceUrl", header: "分享链接", width: 46, value: (r) => r.sourceUrl ?? null },
  { key: "dir", header: "落地目录", width: 36, value: (r) => r.dir ?? null },
  { key: "authorName", header: "作者昵称", width: 18, value: (r) => r.authorName ?? null },
  { key: "authorId", header: "作者ID", width: 16, value: (r) => r.author?.id ?? null },
  { key: "authorUrl", header: "作者主页", width: 40, value: (r) => r.author?.url ?? null },
  { key: "followerCount", header: "粉丝数", width: 12, value: (r) => r.author?.followerCount ?? null },
  { key: "followingCount", header: "关注数", width: 10, value: (r) => r.author?.followingCount ?? null },
  { key: "totalFavorited", header: "获赞数", width: 12, value: (r) => r.author?.totalFavorited ?? null },
  { key: "videoCount", header: "投稿数", width: 10, value: (r) => r.author?.videoCount ?? null },
  // 计数各档：数字直出（不缩写成「1.2 万」），Excel 里要的就是可排序可求和的原始值
  ...WORK_STAT_SLOTS.map((s) => ({
    key: s.key,
    header: s.label,
    width: 11,
    value: (r: ExportWork): ExportCell => r.stat?.[s.key] ?? null,
  })),
];

/** 表头由列表派生（顺序即列序，测试钉它防漂移） */
export const CSV_HEADER = EXPORT_COLUMNS.map((c) => c.header).join(",");

export function buildWorksCsv(rows: ExportWork[], fmtTime: (ts: number) => string): string {
  const line = (r: ExportWork): string =>
    EXPORT_COLUMNS.map((c) => {
      const v = c.value(r);
      // 时间在这一档只能是**格式化串**（CSV 没有日期类型，Excel 认 locale 赌运气）
      return csvCell(v instanceof Date ? fmtTime(v.getTime()) : String(v ?? ""));
    }).join(",");
  return [CSV_HEADER, ...rows.map(line)].join("\r\n");
}

/** json 档：字段名用 `key`，Date 一律 ISO 8601（机器读的时间不该是 locale 串），缺项是 null 不是空串 */
export function buildWorksJson(rows: ExportWork[]): string {
  const objs = rows.map((r) =>
    Object.fromEntries(
      EXPORT_COLUMNS.map((c) => {
        const v = c.value(r);
        return [c.key, v instanceof Date ? v.toISOString() : v];
      })
    )
  );
  return JSON.stringify(objs, null, 2);
}

/** 导出档位（xlsx 是唯一要库的一档） */
export type ExportFormat = "xlsx" | "csv" | "json" | "txt";

/** 弹窗里的显示顺序：表格档在前、文本档在后 */
export const EXPORT_FORMAT_ORDER: ExportFormat[] = ["xlsx", "csv", "json", "txt"];

/** 每档的文案与 MIME。`Record<ExportFormat, …>` 而非数组：页面取 mime 要按档位直取，
 *  查不到就是类型被改坏，不该在运行时兜一个 `find(...)!` */
export const EXPORT_FORMATS: Record<ExportFormat, { label: string; mime: string }> = {
  xlsx: { label: "Excel 表格（.xlsx）", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  csv: { label: "CSV 表格（.csv）", mime: "text/csv" },
  json: { label: "JSON 数据（.json）", mime: "application/json" },
  txt: { label: "作品信息文本（.txt）", mime: "text/plain" },
};

/**
 * xlsx 档：四档里唯一需要库的（其余三档是字符串），所以 exceljs 走**动态 import**——
 * 它带着 155 个传递依赖，不该进首屏 chunk，只有真按 xlsx 才去解析它。
 * 首行加粗 + 冻结 + 自动筛选是这一档存在的全部理由：要的就是在 Excel 里排序筛选。
 */
export async function buildWorksXlsx(rows: ExportWork[], sheetName = "解析历史"): Promise<Uint8Array<ArrayBuffer>> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  rows.forEach((r) => ws.addRow(Object.fromEntries(EXPORT_COLUMNS.map((c) => [c.key, c.value(r)]))));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_COLUMNS.length } };
  const buf = await wb.xlsx.writeBuffer();
  // Node 侧给 Buffer（Uint8Array 的子类），浏览器 UMD 给 ArrayBuffer —— 两边都收。
  // 复制一份而不是就地转：`Blob` 只吃挂在 `ArrayBuffer` 上的字节，TS 5.7 起
  // `Uint8Array<ArrayBufferLike>` 直接当 BlobPart 会编译不过。
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf as unknown as ArrayBuffer);
  return new Uint8Array(src);
}

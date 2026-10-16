/**
 * 历史页多选的纯函数面（选择状态机 + 导出文本拼装）。
 *
 * 为什么单独成模块：多选的全部正确性风险都在这几行里——锚点随行筛选失效、
 * 越界点击、CSV 转义（逗号/引号/换行）与 Excel 公式注入。它们是纯变形，
 * 抽出来才能用纯 Node 测试覆盖，不必拉 DOM（docs/TESTING.md §6：不引 jsdom）。
 *
 * 状态模型：`keys` 存**行键**（groupId ?? id，与 UI 行同构），选择集合不随筛选缩水
 * （Windows 资源管理器口径：选中后再筛掉某行，它仍在集合里、仍可被删/导出）；
 * `anchor` 存**键**不存下标 —— 锚点若是下标，筛选一变就指错行。
 */

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
 *  「—」进表格是脏数据，空串才是「没这个信息」。 */
export interface CsvWork {
  title: string;
  authorName?: string;
  platformName?: string;
  kindLabel?: string;
  count: number;
  /** 原始字节数（Excel 里要的是可排序的数字，不是格式化串） */
  bytes?: number;
  createdAt: number;
  sourceUrl?: string;
  /** 落地目录（dirOf(files[0])；单元格里塞 N 条全路径没法看，「在哪」够用） */
  dir?: string;
}

/** 固定表头（顺序即列序，测试钉它防漂移） */
export const CSV_HEADER =
  "标题,作者,平台,类型,文件数,大小(字节),创建时间,分享链接,落地目录";

export function buildWorksCsv(rows: CsvWork[], fmtTime: (ts: number) => string): string {
  const line = (r: CsvWork): string =>
    [
      csvCell(r.title),
      csvCell(r.authorName ?? ""),
      csvCell(r.platformName ?? ""),
      csvCell(r.kindLabel ?? ""),
      String(r.count),
      r.bytes != null ? String(r.bytes) : "",
      csvCell(fmtTime(r.createdAt)),
      csvCell(r.sourceUrl ?? ""),
      csvCell(r.dir ?? ""),
    ].join(",");
  return [CSV_HEADER, ...rows.map(line)].join("\r\n");
}

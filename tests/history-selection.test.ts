/**
 * 历史页多选的纯函数面（renderer/src/lib/history-selection.ts）。
 * 选择状态机 + 四档导出拼装 —— 多选的全部正确性风险都在这，spec §7 的 L1 档。
 * 导出文本按 docs/TESTING.md §6 属「值得钉住的逻辑」：CSV 转义漏一个逗号，用户
 * 导出的整张表就错位，这种错在 Excel 里打开才发现，代价远高于写用例。
 */
import { describe, expect, it } from "vitest";
import type { Row, Worksheet } from "exceljs";
import {
  buildWorksCsv,
  buildWorksJson,
  buildWorksXlsx,
  clickRange,
  clickToggle,
  concatWorkInfo,
  csvCell,
  CSV_HEADER,
  EMPTY_SEL,
  EXPORT_COLUMNS,
  EXPORT_FORMATS,
  EXPORT_FORMAT_ORDER,
  headerCheckState,
  isSelected,
  reparseLinks,
  selectAllVisible,
  WORK_SEPARATOR,
} from "../renderer/src/lib/history-selection";

const V = ["a", "b", "c", "d", "e"];

/** 读回自己写的 xlsx。exceljs 既是写方也是读方，所以这条只证明「文件自洽、字段落对了格子」，
 *  **不证明真 Excel 认它** —— 那一档是 L5 人工（docs/TESTING.md），收尾要如实分开说。 */
async function readBackXlsx(bytes: Uint8Array): Promise<Worksheet> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  await wb.xlsx.load(bytes.buffer as ArrayBuffer);
  const ws = wb.getWorksheet("解析历史");
  if (!ws) throw new Error("工作表名不是「解析历史」");
  return ws;
}

const headerOf = (ws: Worksheet): string =>
  EXPORT_COLUMNS.map((_, i) => ws.getRow(1).getCell(i + 1).text).join(",");

describe("clickToggle（Ctrl/⌘+点）", () => {
  it("点一行 = 选中并立锚点；再点 = 取消", () => {
    const s1 = clickToggle(EMPTY_SEL, V, 1);
    expect(s1.keys).toEqual(["b"]);
    expect(s1.anchor).toBe("b");
    const s2 = clickToggle(s1, V, 1);
    expect(s2.keys).toEqual([]);
    expect(isSelected(s2, "b")).toBe(false);
  });

  it("越界 index（列表刚被删过一行的渲染间隙）原样返回，不崩不选", () => {
    const s = clickToggle(EMPTY_SEL, V, 99);
    expect(s).toBe(EMPTY_SEL);
  });

  it("多行累加保序（按点击序而非键序 —— 动作条计数要如实）", () => {
    let s = EMPTY_SEL;
    for (const i of [3, 0, 2]) s = clickToggle(s, V, i);
    expect(s.keys).toEqual(["d", "a", "c"]);
  });
});

describe("clickRange（Shift+点）", () => {
  it("有锚点：锚点到目标行整段并入（端点含），锚点不动", () => {
    const s0 = clickToggle(EMPTY_SEL, V, 1); // 锚点 b
    const s = clickRange(s0, V, 4);
    expect(s.keys).toEqual(["b", "c", "d", "e"]);
    expect(s.anchor).toBe("b");
  });

  it("反向范围（目标在锚点左侧）同样正确", () => {
    const s0 = clickToggle(EMPTY_SEL, V, 4); // 锚点 e
    expect(clickRange(s0, V, 2).keys).toEqual(["e", "c", "d"]);
  });

  it("无锚点（第一次就按 Shift）：只选这一行并立锚点", () => {
    const s = clickRange(EMPTY_SEL, V, 2);
    expect(s.keys).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  it("锚点被筛掉/不在可见区：退化为单选目标行，锚点保留（不猜范围）", () => {
    const s0 = { keys: ["x"], anchor: "x" };
    const s = clickRange(s0, V, 3);
    expect(s.keys).toEqual(["x", "d"]);
    expect(s.anchor).toBe("x");
  });

  it("与已选不重复累加（并集语义）", () => {
    const s0 = { keys: ["c"], anchor: "b" };
    expect(clickRange(s0, V, 4).keys).toEqual(["c", "b", "d", "e"]);
  });
});

describe("selectAllVisible（Ctrl/⌘+A）", () => {
  it("替换语义：并入既有选择会被禁止 —— 只等于可见行", () => {
    const s0 = { keys: ["gone"], anchor: "b" };
    const s = selectAllVisible(s0, V);
    expect(s.keys).toEqual(V);
    expect(s.keys).not.toContain("gone");
  });

  it("锚点保留（全选后 Shift 扩展仍以第一次点行为原点）", () => {
    expect(selectAllVisible({ keys: [], anchor: "c" }, V).anchor).toBe("c");
  });
});

describe("concatWorkInfo（txt 多条拼接）", () => {
  it("单条不加任何前后缀", () => {
    expect(concatWorkInfo(["标题：甲"])).toBe("标题：甲");
  });

  it("多条以分隔行相接（前后各一个换行，分隔行独占一行）", () => {
    expect(concatWorkInfo(["标题：甲", "标题：乙"])).toBe(`标题：甲\n${WORK_SEPARATOR}\n标题：乙`);
  });
});

describe("csvCell（RFC 4180 转义 + Excel 口径）", () => {
  it("普通值原样（不加引号 —— 表要干净可读）", () => {
    expect(csvCell("秋日穿搭")).toBe("秋日穿搭");
  });

  it("含逗号 / 引号 / 换行 → 双引号包裹，内嵌引号翻倍", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('说"不"')).toBe('"说""不"""');
    expect(csvCell("两\r\n行")).toBe('"两\r\n行"');
  });

  it("公式注入防御：= + - @ 开头的值强制成文本（标题来自平台，是不可信输入）", () => {
    // 口径：只加前缀撇号，不额外裹双引号 —— RFC 4180 里只有含逗号/引号/换行的字段才需要裹
    expect(csvCell("=HYPERLINK(...)")).toBe("'=HYPERLINK(...)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("空串落空（缺项不是「—」这种脏数据）", () => {
    expect(csvCell("")).toBe("");
  });
});

describe("buildWorksCsv（一行一作品）", () => {
  const fmt = (ts: number): string => `T${ts}`;
  const full = {
    title: "甲",
    authorName: "作者",
    platformName: "抖音",
    kindLabel: "视频",
    count: 3,
    bytes: 4096,
    createdAt: 1,
    sourceUrl: "https://x",
    dir: "C:/dl",
  };

  it("表头钉死（列序漂移会静默错列，改列必须显式改这一条）", () => {
    expect(CSV_HEADER).toBe(
      [
        "标题",
        "平台",
        "类型",
        "文件数",
        "大小(字节)",
        "发布时间",
        "解析时间",
        "分享链接",
        "落地目录",
        "作者昵称",
        "作者ID",
        "作者主页",
        "粉丝数",
        "关注数",
        "获赞数",
        "投稿数",
        "点赞",
        "转发",
        "评论",
        "收藏",
        "播放",
        "弹幕",
        "投币",
        "分享",
      ].join(",")
    );
  });

  it("行尾 CRLF（老 Excel 对裸 \\n 会挤成一行）", () => {
    const csv = buildWorksCsv([full, { ...full, title: "乙" }], fmt);
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).not.toMatch(/(?<!\r)\n/); // 行尾之外不夹裸 LF（LF 只许作为 CRLF 的后半出现）
  });

  it("数字列发原始值：count/bytes 不带格式化串，可排序", () => {
    const row = buildWorksCsv([full], fmt).split("\r\n")[1];
    expect(row).toContain("3,4096,,T1");
  });

  it("缺项留空列（每格都在自己的位置上空着，而不是整行缩水）", () => {
    const cells = buildWorksCsv([{ title: "甲", count: 1, createdAt: 9 }], fmt).split("\r\n")[1].split(",");
    expect(cells).toHaveLength(EXPORT_COLUMNS.length);
    expect(cells.filter((c) => c !== "")).toEqual(["甲", "1", "T9"]);
  });

  it("计数与两个时间各落各列：发布时间缺位留空，解析时间照旧", () => {
    const row = { title: "甲", count: 1, createdAt: 1, publishedAt: 2, stat: { view: 520000, like: 30 } };
    const cells = buildWorksCsv([row], fmt).split("\r\n")[1].split(",");
    const at = (key: string): number => EXPORT_COLUMNS.findIndex((c) => c.key === key);
    expect(cells[at("publishedAt")]).toBe("T2");
    expect(cells[at("createdAt")]).toBe("T1");
    expect(cells[at("view")]).toBe("520000");
    expect(cells[at("like")]).toBe("30");
    // 没有的档留空，不是 0 —— 「没记到」与「零个赞」是两件事
    expect(cells[at("coin")]).toBe("");
  });

  it("BOM 不在这里加（那是落盘侧的事，拼进字符串会污染首列表头）", () => {
    expect(buildWorksCsv([full], fmt)[0]).not.toBe("\uFEFF");
  });
});

describe("buildWorksJson（表格档的机器读版）", () => {
  const full = {
    title: "甲",
    authorName: "作者",
    author: { id: "9527", url: "https://douyin.com/user/9527", followerCount: 12000, videoCount: 12 },
    platformName: "抖音",
    kindLabel: "视频",
    count: 3,
    bytes: 4096,
    createdAt: 1700000000000,
    publishedAt: 1600000000000,
    stat: { view: 520000, like: 30 },
    sourceUrl: "https://x",
    dir: "C:/dl",
  };

  it("字段名是 ASCII 的列 key，不是给人看的中文表头", () => {
    const [row] = JSON.parse(buildWorksJson([full])) as Array<Record<string, unknown>>;
    expect(Object.keys(row)).toEqual(EXPORT_COLUMNS.map((c) => c.key));
  });

  it("时间是 ISO 8601（机器读的时间不该是 locale 串），数字仍是数字", () => {
    const [row] = JSON.parse(buildWorksJson([full])) as Array<Record<string, unknown>>;
    expect(row.createdAt).toBe(new Date(1700000000000).toISOString());
    expect(row.publishedAt).toBe(new Date(1600000000000).toISOString());
    expect(row.count).toBe(3);
    expect(row.bytes).toBe(4096);
    // 计数发原始数字，不缩写 —— 「1.2万」在 json 里是字符串，机器没法求和
    expect(row.view).toBe(520000);
    expect(row.followerCount).toBe(12000);
    expect(row.videoCount).toBe(12);
  });

  it("缺项是 null 不是空串（json 该能区分「没有」与「空字符串」）", () => {
    const [row] = JSON.parse(buildWorksJson([{ title: "甲", count: 1, createdAt: 0 }])) as Array<
      Record<string, unknown>
    >;
    expect(row.authorName).toBeNull();
    expect(row.bytes).toBeNull();
    expect(row.publishedAt).toBeNull();
    expect(row.view).toBeNull();
    expect(row.coin).toBeNull();
  });

  it("档位在弹窗里的顺序与文案都在这张表上（四档、后缀写进文案）", () => {
    expect(EXPORT_FORMAT_ORDER).toEqual(["xlsx", "csv", "json", "txt"]);
    expect(EXPORT_FORMAT_ORDER.map((f) => EXPORT_FORMATS[f].label)).toEqual([
      "Excel 表格（.xlsx）",
      "CSV 表格（.csv）",
      "JSON 数据（.json）",
      "作品信息文本（.txt）",
    ]);
  });
});

describe("buildWorksXlsx（真读回来：xlsx 档的唯一证据是它自己能否被解析）", () => {
  const rows = [
    {
      title: "普通标题, 带逗号",
      author: { followerCount: 12000 },
      count: 3,
      bytes: 4096,
      createdAt: 1700000000000,
      publishedAt: 1600000000000,
      stat: { view: 520000 },
      sourceUrl: "https://x",
    },
    { title: '=HYPERLINK("evil")', count: 1, createdAt: 1700000000001 },
  ];
  /** 按列 key 取格：值落在哪一列由 `EXPORT_COLUMNS` 说了算，测试不该再数一遍位置 */
  const cellOf = (row: Row, key: string): unknown =>
    row.getCell(EXPORT_COLUMNS.findIndex((c) => c.key === key) + 1).value;

  // 这两条要真写一个 xlsx 再读回来：ExcelJS 首次加载 + 落盘在并行跑全量时会轻松越过默认 5s
  // （2026-10-21 连续三次全量红在这条，单跑 2.4s）。放宽的是**等待时间**，断言一个字没动。
  it("首行表头与 CSV 同一张列表（三档漂列就是这条先红）", { timeout: 20_000 }, async () => {
    const sheet = await readBackXlsx(await buildWorksXlsx(rows));
    expect(headerOf(sheet)).toBe(CSV_HEADER);
  });

  it("数字列是数字、时间列是日期 —— 排序筛选可用是这一档存在的全部理由", { timeout: 20_000 }, async () => {
    const sheet = await readBackXlsx(await buildWorksXlsx(rows));
    const r2 = sheet.getRow(2);
    expect(cellOf(r2, "count")).toBe(3);
    expect(cellOf(r2, "bytes")).toBe(4096);
    expect(cellOf(r2, "view")).toBe(520000);
    expect(cellOf(r2, "followerCount")).toBe(12000);
    expect(cellOf(r2, "createdAt")).toBeInstanceOf(Date);
    expect(cellOf(r2, "publishedAt")).toBeInstanceOf(Date);
    // 第二行没有发布时间：留空而不是补一个 1970 的日期格
    expect(cellOf(sheet.getRow(3), "publishedAt")).toBeNull();
  });

  it("公式注入防御在 xlsx 同样成立：= 开头的标题读回来还是字符串", async () => {
    const sheet = await readBackXlsx(await buildWorksXlsx(rows));
    const title = sheet.getRow(3).getCell(1);
    expect(typeof title.value).toBe("string");
    expect(title.value).toBe('=HYPERLINK("evil")');
  });

  it("零行也能出文件（全选后又被筛空，按钮不该产出打不开的空档）", async () => {
    const bytes = await buildWorksXlsx([]);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(headerOf(await readBackXlsx(bytes))).toBe(CSV_HEADER);
  });
});

describe("headerCheckState（表头那枚全选框的三态）", () => {
  it("一条没选 = 空", () => {
    expect(headerCheckState(EMPTY_SEL, V)).toBe(false);
  });

  it("选了一部分必须是 indeterminate：画成勾，下一次点就变清空，用户以为刚才全选过", () => {
    expect(headerCheckState({ keys: ["a", "c"], anchor: "c" }, V)).toBe("indeterminate");
  });

  it("可见行全在里面 = 勾；**筛掉的**选中行不参与判断（表头只代表看得见的这些）", () => {
    expect(headerCheckState({ keys: V, anchor: "e" }, V)).toBe(true);
    expect(headerCheckState({ keys: ["a", "b", "zz"], anchor: "zz" }, ["a", "b"])).toBe(true);
    expect(headerCheckState({ keys: ["a", "b", "zz"], anchor: "zz" }, ["a", "b", "c"])).toBe("indeterminate");
  });

  it("过滤到零行时不给「全选」假象（空集不是「全选中」）", () => {
    expect(headerCheckState({ keys: ["a"], anchor: "a" }, [])).toBe(false);
  });
});

describe("reparseLinks（多选·重新解析交得出什么）", () => {
  it("缺来源链接的行跳过 —— 历史不存直链，分享链接是唯一入口", () => {
    expect(reparseLinks([{ sourceUrl: "u1" }, {}, { sourceUrl: "" }, { sourceUrl: "u2" }])).toEqual(["u1", "u2"]);
  });

  it("保行序（送进首页的顺序就是列表里的顺序，多条时结果卡对得上）", () => {
    expect(reparseLinks([{ sourceUrl: "b" }, { sourceUrl: "a" }])).toEqual(["b", "a"]);
    expect(reparseLinks([])).toEqual([]);
  });
});

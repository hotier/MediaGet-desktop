/**
 * 历史页多选的纯函数面（renderer/src/lib/history-selection.ts）。
 * 选择状态机 + CSV/txt 导出拼装 —— 多选的全部正确性风险都在这，spec §7 的 L1 档。
 * 导出文本按 docs/TESTING.md §6 属「值得钉住的逻辑」：CSV 转义漏一个逗号，用户
 * 导出的整张表就错位，这种错在 Excel 里打开才发现，代价远高于写用例。
 */
import { describe, expect, it } from "vitest";
import {
  buildWorksCsv,
  clickRange,
  clickToggle,
  concatWorkInfo,
  csvCell,
  CSV_HEADER,
  EMPTY_SEL,
  isSelected,
  selectAllVisible,
  WORK_SEPARATOR,
} from "../renderer/src/lib/history-selection";

const V = ["a", "b", "c", "d", "e"];

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

  it("表头钉死（列序漂移会静默错列，这条必须显式改）", () => {
    expect(buildWorksCsv([], fmt)).toBe(CSV_HEADER);
  });

  it("行尾 CRLF（老 Excel 对裸 \\n 会挤成一行）", () => {
    const csv = buildWorksCsv([full, { ...full, title: "乙" }], fmt);
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).not.toMatch(/(?<!\r)\n/); // 行尾之外不夹裸 LF（LF 只许作为 CRLF 的后半出现）
  });

  it("数字列发原始值：count/bytes 不带格式化串，可排序", () => {
    const row = buildWorksCsv([full], fmt).split("\r\n")[1];
    expect(row).toContain("3,4096,T1");
  });

  it("缺项留空列（bytes 无、作者无 → 两个空字段仍在正确位置）", () => {
    const row = buildWorksCsv(
      [{ title: "甲", count: 1, createdAt: 9, bytes: undefined, authorName: undefined }],
      fmt
    ).split("\r\n")[1];
    expect(row).toBe("甲,,,,1,,T9,,"); // 9 字段对齐表头：作者/平台/类型三格空，大小一格空，链接/目录两格空
  });

  it("BOM 不在这里加（那是落盘侧的事，拼进字符串会污染首列表头）", () => {
    expect(buildWorksCsv([full], fmt)[0]).not.toBe("\uFEFF");
  });
});

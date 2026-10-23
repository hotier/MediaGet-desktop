/**
 * 图表口径层测试（renderer/src/components/charts/options.ts + palette 的取色换算）。
 *
 * 这一层是「图上那几个数从哪来」的唯一判定点，纯函数所以能在 node 环境整份测掉 ——
 * 起 canvas 只能证明「画出来了」，证明不了「趋势单位是否一致」「条长是份额不是实际数」。
 * 守的四条：
 * - **条长 ≠ 数值**：榜单的 data 必须是 `share`，实际数只出现在标签文本里。写成 value 的话
 *   第一名永远满格，读者会把「占 63%」看成「占 100%」。
 * - **色值不从代码来**：option 里每一处颜色都必须等于注入的 palette 字段，
 *   这样「hex 只活在 styles.css 层 1」在 canvas 侧也没有破口。
 * - **除零不猜**：全零的热力图 visualMap.max 要顶到 1（0/0 会让色阶塌成一片），
 *   空榜单的 series 是空数组而不是「画一根 0 长的条」。
 * - **tooltip 回的是自己的数组**： formatter 只取 dataIndex，不读 ECharts 加工过的 value。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dayHeatOption,
  donutOption,
  heatOption,
  histogramOption,
  rankHeight,
  rankOption,
  trendOption,
  type RankDatum,
} from "../renderer/src/components/charts/options";
import { withAlpha, type ChartPalette } from "../renderer/src/components/charts/palette";
import { fmtDuration, fmtPercent, fmtSpeed } from "../renderer/src/lib/format";
import type { SizeBucket, TrendCell, TrendPoint } from "../renderer/src/lib/stats";

/** 每个字段一眼可辨的假色板：断言「这里用的是 primary」才有意义，全用 #fff 就只是比长度 */
const P: ChartPalette = {
  text: "rgb(10, 10, 10)",
  textMuted: "rgb(20, 20, 20)",
  primary: "rgb(30, 30, 30)",
  ok: "rgb(40, 40, 40)",
  warn: "rgb(50, 50, 50)",
  err: "rgb(60, 60, 60)",
  info: "rgb(70, 70, 70)",
  line: "rgb(80, 80, 80)",
  surface: "rgb(90, 90, 90)",
  sunken: "rgb(100, 100, 100)",
  font: "TestFont, sans-serif",
  fontSize: 13,
  ramp: ["rgba(30, 30, 30, 0.16)", "rgba(30, 30, 30, 1)"],
};

/**
 * 沿路径下钻 option：EChartsOption 是巨大的 union 类型，`option.series[0].data` 这种写法
 * 要一路 as 才能编译过。测试要的是「这个位置有没有这个值」，unknown 逐跳比断言链更诚实 ——
 * 路径写错就得到 undefined，断言随即失败，而不是编译期替我猜一个形状。
 */
function pick(option: unknown, ...path: Array<string | number>): unknown {
  return path.reduce<unknown>((cur, key) => {
    if (typeof key === "number") return Array.isArray(cur) ? cur[key] : undefined;
    if (cur && typeof cur === "object") return (cur as Record<string, unknown>)[key];
    return undefined;
  }, option);
}

/** tooltip / label 回调：数组入参 = trigger:"axis"，对象入参 = trigger:"item" */
const at = (fn: unknown, index: number, group = true): string => {
  expect(typeof fn).toBe("function");
  const call = fn as (p: unknown) => string;
  return group ? call([{ dataIndex: index }]) : call({ dataIndex: index });
};

const trend = (): TrendPoint[] => [
  { key: "2026-10-15", label: "10-15", downloads: 2, failures: 1, bytes: 1024, parses: 3 },
  { key: "2026-10-16", label: "10-16", downloads: 4, failures: 0, bytes: 2048, parses: 0 },
];

const rows: RankDatum[] = [
  { label: "bilibili", value: 63, share: 0.63, note: "失败率 4%" },
  { label: "xiaohongshu", value: 37, share: 0.37 },
];

describe("withAlpha", () => {
  it("认 Chrome 算完的 rgb()（空格与逗号两种分隔都收）", () => {
    expect(withAlpha("rgb(19 20 26)", 0.5)).toBe("rgba(19, 20, 26, 0.5)");
    expect(withAlpha("rgb(19, 20, 26)", 0.16)).toBe("rgba(19, 20, 26, 0.16)");
  });

  it("已带 alpha 的斜杠语法也拆得开", () => {
    expect(withAlpha("rgb(19 20 26 / 0.8)", 0.3)).toBe("rgba(19, 20, 26, 0.3)");
  });

  it("认不出来就原样返回，绝不抹一片 NaN 色", () => {
    expect(withAlpha("color-mix(in oklab, red 40%, transparent)", 0.5)).toBe(
      "color-mix(in oklab, red 40%, transparent)"
    );
    expect(withAlpha("red", 0.5)).toBe("red");
    expect(withAlpha("rgb(19 20)", 0.5)).toBe("rgb(19 20)");
    expect(withAlpha("rgb(a b c)", 0.5)).toBe("rgb(a b c)");
  });

  it("色阶由浅到深，末档是不透明的 primary", () => {
    const ramp = [0.16, 0.34, 0.54, 0.74, 1].map((a) => withAlpha("rgb(30 30 30)", a));
    expect(ramp[0]).toBe("rgba(30, 30, 30, 0.16)");
    expect(ramp.at(-1)).toBe("rgba(30, 30, 30, 1)");
  });
});

describe("比率与时长格式化", () => {
  it("null 是「不知道」，渲染成破折号而不是 0%", () => {
    expect(fmtPercent(null)).toBe("—");
    expect(fmtDuration(null)).toBe("—");
    expect(fmtSpeed(null)).toBe("—");
    expect(fmtSpeed(0)).toBe("—");
  });

  it("比率默认整数档，第二参给小数", () => {
    expect(fmtPercent(0.634)).toBe("63%");
    expect(fmtPercent(0.634, 1)).toBe("63.4%");
    expect(fmtPercent(0)).toBe("0%");
  });

  it("毫秒以下不带小数，秒级一位", () => {
    expect(fmtDuration(820)).toBe("820 ms");
    expect(fmtDuration(1000)).toBe("1.0s");
    expect(fmtDuration(1500)).toBe("1.5s");
  });

  it("速度带 /s 后缀并复用体积口径", () => {
    expect(fmtSpeed(1024 * 1024)).toBe("1.0 MB/s");
  });
});

describe("trendOption", () => {
  it("次数档用同轴柱状区分完成与失败（业主 2026-10-23 折线改柱）", () => {
    const o = trendOption(trend(), P, "downloads");
    expect(pick(o, "series", 0, "name")).toBe("完成");
    expect(pick(o, "series", 0, "data")).toEqual([2, 4]);
    expect(pick(o, "series", 0, "itemStyle", "color")).toBe(P.ok);
    expect(pick(o, "series", 0, "type")).toBe("bar");
    expect(pick(o, "series", 1, "type")).toBe("bar");
    expect(pick(o, "series", 1, "data")).toEqual([1, 0]);
    expect(pick(o, "series", 1, "itemStyle", "color")).toBe(P.err);
    expect(pick(o, "yAxis", "minInterval")).toBe(1);
    expect(pick(o, "legend", "data")).toEqual(["完成", "失败"]);
  });

  it("字节档只画字节，不把失败次数放到不同单位的坐标上", () => {
    const o = trendOption(trend(), P, "bytes");
    expect(pick(o, "series", 0, "name")).toBe("字节");
    expect(pick(o, "series", 0, "data")).toEqual([1024, 2048]);
    expect(pick(o, "series")).toHaveLength(1);
    expect(pick(o, "legend", "data")).toEqual(["字节"]);
  });

  it("均值线跟当前主指标同量纲：完成资源日均 3，字节日均 1536", () => {
    expect(pick(trendOption(trend(), P, "downloads"), "series", 0, "markLine", "data", 0, "yAxis")).toBe(3);
    expect(pick(trendOption(trend(), P, "bytes"), "series", 0, "markLine", "data", 0, "yAxis")).toBe(1536);
  });

  it("均值标签是格式化后的文本，不是裸数字", () => {
    const label = pick(trendOption(trend(), P, "bytes"), "series", 0, "markLine", "label", "formatter");
    expect(label).toBe("日均 1.5 KB");
  });

  it("空序列不除零：均值为 0 而不是 NaN", () => {
    const o = trendOption([], P, "downloads");
    expect(pick(o, "series", 0, "markLine", "data", 0, "yAxis")).toBe(0);
    expect(pick(o, "series", 0, "data")).toEqual([]);
  });

  it("坐标轴刻度一律锁整数：字节档也不许冒出小数刻度", () => {
    expect(pick(trendOption(trend(), P, "downloads"), "yAxis", "minInterval")).toBe(1);
    // 撤成自动（undefined）时全 0 的轴会给出 0.2 / 0.8 刻度，字节轴渲染成「204.8 undefined」（2026-10-23 实测）
    expect(pick(trendOption(trend(), P, "bytes"), "yAxis", "minInterval")).toBe(1);
  });

  it("axis tooltip 按 dataIndex 回自己的数组，把四项都列出来", () => {
    const fmt = pick(trendOption(trend(), P, "downloads"), "tooltip", "formatter");
    expect(at(fmt, 0)).toBe("2026-10-15<br/>下载 2 · 字节 1.0 KB<br/>失败 1 · 解析 3");
    expect(at(fmt, 1)).toContain("下载 4");
    expect(at(fmt, 9)).toBe("");
  });

  it("字体与字号来自 palette（界面设置同源）", () => {
    const o = trendOption(trend(), P, "downloads");
    expect(pick(o, "textStyle", "fontFamily")).toBe(P.font);
    expect(pick(o, "textStyle", "fontSize")).toBe(P.fontSize);
    expect(pick(o, "xAxis", "axisLabel", "fontSize")).toBe(P.fontSize - 1);
  });
});

describe("dayHeatOption 的空白格（业主 2026-10-23：没有数据的天也要出方框）", () => {
  const cells: TrendCell[] = [
    { key: "2026-10-20", label: "10-20", downloads: 0, failures: 0, bytes: 0, parses: 0, missing: true },
    { key: "2026-10-21", label: "10-21", downloads: 0, failures: 0, bytes: 0, parses: 0 },
  ];

  it("覆盖起点前与当天零值都占一格：绘图值落 0，不留 null", () => {
    const o = dayHeatOption(cells, P, "downloads");
    expect(pick(o, "series", 0, "data")).toHaveLength(2);
    expect(pick(o, "series", 0, "data", 0, 2)).toBe(0);
    expect(pick(o, "series", 0, "data", 1, 2)).toBe(0);
  });

  it("空格是单独一段中性灰，有账才进色阶（业主 2026-10-23：灰色才分得开）", () => {
    const o = dayHeatOption(cells, P, "downloads");
    // heatmap 必须挂 visualMap（撤掉 ECharts 抛 "Heatmap must use with visualMap"）；
    // 分段型才能把 0 单独染灰 —— 连续型会把 0 clamp 成色阶最浅档，又变浅蓝
    expect(pick(o, "visualMap", "type")).toBe("piecewise");
    expect(pick(o, "visualMap", "show")).toBe(false);
    expect(pick(o, "visualMap", "pieces", 0)).toEqual({ value: 0, color: P.sunken });
  });

  it("有账的格子按当前范围分档，最大值落最深一档且 1..max 无空档", () => {
    const pts: TrendCell[] = [
      { key: "2026-10-21", label: "10-21", downloads: 4, failures: 0, bytes: 0, parses: 0 },
    ];
    const pieces = pick(dayHeatOption(pts, P, "downloads"), "visualMap", "pieces") as Array<{
      min?: number;
      max?: number;
      color: string;
    }>;
    // P.ramp 两档、max=4 → 段宽 ceil(4/2)=2：1..2 首档、3..4 末档
    expect(pieces.slice(1)).toEqual([
      { min: 1, max: 2, color: P.ramp[0] },
      { min: 3, max: 4, color: P.ramp[1] },
    ]);
  });

  it("tooltip 仍分得清「暂无记录」与「0 个资源」", () => {
    const fmt = pick(dayHeatOption(cells, P, "downloads"), "tooltip", "formatter");
    expect(at(fmt, 0, false)).toContain("暂无记录");
    expect(at(fmt, 1, false)).toContain("0 个资源");
  });
});

describe("rankOption", () => {
  const fmt = (n: number): string => String(n);

  it("条长是份额，实际数只在标签文本里", () => {
    const o = rankOption(rows, P, fmt);
    expect(pick(o, "series", 0, "data")).toEqual([0.63, 0.37]);
    expect(pick(o, "yAxis", "data")).toEqual(["bilibili", "xiaohongshu"]);
    expect(pick(o, "yAxis", "inverse")).toBe(true);
    expect(pick(o, "series", 0, "showBackground")).toBe(true);
    expect(pick(o, "series", 0, "backgroundStyle", "color")).toBe(P.sunken);
  });

  it("数值轴整条隐藏、上界锁 1：长度已经说了份额，刻度只是重复一遍", () => {
    const o = rankOption(rows, P, fmt);
    expect(pick(o, "xAxis", "show")).toBe(false);
    expect(pick(o, "xAxis", "max")).toBe(1);
    expect(pick(o, "xAxis", "axisLabel", "show")).toBe(false);
  });

  it("标签常显「数 · 份额」", () => {
    const label = pick(rankOption(rows, P, fmt), "series", 0, "label", "formatter");
    expect(at(label, 0, false)).toBe("63 · 63%");
    expect(at(label, 1, false)).toBe("37 · 37%");
    expect(at(label, 8, false)).toBe("");
  });

  it("tooltip 带份额（一位小数）与补句，没补句就不占行", () => {
    const tip = pick(rankOption(rows, P, fmt), "tooltip", "formatter");
    expect(at(tip, 0, false)).toBe("bilibili<br/>63 · 份额 63.0%<br/>失败率 4%");
    expect(at(tip, 1, false)).toBe("xiaohongshu<br/>37 · 份额 37.0%");
  });

  it("空榜单 series 是空数组，而不是画一根 0 长的条", () => {
    expect(pick(rankOption([], P, fmt), "series")).toEqual([]);
  });

  it("图高随行数伸缩但有下限：卡片高度不该随数据跳动", () => {
    expect(rankHeight(0)).toBe(56);
    expect(rankHeight(2)).toBe(60);
    expect(rankHeight(10)).toBe(268);
  });
});

describe("donutOption", () => {
  it("用空心环表达占比，中心常显合计，tooltip 说明每类数量和份额", () => {
    const o = donutOption(rows, P, String);
    expect(pick(o, "series", 0, "type")).toBe("pie");
    expect(pick(o, "series", 0, "radius")).toEqual(["62%", "82%"]);
    expect(pick(o, "series", 0, "data")).toEqual([
      { name: "bilibili", value: 63, itemStyle: { color: P.primary } },
      { name: "xiaohongshu", value: 37, itemStyle: { color: P.ok } },
    ]);
    expect(at(pick(o, "tooltip", "formatter"), 0, false)).toBe("bilibili<br/>63 · 63.0%");
  });

  it("空数据不给出假环形段", () => {
    expect(pick(donutOption([], P, String), "series")).toEqual([]);
  });
});

describe("heatOption", () => {
  const cells = (set: Record<string, number>): number[] => {
    const arr = new Array<number>(168).fill(0);
    for (const [k, v] of Object.entries(set)) arr[Number(k)] = v;
    return arr;
  };

  it("摊成 7×24=168 格，坐标是 [小时, 星期, 次数]", () => {
    const o = heatOption(cells({ 0: 5 }), P);
    const data = pick(o, "series", 0, "data") as [number, number, number][];
    expect(data).toHaveLength(168);
    expect(data[0]).toEqual([0, 0, 5]);
    expect(data[1]).toEqual([1, 0, 0]);
    expect(data[26]).toEqual([2, 1, 0]);
    expect(pick(o, "series", 0, "type")).toBe("heatmap");
  });

  it("全零时色阶上界顶到 1：0/0 会让 visualMap 塌成一片", () => {
    expect(pick(heatOption(cells({}), P), "visualMap", "max")).toBe(1);
    expect(pick(heatOption(cells({ 3: 7 }), P), "visualMap", "max")).toBe(7);
  });

  it("visualMap 只借换算不卖控件（不做仪表盘）", () => {
    const o = heatOption(cells({}), P);
    expect(pick(o, "visualMap", "show")).toBe(false);
    expect(pick(o, "visualMap", "inRange", "color")).toBe(P.ramp);
  });

  it("tooltip 说清「周几几点 · 几次」", () => {
    const arr = new Array<number>(168).fill(0);
    arr[3 * 24 + 21] = 12; // 周三 21:00
    const tip = pick(heatOption(arr, P), "tooltip", "formatter");
    expect(at(tip, 93, false)).toBe("周三 21:00 · 12 次");
    expect(at(tip, 0, false)).toBe("周日 00:00 · 0 次");
  });

  it("格子描边用的是所在卡底色，于是格间是缝而不是线", () => {
    expect(pick(heatOption(cells({}), P), "series", 0, "itemStyle", "borderColor")).toBe(P.surface);
  });
});

/**
 * 图表适配器的源码纪律（不进 option，只管「这个目录怎么写」）。
 * 三条都是 UIUX §9.2/§9.3 已经写进文档的承诺，落成断言才不会靠后来的人记得读文档：
 * - echarts 只许在 `echarts-core.ts` 一处 import：别处 `import "echarts"` 会把全量 1.10 MB 拉回启动面；
 * - v6 把 `grid.containLabel` 挪进 opt-in 兼容件，漏登记不报错、只把类目名裁掉（真窗口踩过）；
 * - 色值一律来自 palette 探针：图表代码里出现 hex 字面量就等于在 canvas 侧开了第二条色板。
 */
describe("图表适配器纪律", () => {
  const dir = "../renderer/src/components/charts";
  const files = readdirSync(fileURLToPath(new URL(dir, import.meta.url))).filter((f) => /\.(ts|tsx)$/.test(f));
  const source = Object.fromEntries(
    files.map((f) => [f, readFileSync(fileURLToPath(new URL(`${dir}/${f}`, import.meta.url)), "utf8").replace(/\/\*[^]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")])
  );

  /** 运行时 import 才算把 echarts 拉进 bundle；`import type { EChartsOption }` 编译后不存在，放行 */
  const runtimeEchartsImport = (src: string): boolean =>
    /from "echarts/.test(src.replace(/import\s+type\s+[\s\S]*?from\s+"echarts[^"]*";/g, ""));

  it("echarts 只在 echarts-core.ts 登记", () => {
    const importers = files.filter((f) => runtimeEchartsImport(source[f]));
    expect(importers).toEqual(["echarts-core.ts"]);
  });

  it("containLabel 的 v6 兼容件已登记（否则类目标签被裁且不报错）", () => {
    expect(source["echarts-core.ts"]).toMatch(/LegacyGridContainLabel/);
  });

  it("目录内不写 hex 色值", () => {
    const offenders = files.filter((f) => /#[0-9a-fA-F]{3,8}\b/.test(source[f]));
    expect(offenders).toEqual([]);
  });
});

describe("histogramOption", () => {
  const buckets: SizeBucket[] = [
    { label: "< 10 MB", from: 0, to: 10, count: 12, share: 0.6 },
    { label: "10–50 MB", from: 10, to: 50, count: 8, share: 0.4 },
  ];

  it("柱高是文件个数，标签是份额", () => {
    const o = histogramOption(buckets, P);
    expect(pick(o, "series", 0, "data")).toEqual([12, 8]);
    expect(pick(o, "xAxis", "data")).toEqual(["< 10 MB", "10–50 MB"]);
    expect(pick(o, "xAxis", "axisLabel", "interval")).toBe(0);
    const label = pick(o, "series", 0, "label", "formatter");
    expect(at(label, 0, false)).toBe("60%");
    expect(at(label, 1, false)).toBe("40%");
  });

  it("空档表不炸：标签越界回空串", () => {
    const label = pick(histogramOption([], P), "series", 0, "label", "formatter");
    expect(at(label, 0, false)).toBe("");
    expect(pick(histogramOption([], P), "series", 0, "data")).toEqual([]);
  });

  it("axis tooltip 说明分母是「占有字节记录」的行数", () => {
    const tip = pick(histogramOption(buckets, P), "tooltip", "formatter");
    expect(at(tip, 0)).toBe("< 10 MB<br/>12 个文件 · 占有字节记录 60.0%");
  });
});

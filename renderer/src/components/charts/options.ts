/**
 * 图表口径层：把聚合结果换成 ECharts option。纯函数、不碰 DOM、不读色板 ——
 * 色板由调用方（页面）注入，所以这一层能在 node 环境里整份测掉，
 * 而不必为了验证「失败率有没有算进图里」去起一个 canvas。
 *
 * 三条一直守着的规矩：
 * 1. **数值常显**。业主口径「指标不用仪表盘」：数直接跟在图上，不做「悬浮才知道」的图。
 *    因此条形榜的标签始终打开，只有密度真撑不住的趋势图例外（365 根柱贴不下 365 个数），
 *    那种情况把合计写在卡片标题右边。
 * 2. **坐标轴不是信息载体**。榜单的数值轴整条隐藏：长度已经表达了份额，轴刻度只会重复一遍。
 * 3. **除零不猜**。份额为 0 就画 0 长的条；比率为 null 就写「—」，不写成 0%。
 */
import type { EChartsOption } from "echarts";
import { fmtBytes, fmtCount, fmtPercent } from "../../lib/format";
import { WEEKDAYS, heatSlotLabel, type SizeBucket, type TrendPoint } from "../../lib/stats";
import type { ChartPalette } from "./palette";

/** 榜单行：`value` 是实际数（写进标签），`share` 是条长（0..1） */
export interface RankDatum {
  label: string;
  value: number;
  share: number;
  /** tooltip 里补的一句（失败率、作品数之类），没有就不占行 */
  note?: string;
}

export type TrendMetric = "downloads" | "bytes";

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

const frame = (p: ChartPalette) => ({
  // 一次性入场动效（统计页不是进度热路径）；字号与字体族跟界面设置同源
  animationDuration: 260,
  textStyle: { fontFamily: p.font, fontSize: p.fontSize, color: p.text },
});

const tip = (p: ChartPalette) => ({
  backgroundColor: p.surface,
  borderColor: p.line,
  borderWidth: 1,
  padding: [6, 9] as [number, number],
  textStyle: { color: p.text, fontSize: p.fontSize },
  extraCssText: "border-radius:8px;box-shadow:none",
});

/** 数值轴：整数刻度（`minInterval`）是硬要求 —— 「1.5 次下载」这种刻度是把数据讲坏了 */
const valueAxis = (p: ChartPalette, over: Record<string, unknown> = {}) => ({
  type: "value" as const,
  minInterval: 1,
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: p.textMuted, fontSize: p.fontSize - 1 },
  splitLine: { lineStyle: { color: p.line, type: "dashed" as const, opacity: 0.6 } },
  ...over,
});

const categoryAxis = (p: ChartPalette, over: Record<string, unknown> = {}) => ({
  type: "category" as const,
  axisLine: { lineStyle: { color: p.line } },
  axisTick: { show: false },
  axisLabel: { color: p.textMuted, fontSize: p.fontSize - 1 },
  ...over,
});

const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);

/**
 * tooltip 回调的入参在 `trigger:"item"` 时是单个、`"axis"` 时是数组，而三种情况要的都只是
 * 「落在第几行」。统一从这里取索引再回自己的数组拿数 —— 不读 `params.value`：
 * 那是 ECharts 加工过的显示值（会带 axis 格式化），拿它再格式化一次会把口径绕回悬浮层里。
 * 结构类型而非 ECharts 的导出名：包把 `types` 指到 `.cts`，那几个 params 类型不在公共出口上，
 * 我们只需要 `dataIndex` 这一个字段，自己声明比依赖它的内部命名更稳。
 */
type RowIndexParam = { dataIndex: number } | { dataIndex: number }[];
const rowIndexOf = (params: RowIndexParam): number =>
  (Array.isArray(params) ? params[0] : params).dataIndex;

/**
 * 趋势：柱 = 当日量（次数或字节），折线 = 当日失败次数（右轴，整数）。
 * 失败次数与失败率选前者：小样本日的比率会把 1/1 画成 100%，看着像崩盘；
 * 次数配上柱子的相对高度，才能一眼分清「这天真炸了」和「这天只下了一条」。
 */
export function trendOption(points: TrendPoint[], p: ChartPalette, metric: TrendMetric): EChartsOption {
  const bytes = metric === "bytes";
  const bars = points.map((pt) => (bytes ? pt.bytes : pt.downloads));
  const fmt = bytes ? fmtBytes : fmtCount;
  const avg = points.length > 0 ? sum(bars) / points.length : 0;
  return {
    ...frame(p),
    grid: { left: 4, right: 4, top: 30, bottom: 0, containLabel: true },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 10,
      icon: "roundRect",
      textStyle: { color: p.textMuted, fontSize: p.fontSize - 1 },
      data: [bytes ? "字节" : "次数", "失败"],
    },
    tooltip: {
      trigger: "axis",
      ...tip(p),
      formatter: (params) => {
        const pt = points[rowIndexOf(params)];
        if (!pt) return "";
        return [
          pt.key,
          `下载 ${fmtCount(pt.downloads)} · 字节 ${fmtBytes(pt.bytes)}`,
          `失败 ${fmtCount(pt.failures)} · 解析 ${fmtCount(pt.parses)}`,
        ].join("<br/>");
      },
    },
    xAxis: categoryAxis(p, { data: points.map((pt) => pt.label), axisLabel: { color: p.textMuted, fontSize: p.fontSize - 1, hideOverlap: true } }),
    yAxis: [
      valueAxis(p, {
        axisLabel: { color: p.textMuted, fontSize: p.fontSize - 1, formatter: (v: number) => fmt(v) },
        // 字节档不是整数语义：minInterval 得撤成自动，否则「至少隔 1 才一格」会把 KB 轴顶成无意义的小整数分档
        ...(bytes ? { minInterval: undefined } : {}),
      }),
      valueAxis(p, {
        position: "right",
        splitLine: { show: false },
        axisLabel: { color: p.err, fontSize: p.fontSize - 1 },
      }),
    ],
    series: [
      {
        name: bytes ? "字节" : "次数",
        type: "bar",
        data: bars,
        barMaxWidth: 26,
        itemStyle: { color: p.primary, borderRadius: [3, 3, 0, 0] },
        markLine: {
          symbol: "none",
          silent: true,
          lineStyle: { color: p.textMuted, type: "dotted" as const },
          label: { color: p.textMuted, fontSize: p.fontSize - 1, formatter: `均值 ${fmt(avg)}` },
          data: [{ yAxis: avg }],
        },
      },
      {
        name: "失败",
        type: "line",
        yAxisIndex: 1,
        data: points.map((pt) => pt.failures),
        symbol: "circle",
        symbolSize: 4,
        lineStyle: { color: p.err, width: 1.5 },
        itemStyle: { color: p.err },
      },
    ],
  };
}

/**
 * 横向榜：条长 = 全局份额（所以第一名不必然是满格，份额 60% 就只画 60%），
 * 条右常显「实际数 · 份额」。类目名截断交给 axisLabel 的 width + truncate：
 * 作者昵称能长到 20 字，不锁宽度会把整张图挤成一条缝。
 */
export function rankOption(rows: RankDatum[], p: ChartPalette, fmt: (n: number) => string): EChartsOption {
  const labelAt = (i: number): string => {
    const r = rows[i];
    return r ? `${fmt(r.value)} · ${fmtPercent(r.share)}` : "";
  };
  return {
    ...frame(p),
    grid: { left: 4, right: 96, top: 4, bottom: 0, containLabel: true },
    tooltip: {
      trigger: "item",
      ...tip(p),
      formatter: (params) => {
        const r = rows[rowIndexOf(params)];
        if (!r) return "";
        return [r.label, `${fmt(r.value)} · 份额 ${fmtPercent(r.share, 1)}`, r.note ?? ""].filter(Boolean).join("<br/>");
      },
    },
    xAxis: { ...valueAxis(p), show: false, max: 1, splitLine: { show: false }, axisLabel: { show: false } },
    yAxis: categoryAxis(p, {
      inverse: true,
      data: rows.map((r) => r.label),
      axisLine: { show: false },
      axisLabel: { color: p.text, fontSize: p.fontSize - 1, width: 88, overflow: "truncate" },
      splitLine: { show: false },
    }),
    series: rows.length
      ? [
          {
            type: "bar" as const,
            data: rows.map((r) => r.share),
            barWidth: "58%",
            showBackground: true,
            backgroundStyle: { color: p.sunken, borderRadius: 4 },
            itemStyle: { color: p.primary, borderRadius: 4 },
            label: {
              show: true,
              position: "right" as const,
              color: p.textMuted,
              fontSize: p.fontSize - 1,
              formatter: (pr: { dataIndex: number }) => labelAt(pr.dataIndex),
            },
          },
        ]
      : [],
  };
}

/** 一行的固定高度：条形榜的图高由行数决定，卡片高度才不会随数据跳动 */
export const rankHeight = (rows: number): number => Math.max(56, rows * 26 + 8);

/**
 * 星期 × 小时活跃热力。色阶用 primary 的透明度阶梯（`palette.ramp`）走 visualMap 映射，
 * 但 visualMap 本体 `show:false` —— 只借它的数值→色阶换算，不卖它的滑块控件（业主口径：不做仪表盘）。
 */
export function heatOption(cells: number[], p: ChartPalette): EChartsOption {
  const max = Math.max(1, ...cells);
  const data: [number, number, number][] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      data.push([h, d, cells[d * 24 + h] ?? 0]);
    }
  }
  return {
    ...frame(p),
    grid: { left: 4, right: 4, top: 6, bottom: 0, containLabel: true },
    tooltip: {
      trigger: "item",
      ...tip(p),
      formatter: (params) => {
        const cell = data[rowIndexOf(params)];
        if (!cell) return "";
        return `${heatSlotLabel(cell[1], cell[0])} · ${fmtCount(cell[2])} 次`;
      },
    },
    visualMap: {
      show: false,
      type: "continuous",
      min: 0,
      max,
      inRange: { color: p.ramp },
    },
    xAxis: categoryAxis(p, {
      data: HOUR_LABELS,
      splitArea: { show: false },
      axisLabel: { color: p.textMuted, fontSize: p.fontSize - 2, interval: 1 },
    }),
    yAxis: categoryAxis(p, {
      inverse: true,
      data: [...WEEKDAYS],
      axisLine: { show: false },
      splitLine: { show: false },
    }),
    series: [
      {
        type: "heatmap" as const,
        data,
        itemStyle: { borderColor: p.surface, borderWidth: 1, borderRadius: 2 },
        emphasis: { itemStyle: { shadowBlur: 0, borderColor: p.textMuted } },
      },
    ],
  };
}

/** 单文件体积分布：档位边界固定（跨版本可比），标签常显份额 */
export function histogramOption(buckets: SizeBucket[], p: ChartPalette): EChartsOption {
  return {
    ...frame(p),
    grid: { left: 4, right: 4, top: 22, bottom: 0, containLabel: true },
    tooltip: {
      trigger: "axis",
      ...tip(p),
      axisPointer: { type: "shadow" },
      formatter: (params) => {
        const b = buckets[rowIndexOf(params)];
        if (!b) return "";
        return `${b.label}<br/>${fmtCount(b.count)} 个文件 · 占有字节记录 ${fmtPercent(b.share, 1)}`;
      },
    },
    xAxis: categoryAxis(p, {
      data: buckets.map((b) => b.label),
      axisLabel: { color: p.textMuted, fontSize: p.fontSize - 1, interval: 0, width: 60, overflow: "break" },
    }),
    yAxis: valueAxis(p),
    series: [
      {
        type: "bar" as const,
        data: buckets.map((b) => b.count),
        barMaxWidth: 34,
        itemStyle: { color: p.primary, borderRadius: [3, 3, 0, 0] },
        label: {
          show: true,
          position: "top" as const,
          color: p.textMuted,
          fontSize: p.fontSize - 1,
          formatter: (pr: { dataIndex: number }) =>
            buckets[pr.dataIndex] ? fmtPercent(buckets[pr.dataIndex].share) : "",
        },
      },
    ],
  };
}

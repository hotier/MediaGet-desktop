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
import { WEEKDAYS, heatSlotLabel, type SizeBucket, type TrendCell, type TrendPoint } from "../../lib/stats";
import type { ChartPalette } from "./palette";

/** 榜单行：`value` 是实际数（写进标签），`share` 是条长（0..1） */
export interface RankDatum {
  label: string;
  value: number;
  share: number;
  /** tooltip 里补的一句（失败率、作品数之类），没有就不占行 */
  note?: string;
}

export type TrendMetric = "downloads" | "parses" | "bytes";

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
 * 按日趋势用柱状呈现（业主 2026-10-23：由折线改柱）。每天的量是各自独立的账，
 * 柱高比折线落差更好读、也不靠连线去暗示「中间那天存在」——缺口径的日子就该是空柱。
 * 失败只属于下载账，解析次数单独切换展示。
 */
export function trendOption(points: TrendPoint[], p: ChartPalette, metric: TrendMetric): EChartsOption {
  const bytes = metric === "bytes";
  const values = points.map((pt) => (bytes ? pt.bytes : metric === "parses" ? pt.parses : pt.downloads));
  const fmt = bytes ? fmtBytes : fmtCount;
  const failures = points.map((pt) => pt.failures);
  const avg = points.length > 0 ? sum(values) / points.length : 0;
  const primaryName = bytes ? "字节" : metric === "parses" ? "解析请求" : "完成";
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
      data: metric === "downloads" ? ["完成", "失败"] : [primaryName],
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
    // 三档统一锁整数刻度：字节也是整数语义，撤掉 `minInterval` 会让全 0 的轴冒出
    // 0.2 / 0.4 / 0.8 这类小数刻度，字节轴因此显示成「204.8 undefined」（2026-10-23 实测）。
    yAxis: valueAxis(p, {
      axisLabel: { color: p.textMuted, fontSize: p.fontSize - 1, formatter: (v: number) => fmt(v) },
    }),
    series: [
      {
        name: primaryName,
        type: "bar" as const,
        data: values,
        // 柱宽封顶：跨度短（7 天）时不至于胖成方块，长（365 天）时由 ECharts 自己收细
        barMaxWidth: 18,
        itemStyle: { color: bytes || metric === "parses" ? p.primary : p.ok, borderRadius: 4 },
        markLine: {
          symbol: "none",
          silent: true,
          lineStyle: { color: p.textMuted, type: "dotted" as const },
          label: { color: p.textMuted, fontSize: p.fontSize - 1, formatter: `日均 ${fmt(bytes ? avg : Math.round(avg * 10) / 10)}` },
          data: [{ yAxis: avg }],
        },
      },
      ...(metric === "downloads"
        ? [{
            name: "失败",
            type: "bar" as const,
            data: failures,
            barMaxWidth: 18,
            itemStyle: { color: p.err, borderRadius: 4 },
          }]
        : []),
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

/** 部分与整体的关系用空心环表达，中心常显总量，分类数值由相邻列表完整呈现。 */
export function donutOption(
  rows: RankDatum[],
  p: ChartPalette,
  fmt: (n: number) => string,
  colors: string[] = [p.primary, p.ok, p.info, p.warn, p.err]
): EChartsOption {
  return {
    ...frame(p),
    tooltip: {
      trigger: "item",
      ...tip(p),
      formatter: (params) => {
        const row = rows[rowIndexOf(params)];
        return row ? `${row.label}<br/>${fmt(row.value)} · ${fmtPercent(row.share, 1)}` : "";
      },
    },
    series: rows.length
      ? [{
          type: "pie",
          radius: ["62%", "82%"],
          center: ["50%", "50%"],
          startAngle: 90,
          clockwise: true,
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          emphasis: { scale: true, scaleSize: 4 },
          itemStyle: { borderColor: p.surface, borderWidth: 3, borderRadius: 3 },
          data: rows.map((row, index) => ({ name: row.label, value: row.value, itemStyle: { color: colors[index % colors.length] } })),
        }]
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

/**
 * 日历热力图：每个格子对应一个自然日，整年逐日出格。
 *
 * 没有账的日子（含覆盖起点之前的 `missing`）**也画方框**（业主 2026-10-23）：热力图读的是
 * 「一年 365 格的矩阵」，空着不画会让最近几天看起来像凭空浮在坐标里，也分不出「那天没有下载」
 * 与「那格根本不存在」。绘图值统一落 0 并走 visualMap 的 `outOfRange`（中性灰），
 * tooltip 仍按 `value === null` 说「暂无记录」。
 */
export function dayHeatOption(points: TrendCell[], p: ChartPalette, metric: TrendMetric): EChartsOption {
  const values = points.map((point) =>
    point.missing ? null : metric === "bytes" ? point.bytes : metric === "parses" ? point.parses : point.downloads
  );
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const first = points[0] ? new Date(`${points[0].key}T00:00:00`).getDay() : 0;
  const weekCount = Math.max(1, Math.ceil((points.length + ((first + 6) % 7)) / 7));
  const rows = points.map((point, index) => {
    const date = new Date(`${point.key}T00:00:00`);
    const weekday = (date.getDay() + 6) % 7;
    const value = values[index] ?? null;
    // `value ?? 0`：null 在 ECharts 里等于「这一格没有值」→ 不绘制；改成 0 才会画出底板
    return { key: point.key, value, cell: [Math.floor((index + ((first + 6) % 7)) / 7), weekday, value ?? 0] };
  });
  const monthLabels = new Map<number, string>();
  for (const row of rows) {
    if (row.key.slice(-2) === "01") {
      const date = new Date(`${row.key}T00:00:00`);
      const week = row.cell[0];
      if (typeof week === "number") monthLabels.set(week, `${date.getMonth() + 1}月`);
    }
  }
  const fmt = metric === "bytes" ? fmtBytes : fmtCount;
  const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
  return {
    ...frame(p),
    grid: { left: 26, right: 4, top: 12, bottom: 0, containLabel: true },
    tooltip: {
      trigger: "item",
      ...tip(p),
      formatter: (params) => {
        const row = rows[rowIndexOf(params)];
        if (!row) return "";
        if (row.value === null) return `${row.key}<br/>暂无记录`;
        return `${row.key}<br/>${fmt(row.value)}${metric === "bytes" ? "" : metric === "parses" ? " 次解析" : " 个资源"}`;
      },
    },
    // heatmap 必须挂 visualMap（ECharts 硬校验：没有它直接抛 "Heatmap must use with visualMap"）。
    // 用分段型而不是连续型：连续型把低于下界的 0 clamp 回色阶最浅档，空格又变成浅蓝，
    // 分不出「这天没有账」（业主 2026-10-23）。分段型给 0 单独一段中性灰，1..max 再按色阶分档。
    visualMap: {
      show: false,
      type: "piecewise",
      pieces: heatPieces(max, p.ramp, p.sunken),
    },
    xAxis: categoryAxis(p, {
      data: Array.from({ length: weekCount }, (_, index) => String(index)),
      axisLine: { show: false },
      axisLabel: { color: p.textMuted, fontSize: p.fontSize - 2, interval: 0, hideOverlap: true, formatter: (_value: string, index: number) => monthLabels.get(index) ?? "" },
      splitLine: { show: false },
    }),
    yAxis: categoryAxis(p, {
      inverse: true,
      data: weekdays,
      axisLine: { show: false },
      axisLabel: { color: p.textMuted, fontSize: p.fontSize - 2 },
      splitLine: { show: false },
    }),
    series: [{
      type: "heatmap" as const,
      data: rows.map((row) => row.cell),
      itemStyle: { borderColor: p.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { shadowBlur: 0, borderColor: p.textMuted } },
    }],
  };
}

/**
 * 日历热力的分段色阶：`0` 单独一段（中性灰 = 这天没有账），`1..max` 按 palette 色阶等宽分档。
 *
 * 段宽取 `ceil(max / 档数)` 而不是均分后取整：均分会让小 max 出现空档（值 1 不命中任何
 * pieces → ECharts 不着色，格子透明），`ceil` 保证 1..max 每个整数都落在某一段里。
 */
function heatPieces(
  max: number,
  ramp: string[],
  empty: string
): Array<{ value?: number; min?: number; max?: number; color: string }> {
  const pieces: Array<{ value?: number; min?: number; max?: number; color: string }> = [
    { value: 0, color: empty },
  ];
  const span = Math.max(1, Math.ceil(max / ramp.length));
  for (let index = 0; index < ramp.length; index++) {
    const low = index * span + 1;
    const high = Math.min(max, (index + 1) * span);
    if (low > high) break;
    pieces.push({ min: low, max: high, color: ramp[index] });
  }
  return pieces;
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

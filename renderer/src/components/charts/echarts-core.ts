/**
 * ECharts 登记点（统计页的图表底座）。
 *
 * 为什么不在页面里 `import "echarts"`：全量包 1.10 MB / gzip 370 KB、Node 侧 eval 实测 106 ms，
 * 而摇树到「本应用真用到的图种」只有 625 KB / eval 48 ms。统计页是第 5 页且懒加载，
 * 这笔钱只该在用户真打开它时付一次 —— 所以图种与组件**只能**在这里登记。
 * 加一张新图 = 往下面数组里补一行；删一张图 = 顺手把不再用的登记撤掉。
 */
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
// containLabel 在 v6 被挪进 opt-in 的兼容件：不登记它就静默失效，
// 于是 yAxis 的类目名被 grid 裁掉、榜单左侧文字整列不见（真窗口报过这条 warn）
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  // heatmap 系列必须配 visualMap 才有色阶映射（show:false 只借它的换算，不借它的控件）
  VisualMapComponent,
  LegacyGridContainLabel,
  CanvasRenderer,
]);

export { echarts };

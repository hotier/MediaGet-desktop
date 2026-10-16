/**
 * ECharts 宿主组件：本仓唯一碰 `echarts` 实例的地方。
 *
 * 只管四件事：init/dispose、容器尺寸变化、option 换、点击回抛。
 * 色值与数据都在外面算好（`palette.ts` + `options.ts` 的纯构造器），
 * 所以这里没有业务口径，也就没有需要 DOM 才能验的分支 —— 口径全部留在可测的那层。
 *
 * `notMerge: true`：option 每次都由构造器整份重建，合并反而会留下上一次系列的残影
 * （切指标时系列数量变了，merge 语义会把旧系列当「保留项」画在图上）。
 */
import { useEffect, useRef } from "react";
import type { EChartsOption } from "echarts";
import { echarts } from "./echarts-core";
import { cn } from "../../lib/utils";

export function EChart({
  option,
  height = 208,
  className,
  ariaLabel,
  onSelect,
}: {
  option: EChartsOption;
  /** 固定像素高度：ECharts 需要确定尺寸，且字号变化时图不能跟着抽风式改高 */
  height?: number;
  className?: string;
  /** canvas 没有可读结构，图的信息量由标题与常显数值承担，这里只给一句它是什么的说明 */
  ariaLabel: string;
  /**
   * 回抛被点中数据项在 series 里的序号。
   * 用序号不用类目名：类目名是给人看的显示文案（作者昵称会重名），序号才唯一对应那一行。
   */
  onSelect?: (index: number) => void;
}): React.ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const selectRef = useRef(onSelect);

  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    chart.on("click", (params) => selectRef.current?.(params.dataIndex));
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={boxRef}
      role="img"
      aria-label={ariaLabel}
      className={cn("w-full", className)}
      style={{ height }}
    />
  );
}

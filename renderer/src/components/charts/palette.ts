/**
 * 图表取色：把 CSS Token 问出来喂给 canvas，styles.css 因此仍是全站唯一色值真源。
 *
 * 为什么要「探针」而不是 `getPropertyValue("--color-primary")`：本仓的 token 是三层链
 * （`--color-primary` → `--accent-solid` → `color-mix(...)`），而自定义属性的 computed value
 * 只做 var() 替换、**不求值** `color-mix()` —— 拿到的是一串 ECharts 解析不了的函数文本。
 * 把 utility class 挂到真元素上读它的 `color`/`backgroundColor`，浏览器才替我们把整条链算成 rgb。
 * 这也是「hex 只活在层 1」那条纪律在 canvas 侧的唯一不破口：代码里一个色值都不写。
 */
import { useEffect, useState } from "react";

export interface ChartPalette {
  text: string;
  textMuted: string;
  primary: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  /** 轴线 / 网格线 */
  line: string;
  /** 图表所在卡的底色（tooltip 背景跟它，浮层才不像贴了张别的主题的纸） */
  surface: string;
  /** 空态格的底色（热力图零格、条形图的轨道） */
  sunken: string;
  /** UI 字体族：图表文字跟着「设置→外观→界面字体」走 */
  font: string;
  /** 正文档字号（px）：图表文字与表格同源，跟着「界面字号」实时变 */
  fontSize: number;
  /** 由 primary 叠透明度得到的连续色阶（浅 → 深），热力图按档位取色 */
  ramp: string[];
}

/**
 * 透明度只能自己乘：ECharts 的 itemStyle 要具体色值，`color-mix` 文本它读不了。
 * 认 Chrome 算完的 `rgb()`/`rgba()`（空格或逗号分隔都收）；认不出来就原样返回 ——
 * 宁可少一层深浅，也不要往图上抹一片 NaN 色。
 */
export function withAlpha(color: string, alpha: number): string {
  const body = color.match(/rgba?\(([^)]+)\)/i)?.[1];
  if (!body) return color;
  const parts = body.replace(/\//g, " ").split(/[\s,]+/).filter(Boolean).map(Number);
  const [r, g, b] = parts;
  if (parts.length < 3 || [r, g, b].some((n) => !Number.isFinite(n))) return color;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const RAMP_STEPS = [0.24, 0.42, 0.62, 0.82, 1];

function readPalette(): ChartPalette {
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  // 挂进文档才吃得到级联；离屏定位避免占位与滚动条
  box.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden";
  const probe = (cls: string): CSSStyleDeclaration => {
    const el = document.createElement("span");
    el.className = cls;
    box.append(el);
    return getComputedStyle(el);
  };
  document.body.append(box);
  try {
    const type = probe("text-sm font-sans");
    const primary = probe("text-primary").color;
    return {
      text: probe("text-foreground").color,
      textMuted: probe("text-muted-foreground").color,
      primary,
      ok: probe("text-ok").color,
      warn: probe("text-warn").color,
      err: probe("text-err").color,
      info: probe("text-info").color,
      line: probe("border border-border").borderTopColor,
      surface: probe("bg-card").backgroundColor,
      sunken: probe("bg-sunken").backgroundColor,
      font: type.fontFamily,
      fontSize: Number.parseFloat(type.fontSize) || 13,
      ramp: RAMP_STEPS.map((a) => withAlpha(primary, a)),
    };
  } finally {
    box.remove();
  }
}

/**
 * 主题实时跟随：明暗（`[data-theme]`）、风格（`[data-style]`）、字号与字体（`:root` 内联 style）
 * 都是改 :root 的属性，所以盯属性就够 —— 不必问应用状态，也不必给 theme.ts 加通知口子。
 * 盯 `class` 而非只有 `data-*`：将来若有别的机制往 :root 挂类，图表一样跟得上。
 */
export function useChartPalette(): ChartPalette {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-style"],
    });
    return () => observer.disconnect();
  }, []);
  return palette;
}

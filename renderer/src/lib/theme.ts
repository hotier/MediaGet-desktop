/**
 * 明暗主题接线（UIUX-DESIGN §P2）：Token 基座已备双主题
 * （styles.css :root=dark、[data-theme="light"] 覆盖），这里只做解析与应用。
 * system 走 renderer matchMedia —— Electron 渲染进程的 prefers-color-scheme
 * 跟随系统（nativeTheme 默认值），无需主进程参与，零额外 IPC。
 */
import type { AppSettings } from "../../../types/ipc";

type Theme = AppSettings["theme"];
type ThemeStyle = AppSettings["themeStyle"];

const media = window.matchMedia("(prefers-color-scheme: dark)");
let current: Theme = "system";

export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") return media.matches ? "dark" : "light";
  return theme;
}

/**
 * 已解析明暗的订阅出口。存在理由：第三方浮层（sonner 的 Toaster）需要「当前是暗还是亮」
 * 这个值本身，而它又不该自己再读一遍 matchMedia —— 那会和这里的判定分叉。
 * 订阅在 apply() 里派发，所以设置页改主题、系统明暗变化（system 档）都能推到消费方。
 */
type ThemeListener = (resolved: "dark" | "light") => void;
const listeners = new Set<ThemeListener>();

export function getResolvedTheme(): "dark" | "light" {
  return resolveTheme(current);
}

export function subscribeTheme(fn: ThemeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function apply(): void {
  const resolved = resolveTheme(current);
  // dark 是 :root 默认态；仅 light 需要显式标记，system+暗时保持无属性
  if (resolved === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
  for (const fn of listeners) fn(resolved);
}

/** 设置页保存后调用；null/undefined = 维持现状（首帧默认 system） */
export function setTheme(theme: Theme | undefined): void {
  current = theme ?? "system";
  apply();
}

/**
 * 主题风格：写 :root[data-style]，styles.css 层 1 按它整带切换（底色/线条/焦点色…）。
 * azure = 默认态（无属性），与明暗的「dark=无属性」同构，首帧零内联也不花屏。
 */
export function setThemeStyle(style: ThemeStyle | undefined): void {
  const root = document.documentElement;
  if (!style || style === "azure") delete root.dataset.style;
  else root.dataset.style = style;
}

/**
 * 界面字体族：字体名来自本机枚举（font-list），无法预写 CSS，故**直接内联覆盖 :root 的 --font-ui**
 * （而非 [data-font] 属性——那要求族名预先登记）。"system" = 哨兵，清掉内联即回落 styles.css 基座栈。
 * 内联样式特异性高于 :root 规则，一处赋值即全站生效；body 与 Tailwind 的 --font-sans 都吃这条。
 * 族名里凡含空格/非 ASCII（中文字面）一律加引号，选中的字体缺某字形时按栈回落到基座、不塌成默认。
 */
const UI_BASE_FALLBACK =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

function quoteFamily(name: string): string {
  return /[^a-zA-Z0-9_-]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name;
}

export function setFontFamily(family: string | undefined): void {
  const root = document.documentElement;
  if (!family || family === "system") {
    root.style.removeProperty("--font-ui");
    return;
  }
  root.style.setProperty("--font-ui", `${quoteFamily(family)}, ${UI_BASE_FALLBACK}`);
}

/**
 * 界面字号：写 :root 上的 --fs-content，text-xs/sm/base 三档在 @theme inline 里由它派生，
 * 所以一处赋值即全站生效（设置页改选即刻预览，与 setTheme 同一条路子）。
 * 下限 12px 来自中文可读性（雅黑 11px 起糊），上限与契约的 11–18 同区间。
 */
export function setFontSize(px: number | undefined): void {
  if (px === undefined || !Number.isFinite(px)) return;
  const clamped = Math.min(18, Math.max(12, Math.round(px)));
  document.documentElement.style.setProperty("--fs-content", `${clamped}px`);
}

media.addEventListener("change", () => {
  if (current === "system") apply();
});

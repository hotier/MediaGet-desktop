/**
 * 明暗主题接线（UIUX-DESIGN §P2）：Token 基座已备双主题
 * （styles.css :root=dark、[data-theme="light"] 覆盖），这里只做解析与应用。
 * system 走 renderer matchMedia —— Electron 渲染进程的 prefers-color-scheme
 * 跟随系统（nativeTheme 默认值），无需主进程参与，零额外 IPC。
 */
import type { AppSettings } from "../../../types/ipc";

type Theme = AppSettings["theme"];

const media = window.matchMedia("(prefers-color-scheme: dark)");
let current: Theme = "system";

export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") return media.matches ? "dark" : "light";
  return theme;
}

function apply(): void {
  const resolved = resolveTheme(current);
  // dark 是 :root 默认态；仅 light 需要显式标记，system+暗时保持无属性
  if (resolved === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/** 设置页保存后调用；null/undefined = 维持现状（首帧默认 system） */
export function setTheme(theme: Theme | undefined): void {
  current = theme ?? "system";
  apply();
}

media.addEventListener("change", () => {
  if (current === "system") apply();
});

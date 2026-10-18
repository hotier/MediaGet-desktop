/**
 * 空态纪律守卫（业主指令 2026-10-17：只留一行标题、垂直居中，说明段删掉）。
 *
 * 为什么是源码结构断言而不是渲染冒烟：这条要钉的是「空态分支里不许再长出说明书段落」，
 * 而空态分支要凑齐 `tasks=[]` / `list=[]` 才能渲染，渲染冒烟给出的信息量不比断言多。
 * 蓝图 §3.1 原写「首次空 = 插图 + 一句价值说明 + 一个主 CTA」，本条按业主指令偏离（同一原则见
 * 同日「检测更新按钮」与 2026-10-14 删隐私自述文案——**解释不常驻**）。手法同 tests/toast-sonner.test.ts。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** 取 `if (cond) {` 那一支的源码（到同缩进的 `}` 为止）——只约束空态分支，不误伤正常渲染 */
function branch(source: string, cond: string): string {
  const at = source.indexOf(cond);
  expect(at, `找不到空态分支：${cond}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", at);
  expect(end, `${cond} 之后收不到分支结尾`).toBeGreaterThan(at);
  return source.slice(at, end);
}

const QUEUE = branch(src("renderer/src/pages/DownloadsPage.tsx"), "if (tasks.length === 0) {");
const HISTORY = branch(src("renderer/src/pages/HistoryPage.tsx"), "if (list.length === 0) {");

describe("队列页空态", () => {
  it("只有一行标题，没有说明段", () => {
    expect(QUEUE).toContain("暂无下载任务");
    expect(QUEUE).not.toMatch(/<p\b/);
    expect(QUEUE).not.toContain("text-muted-foreground");
  });

  it("整组在可用高度里垂直居中（不靠 py-16 顶在页头下面）", () => {
    expect(QUEUE).toContain("min-h-full");
    expect(QUEUE).toContain("justify-center");
    expect(QUEUE).not.toContain("py-16");
  });

  it("空态分支里不许再长出页内播报（回执只走浮空 toast，见 tests/toast-sonner.test.ts）", () => {
    expect(QUEUE).not.toMatch(/<Alert\b|ToastLine/);
  });
});

describe("历史页空态", () => {
  it("只有一行标题，「会自动记录在这里」那句已删且不许回潮", () => {
    expect(HISTORY).toContain("暂无历史记录");
    expect(HISTORY).not.toMatch(/<p\b/);
    expect(src("renderer/src/pages/HistoryPage.tsx")).not.toContain("会自动记录在这里");
  });

  it("整组垂直居中", () => {
    expect(HISTORY).toContain("min-h-full");
    expect(HISTORY).toContain("justify-center");
    expect(HISTORY).not.toContain("py-16");
  });
});

describe("队列页被删掉的两句说明不回潮", () => {
  it("「断点续传」与「批量图集」两段不在队列页源码里（机制口径归 README 与设置页）", () => {
    const page = src("renderer/src/pages/DownloadsPage.tsx");
    expect(page).not.toContain("批量图集会整组显示进度");
    expect(page).not.toContain("断点续传：重启后未完成任务自动恢复");
  });
});

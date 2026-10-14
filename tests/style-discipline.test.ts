/**
 * 视觉纪律回归（docs/UIUX-DESIGN.md C4 三修后的口径）。
 *
 * 2026-10-14 业主指令「都放宽，按照 Motrix 的 UI 设计框架和理念，不要给自己设限」，
 * 因此本文件只保留**机械可判定且与选库无关**的三条：
 *  1. 颜色只有一个真源：hex 只活在层 1 原始色板（@property 的静态 initial-value 是唯一例外），
 *     主题切换与 accent 派生都靠这层，散落色值会让 light 主题静默坏掉；
 *  2. 用到的每个 var(--x) 都在本文件声明过（拼错的 token 静默失效，没人会发现）；
 *  3. 不残留 Air 时代的 --air-* token。
 *
 * 此前另三条是**审美禁令**（不用玻璃、单一高程、不上浮缩放），属冷灰工具风对当时那版
 * 自绘 CSS 的自我约束，不是工程边界 —— 已由业主解除，shadcn/Radix 的默认阴影与
 * translate 动效不再需要为它们做覆写。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("../renderer/src/styles.css", import.meta.url)), "utf8");

/** 注释里可以写「已移除毛玻璃」这类说明，纪律检查只看代码本体 */
function stripComments(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, "");
}

/** 层 1 之外（含层 2 / 2.5 / 组件层）的文本 */
function outsidePalette(src: string): string {
  const marker = src.indexOf("—— 层 2");
  expect(marker).toBeGreaterThan(-1);
  return stripComments(
    src.slice(marker).replace(/@property[^}]*\}/g, "") // 允许 @property 的静态色初值
  );
}

describe("视觉纪律（放宽后仅剩工程约束）", () => {
  it("hex 字面量只出现在层 1 色板（层 2 之外禁止硬编码颜色）", () => {
    expect(outsidePalette(CSS)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("每个被消费的 CSS 变量都在本文件声明", () => {
    const declared = new Set([...CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = [...CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    const missing = [...new Set(used.filter((u) => !declared.has(u)))];
    expect(missing).toEqual([]);
  });

  it("不残留 Air 时代的 token", () => {
    expect(stripComments(CSS)).not.toMatch(/--air-/);
  });
});

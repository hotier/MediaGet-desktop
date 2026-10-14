/**
 * 魔法色钳位（工具风的剂量约束）。
 * 钳位数学单独成纯函数就是为了这条测试：浏览器里看不出「饱和度被压了多少」，
 * 但一旦放开，橙红封面会把主按钮和进度条染成霓虹，整个界面立刻从「工具」变「营销页」。
 */
import { describe, expect, it } from "vitest";
import { clampAccent } from "../renderer/src/lib/accent";

const S_MAX = 0.55;
const L_MIN = 0.45;
const L_MAX = 0.75;

describe("clampAccent", () => {
  it("高饱和封面色被压到上限，色相保持不变", () => {
    const [h, s] = clampAccent(0.08, 0.95, 0.5);
    expect(s).toBeCloseTo(S_MAX);
    expect(h).toBeCloseTo(0.08);
  });

  it("低饱和（灰阶封面）不上调色：不放大饱和度", () => {
    expect(clampAccent(0.5, 0.05, 0.6)[1]).toBeCloseTo(0.05);
  });

  it("过亮/过暗都收进可用亮度区间，保证 accent 上的文字对比", () => {
    expect(clampAccent(0.3, 0.3, 0.98)[2]).toBeCloseTo(L_MAX);
    expect(clampAccent(0.3, 0.3, 0.02)[2]).toBeCloseTo(L_MIN);
    expect(clampAccent(0.3, 0.3, 0.6)[2]).toBeCloseTo(0.6);
  });

  it("钳位后始终落在合法 HSL 域内", () => {
    for (const h of [0, 0.25, 0.5, 0.75, 0.999]) {
      for (const s of [0, 0.3, 0.8, 1]) {
        for (const l of [0, 0.2, 0.5, 0.9, 1]) {
          const [ch, cs, cl] = clampAccent(h, s, l);
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
          expect(cs).toBeGreaterThanOrEqual(0);
          expect(cs).toBeLessThanOrEqual(S_MAX);
          expect(cl).toBeGreaterThanOrEqual(L_MIN);
          expect(cl).toBeLessThanOrEqual(L_MAX);
        }
      }
    }
  });
});

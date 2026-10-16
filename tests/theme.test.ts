/**
 * theme.ts 订阅出口（getResolvedTheme / subscribeTheme）——2026-10-15 为浮空 toast 新增：
 * Toaster 需要「当前解析后的明暗」这个值本身（sonner 的 theme 参数不收 system），
 * 而它不该自己再读一遍 matchMedia —— 那会和 theme.ts 的判定分叉，故从这里订阅派发。
 *
 * 桩：theme.ts 在模块作用域读 window.matchMedia、apply() 写 documentElement.dataset，
 * node 两者皆无，必须 import 之前打好桩（matches=true → system 解析为 dark，与 :root 默认态一致）。
 */
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {
  matchMedia: () => ({ matches: true, addEventListener: () => {} }),
});
vi.stubGlobal("document", { documentElement: { dataset: {} } });

const theme = await import("../renderer/src/lib/theme");

describe("getResolvedTheme", () => {
  it("初始 system 按 matchMedia 解析（桩 matches=true → dark）", () => {
    expect(theme.getResolvedTheme()).toBe("dark");
  });

  it("setTheme 后返回设置值本身（light/dark 不再走 matchMedia）", () => {
    theme.setTheme("light");
    expect(theme.getResolvedTheme()).toBe("light");
    theme.setTheme("system");
    expect(theme.getResolvedTheme()).toBe("dark");
  });
});

describe("subscribeTheme", () => {
  it("setTheme 派发给订阅者，收到的是解析后的明暗而不是设置值", () => {
    const seen: string[] = [];
    const off = theme.subscribeTheme((t) => seen.push(t));
    try {
      theme.setTheme("light");
      theme.setTheme("dark");
      theme.setTheme("system"); // 落回 matchMedia → dark
      expect(seen).toEqual(["light", "dark", "dark"]);
    } finally {
      off();
      theme.setTheme("system");
    }
  });

  it("取消订阅后不再收到（设置页反复保存不能让订阅者堆积）", () => {
    const seen: string[] = [];
    const off = theme.subscribeTheme((t) => seen.push(t));
    off();
    theme.setTheme("light");
    theme.setTheme("system");
    expect(seen).toEqual([]);
  });

  it("返回的取消函数可安全重复调用", () => {
    const off = theme.subscribeTheme(() => {});
    off();
    expect(() => off()).not.toThrow();
    theme.setTheme("light");
    theme.setTheme("system");
  });
});

/**
 * 「草稿 → 保存载荷」的纯函数守卫（P2-1，2026-10-23 审查）。
 *
 * 草稿是进设置页时的快照，而平台/引擎/主引擎/回退四张表在点下去的那一刻就已各自落盘。
 * 整份提交会把这一路上的即时修改打回旧值，且它们不进脏计数——必须由保存载荷这一侧剥掉。
 */
import { describe, expect, it } from "vitest";
import { toSettingsPatch } from "../renderer/src/lib/settings-patch";
import { DEFAULT_SETTINGS } from "../types/ipc";
import type { AppSettings } from "../types/ipc";

describe("toSettingsPatch（保存载荷剔除即时开关）", () => {
  it("开关表与 Cookie 不进载荷，其余草稿字段原样保留", () => {
    const draft: AppSettings = {
      ...DEFAULT_SETTINGS,
      cookies: { DOUYIN_COOKIE: "***" },
      platformSwitches: { douyin: { enabled: false } },
      engineSwitches: { ytdlp: { enabled: false } },
      platformEngines: { douyin: "ytdlp" },
      engineFallback: false,
      fontSizePx: 15,
    };
    const patch = toSettingsPatch(draft);
    for (const key of ["cookies", "platformSwitches", "engineSwitches", "platformEngines", "engineFallback"]) {
      expect(patch).not.toHaveProperty(key);
    }
    expect(patch.fontSizePx).toBe(15);
    expect(patch.themeStyle).toBe(DEFAULT_SETTINGS.themeStyle);
  });
});

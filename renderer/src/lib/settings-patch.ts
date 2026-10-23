/**
 * 设置草稿 → 保存载荷：剥掉「不走草稿」的几项。
 *
 * 平台开关 / 引擎开关 / 主引擎 / 回退开关在用户点下去的那一刻就各自经 store 落盘了
 * （见 `store/platforms.ts`、`store/engines.ts`）；草稿是**进设置页时**的快照，
 * 整份提交会把这一路上的即时修改悄悄打回旧值——而它们不进脏计数，用户几乎无从察觉。
 *
 * Cookie 同样不从草稿提交：保存时只带本次真正编辑或清除过的键（掩码 `***` 不落盘）。
 */
import type { AppSettings } from "../../../types/ipc";

export type SettingsPatch = Omit<
  AppSettings,
  "cookies" | "platformSwitches" | "engineSwitches" | "platformEngines" | "engineFallback"
>;

export function toSettingsPatch(draft: AppSettings): SettingsPatch {
  const {
    cookies: _cookies,
    platformSwitches: _platformSwitches,
    engineSwitches: _engineSwitches,
    platformEngines: _platformEngines,
    engineFallback: _engineFallback,
    ...rest
  } = draft;
  return rest;
}

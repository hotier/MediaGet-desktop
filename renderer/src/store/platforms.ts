/**
 * 平台开关的渲染层视图（zustand —— 本仓第一份状态库，2026-10-16）。
 *
 * 分工要说清，否则又会长成两张表：
 * - **平台的定义**（名字/图标/域名/引擎能力）在 `shared/platforms.ts`，两个进程 import 同一模块，
 *   纯查表不需要 hook —— 所以下面只 re-export 那几个纯函数，不在这里重复实现；
 * - **用户改过的开关**是设置档的一部分（`settings.platformSwitches`），活在这份 store 里，
 *   写回走既有 settings:set 通道，不新增 IPC。
 *
 * 覆盖层只存「用户明确改过的」平台：没改过的跟随注册表 `enabledByDefault`，
 * 于是注册表加一个平台不需要写迁移、也不会被过期快照钉死。
 */
import { create } from "zustand";
import { api } from "../lib/bridge";
import type { PlatformSwitch } from "../../../shared/platforms";

interface PlatformStore {
  /** 用户覆盖层；键 = 契约键 */
  switches: Record<string, PlatformSwitch>;
  /** 启动接线时灌入（读不到设置就维持空覆盖 = 全按注册表默认） */
  hydrate: (switches: Record<string, PlatformSwitch>) => void;
  /** 乐观写：先反映到界面，落盘失败回滚并抛出 */
  setEnabled: (key: string, enabled: boolean) => Promise<void>;
}

export const usePlatformStore = create<PlatformStore>((set, get) => ({
  switches: {},
  hydrate: (switches) => set({ switches }),
  setEnabled: async (key, enabled) => {
    const prev = get().switches;
    const next = { ...prev, [key]: { enabled } };
    set({ switches: next });
    try {
      const saved = await api.settings.set({ platformSwitches: next });
      // 以主进程回读为准：它对全量设置做了合并与脱敏，界面跟着它才不会与盘上不一致
      set({ switches: saved.platformSwitches });
    } catch (e) {
      set({ switches: prev });
      throw e;
    }
  },
}));

/**
 * 灌入覆盖层（App 启动读设置时调一次）。
 * 独立成函数而不是 hook，是为了让启动接线复用同一次 settings 读，不多打一遍 IPC。
 */
export function hydratePlatformSwitches(switches: Record<string, PlatformSwitch>): void {
  usePlatformStore.getState().hydrate(switches);
}

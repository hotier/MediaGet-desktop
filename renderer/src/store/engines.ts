/**
 * 引擎开关的渲染层视图（2026-10-21，与 `store/platforms.ts` 同一条纪律）。
 *
 * 分工：
 * - **有哪些引擎、叫什么、说明是什么**在 `shared/platforms.ts` 的 `ENGINE_INFO`
 *   （零依赖，主进程与渲染进程 import 同一份）；
 * - **用户关掉的引擎**是设置档的一部分（`settings.engineSwitches`），活在这份 store 里，
 *   写回走既有 `settings:set` 通道，不新增 IPC。
 *
 * 覆盖层只存「用户明确改过的」引擎：缺键 = 开（`isEngineEnabled`）。所以引擎注册表
 * 加一项不需要写迁移、也不会被过期快照钉死。
 *
 * 语义与平台开关一致：乐观置态 → 整表提交 → 失败回滚；主进程读持久值，不读这份内存。
 */
import { create } from "zustand";
import { api } from "../lib/bridge";
import type { EngineSwitch } from "../../../shared/platforms";

interface EngineStore {
  /** 用户覆盖层；键 = 可切换引擎 id */
  switches: Record<string, EngineSwitch>;
  /** 主引擎失败后是否回退其余可用引擎（缺省开） */
  fallback: boolean;
  /** 启动接线时灌入（读不到设置就维持默认：全开 + 回退开） */
  hydrate: (switches: Record<string, EngineSwitch>, fallback: boolean) => void;
  /** 乐观写：先反映到界面，落盘失败回滚并抛出 */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** 回退开关（同上：乐观置态，失败回滚并抛出） */
  setFallback: (enabled: boolean) => Promise<void>;
}

export const useEngineStore = create<EngineStore>((set, get) => ({
  switches: {},
  fallback: true,
  hydrate: (switches, fallback) => set({ switches, fallback }),
  setEnabled: async (id, enabled) => {
    const prev = get().switches;
    // 「开着」是缺省：勾回开就删键，别让覆盖层越积越厚、也别让将来的默认值改不动
    const next: Record<string, EngineSwitch> = { ...prev };
    if (enabled) delete next[id];
    else next[id] = { enabled: false };
    set({ switches: next });
    try {
      const saved = await api.settings.set({ engineSwitches: next });
      // 以主进程回读为准：它对全量设置做了合并与脱敏，界面跟着它才不会与盘上不一致
      set({ switches: saved.engineSwitches });
    } catch (e) {
      set({ switches: prev });
      throw e;
    }
  },
  setFallback: async (enabled) => {
    const prev = get().fallback;
    set({ fallback: enabled });
    try {
      const saved = await api.settings.set({ engineFallback: enabled });
      set({ fallback: saved.engineFallback });
    } catch (e) {
      set({ fallback: prev });
      throw e;
    }
  },
}));

/**
 * 灌入覆盖层（App 启动读设置时调一次）。
 * 独立成函数而不是 hook，是为了让启动接线复用同一次 settings 读，不多打一遍 IPC。
 */
export function hydrateEngineSwitches(
  switches: Record<string, EngineSwitch>,
  fallback: boolean
): void {
  useEngineStore.getState().hydrate(switches, fallback);
}

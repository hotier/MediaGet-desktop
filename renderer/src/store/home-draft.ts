/**
 * 首页工作台的会话草稿（业主指令 2026-10-17：切走再切回，上一次解析的结果还在，
 * 除非重新解析了新的链接）。
 *
 * 为什么这份状态不留在 HomePage 里：页面是条件渲染外加 `<main key={page}>`，切页即卸载重挂，
 * useState 的结果卡连同输入框文本一起归零。而「刚解析出来的东西」属于本会话的工作台，
 * 不属于某个组件实例 —— 与平台开关同一处置：提到模块级 zustand，重挂载只是重新订阅。
 *
 * 只活在内存里，不落盘：应用重启后首页是干净的，长期记忆归历史页（v8 起解析也记）。
 */
import { create } from "zustand";
import type { ParseRunOutcome } from "../../../types/ipc";

/** 批量解析的一条：一颗结果卡从 pending 走到 done / error */
export type BatchItem = {
  id: number;
  text: string;
  status: "pending" | "done" | "error";
  /** identify 出的来源链接（写历史用，非直链） */
  sourceUrl?: string;
  outcome?: ParseRunOutcome;
  /**
   * 结果到手时刻（epoch ms）。内核直链 5 分钟就过期，而切页会让结果卡重挂载：
   * 卡片自己的计龄从挂载那刻起算，没有这个字段就会把一条早已过期的链显示成「刚刚拿到」。
   */
  at?: number;
  /** IPC 级失败（bridge 抛错）；引擎业务失败走 outcome.code≠200 的失败卡 */
  error?: string;
};

interface HomeDraftStore {
  /** 输入框草稿 */
  text: string;
  /** 识别提示（识别为 X / 识别到 N 条 / 未识别到） */
  hint: string;
  items: BatchItem[];
  /** 批内串行解析的进行态：在飞的任务不会因为切页而消失，进行态也不该消失 */
  busy: boolean;
  /** 结果卡自增 id（放进 store 而不是组件 ref：重挂载不能把编号退回 0） */
  nextId: number;
  setText: (text: string) => void;
  setHint: (hint: string) => void;
  setBusy: (busy: boolean) => void;
  /** 新批次 = 整表替换（「除非我重新解析了新的链接」就是这一句的代码化） */
  startBatch: (texts: string[]) => BatchItem[];
  patchItem: (id: number, up: Partial<BatchItem>) => void;
  /** 清空工作台：文本、识别提示、结果卡整表（业主指令 2026-10-19） */
  clear: () => void;
}

export const useHomeDraft = create<HomeDraftStore>((set, get) => ({
  text: "",
  hint: "",
  items: [],
  busy: false,
  nextId: 0,
  setText: (text) => set({ text }),
  setHint: (hint) => set({ hint }),
  setBusy: (busy) => set({ busy }),
  startBatch: (texts) => {
    const from = get().nextId;
    const fresh = texts.map((t, i) => ({ id: from + 1 + i, text: t, status: "pending" as const }));
    set({ items: fresh, nextId: from + fresh.length });
    return fresh;
  },
  patchItem: (id, up) =>
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...up } : it)) })),
  // nextId 不回退：卡片 id 保持单调，清空后新批次不会与旧卡的 React key 撞车
  clear: () => set({ text: "", hint: "", items: [] }),
}));

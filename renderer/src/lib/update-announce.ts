/**
 * 更新播报决策表（UpdateActions 的 toast 真源）：输入状态迁移 (prev → next)，
 * 输出该不该播报、用什么档。
 *
 * 为什么抽成纯函数：播报曾只看「phase 变了且在名单里」，于是
 * 点「下载更新」→ 取消 → updater.cancel() 落回 available（设计如此：保留版本号
 * 与 changelog 便于重新下载）被当成「发现新版本」又弹一次 toast（业主报 2026-10-15）。
 * 取消的确认是弹窗收起后原位那颗「下载更新」按钮，不是再播一条发现——
 * 这条区分是行为规则，得有用例钉住，不能散在组件的 if 里。
 */
import type { UpdateState } from "../../../types/ipc";

type Phase = UpdateState["phase"];

/** 结果类阶段才考虑播报；进行中类（checking/downloading/paused）由流式下载弹窗承载 */
const RESULT_PHASES: readonly Phase[] = ["up-to-date", "available", "downloaded", "error"];

/** 播报档位：error 红档，其余中性 info（带档才渲染图标，裸 toast 无图标） */
export type Notice = "error" | "info" | null;

export function updateNotice(prev: Phase, next: Phase): Notice {
  // 同一快照重复送达（事件回灌/动作返回值）不播第二次
  if (prev === next) return null;
  if (!RESULT_PHASES.includes(next)) return null;
  // 取消/暂停后回落 available：只是恢复可重下的入口，不是新发现 —— 静默
  if (next === "available" && (prev === "downloading" || prev === "paused")) return null;
  return next === "error" ? "error" : "info";
}

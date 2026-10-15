/**
 * 下载系统通知聚合器（设置→通用→「系统通知」两开关）。
 *
 * 为什么按组聚合而不是逐文件弹：downloader 的 done/error 是**文件粒度**事件
 * （一个图集 9 张 = 9 次事件），逐条弹就是通知风暴。队列页的语义单元是「组」
 * （聚合行），通知跟随同一粒度：组内不再有 queued/downloading 任务时才播报一次。
 *
 * 为什么是轮询式结算而不是简单防抖：防抖在组内长任务（大视频）拖着时会把通知
 * 无限推迟或误报「完成」，这里每 settleMs 检查一次组是否仍有活任务，直到整组落地。
 *
 * Notification 本体不进本模块（index.ts 装配注入 show）：headless 测试环境没有
 * Electron runtime，注入式让聚合逻辑可纯 Node 验证。
 */
import type { DownloadTaskView } from "../../types/ipc";

export interface NotifyPolicy {
  onDone: boolean;
  onError: boolean;
}

export interface NotifyPayload {
  kind: "done" | "error";
  title: string;
  body: string;
}

export interface DownloadNotifierDeps {
  /** 读取时求值：设置保存后无需热更，下次播报即生效 */
  getPolicy(): NotifyPolicy;
  /** 该组是否还有排队/下载中的任务（决定现在能否播报） */
  hasActiveTask(groupId: string): boolean;
  show(payload: NotifyPayload): void;
  /** 结算检查间隔；组内事件停歇多久后检查组是否已落地 */
  settleMs?: number;
}

const DEFAULT_SETTLE_MS = 1200;
const BODY_ERROR_LIMIT = 160;

interface GroupAgg {
  label: string;
  done: number;
  error: number;
  firstError?: string;
  timer: NodeJS.Timeout | null;
}

export class DownloadNotifier {
  private groups = new Map<string, GroupAgg>();
  private readonly settleMs: number;

  constructor(private deps: DownloadNotifierDeps) {
    this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  }

  onTaskEvent(kind: "done" | "error", t: DownloadTaskView): void {
    let agg = this.groups.get(t.groupId);
    if (!agg) {
      agg = { label: t.title ?? t.filename, done: 0, error: 0, timer: null };
      this.groups.set(t.groupId, agg);
    }
    if (kind === "done") {
      agg.done += 1;
    } else {
      agg.error += 1;
      if (!agg.firstError && t.error) agg.firstError = t.error;
    }
    this.schedule(t.groupId);
  }

  dispose(): void {
    for (const g of this.groups.values()) {
      if (g.timer) clearTimeout(g.timer);
    }
    this.groups.clear();
  }

  private schedule(groupId: string): void {
    const agg = this.groups.get(groupId);
    if (!agg || agg.timer) return;
    agg.timer = setTimeout(() => {
      agg.timer = null;
      this.settle(groupId);
    }, this.settleMs);
    agg.timer.unref?.();
  }

  private settle(groupId: string): void {
    const agg = this.groups.get(groupId);
    if (!agg) return;
    if (this.deps.hasActiveTask(groupId)) {
      this.schedule(groupId); // 组内还有活：继续等，整组落地才播报
      return;
    }
    this.groups.delete(groupId);

    const policy = this.deps.getPolicy();
    if (agg.error > 0) {
      if (!policy.onError) return;
      const title = agg.done > 0 ? "部分下载失败" : "下载失败";
      const detail = truncate(agg.firstError ?? "重试用尽仍失败");
      this.deps.show({
        kind: "error",
        title,
        body: agg.done > 0 ? `${agg.label}：${agg.done} 个完成，${agg.error} 个失败` : `${agg.label}：${detail}`,
      });
      return;
    }
    if (agg.done === 0 || !policy.onDone) return;
    this.deps.show({
      kind: "done",
      title: "下载完成",
      body: agg.done > 1 ? `${agg.label}（${agg.done} 个文件）` : agg.label,
    });
  }
}

function truncate(s: string): string {
  return s.length > BODY_ERROR_LIMIT ? `${s.slice(0, BODY_ERROR_LIMIT)}…` : s;
}

export function createDownloadNotifier(deps: DownloadNotifierDeps): DownloadNotifier {
  return new DownloadNotifier(deps);
}

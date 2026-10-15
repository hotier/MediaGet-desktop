/**
 * 下载通知聚合器（electron/main/notify.ts）：done/error 是文件粒度事件，
 * 通知必须按组收敛 —— 图集 9 张不能弹 9 条。
 * 假时钟驱动结算窗口；show 注入收集，不碰 Electron Notification。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDownloadNotifier, type NotifyPayload } from "../electron/main/notify";
import type { DownloadTaskView } from "../types/ipc";

function task(over: Partial<DownloadTaskView> = {}): DownloadTaskView {
  return {
    taskId: "t-1",
    groupId: "g-1",
    url: "https://cdn.example/a.mp4",
    filename: "a.mp4",
    kind: "video",
    status: "done",
    received: 100,
    total: 100,
    speed: 0,
    title: "示例视频",
    createdAt: 1,
    ...over,
  };
}

function harness(opts: { active?: string[]; onDone?: boolean; onError?: boolean } = {}) {
  let active = opts.active ?? [];
  const shown: NotifyPayload[] = [];
  const notifier = createDownloadNotifier({
    getPolicy: () => ({ onDone: opts.onDone ?? true, onError: opts.onError ?? true }),
    hasActiveTask: (gid) => active.includes(gid),
    show: (p) => shown.push(p),
    settleMs: 100,
  });
  return {
    shown,
    notifier,
    setActive: (g: string[]) => {
      active = g;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("下载通知聚合", () => {
  it("单文件组：结算窗口后播报一次完成", () => {
    const { shown, notifier } = harness();
    notifier.onTaskEvent("done", task());
    expect(shown).toHaveLength(0); // 结算窗口内不急着弹
    vi.advanceTimersByTime(150);
    expect(shown).toEqual([{ kind: "done", title: "下载完成", body: "示例视频" }]);
  });

  it("同组多文件：只播报一次，带文件数", () => {
    const { shown, notifier } = harness();
    for (let i = 1; i <= 3; i++) notifier.onTaskEvent("done", task({ taskId: `t-${i}` }));
    vi.advanceTimersByTime(150);
    expect(shown).toEqual([{ kind: "done", title: "下载完成", body: "示例视频（3 个文件）" }]);
  });

  it("组内仍有排队/下载中任务：延后播报，整组落地才弹", () => {
    const { shown, notifier, setActive } = harness({ active: ["g-1"] });
    notifier.onTaskEvent("done", task());
    vi.advanceTimersByTime(150);
    expect(shown).toHaveLength(0); // 组内还有活：不弹
    setActive([]);
    vi.advanceTimersByTime(150); // 下一轮结算检查
    expect(shown).toHaveLength(1);
  });

  it("不同组各自播报，互不合并", () => {
    const { shown, notifier } = harness();
    notifier.onTaskEvent("done", task({ taskId: "a", groupId: "g-1" }));
    notifier.onTaskEvent("done", task({ taskId: "b", groupId: "g-2", title: "另一个视频" }));
    vi.advanceTimersByTime(150);
    expect(shown.map((p) => p.body).sort()).toEqual(["另一个视频", "示例视频"]);
  });

  it("纯失败：播报失败原因；成功未受影响", () => {
    const { shown, notifier } = harness();
    notifier.onTaskEvent("error", task({ status: "error", error: "HTTP 403 Forbidden" }));
    vi.advanceTimersByTime(150);
    expect(shown).toEqual([
      { kind: "error", title: "下载失败", body: "示例视频：HTTP 403 Forbidden" },
    ]);
  });

  it("部分失败：失败通知带成功/失败计数", () => {
    const { shown, notifier } = harness();
    notifier.onTaskEvent("done", task({ taskId: "a" }));
    notifier.onTaskEvent("error", task({ taskId: "b", status: "error", error: "超时" }));
    vi.advanceTimersByTime(150);
    expect(shown).toEqual([
      { kind: "error", title: "部分下载失败", body: "示例视频：1 个完成，1 个失败" },
    ]);
  });

  it("开关关闭：完成/失败都不播报", () => {
    const doneOff = harness({ onDone: false });
    doneOff.notifier.onTaskEvent("done", task());
    vi.advanceTimersByTime(150);
    expect(doneOff.shown).toHaveLength(0);

    const errOff = harness({ onError: false });
    errOff.notifier.onTaskEvent("error", task({ status: "error", error: "x" }));
    vi.advanceTimersByTime(150);
    expect(errOff.shown).toHaveLength(0);
  });

  it("失败原因超长截断（通知体不做无上限文本）", () => {
    const { shown, notifier } = harness();
    notifier.onTaskEvent("error", task({ status: "error", error: "E".repeat(500) }));
    vi.advanceTimersByTime(150);
    expect(shown[0].body.length).toBeLessThan(200);
    expect(shown[0].body.endsWith("…")).toBe(true);
  });

  it("dispose 后挂起的结算不播报（退出路径不留通知）", () => {
    const { shown, notifier } = harness();
    notifier.onTaskEvent("done", task());
    notifier.dispose();
    vi.advanceTimersByTime(300);
    expect(shown).toHaveLength(0);
  });
});

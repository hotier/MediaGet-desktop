/**
 * 首页右栏：常驻队列轨。
 *
 * 进度不靠底条常驻，而靠「做事时旁边那条线一直在动」：
 * 解析与下载在同一屏里完成，不需要跳页确认任务有没有进去。
 * 只消费 App 层已有的任务订阅（零新 IPC），断开/失败态都直接来自 DownloadTaskView。
 */
import type { DownloadTaskView } from "../../../types/ipc";
import { fmtBytes } from "../lib/format";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";

const STATE_LABEL: Record<DownloadTaskView["status"], string> = {
  queued: "排队",
  downloading: "下载中",
  paused: "已暂停",
  done: "完成",
  error: "失败",
  canceled: "已取消",
};

const MAX_ROWS = 8;

export function QueueRail({
  tasks,
  onShowAll,
}: {
  tasks: DownloadTaskView[];
  onShowAll: () => void;
}): React.ReactElement {
  const active = tasks.filter((t) => t.status !== "done" && t.status !== "canceled");
  const rows = active.slice(0, MAX_ROWS);

  return (
    <aside className="sticky top-0 flex w-(--w-rail) shrink-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm" aria-label="下载队列">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">队列</h2>
        {active.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{active.length}</span>}
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无进行中的任务。解析成功后点「下载」，这里会实时滚动。</p>
      ) : (
        rows.map((t) => {
          const pct = t.total > 0 ? Math.min(100, (t.received / t.total) * 100) : 0;
          const variant = t.status === "error" ? "warn" : t.status === "done" ? "ok" : "secondary";
          return (
            <div key={t.taskId} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-xs" title={t.error ?? t.filename}>
                  {t.filename}
                </span>
                <Badge variant={variant} data-status={t.status} className="shrink-0 tabular-nums">
                  {t.status === "downloading" && t.total > 0
                    ? `${pct.toFixed(0)}%`
                    : t.status === "downloading"
                      ? fmtBytes(t.received)
                      : STATE_LABEL[t.status]}
                </Badge>
              </div>
              <Progress value={t.status === "done" ? 100 : pct} className="h-1" />
            </div>
          );
        })
      )}

      <Button variant="ghost" size="sm" className="mt-auto justify-start px-0 text-xs" onClick={onShowAll}>
        打开完整队列
      </Button>
    </aside>
  );
}

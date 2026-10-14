/**
 * 底部任务控制条（Air 四区之一，替代 QQ音乐「播放器条」的迁移位）：
 * 当前任务缩略图模糊背景 + 左文件信息 / 中进度速度ETA控制 / 右队列数与展开。
 * 数据来自 App 层订阅（跨页存活）；封面 URL 由解析结果上抛（契约无 cover，零 IPC 变更）。
 */
import { useEffect, useState } from "react";
import { ListOrdered, Pause, Play, FolderOpen, X } from "lucide-react";
import { api } from "../lib/bridge";
import type { DownloadTaskView } from "../../../types/ipc";
import { fmtBytes } from "../pages/DownloadsPage";

const ACTIVE: DownloadTaskView["status"][] = ["queued", "downloading"];

function statusLabel(s: DownloadTaskView["status"]): string {
  return (
    { queued: "排队中", downloading: "下载中", paused: "已暂停", done: "已完成", error: "失败", canceled: "已取消" }[
      s
    ] ?? s
  );
}

function fmtEta(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

export function Taskbar({
  tasks,
  cover,
  onOpenQueue,
}: {
  tasks: DownloadTaskView[];
  cover: string | null;
  onOpenQueue: () => void;
}): React.ReactElement | null {
  // 背景交叉淡入层：hooks 必须声明在空任务早退之前（hook 顺序恒定）
  const [bg, setBg] = useState<{ cur: string | null; prev: string | null }>({
    cur: null,
    prev: null,
  });
  useEffect(() => {
    setBg((b) => (cover === b.cur ? b : { cur: cover, prev: b.cur }));
  }, [cover]);

  if (tasks.length === 0) return null;

  // 当前 = 最近一个活跃任务；全完成后停在最后一个终态任务
  const current =
    [...tasks].reverse().find((t) => ACTIVE.includes(t.status) || t.status === "paused") ??
    tasks[tasks.length - 1];
  const pct = current.total > 0 ? Math.min(100, (current.received / current.total) * 100) : 0;
  const eta =
    current.status === "downloading" && current.speed > 0 && current.total > current.received
      ? (current.total - current.received) / current.speed
      : null;
  const queueCount = tasks.filter((t) => ACTIVE.includes(t.status)).length;

  async function act(fn: (id: string) => Promise<unknown>): Promise<void> {
    try {
      await fn(current.taskId);
    } catch {
      /* 状态竞争忽略，事件流会带回真值 */
    }
  }

  return (
    <footer className="taskbar" aria-label="任务控制条">
      {bg.prev && (
        <div className="taskbar-bg" style={{ backgroundImage: `url(${bg.prev})` }} aria-hidden="true" />
      )}
      {bg.cur && (
        <div
          key={bg.cur}
          className={`taskbar-bg enter${current.status === "downloading" ? " breathe" : ""}`}
          style={{ backgroundImage: `url(${bg.cur})` }}
          aria-hidden="true"
        />
      )}
      <div className="taskbar-veil" aria-hidden="true" />

      <div className="taskbar-cell taskbar-file">
        <div className="taskbar-thumb">{current.title?.slice(0, 1) ?? "▤"}</div>
        <div className="taskbar-file-text">
          <div className="fname" title={current.filename}>
            {current.filename}
          </div>
          <div className="hint num">
            {statusLabel(current.status)}
            {current.status === "downloading" &&
              ` · ${pct < 1 ? "…" : `${pct.toFixed(1)}%`}` +
                ` · ${fmtBytes(current.received)} / ${fmtBytes(current.total)}` +
                (current.speed > 0 ? ` · ${fmtBytes(current.speed)}/s` : "") +
                (eta !== null ? ` · 剩 ${fmtEta(eta)}` : "")}
          </div>
        </div>
      </div>

      <div className="taskbar-cell taskbar-prog">
        <div className="ops">
          {(current.status === "downloading" || current.status === "queued") && (
            <button className="icon-btn" title="暂停" onClick={() => void act(api.download.pause)}>
              <Pause size={15} strokeWidth={1.5} />
            </button>
          )}
          {(current.status === "paused" || current.status === "error" || current.status === "canceled") && (
            <button className="icon-btn" title="继续" onClick={() => void act(api.download.resume)}>
              <Play size={15} strokeWidth={1.5} />
            </button>
          )}
          {ACTIVE.includes(current.status) || current.status === "paused" ? (
            <button className="icon-btn" title="取消" onClick={() => void act(api.download.cancel)}>
              <X size={15} strokeWidth={1.5} />
            </button>
          ) : null}
          {current.status === "done" && current.filePath && (
            <button
              className="icon-btn"
              title="打开位置"
              onClick={() => void api.app.showInFolder(current.filePath!)}
            >
              <FolderOpen size={15} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      <div className="taskbar-cell taskbar-right">
        <button className="ghost-btn" onClick={onOpenQueue}>
          <ListOrdered size={15} strokeWidth={1.5} />
          队列 {queueCount}
        </button>
      </div>
    </footer>
  );
}

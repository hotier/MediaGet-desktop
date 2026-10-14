/**
 * 下载页：队列视图（进度/暂停/继续/取消/打开位置）
 */
import { useEffect, useState } from "react";
import { api } from "../lib/bridge";
import type { DownloadTaskView } from "../../../types/ipc";

export default function DownloadsPage(): React.ReactElement {
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);

  useEffect(() => {
    void api.download.list().then(setTasks).catch(() => {});
    const offs = [
      api.download.onProgress((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onDone((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onError((t) => setTasks((prev) => upsert(prev, t))),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  async function act(fn: (id: string) => Promise<unknown>, id: string): Promise<void> {
    try {
      await fn(id);
      setTasks(await api.download.list());
    } catch {
      /* 状态竞争（已完成再取消等）忽略 */
    }
  }

  return (
    <section className="page">
      {tasks.length === 0 ? (
        <div className="empty">
          <p>暂无下载任务。解析成功后点「下载」即入队。</p>
          <p className="hint">断点续传：重启后未完成任务自动恢复；.part 存在则 Range 续传。</p>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>文件</th>
              <th>状态</th>
              <th>进度</th>
              <th>速度</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.taskId}>
                <td className="name" title={t.error ?? t.filename}>
                  <div className="fname">{t.filename}</div>
                  {t.platform && <span className="chip">{t.platform}</span>}
                </td>
                <td>
                  <StatusChip status={t.status} />
                </td>
                <td className="prog">
                  {t.total > 0 ? (
                    <>
                      <div className="bar">
                        <div className="bar-in" style={{ width: `${Math.min(100, (t.received / t.total) * 100)}%` }} />
                      </div>
                      <span className="hint">
                        {fmtBytes(t.received)} / {fmtBytes(t.total)}
                      </span>
                    </>
                  ) : t.status === "downloading" ? (
                    <span className="hint">{fmtBytes(t.received)}…</span>
                  ) : (
                    <span className="hint">—</span>
                  )}
                </td>
                <td>{t.speed > 0 ? `${fmtBytes(t.speed)}/s` : "—"}</td>
                <td className="ops">
                  {t.status === "downloading" && (
                    <button onClick={() => void act(api.download.pause, t.taskId)}>暂停</button>
                  )}
                  {(t.status === "paused" || t.status === "error" || t.status === "canceled") && (
                    <button onClick={() => void act(api.download.resume, t.taskId)}>
                      {t.status === "error" ? "重试" : "继续"}
                    </button>
                  )}
                  {(t.status === "queued" || t.status === "downloading" || t.status === "paused") && (
                    <button onClick={() => void act(api.download.cancel, t.taskId)}>取消</button>
                  )}
                  {t.status === "done" && t.filePath && (
                    <button onClick={() => void api.app.showInFolder(t.filePath!)}>位置</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function upsert(list: DownloadTaskView[], t: DownloadTaskView): DownloadTaskView[] {
  const i = list.findIndex((x) => x.taskId === t.taskId);
  if (i < 0) return [t, ...list];
  const next = [...list];
  next[i] = t;
  return next;
}

function StatusChip({ status }: { status: DownloadTaskView["status"] }): React.ReactElement {
  const map: Record<string, [string, string]> = {
    queued: ["排队", ""],
    downloading: ["下载中", "ok"],
    paused: ["已暂停", "warn"],
    done: ["完成", "ok"],
    error: ["失败", "warn"],
    canceled: ["已取消", ""],
  };
  const [label, cls] = map[status] ?? [status, ""];
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

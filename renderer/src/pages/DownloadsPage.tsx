/**
 * 下载页：队列视图（进度/暂停/继续/取消/打开位置）。
 * 批量图集按 groupId 聚合：组头显示聚合进度与完成数、可折叠、支持组级全部暂停/继续；
 * 单任务组不显示组头（保持原单行形态）。数据契约不变（DownloadTaskView.groupId 已有）。
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/bridge";
import type { AppMeta, DownloadTaskView } from "../../../types/ipc";
import { PlatformIcon } from "../components/PlatformIcon";

interface TaskGroup {
  groupId: string;
  tasks: DownloadTaskView[];
}

export default function DownloadsPage({ meta }: { meta: AppMeta | null }): React.ReactElement {
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void api.download.list().then(setTasks).catch(() => {});
    const offs = [
      api.download.onProgress((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onDone((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onError((t) => setTasks((prev) => upsert(prev, t))),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const groups = useMemo<TaskGroup[]>(() => {
    const byId = new Map<string, TaskGroup>();
    for (const t of tasks) {
      let g = byId.get(t.groupId);
      if (!g) {
        g = { groupId: t.groupId, tasks: [] };
        byId.set(t.groupId, g);
      }
      g.tasks.push(t);
    }
    return [...byId.values()];
  }, [tasks]);

  async function act(fn: (id: string) => Promise<unknown>, id: string): Promise<void> {
    try {
      await fn(id);
      setTasks(await api.download.list());
    } catch {
      /* 状态竞争（已完成再取消等）忽略 */
    }
  }

  function toggleGroup(groupId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  const nameOf = (key?: string): string | undefined =>
    key ? meta?.platforms.find((p) => p.key === key)?.name ?? key : undefined;

  if (tasks.length === 0) {
    return (
      <section className="page">
        <div className="empty">
          <div className="empty-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M4 21h16" />
            </svg>
          </div>
          <div className="empty-title">暂无下载任务</div>
          <p>解析成功后点「下载」即入队；批量图集会整组显示进度。</p>
          <p className="hint">断点续传：重启后未完成任务自动恢复；.part 存在则 Range 续传。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.groupId);
        if (g.tasks.length === 1) {
          return (
            <div className="card slim" key={g.groupId}>
              <table className="table">
                <TaskHead />
                <TaskTableBody tasks={g.tasks} onAct={act} hidePlatform={false} nameOf={nameOf} />
              </table>
            </div>
          );
        }
        const done = g.tasks.filter((t) => t.status === "done").length;
        const recv = g.tasks.reduce((s, t) => s + t.received, 0);
        const total = g.tasks.reduce((s, t) => s + Math.max(t.total, 0), 0);
        const anyActive = g.tasks.some(
          (t) => t.status === "downloading" || t.status === "queued"
        );
        const anyPaused = g.tasks.some((t) => t.status === "paused");
        const title = g.tasks.find((t) => t.title)?.title ?? g.tasks[0].filename;
        const platform = g.tasks.find((t) => t.platform)?.platform;
        return (
          <div className="card" key={g.groupId}>
            <div className="download-row group-head">
              <button className="group-toggle" onClick={() => toggleGroup(g.groupId)} aria-expanded={!isCollapsed}>
                {isCollapsed ? "▸" : "▾"}
              </button>
              <span className="card-title fname" title={title}>
                {title}
              </span>
              {platform && (
                <span className="chip chip-icon">
                  <PlatformIcon platform={platform} />
                  {nameOf(platform)}
                </span>
              )}
              <span className="hint num">
                {done}/{g.tasks.length} 完成
              </span>
              <span className="prog group-prog">
                <div className="bar">
                  <div
                    className="bar-in"
                    style={{ width: total > 0 ? `${Math.min(100, (recv / total) * 100)}%` : "0%" }}
                  />
                </div>
              </span>
              <span className="ops">
                {anyActive && (
                  <button
                    onClick={() =>
                      void (async () => {
                        for (const t of g.tasks) {
                          if (t.status === "downloading" || t.status === "queued")
                            await act(api.download.pause, t.taskId);
                        }
                      })()
                    }
                  >
                    全部暂停
                  </button>
                )}
                {anyPaused && (
                  <button
                    onClick={() =>
                      void (async () => {
                        for (const t of g.tasks)
                          if (t.status === "paused") await act(api.download.resume, t.taskId);
                      })()
                    }
                  >
                    继续全部
                  </button>
                )}
              </span>
            </div>
            {!isCollapsed && (
              <table className="table">
                <TaskTableBody tasks={g.tasks} onAct={act} hidePlatform nameOf={nameOf} />
              </table>
            )}
          </div>
        );
      })}
    </section>
  );
}

function TaskHead(): React.ReactElement {
  return (
    <thead>
      <tr>
        <th>文件</th>
        <th>状态</th>
        <th>进度</th>
        <th>速度</th>
        <th />
      </tr>
    </thead>
  );
}

function TaskTableBody({
  tasks,
  onAct,
  hidePlatform,
  nameOf,
}: {
  tasks: DownloadTaskView[];
  onAct: (fn: (id: string) => Promise<unknown>, id: string) => Promise<void>;
  hidePlatform: boolean;
  nameOf: (key?: string) => string | undefined;
}): React.ReactElement {
  return (
    <tbody>
      {tasks.map((t) => (
        <tr key={t.taskId}>
          <td className="name" title={t.error ?? t.filename}>
            <div className="fname">{t.filename}</div>
            {!hidePlatform && t.platform && (
              <span className="chip chip-icon">
                <PlatformIcon platform={t.platform} />
                {nameOf(t.platform)}
              </span>
            )}
          </td>
          <td>
            <StatusChip status={t.status} />
          </td>
          <td className="prog">
            {t.total > 0 ? (
              <>
                <div className="bar">
                  <div
                    className="bar-in"
                    style={{ width: `${Math.min(100, (t.received / t.total) * 100)}%` }}
                  />
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
              <button onClick={() => void onAct(api.download.pause, t.taskId)}>暂停</button>
            )}
            {(t.status === "paused" || t.status === "error" || t.status === "canceled") && (
              <button onClick={() => void onAct(api.download.resume, t.taskId)}>
                {t.status === "error" ? "重试" : "继续"}
              </button>
            )}
            {(t.status === "queued" || t.status === "downloading" || t.status === "paused") && (
              <button onClick={() => void onAct(api.download.cancel, t.taskId)}>取消</button>
            )}
            {t.status === "done" && t.filePath && (
              <button onClick={() => void api.app.showInFolder(t.filePath!)}>位置</button>
            )}
          </td>
        </tr>
      ))}
    </tbody>
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

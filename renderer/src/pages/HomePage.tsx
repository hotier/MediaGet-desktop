/**
 * 首页（汇聚页，零新 IPC）：一句主张 + 进行中任务摘要 + 最近历史。
 * 视觉纪律：同屏不超过约两屏内容，留白优先；强调色只来自 --accent（当前魔法色）。
 */
import { useEffect, useState } from "react";
import { ArrowUpRight, ClipboardPaste } from "lucide-react";
import { api } from "../lib/bridge";
import type { AppMeta, DownloadTaskView, HistoryEntry } from "../../../types/ipc";
import { PlatformIcon } from "../components/PlatformIcon";
import { fmtBytes } from "./DownloadsPage";

type Page = "parse" | "downloads" | "history" | "settings";

export default function HomePage({
  tasks,
  meta,
  onNav,
}: {
  tasks: DownloadTaskView[];
  meta: AppMeta | null;
  onNav: (p: Page) => void;
}): React.ReactElement {
  const [recent, setRecent] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    void api.history.list({ limit: 5 }).then(setRecent).catch(() => {});
  }, []);

  const running = tasks.filter((t) => t.status === "downloading" || t.status === "queued");
  const recv = running.reduce((s, t) => s + t.received, 0);
  const total = running.reduce((s, t) => s + Math.max(t.total, 0), 0);
  const pct = total > 0 ? Math.min(100, (recv / total) * 100) : 0;

  return (
    <section className="page home">
      <div className="hero">
        <h1 className="hero-title">把一条分享链接，变成硬盘里的文件</h1>
        <div className="row">
          <button className="primary" onClick={() => onNav("parse")}>
            <ClipboardPaste size={15} strokeWidth={1.5} />
            去粘贴解析
          </button>
          <button onClick={() => onNav("downloads")}>
            队列{running.length > 0 ? `（${running.length} 个进行中）` : ""}
          </button>
        </div>
      </div>

      {running.length > 0 && (
        <div className="card">
          <div className="card-title">进行中</div>
          <div className="bar">
            <div className="bar-in" style={{ width: `${pct}%` }} />
          </div>
          <div className="hint num">
            {fmtBytes(recv)} / {fmtBytes(total)} · {running.length} 个任务
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title-row">
          <span className="card-title">最近下载</span>
          <button className="ghost-btn" onClick={() => onNav("history")}>
            全部历史 <ArrowUpRight size={14} strokeWidth={1.5} />
          </button>
        </div>
        {recent.length === 0 ? (
          <p className="hint">还没有记录。解析成功后点「下载」，完成的历史会出现在这里。</p>
        ) : (
          <ul className="home-recent">
            {recent.map((h) => (
              <li key={h.id}>
                <span className="chip chip-icon">
                  <PlatformIcon platform={h.platform} />
                  {(h.platform && meta?.platforms.find((p) => p.key === h.platform)?.name) ||
                    h.platform ||
                    "本地"}
                </span>
                <span className="fname" title={h.title ?? ""}>
                  {h.title ?? "（未命名）"}
                </span>
                <span className="hint">{new Date(h.createdAt).toLocaleString("zh-CN")}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

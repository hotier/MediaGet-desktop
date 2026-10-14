/**
 * 历史页：列式表格（作品 / 类型 / 大小 / 时间 / 操作）。
 * 同一 groupId 的图集条目聚合成一行（N 个 · 总大小）；标题单行截断、悬浮看全文。
 * 旧记录缺 kind/bytes/sourceUrl（本版本前写入）显示「—」优雅降级；不存直链（§3 隐私）。
 */
import { useEffect, useState } from "react";
import { FolderOpen, Link2 } from "lucide-react";
import { api } from "../lib/bridge";
import type { AppMeta, HistoryEntry } from "../../../types/ipc";
import { PlatformIcon } from "../components/PlatformIcon";
import { fmtBytes } from "./DownloadsPage";

const KIND_LABEL: Record<string, string> = {
  video: "视频",
  image: "图集",
  audio: "音频",
  file: "文件",
};

interface Row {
  key: string;
  platform?: string;
  title: string;
  kind?: string;
  bytes?: number;
  count: number;
  createdAt: number;
  firstFile?: string;
  sourceUrl?: string;
}

export default function HistoryPage({ meta }: { meta: AppMeta | null }): React.ReactElement {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [platform, setPlatform] = useState<string>("");
  const [toast, setToast] = useState<string>("");

  useEffect(() => {
    void api.history.list(platform ? { platform } : undefined).then(setList).catch(() => {});
  }, [platform]);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  const nameOf = (key?: string): string =>
    (key && meta?.platforms.find((p) => p.key === key)?.name) || key || "";

  const seenPlatforms = Array.from(new Set(list.map((h) => h.platform).filter(Boolean)));

  // store 返回新在前；按首次出现序聚组即保持倒序
  const rows: Row[] = (() => {
    const byGroup = new Map<string, HistoryEntry[]>();
    for (const h of list) {
      const key = h.groupId ?? h.id;
      const g = byGroup.get(key);
      if (g) g.push(h);
      else byGroup.set(key, [h]);
    }
    return [...byGroup.entries()].map(([key, g]) => {
      const head = g[0];
      const count = g.reduce((s, e) => s + e.files.length, 0);
      return {
        key,
        platform: head.platform,
        title: head.title ?? "（未命名）",
        kind: head.kind,
        bytes: g.every((e) => e.bytes === undefined) ? undefined : g.reduce((s, e) => s + (e.bytes ?? 0), 0),
        count,
        createdAt: Math.max(...g.map((e) => e.createdAt)),
        firstFile: g.flatMap((e) => e.files)[0],
        sourceUrl: g.find((e) => e.sourceUrl)?.sourceUrl,
      };
    });
  })();

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <section className="page">
      <div className="toolbar">
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">全部平台</option>
          {seenPlatforms.map((p) => (
            <option key={p} value={p}>
              {nameOf(p)}
            </option>
          ))}
        </select>
        <button
          className="danger"
          onClick={() => {
            if (confirm("清空全部下载历史？（不删除已下载文件）")) {
              void api.history.clear().then(() => setList([]));
            }
          }}
        >
          清空历史
        </button>
      </div>

      {toast && <div className="banner info">{toast}</div>}

      {rows.length === 0 ? (
        <div className="empty">
          <div className="empty-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3.5 2" />
            </svg>
          </div>
          <div className="empty-title">暂无历史记录</div>
          <p>下载成功的条目会自动记录在这里。</p>
        </div>
      ) : (
        <div className="card">
          <table className="table history-table">
            <thead>
              <tr>
                <th className="col-work">作品</th>
                <th>类型</th>
                <th>大小</th>
                <th>时间</th>
                <th className="col-ops" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="name">
                    <span className="ht-work">
                      {r.platform && <PlatformIcon platform={r.platform} />}
                      <span className="fname" title={r.title}>{r.title}</span>
                      {r.count > 1 && <span className="chip">{r.count} 个</span>}
                    </span>
                  </td>
                  <td className="hint">{r.kind ? KIND_LABEL[r.kind] ?? r.kind : "—"}</td>
                  <td className="hint num">{r.bytes !== undefined ? fmtBytes(r.bytes) : "—"}</td>
                  <td className="hint num">{fmtTime(r.createdAt)}</td>
                  <td className="ht-ops">
                    {r.firstFile && (
                      <button
                        className="icon-btn"
                        title="打开位置"
                        onClick={() => void api.app.showInFolder(r.firstFile!)}
                      >
                        <FolderOpen size={15} strokeWidth={1.5} />
                      </button>
                    )}
                    {r.sourceUrl ? (
                      <button
                        className="icon-btn"
                        title="复制分享链接"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(r.sourceUrl!)
                            .then(() => setToast("已复制分享链接"))
                            .catch(() => setToast("复制失败"))
                        }
                      >
                        <Link2 size={15} strokeWidth={1.5} />
                      </button>
                    ) : (
                      <button className="icon-btn" disabled title="该记录未保存分享链接（此后生效）">
                        <Link2 size={15} strokeWidth={1.5} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

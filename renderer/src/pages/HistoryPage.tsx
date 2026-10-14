/**
 * 历史页：只展示平台/标题/时间/落地文件（**不存直链** —— 隐私与时效，§3）
 */
import { useEffect, useState } from "react";
import { api } from "../lib/bridge";
import type { HistoryEntry } from "../../../types/ipc";

export default function HistoryPage(): React.ReactElement {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [platform, setPlatform] = useState<string>("");

  useEffect(() => {
    void api.history.list(platform ? { platform } : undefined).then(setList).catch(() => {});
  }, [platform]);

  return (
    <section className="page">
      <div className="toolbar">
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">全部平台</option>
          {Array.from(new Set(list.map((h) => h.platform).filter(Boolean))).map((p) => (
            <option key={p} value={p}>
              {p}
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

      {list.length === 0 ? (
        <div className="empty">
          <p>暂无历史记录。</p>
          <p className="hint">历史只记平台 / 标题 / 时间 / 落地路径，不保存直链。</p>
        </div>
      ) : (
        <ul className="history-list">
          {list.map((h) => (
            <li key={h.id} className="card slim">
              <div className="row1">
                {h.platform && <span className="chip">{h.platform}</span>}
                <span className="fname">{h.title ?? "（未命名）"}</span>
                <span className="hint">{new Date(h.createdAt).toLocaleString("zh-CN")}</span>
              </div>
              {h.files.length > 0 && (
                <div className="row2">
                  {h.files.map((f) => (
                    <button
                      key={f}
                      className="linkish"
                      title={f}
                      onClick={() => void api.app.showInFolder(f)}
                    >
                      {f.split(/[\\/]/).pop()}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

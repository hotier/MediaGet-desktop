/**
 * 应用外壳：四页（解析 / 下载 / 历史 / 设置）极简 tab 路由。
 * renderer 不引 react-router —— 桌面四固定页，state 路由足够（减法优先）。
 */
import { useEffect, useState } from "react";
import { api, BridgeError } from "./lib/bridge";
import type { AppMeta } from "../../types/ipc";
import ParsePage from "./pages/ParsePage";
import DownloadsPage from "./pages/DownloadsPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";

type Page = "parse" | "downloads" | "history" | "settings";

const PAGES: Array<{ key: Page; label: string }> = [
  { key: "parse", label: "解析" },
  { key: "downloads", label: "下载" },
  { key: "history", label: "历史" },
  { key: "settings", label: "设置" },
];

export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>("parse");
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [bootError, setBootError] = useState<string>("");
  const [update, setUpdate] = useState<string>("");

  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch((e: unknown) =>
        setBootError(e instanceof BridgeError ? e.message : String(e))
      );
    return api.app.onUpdateAvailable((info) => setUpdate(info.version));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">即刻解析</span>
          {meta && (
            <span className="meta-chip" title="内核形态：local=本地内核 / online=线上回落 / mock=骨架演示">
              v{meta.version} · {meta.kernelMode}
            </span>
          )}
        </div>
        <nav className="tabs">
          {PAGES.map((p) => (
            <button
              key={p.key}
              className={page === p.key ? "tab active" : "tab"}
              onClick={() => setPage(p.key)}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </header>

      {update && (
        <div className="banner info">发现新版本 {update}，重启应用即自动更新。</div>
      )}
      {bootError && (
        <div className="banner error">
          桥接未就绪：{bootError}
          <div className="hint">请用 npm run dev（或安装版）启动，而非浏览器直接打开。</div>
        </div>
      )}

      <main className="content">
        {page === "parse" && <ParsePage meta={meta} />}
        {page === "downloads" && <DownloadsPage />}
        {page === "history" && <HistoryPage />}
        {page === "settings" && <SettingsPage meta={meta} />}
      </main>
    </div>
  );
}

/**
 * 应用外壳（Air 四区布局）：玻璃侧栏 220 / 悬浮玻璃顶栏 60（全局粘贴入口）/
 * 主内容（页面切换淡入上移）/ 悬浮玻璃底部任务条 80（App 层订阅，跨页存活）。
 * renderer 不引 react-router —— 桌面固定五页，state 路由足够（减法优先）。
 */
import { useEffect, useRef, useState } from "react";
import {
  ClipboardList,
  History,
  Home,
  ListOrdered,
  Settings,
} from "lucide-react";
import { api, BridgeError } from "./lib/bridge";
import { setTheme } from "./lib/theme";
import { useAccent } from "./lib/accent";
import type { AppMeta, DownloadTaskView } from "../../types/ipc";
import ParsePage from "./pages/ParsePage";
import DownloadsPage from "./pages/DownloadsPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import HomePage from "./pages/HomePage";
import { Taskbar } from "./components/Taskbar";

type Page = "home" | "parse" | "downloads" | "history" | "settings";

const PAGES: Array<{ key: Page; label: string; hotkey: string; icon: React.ReactNode }> = [
  { key: "home", label: "首页", hotkey: "⌃1", icon: <Home size={16} strokeWidth={1.5} /> },
  { key: "parse", label: "解析", hotkey: "⌃2", icon: <ClipboardList size={16} strokeWidth={1.5} /> },
  { key: "downloads", label: "队列", hotkey: "⌃3", icon: <ListOrdered size={16} strokeWidth={1.5} /> },
  { key: "history", label: "历史", hotkey: "⌃4", icon: <History size={16} strokeWidth={1.5} /> },
  { key: "settings", label: "设置", hotkey: "⌃5", icon: <Settings size={16} strokeWidth={1.5} /> },
];

export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>("home");
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [bootError, setBootError] = useState<string>("");
  const [update, setUpdate] = useState<string>("");
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  const [cover, setCover] = useState<string | null>(null);
  const [topText, setTopText] = useState("");
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const nonceRef = useRef(0);
  const topInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch((e: unknown) =>
        setBootError(e instanceof BridgeError ? e.message : String(e))
      );
    // 主题首帧接线：设置读不到就维持 system（Token 基座 :root=dark）
    void api.settings
      .get()
      .then((s) => setTheme(s.theme))
      .catch(() => {});
    return api.app.onUpdateAvailable((info) => setUpdate(info.version));
  }, []);

  // 魔法色：当前封面主色驱动 --accent-color（400ms 渐变在 :root 声明）
  useAccent(cover);

  // 任务流在 App 层订阅：底条跨页存活（事件幂等 upsert）
  useEffect(() => {
    void api.download.list().then(setTasks).catch(() => {});
    const offs = [
      api.download.onProgress((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onDone((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onError((t) => setTasks((prev) => upsert(prev, t))),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // L1 应用内快捷键（UIUX-DESIGN §3.4，页面级动作）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === ",") {
        e.preventDefault();
        setPage("settings");
        return;
      }
      if (e.key === "k") {
        e.preventDefault();
        topInputRef.current?.focus();
        return;
      }
      const idx = ["1", "2", "3", "4", "5"].indexOf(e.key);
      if (idx >= 0) {
        e.preventDefault();
        setPage(PAGES[idx].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submitTop(): void {
    const t = topText.trim();
    if (!t) return;
    nonceRef.current += 1;
    setSeed({ text: t, nonce: nonceRef.current });
    setPage("parse");
    setTopText("");
  }

  return (
    <div className="app air">
      <nav className="sidebar" aria-label="页面导航">
        <div className="brand">
          <span className="logo">即刻解析</span>
        </div>
        {PAGES.map((p) => (
          <button
            key={p.key}
            className={page === p.key ? "tab active" : "tab"}
            onClick={() => setPage(p.key)}
          >
            <span className="tab-ico">{p.icon}</span>
            <span>{p.label}</span>
            <span className="kbd">{p.hotkey}</span>
          </button>
        ))}
        {meta && (
          <span className="meta-chip" title="内核形态：local=本地内核 / online=线上回落 / mock=骨架演示">
            v{meta.version} · {meta.kernelMode}
          </span>
        )}
      </nav>

      <div className="air-main">
        <header className="topbar">
          <input
            ref={topInputRef}
            value={topText}
            onChange={(e) => setTopText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTop();
            }}
            placeholder="粘贴分享链接，Ctrl+K 直达 · Enter 解析"
            spellCheck={false}
            aria-label="全局粘贴入口"
          />
          <button className="primary" onClick={submitTop} disabled={!topText.trim()}>
            解析
          </button>
        </header>

        <main className="content" key={page}>
          {update && (
            <div className="banner info">发现新版本 {update}，正在后台下载安装，退出后自动生效。</div>
          )}
          {bootError && (
            <div className="banner error">
              桥接未就绪：{bootError}
              <div className="hint">请用 npm run dev（或安装版）启动，而非浏览器直接打开。</div>
            </div>
          )}
          {page === "home" && <HomePage tasks={tasks} meta={meta} onNav={setPage} />}
          {page === "parse" && (
            <ParsePage
              meta={meta}
              seed={seed}
              onCover={setCover}
              onGoSettings={() => setPage("settings")}
            />
          )}
          {page === "downloads" && <DownloadsPage meta={meta} />}
          {page === "history" && <HistoryPage meta={meta} />}
          {page === "settings" && <SettingsPage meta={meta} />}
        </main>

        <Taskbar tasks={tasks} cover={cover} onOpenQueue={() => setPage("downloads")} />
      </div>
    </div>
  );
}

function upsert(list: DownloadTaskView[], t: DownloadTaskView): DownloadTaskView[] {
  const i = list.findIndex((x) => x.taskId === t.taskId);
  if (i < 0) return [t, ...list];
  const next = [...list];
  next[i] = t;
  return next;
}

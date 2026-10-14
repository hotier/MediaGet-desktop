/**
 * 应用外壳（shadcn/ui + Tailwind 基线，2026-10-14 对标 Motrix v2）：
 * 侧栏 208 / 标题栏 / 主内容三区，导航与状态件走组件库（Button/Badge/Tooltip）。
 * renderer 不引 react-router —— 桌面固定四页，state 路由足够。
 * 解析工作台已并入首页（2026-10-14）：首页 Textarea 是唯一输入面，
 * Ctrl+K 跳首页并聚焦它；顶栏只留页面标题。
 * 样式写在 utility 里，`styles.css` 只剩 Token 与少数无法 utility 化的规则（拖拽区、滚动条）。
 */
import { useEffect, useRef, useState } from "react";
import { History, Home, ListOrdered, Settings } from "lucide-react";
import { api, BridgeError } from "./lib/bridge";
import { setTheme } from "./lib/theme";
import { useAccent } from "./lib/accent";
import type { AppMeta, DownloadTaskView, UpdateState } from "../../types/ipc";
import DownloadsPage from "./pages/DownloadsPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import HomePage from "./pages/HomePage";
import { UpdateBanner } from "./components/Update";
import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";

type Page = "home" | "downloads" | "history" | "settings";

const PAGES: Array<{ key: Page; label: string; hotkey: string; icon: React.ReactNode }> = [
  { key: "home", label: "首页", hotkey: "⌃1", icon: <Home size={16} strokeWidth={1.5} /> },
  { key: "downloads", label: "队列", hotkey: "⌃2", icon: <ListOrdered size={16} strokeWidth={1.5} /> },
  { key: "history", label: "历史", hotkey: "⌃3", icon: <History size={16} strokeWidth={1.5} /> },
  { key: "settings", label: "设置", hotkey: "⌃4", icon: <Settings size={16} strokeWidth={1.5} /> },
];

export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>("home");
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [bootError, setBootError] = useState<string>("");
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  const [cover, setCover] = useState<string | null>(null);
  const workspaceInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch((e: unknown) => setBootError(e instanceof BridgeError ? e.message : String(e)));
    // 主题首帧接线：设置读不到就维持 system（Token 基座 :root=dark）
    void api.settings
      .get()
      .then((s) => setTheme(s.theme))
      .catch(() => {});
    // 更新快照先取一次：窗口未建/隐藏期间的事件会丢，横幅要能补上真实阶段
    void api.app.update.state().then(setUpdate).catch(() => {});
    return api.app.update.onState(setUpdate);
  }, []);

  // 魔法色：当前封面主色驱动 --accent-color（400ms 渐变在 :root 声明）
  useAccent(cover);

  // 任务流在 App 层订阅：首页的进行中任务跨页存活（事件幂等 upsert）
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
        // 唯一输入面在首页：不在首页先切页，等这一帧渲染完再聚焦
        setPage("home");
        setTimeout(() => workspaceInputRef.current?.focus(), 0);
        return;
      }
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      if (idx >= 0) {
        e.preventDefault();
        setPage(PAGES[idx].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const running = tasks.filter((t) => t.status === "downloading" || t.status === "queued").length;
  const pageTitle = PAGES.find((p) => p.key === page)?.label ?? "";

  return (
    <TooltipProvider>
      <div className="flex h-full flex-row bg-background text-foreground text-sm">
        <nav className="drag-region flex w-(--w-side) shrink-0 flex-col gap-1 border-r border-border bg-panel py-3 ps-2 pe-2" aria-label="页面导航">
          <div className="px-2 pb-4 text-[15px] font-semibold tracking-wide">即刻解析</div>

          {PAGES.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPage(p.key)}
              aria-current={page === p.key ? "page" : undefined}
              className="no-drag flex h-9 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=page]:bg-secondary aria-[current=page]:text-foreground aria-[current=page]:font-medium"
            >
              {p.icon}
              <span>{p.label}</span>
              {p.key === "downloads" && running > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="ok" className="ms-auto">
                      {running}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{running} 个任务进行中</TooltipContent>
                </Tooltip>
              )}
              <span className={running > 0 && p.key === "downloads" ? "ms-1 text-[11px] text-faint font-mono" : "ms-auto text-[11px] text-faint font-mono"}>
                {p.hotkey}
              </span>
            </button>
          ))}

          {meta && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="mt-auto px-2 py-2 text-[11px] text-disabled font-mono">
                  v{meta.version} · {meta.kernelMode}
                </div>
              </TooltipTrigger>
              <TooltipContent>内核形态：local=本地内核 / online=线上回落 / mock=骨架演示</TooltipContent>
            </Tooltip>
          )}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="drag-region flex h-11 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
            <span className="text-sm font-medium text-muted-foreground">{pageTitle}</span>
          </header>

          <main key={page} className="flex-1 overflow-y-auto p-4 animate-in fade-in slide-in-from-bottom-1 duration-200">
            {update && <UpdateBanner state={update} onState={setUpdate} />}
            {bootError && (
              <Alert variant="destructive" className="mb-3">
                <AlertTitle>桥接未就绪：{bootError}</AlertTitle>
                <AlertDescription>请用 npm run dev（或安装版）启动，而非浏览器直接打开。</AlertDescription>
              </Alert>
            )}
            {page === "home" && (
              <HomePage
                tasks={tasks}
                meta={meta}
                inputRef={workspaceInputRef}
                onCover={setCover}
                onNav={setPage}
              />
            )}
            {page === "downloads" && <DownloadsPage />}
            {page === "history" && <HistoryPage meta={meta} />}
            {page === "settings" && <SettingsPage meta={meta} update={update} onUpdateState={setUpdate} />}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function upsert(list: DownloadTaskView[], t: DownloadTaskView): DownloadTaskView[] {
  const i = list.findIndex((x) => x.taskId === t.taskId);
  if (i < 0) return [t, ...list];
  const next = [...list];
  next[i] = t;
  return next;
}

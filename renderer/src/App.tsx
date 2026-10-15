/**
 * 应用外壳（shadcn/ui + Tailwind 基线，2026-10-14 对标 Motrix v2）：
 * 侧栏 208 / 主内容两区，导航与状态件走组件库（Button/Badge/Tooltip）。
 * renderer 不引 react-router —— 桌面固定四页，state 路由足够。
 * 解析工作台已并入首页（2026-10-14）：首页 Textarea 是唯一输入面，
 * Ctrl+K 跳首页并聚焦它；顶栏已移除（页面标题不再占一行）。
 * 样式写在 utility 里，`styles.css` 只剩 Token 与少数无法 utility 化的规则（拖拽区、滚动条）。
 */
import { useEffect, useRef, useState } from "react";
import { Download, History, Home, ListOrdered, Settings } from "lucide-react";
import { api, BridgeError } from "./lib/bridge";
import { setFontSize, setTheme, setThemeStyle, setFontFamily } from "./lib/theme";
import type { AppMeta, DownloadTaskView, UpdateState } from "../../types/ipc";
import DownloadsPage from "./pages/DownloadsPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import HomePage from "./pages/HomePage";
import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";

type Page = "home" | "downloads" | "history";

const PAGES: Array<{ key: Page; label: string; icon: React.ReactNode }> = [
  { key: "home", label: "首页", icon: <Home size={16} strokeWidth={1.5} /> },
  { key: "downloads", label: "队列", icon: <ListOrdered size={16} strokeWidth={1.5} /> },
  { key: "history", label: "历史", icon: <History size={16} strokeWidth={1.5} /> },
];

export default function App(): React.ReactElement {
  const [page, setPage] = useState<Page>("home");
  /** 设置模式：侧栏导航整体被设置导航覆盖，Esc/返回 退出（SettingsPage 内部把关脏状态） */
  const [settingsMode, setSettingsMode] = useState(false);
  /** 进入设置模式时选中的分类；下载图标带 "about" 直达「关于」 */
  const [settingsEntry, setSettingsEntry] = useState<string | null>(null);
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [bootError, setBootError] = useState<string>("");
  const [update, setUpdate] = useState<UpdateState | null>(null);
  /** 更新策略两开关（设置→关于）：静默流水线跑完（下载好安装包）后侧栏才亮下载图标 */
  const [updatePolicy, setUpdatePolicy] = useState({ onStartup: false, autoDownload: false });
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  /** 队列页右键「查看作品信息」带过来的定位目标（历史页行 key） */
  const [historyFocus, setHistoryFocus] = useState<string | null>(null);
  /** 剪贴板监听命中的链接（main 端已识别）：交给首页输入面填入；seq 让同值复填可重触发 */
  const [clipboardFill, setClipboardFill] = useState<{ url: string; platform: string; seq: number } | null>(null);
  const clipboardSeq = useRef(0);
  const workspaceInputRef = useRef<HTMLTextAreaElement | null>(null);

  /** 读更新策略两开关：启动一次，退出设置模式时再读（保存即影响侧栏下载图标显示条件） */
  const loadUpdatePolicy = () =>
    api.settings
      .get()
      .then((s) => setUpdatePolicy({ onStartup: s.updateOnStartup, autoDownload: s.updateAutoDownload }))
      .catch(() => {});

  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch((e: unknown) => setBootError(e instanceof BridgeError ? e.message : String(e)));
    // 外观首帧接线（明暗 + 风格 + 字号 + 字体）：设置读不到就维持基座默认（:root=dark、azure、13px、system 字体）
    void api.settings
      .get()
      .then((s) => {
        setTheme(s.theme);
        setThemeStyle(s.themeStyle);
        setFontSize(s.fontSizePx);
        setFontFamily(s.fontFamily);
      })
      .catch(() => {});
    void loadUpdatePolicy();
    // 更新快照先取一次：窗口未建/隐藏期间的事件会丢，横幅要能补上真实阶段
    void api.app.update.state().then(setUpdate).catch(() => {});
    return api.app.update.onState(setUpdate);
  }, []);

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

  // 剪贴板监听命中：收下待填（App 层订阅，主页不挂载时也不丢；首页挂载后消费）
  useEffect(
    () =>
      api.app.onClipboardLink((o) => {
        if (!o.url) return;
        clipboardSeq.current += 1;
        setClipboardFill({ url: o.url, platform: o.platform, seq: clipboardSeq.current });
      }),
    []
  );

  // L1 应用内快捷键（UIUX-DESIGN §3.4，页面级动作）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === ",") {
        e.preventDefault();
        setSettingsEntry(null);
        setSettingsMode(true);
        return;
      }
      if (settingsMode) return; // 设置模式下 ⌃1–3 不生效：退出必须走 返回/Esc（脏状态有确认把关）
      if (e.key === "k") {
        e.preventDefault();
        // 唯一输入面在首页：不在首页先切页，等这一帧渲染完再聚焦
        setPage("home");
        setTimeout(() => workspaceInputRef.current?.focus(), 0);
        return;
      }
      const idx = ["1", "2", "3"].indexOf(e.key);
      if (idx >= 0) {
        e.preventDefault();
        setPage(PAGES[idx].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsMode]);

  const running = tasks.filter((t) => t.status === "downloading" || t.status === "queued").length;

  return (
    <TooltipProvider>
      <div className="flex h-full flex-row bg-background text-foreground text-sm">
        {settingsMode ? (
          <SettingsPage
            meta={meta}
            update={update}
            onUpdateState={setUpdate}
            initialCategory={settingsEntry ?? undefined}
            onExit={() => {
              setSettingsMode(false);
              void loadUpdatePolicy();
            }}
          />
        ) : (
          <>
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
            </button>
          ))}

          <div className="mt-auto flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setSettingsEntry(null);
                  setSettingsMode(true);
                }}
                className="no-drag flex h-9 flex-1 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Settings size={16} strokeWidth={1.5} />
                <span>设置</span>
              </button>
              {update?.phase === "downloaded" && updatePolicy.onStartup && updatePolicy.autoDownload && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="更新包已下载完成，去关于页安装"
                      onClick={() => {
                        setSettingsEntry("about");
                        setSettingsMode(true);
                      }}
                      className="no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ok outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <Download size={16} strokeWidth={1.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>更新包已就绪，点「立即重启」安装</TooltipContent>
                </Tooltip>
              )}
            </div>
            {meta && (
              <div className="px-2 py-2 text-[11px] text-disabled font-mono">
                v{meta.version} · {meta.kernelMode}
              </div>
            )}
          </div>
        </nav>

        {/* 裁掉切页入场（统一从左滑入）的滑移出界，不越界探入左侧导航 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <main key={page} className="flex-1 overflow-y-auto p-4 animate-in fade-in duration-200 slide-in-from-left-3">
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
                onNav={setPage}
                clipboardFill={clipboardFill}
                onClipboardFillDone={() => setClipboardFill(null)}
              />
            )}
            {page === "downloads" && (
              <DownloadsPage
                meta={meta}
                onNav={(target, groupId) => {
                  setHistoryFocus(groupId);
                  setPage(target);
                }}
              />
            )}
            {page === "history" && <HistoryPage meta={meta} focusKey={historyFocus} />}
          </main>
        </div>
          </>
        )}
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

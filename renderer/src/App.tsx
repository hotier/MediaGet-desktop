/**
 * 应用外壳（shadcn/ui + Tailwind 基线，2026-10-14 对标 Motrix v2）：
 * 侧栏 208 / 主内容两区，导航与状态件走组件库（Button/Badge/Tooltip）。
 * renderer 不引 react-router —— 桌面固定五页，state 路由足够。
 * 解析工作台已并入首页（2026-10-14）：首页 Textarea 是唯一输入面，
 * Ctrl+K 跳首页并聚焦它；顶栏已移除（页面标题不再占一行）。
 * 样式写在 utility 里，`styles.css` 只剩 Token 与少数无法 utility 化的规则（拖拽区、滚动条）。
 */
import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { PanelLeftCloseIcon } from "./components/ui/panel-left-close";
import { PanelLeftOpenIcon } from "./components/ui/panel-left-open";
import { useReducedMotion } from "motion/react";
import { NAV_ITEMS, SETTINGS_GLYPHS, type AnimGlyphHandle, type NavKey } from "./lib/nav-icons";
import { SIDEBAR_COLLAPSED_KEY, parseSidebarCollapsed, serializeSidebarCollapsed } from "./lib/sidebar-pref";
import { AnimIcon } from "./components/AnimIcon";
import { BrandLogo } from "./components/BrandLogo";
import { api, BridgeError } from "./lib/bridge";
import { cn } from "./lib/utils";
import { setFontSize, setTheme, setThemeStyle, setFontFamily } from "./lib/theme";
import { hydratePlatformSwitches } from "./store/platforms";
import type { AppMeta, DownloadTaskView, UpdateState } from "../../types/ipc";
import DownloadsPage from "./pages/DownloadsPage";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import HomePage from "./pages/HomePage";
// 统计页懒加载：ECharts 摇树后仍有 ~625 KB（Node 侧 eval 48 ms），只在用户真打开第 5 页时才进渲染进程
const StatsPage = lazy(() => import("./pages/StatsPage"));
import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Skeleton } from "./components/ui/skeleton";
import { Toaster } from "./components/ui/sonner";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";

/** 页面键与导航项的真源在 `lib/nav-icons.ts`（那张表的顺序就是 ⌃1–4 的映射顺序） */
type Page = NavKey;

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
  /** 设置钮字形的受控触发（悬停驱动，AnimIcon 只管导航那种 active 布尔） */
  const settingsGlyphRef = useRef<AnimGlyphHandle>(null);
  /** 品牌行收起/展开钮字形：同款悬停驱动（字形只占 16px，按钮 36px——不驱动的话悬停按钮边缘字形不动） */
  const collapseGlyphRef = useRef<AnimGlyphHandle>(null);
  const expandGlyphRef = useRef<AnimGlyphHandle>(null);
  const reducedMotion = useReducedMotion();
  /** 侧栏收起（规格 2026-10-20）：UI chrome，localStorage 自管，不入 AppSettings（不进脏计数/保存条） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    parseSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)),
  );
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, serializeSidebarCollapsed(next));
      return next;
    });
  }, []);
  /** 导航字形的句柄槽（手动起跑）：四枚 key 固定，useRef 存一组稳定的 ref 形对象 */
  const navGlyphRefs = useRef<Record<NavKey, { current: AnimGlyphHandle | null }>>({
    home: { current: null },
    downloads: { current: null },
    history: { current: null },
    stats: { current: null },
  });
  /** 切页时同步起跑字形动画（点击/快捷键共用）：不等 React 卸旧页挂新页，事件帧就见动 */
  const startNavGlyph = useCallback(
    (key: NavKey) => {
      if (!reducedMotion) navGlyphRefs.current[key].current?.startAnimation();
    },
    [reducedMotion],
  );

  /** 队列行 → 历史页定位。稳定引用：DownloadsPage 的行是 memo 组件，内联箭头会让每行都被判「变了」 */
  const navToHistory = useCallback((target: "history", groupId: string) => {
    setHistoryFocus(groupId);
    setPage(target);
  }, []);
  /** 统计页平台榜 → 历史页只看这个平台。seq 让「连着点同一个平台」也能重放这次意图 */
  const [historyPlatform, setHistoryPlatform] = useState<{ key: string; seq: number } | null>(null);
  const historyPlatformSeq = useRef(0);
  const navToHistoryPlatform = useCallback((platform: string) => {
    historyPlatformSeq.current += 1;
    setHistoryPlatform({ key: platform, seq: historyPlatformSeq.current });
    setHistoryFocus(null);
    setPage("history");
  }, []);
  /** 历史页多选「重新解析」送来的链接：切到首页并交给那唯一一块输入面。
   *  与 clipboardFill 同一形状（seq 让「同一批再送一次」也能重放，否则同值 setState 不触发消费 effect） */
  const [homeReparse, setHomeReparse] = useState<{ links: string[]; seq: number } | null>(null);
  const homeReparseSeq = useRef(0);
  const requestHomeReparse = useCallback((links: string[]) => {
    homeReparseSeq.current += 1;
    setHomeReparse({ links, seq: homeReparseSeq.current });
    setPage("home");
  }, []);
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
        // 平台开关覆盖层复用这一次读，不再多打一遍 IPC
        hydratePlatformSwitches(s.platformSwitches);
      })
      .catch(() => {});
    void loadUpdatePolicy();
    // 更新快照先取一次：窗口未建/隐藏期间的事件会丢，横幅要能补上真实阶段
    void api.app.update.state().then(setUpdate).catch(() => {});
    return api.app.update.onState(setUpdate);
  }, []);

  // 任务流在 App 层订阅：首页的进行中任务跨页存活（事件幂等 upsert）
  useEffect(() => {
    // 侧栏徽标与首页队列轨只关心未完成与失败的行：分两页取，不把整条无限队列拉进渲染层。
    // 这一处静默是有意的：同一次失败由队列页出声（避免两条同文 toast）
    void Promise.all([
      api.download.list({ status: "active", limit: 100 }),
      api.download.list({ status: "error", limit: 100 }),
    ])
      .then(([active, failed]) => setTasks([...active.rows, ...failed.rows]))
      .catch(() => {});
    const offs = [
      api.download.onProgress((t) => {
        setTasks((prev) => upsert(prev, t));
        // 403 自动续链成功时静默重试并通过 toast 告知用户
        if (t.note && t.status === "downloading") {
          toast.info(t.note);
        }
      }),
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
      if (settingsMode) return; // 设置模式下 ⌃1–4 不生效：退出必须走 返回/Esc（脏状态有确认把关）
      if (e.key === "k") {
        e.preventDefault();
        // 唯一输入面在首页：不在首页先切页，等这一帧渲染完再聚焦
        startNavGlyph("home");
        setPage("home");
        setTimeout(() => workspaceInputRef.current?.focus(), 0);
        return;
      }
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      if (idx >= 0) {
        e.preventDefault();
        startNavGlyph(NAV_ITEMS[idx].key);
        setPage(NAV_ITEMS[idx].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsMode, startNavGlyph]);

  const running = tasks.filter((t) => t.status === "downloading" || t.status === "queued").length;

  return (
    <TooltipProvider>
      {/* 浮空 toast 容器：portal 到 body、固定定位，不占内容流（业主指令 2026-10-15）。
          挂在 Provider 内、全部页面之外，所以切页不打断正在显示的提示。 */}
      <Toaster />
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
        <nav
          aria-label="页面导航"
          className={cn(
            "drag-region flex shrink-0 flex-col gap-1 overflow-hidden border-r border-border bg-panel pb-3 ps-2 pe-2",
            "transition-[width] duration-200 motion-reduce:transition-none",
            sidebarCollapsed ? "w-(--w-side-collapsed)" : "w-(--w-side)",
          )}
        >
          {/* 品牌行：展开 = 字标（垂直落点=「页面顶 0px」与「导航栏顶 56px」的中点，带中心下移 8px）
              + 收起钮在字标右侧（业主 2026-10-20）；收起 = 只剩展开钮，不渲染 logo（同日定稿）。
              收起态容器转 justify-center 并去掉 px-3：56px 里再抠 24px 内边距会把 w-9 按钮压扁（整分支审查 I1），
              居中后按钮落在 40px 内容列内、与导航项同轴。
              mb-3 + 列表 gap-1 = 16px，首个导航项与右侧内容（带高 40 + main 的 p-4）都落在 56px 这条线上 */}
          <div
            className={cn(
              "mb-3 flex h-(--wco-h) items-center",
              sidebarCollapsed ? "justify-center" : "px-3",
            )}
          >
            {sidebarCollapsed ? (
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label="展开导航栏"
                aria-expanded={false}
                onMouseEnter={() => {
                  if (!reducedMotion) expandGlyphRef.current?.startAnimation();
                }}
                onMouseLeave={() => expandGlyphRef.current?.stopAnimation()}
                className="no-drag mx-auto flex h-9 w-9 translate-y-2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <PanelLeftOpenIcon ref={expandGlyphRef} size={16} className="anim-icon" aria-hidden="true" />
              </button>
            ) : (
              <>
                <BrandLogo className="h-[18px] w-auto translate-y-2" />
                <button
                  type="button"
                  onClick={toggleSidebar}
                  aria-label="收起导航栏"
                  aria-expanded={true}
                  onMouseEnter={() => {
                    if (!reducedMotion) collapseGlyphRef.current?.startAnimation();
                  }}
                  onMouseLeave={() => collapseGlyphRef.current?.stopAnimation()}
                  className="no-drag ms-auto flex h-9 w-9 translate-y-2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <PanelLeftCloseIcon ref={collapseGlyphRef} size={16} className="anim-icon" aria-hidden="true" />
                </button>
              </>
            )}
          </div>

          {NAV_ITEMS.map((it) => {
            const btn = (
              <button
                type="button"
                onClick={() => {
                  startNavGlyph(it.key);
                  setPage(it.key);
                }}
                aria-current={page === it.key ? "page" : undefined}
                aria-label={it.label}
                className={cn(
                  "no-drag relative flex h-9 items-center gap-2.5 rounded-md text-sm text-muted-foreground outline-none transition-colors",
                  "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  "aria-[current=page]:bg-secondary aria-[current=page]:text-foreground aria-[current=page]:font-medium",
                  sidebarCollapsed ? "w-9 justify-center px-0" : "px-3",
                )}
              >
                {/* 切换那一下的入场动效：起跑在点击/快捷键事件里同步发生（startNavGlyph），
                    AnimIcon 只管离场复位——提交新页再起跑会吃进整页挂载的延迟 */}
                <AnimIcon
                  Icon={it.Icon}
                  active={page === it.key}
                  manualStart
                  glyphRef={navGlyphRefs.current[it.key]}
                />
                {!sidebarCollapsed && <span>{it.label}</span>}
                {it.key === "downloads" && running > 0 && !sidebarCollapsed && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="ok" className="ms-auto">
                        {running}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>{running} 个任务进行中</TooltipContent>
                  </Tooltip>
                )}
                {/* 收起态徽标缩为图标右上角角标：数字是窄条里唯一非文字信息，不随文字一起消失 */}
                {it.key === "downloads" && running > 0 && sidebarCollapsed && (
                  <Badge
                    variant="ok"
                    className="absolute right-0.5 top-0.5 h-3.5 min-w-3.5 px-1 py-0 text-[9px] leading-none"
                  >
                    {running}
                  </Badge>
                )}
              </button>
            );
            // 收起态包 Tooltip（side="right"）；aria-label 已保证无文字时屏幕阅读器可读
            return sidebarCollapsed ? (
              <Fragment key={it.key}>
                <Tooltip>
                  <TooltipTrigger asChild>{btn}</TooltipTrigger>
                  <TooltipContent side="right">{it.label}</TooltipContent>
                </Tooltip>
              </Fragment>
            ) : (
              <Fragment key={it.key}>{btn}</Fragment>
            );
          })}

          <div className={cn("mt-auto flex items-center gap-1", sidebarCollapsed && "flex-col")}>
            {(() => {
              const settingsBtn = (
                <button
                  type="button"
                  onClick={() => {
                    setSettingsEntry(null);
                    setSettingsMode(true);
                  }}
                  onMouseEnter={() => {
                    if (!reducedMotion) settingsGlyphRef.current?.startAnimation();
                  }}
                  onMouseLeave={() => settingsGlyphRef.current?.stopAnimation()}
                  aria-label="设置"
                  className={cn(
                    "no-drag flex h-9 items-center gap-2.5 rounded-md text-sm text-muted-foreground outline-none transition-colors",
                    "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    sidebarCollapsed ? "w-9 justify-center px-0" : "flex-1 px-3",
                  )}
                >
                  {/* 悬停驱动（挂 ref 后组件自身不响应 hover，见 components/AnimIcon.tsx）；离开即 stop——settings 是整枚回转，不复位也能复播，但与其他字形统一语义 */}
                  <SETTINGS_GLYPHS.entry ref={settingsGlyphRef} size={16} className="anim-icon" aria-hidden="true" />
                  {!sidebarCollapsed && <span>设置</span>}
                </button>
              );
              return sidebarCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>{settingsBtn}</TooltipTrigger>
                  <TooltipContent side="right">设置</TooltipContent>
                </Tooltip>
              ) : (
                settingsBtn
              );
            })()}
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
        </nav>

        {/* 裁掉切页入场（统一从左滑入）的滑移出界，不越界探入左侧导航 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 顶栏带：系统的三枚按钮浮在它右端，所以这条带只用来拖窗、不放控件；页面内容一律从它下面起 */}
          <div aria-hidden className="drag-region h-(--wco-h) shrink-0" />
          {/* scrollbar-gutter：细槽（styles.css 的 scrollbar-width: thin）仍占宽度，
              结果卡展开资源清单把内容推过一屏时，槽位出现/消失会让整列卡片左右抽动 ——
              常驻预留，宽度只跟窗口走。 */}
          <main
            key={page}
            className="flex-1 overflow-y-auto p-4 animate-in fade-in duration-200 slide-in-from-left-3 [scrollbar-gutter:stable]"
          >
            {bootError && (
              <Alert variant="destructive" className="mb-3">
                <AlertTitle>桥接未就绪：{bootError}</AlertTitle>
                <AlertDescription>请用 npm run dev（或安装版）启动，而非浏览器直接打开。</AlertDescription>
              </Alert>
            )}
            {page === "home" && (
              <HomePage
                tasks={tasks}
                inputRef={workspaceInputRef}
                onNav={setPage}
                onOpenSettings={(category) => {
                  setSettingsEntry(category);
                  setSettingsMode(true);
                }}
                clipboardFill={clipboardFill}
                onClipboardFillDone={() => setClipboardFill(null)}
                reparseFill={homeReparse}
                onReparseFillDone={() => setHomeReparse(null)}
              />
            )}
            {page === "downloads" && <DownloadsPage onNav={navToHistory} />}
            {page === "history" && (
              <HistoryPage focusKey={historyFocus} platformFocus={historyPlatform} onReparse={requestHomeReparse} />
            )}
            {page === "stats" && (
              <Suspense
                fallback={
                  <div className="flex flex-col gap-3">
                    <Skeleton className="h-28" />
                    <Skeleton className="h-64" />
                  </div>
                }
              >
                <StatsPage onNavPlatform={navToHistoryPlatform} />
              </Suspense>
            )}
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

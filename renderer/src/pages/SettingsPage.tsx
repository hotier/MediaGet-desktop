/**
 * 设置模式独立页（2026-10-15）：侧栏整体覆盖主页面导航——一级分类即粒度，
 * 不做二级导航：选中分类后右侧直接堆叠展示该分类下全部可设置项。
 * 脏状态按分类跟踪，切分类/退出有未保存改动时浮层把关
 * （修 UIUX-DESIGN 缺陷 §「切页静默丢未保存内容」：旧版局部 state 切页即卸载）。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Cpu,
  Download,
  FolderOpen,
  Info,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { api, BridgeError } from "../lib/bridge";
import { fmtBytes } from "../lib/format";
import { CACHE_ITEMS as SETTINGS_CACHE_ITEMS } from "../lib/cache-items";
import { setFontSize, setTheme, setThemeStyle, setFontFamily } from "../lib/theme";
import type {
  AppMeta,
  AppSettings,
  BinaryStatusReport,
  CacheStatus,
  EngineHealth,
  UpdateState,
} from "../../../types/ipc";
import { CONTRACT_VERSION } from "../../../types/ipc";
import { PLATFORMS, displayName, isEnabled } from "../../../shared/platforms";
import { usePlatformStore } from "../store/platforms";
import { PlatformIcon } from "../components/PlatformIcon";
import { UpdateActions } from "../components/Update";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { HintInfo, Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { FontPicker } from "../components/FontPicker";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

/**
 * Cookie 行：只有「哪个环境变量对哪个平台」这一件新信息 ——
 * 平台名一律查注册表（displayName），不再在这里手抄第二遍；
 * 键必须是**契约键**（`redbook` 而非上游路由别名 `xhs`），否则与体检行的 platform 对不上。
 */
const COOKIE_ROWS: Array<{ key: string; platform: string; note: string }> = [
  { key: "BILIBILI_COOKIE", platform: "bilibili", note: "强烈建议：提升大会员清晰度与风控通过率" },
  { key: "DOUYIN_COOKIE", platform: "douyin", note: "可选：仅增强" },
  { key: "XHS_COOKIE", platform: "redbook", note: "可选" },
  { key: "IG_COOKIE", platform: "instagram", note: "强烈建议：游客几乎必被风控" },
  { key: "QQMUSIC_COOKIE", platform: "qqmusic", note: "可选：source+id 试听 vkey" },
];

/** 体检表列宽：table-fixed 下不设宽的「平台」列吃剩余；其余按 `1.5rem + Nem` 定宽（与队列/历史页同口径，跟字号档缩放） */
const ENGINE_COL = {
  /** max(开关 w-11, 「提供」二字 + info 图标) */
  supply: "w-[calc(1.5rem+3.5em)]",
  /** 最宽形态是徽标「未配置」 */
  cookie: "w-[calc(1.5rem+4.2em)]",
  /** 最宽形态是徽标「本地内核」 */
  channel: "w-[calc(1.5rem+5.2em)]",
} as const;

/** 标量字段归属哪个设置区块（脏计数/放弃都以区块为粒度）；Cookie 字段的区块 id = 其 key */
const SCALAR_SECTION: Partial<Record<keyof AppSettings, string>> = {
  launchAtLogin: "startup",
  minimizeToTray: "window",
  notifyOnDone: "notify",
  notifyOnError: "notify",
  clipboardWatch: "clipboard",
  logLevel: "log",
  logRetentionDays: "log",
  downloadDir: "dir",
  maxConcurrent: "load",
  throttleMs: "load",
  proxyMode: "proxy",
  proxyUrl: "proxy",
  openFolderOnDone: "post",
  retryTimes: "post",
  keepPartials: "post",
  defaultQuality: "post",
  theme: "theme",
  themeStyle: "theme",
  fontSizePx: "font",
  fontFamily: "font",
  fallbackOnline: "fallback",
  onlineApiBase: "fallback",
  updateOnStartup: "about",
  updateAutoDownload: "about",
};
const SCALAR_FIELDS = Object.keys(SCALAR_SECTION) as (keyof AppSettings)[];

const CATEGORIES: Array<{
  id: string;
  label: string;
  icon: typeof Download;
  sections: string[];
}> = [
  { id: "general", label: "通用", icon: SlidersHorizontal, sections: ["startup", "window", "notify", "clipboard", "cache", "log"] },
  { id: "download", label: "下载", icon: Download, sections: ["dir", "load", "proxy", "post"] },
  { id: "appearance", label: "外观", icon: Palette, sections: ["theme", "font"] },
  { id: "engine", label: "引擎", icon: Cpu, sections: ["fallback", "engines", ...COOKIE_ROWS.map((r) => r.key)] },
  { id: "about", label: "关于", icon: Info, sections: ["about"] },
];

/** 数值档位下拉：常用选项 + 自定义（选中后下拉框变输入框）；min/max 与契约同区间 */
const CONC_OPTIONS = [1, 2, 3, 5, 8, 10];
const THROTTLE_OPTIONS = [0, 200, 500, 1000, 2000, 5000];

/** 界面字号候选：契约允许 11–18，常用四档 + 自定义；默认 13 */
const FONT_OPTIONS = [12, 13, 14, 15];

/** 日志级别档位：与契约 enum 同序（off / error / warn / info） */
const LOG_LEVELS: Array<{ value: AppSettings["logLevel"]; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "error", label: "仅错误" },
  { value: "warn", label: "错误 + 警告" },
  { value: "info", label: "全部" },
];
/** 保留天数：契约允许 1–90，常用四档 + 自定义 */
const LOG_RETENTION_OPTIONS = [3, 7, 14, 30];

/**
 * 缓存项文案与展示顺序见 `lib/cache-items.ts`（统计页报同一份占用，名字必须同源）。
 * clearable=false 的两项（update / records）只显示占用，不进清理名单。
 */
const CACHE_ITEMS = SETTINGS_CACHE_ITEMS;

/** 主题风格（= 完整主题色带，styles.css 层 1.5 的真源；这里只登记顺序、文案与色点类） */
const THEME_STYLES: Array<{ id: AppSettings["themeStyle"]; label: string; dot: string }> = [
  { id: "azure", label: "蓝白", dot: "bg-(--wc-dot-azure)" },
  { id: "indigo", label: "靛蓝", dot: "bg-(--wc-dot-indigo)" },
  { id: "teal", label: "湖青", dot: "bg-(--wc-dot-teal)" },
  { id: "slate", label: "石墨", dot: "bg-(--wc-dot-slate)" },
  { id: "violet", label: "幽蓝", dot: "bg-(--wc-dot-violet)" },
];

/** 字体族候选数据源：主进程 font-list 枚举（进程内缓存）；模块级 stable 引用，避免 FontPicker 反复重载 */
const fetchInstalledFonts = (): Promise<string[]> => api.app.listFonts();

function validateApiBase(v: string): string | null {
  if (!v.trim()) return "不能为空";
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "需为 http(s) 地址";
    return null;
  } catch {
    return "不是有效 URL（需含协议，如 https://example.com）";
  }
}

export default function SettingsPage({
  meta,
  update,
  onUpdateState,
  onExit,
  initialCategory,
}: {
  meta: AppMeta | null;
  update: UpdateState | null;
  onUpdateState: (s: UpdateState) => void;
  onExit: () => void;
  /** 进入设置模式时默认选中的分类（侧栏下载图标直达「关于」；缺省 download） */
  initialCategory?: string;
}): React.ReactElement {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [cookieEdits, setCookieEdits] = useState<Record<string, string>>({});
  const [cookieClears, setCookieClears] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState(initialCategory ?? "download");
  const [engines, setEngines] = useState<EngineHealth[]>([]);
  const [bins, setBins] = useState<BinaryStatusReport | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [baseTest, setBaseTest] = useState<{ state: "idle" | "testing" | "ok" | "fail"; msg?: string }>({ state: "idle" });
  const [pending, setPending] = useState<{ type: "switch"; to: string } | { type: "exit" } | null>(null);
  /** Cookie 弹窗：打开的 COOKIE_ROWS key + 草稿文本（打开时从已暂存的编辑值预填） */
  const [cookieKey, setCookieKey] = useState<string | null>(null);
  const [cookieDraft, setCookieDraft] = useState("");
  /**
   * 本地缓存：扫描是「读磁盘」而非设置草稿，所以不进脏计数——
   * 进「通用」分类时统计一次，之后只由「重新统计 / 清理」刷新；清理结果即时生效，不等「保存」。
   */
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState("");
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const cacheScanned = useRef(false);
  /**
   * 平台开关活在 Zustand 而不是本页草稿：它即时落盘、即时生效，与「保存」无关，
   * 所以不进脏计数（和上面「本地缓存」同一套语义）。
   */
  const switches = usePlatformStore((s) => s.switches);
  const setPlatformEnabled = usePlatformStore((s) => s.setEnabled);

  useEffect(() => {
    void api.settings
      .get()
      .then((s) => {
        setSaved(s);
        setDraft(structuredClone(s));
      })
      .catch(() => {});
    void api.probe.engines().then(setEngines).catch(() => {});
    void api.app.getBinaryStatus().then(setBins).catch(() => {});
  }, []);

  // 外观预览：改动即所见；放弃/退出时回落到已保存值
  useEffect(() => {
    if (draft) setTheme(draft.theme);
  }, [draft?.theme]);

  useEffect(() => {
    if (draft) setThemeStyle(draft.themeStyle);
  }, [draft?.themeStyle]);

  useEffect(() => {
    if (draft) setFontSize(draft.fontSizePx);
  }, [draft?.fontSizePx]);

  useEffect(() => {
    if (draft) setFontFamily(draft.fontFamily);
  }, [draft?.fontFamily]);

  const scanCache = useCallback(async (): Promise<void> => {
    setCacheBusy(true);
    setCacheError("");
    try {
      setCache(await api.app.cacheStatus());
    } catch (e) {
      setCacheError(e instanceof BridgeError ? e.message : String(e));
    } finally {
      setCacheBusy(false);
    }
  }, []);

  // 首次进入「通用」才扫（不在启动路径上读盘）；此后靠「重新统计」按钮
  useEffect(() => {
    if (sel !== "general" || cacheScanned.current) return;
    cacheScanned.current = true;
    void scanCache();
  }, [sel, scanCache]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Esc 退出设置模式（确认浮层打开时由浮层自己处理；焦点在输入类控件里时 Esc 只归控件自己）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || pending) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      requestExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function sectionDirty(section: string): number {
    if (!saved || !draft) return 0;
    let n = 0;
    for (const f of SCALAR_FIELDS) {
      if (SCALAR_SECTION[f] === section && draft[f] !== saved[f]) n++;
    }
    const row = COOKIE_ROWS.find((r) => r.key === section);
    if (row) {
      if ((cookieEdits[row.key] ?? "").trim() !== "") n++;
      if (cookieClears[row.key] && saved.cookies[row.key]) n++;
    }
    return n;
  }

  function catDirty(catId: string): number {
    const cat = CATEGORIES.find((c) => c.id === catId);
    if (!cat) return 0;
    return cat.sections.reduce((n, s) => n + sectionDirty(s), 0);
  }

  function totalDirty(): number {
    return CATEGORIES.reduce((n, c) => n + catDirty(c.id), 0);
  }

  function discardSections(sections: string[]): void {
    if (!saved || !draft) return;
    const next: AppSettings = { ...draft };
    for (const f of SCALAR_FIELDS) {
      const owner = SCALAR_SECTION[f];
      if (owner && sections.includes(owner)) (next as Record<string, unknown>)[f] = (saved as Record<string, unknown>)[f];
    }
    const cookieKeys = COOKIE_ROWS.map((r) => r.key).filter((k) => sections.includes(k));
    if (cookieKeys.length > 0) {
      setCookieEdits((p) => {
        const c = { ...p };
        for (const k of cookieKeys) delete c[k];
        return c;
      });
      setCookieClears((p) => {
        const c = { ...p };
        for (const k of cookieKeys) delete c[k];
        return c;
      });
    }
    if (sections.includes("fallback")) {
      setBaseUrlError(null);
      setBaseTest({ state: "idle" });
    }
    setDraft(next);
  }

  function discardAll(): void {
    discardSections(CATEGORIES.flatMap((c) => c.sections));
  }

  function openCookie(key: string): void {
    setCookieKey(key);
    setCookieDraft(cookieEdits[key] ?? "");
  }

  /** 确认：非空 = 暂存替换（同时撤清除标记）；空 = 撤销本次编辑（不动已存值，「清除」须点清除按钮） */
  function confirmCookie(): void {
    if (!cookieKey) return;
    const v = cookieDraft.trim();
    if (v) {
      setCookieEdits({ ...cookieEdits, [cookieKey]: v });
      setCookieClears({ ...cookieClears, [cookieKey]: false });
    } else {
      const next = { ...cookieEdits };
      delete next[cookieKey];
      setCookieEdits(next);
    }
    setCookieKey(null);
  }

  function clearCookie(): void {
    if (!cookieKey) return;
    const next = { ...cookieEdits };
    delete next[cookieKey];
    setCookieEdits(next);
    setCookieClears({ ...cookieClears, [cookieKey]: true });
    setCookieKey(null);
  }

  function undoClearCookie(): void {
    if (!cookieKey) return;
    setCookieClears({ ...cookieClears, [cookieKey]: false });
    setCookieKey(null);
  }

  /**
   * 平台开关：store 已做乐观写 + 失败回滚，这里只补两件事——
   * 复检让「通道」列跟着开关变（关掉那行必须立刻显示「注册表已关闭」），失败如实 toast。
   */
  async function togglePlatform(key: string, enabled: boolean): Promise<void> {
    try {
      await setPlatformEnabled(key, enabled);
      setEngines(await api.probe.engines());
    } catch (e) {
      setNotice({
        id: Date.now(),
        text: `${displayName(key)}：开关未能落盘，已回滚（${e instanceof BridgeError ? e.message : String(e)}）`,
      });
    }
  }

  /** Cookie 单元格：状态徽标即入口，点击开弹窗（体检表 Cookie 列） */
  function renderCookieCell(rowKey: string): React.ReactNode {
    const row = COOKIE_ROWS.find((r) => r.key === rowKey);
    if (!row || !saved) return null;
    const configured = Boolean(saved.cookies[rowKey]);
    const clearing = Boolean(cookieClears[rowKey]) && configured;
    const staged = (cookieEdits[rowKey] ?? "").trim() !== "";
    const badge = clearing
      ? { variant: "err" as const, text: "待清除" }
      : staged
        ? { variant: "warn" as const, text: "待保存" }
        : configured
          ? { variant: "ok" as const, text: "已配置" }
          : { variant: "secondary" as const, text: "未配置" };
    return (
      <button
        type="button"
        onClick={() => openCookie(rowKey)}
        aria-label={`设置 ${displayName(row.platform)} Cookie`}
        className="cursor-pointer rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Badge variant={badge.variant} className="font-normal">
          {badge.text}
        </Badge>
      </button>
    );
  }

  function goto(to: string): void {
    if (to === sel) return;
    if (catDirty(sel) > 0) setPending({ type: "switch", to });
    else setSel(to);
  }

  function doExit(): void {
    if (saved) {
      setTheme(saved.theme);
      setFontSize(saved.fontSizePx);
      setFontFamily(saved.fontFamily);
    }
    onExit();
  }

  function requestExit(): void {
    if (totalDirty() > 0) setPending({ type: "exit" });
    else doExit();
  }

  async function save(): Promise<void> {
    if (!saved || !draft) return;
    setSaveError("");
    const cookies: Record<string, string> = {};
    for (const row of COOKIE_ROWS) {
      const v = (cookieEdits[row.key] ?? "").trim();
      if (v) cookies[row.key] = v;
      else if (cookieClears[row.key]) cookies[row.key] = "";
    }
    try {
      const next = await api.settings.set({
        ...draft,
        onlineApiBase: draft.onlineApiBase.trim(),
        cookies,
      });
      setSaved(next);
      setDraft(structuredClone(next));
      setCookieEdits({});
      setCookieClears({});
      setBaseUrlError(null);
      setBaseTest({ state: "idle" });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) {
      setSaveError(e instanceof BridgeError ? e.message : String(e));
    }
  }

  /** 一键清理：点名所有可清且有占用的项；返回的 report 是清理后的新快照，直接刷新表格 */
  async function clearCacheItems(): Promise<void> {
    if (!cache) return;
    const keys = cache.items.filter((i) => i.clearable && i.bytes > 0).map((i) => i.key);
    if (keys.length === 0) return;
    setCacheBusy(true);
    setCacheError("");
    try {
      const r = await api.app.clearCache(keys);
      setCache(r.report);
      const stuck = CACHE_ITEMS.filter((c) => r.skipped.includes(c.key)).map((c) => c.label);
      setNotice({
        id: Date.now(),
        text: `已释放 ${fmtBytes(r.freed)}${stuck.length > 0 ? `；${stuck.join("、")}未能清除` : ""}`,
      });
    } catch (e) {
      setCacheError(e instanceof BridgeError ? e.message : String(e));
    } finally {
      setCacheBusy(false);
      setCacheConfirm(false);
    }
  }

  /** 日志卡片单独清 logs 项（与表格共用同一份快照，避免两处数字打架） */
  async function clearLogs(): Promise<void> {
    setCacheBusy(true);
    setCacheError("");
    try {
      const r = await api.app.clearCache(["logs"]);
      setCache(r.report);
      setNotice({ id: Date.now(), text: `日志已清空，释放 ${fmtBytes(r.freed)}` });
    } catch (e) {
      setCacheError(e instanceof BridgeError ? e.message : String(e));
    } finally {
      setCacheBusy(false);
    }
  }

  async function openLogDir(): Promise<void> {
    try {
      const r = await api.app.openLogDir();
      if (!r.ok) setNotice({ id: Date.now(), text: "日志目录打开失败" });
    } catch {
      setNotice({ id: Date.now(), text: "日志目录打开失败" });
    }
  }

  const loading = !saved || !draft;
  const catNow = CATEGORIES.find((c) => c.id === sel) ?? CATEGORIES[0];
  const cookieRow = COOKIE_ROWS.find((r) => r.key === cookieKey);
  const cookieConfigured = cookieRow ? Boolean(saved?.cookies[cookieRow.key]) : false;
  const cookieClearing = cookieRow ? Boolean(cookieClears[cookieRow.key]) && cookieConfigured : false;

  const nav = (
    <nav
      aria-label="设置导航"
      className="drag-region flex w-(--w-side) shrink-0 flex-col gap-1 border-r border-border bg-panel pb-3 ps-2 pe-2 max-[860px]:hidden"
    >
      {/* 标题行 = 顶栏带（与主外壳的品牌行同款同高），mb-3 + gap-1 = 16px 让首个动作行落在 56px，与右侧内容对齐 */}
      <div className="mb-3 flex h-(--wco-h) items-center px-2 text-[15px] font-semibold tracking-wide">设置</div>
      <button
        type="button"
        onClick={requestExit}
        className="no-drag flex h-9 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeft size={16} strokeWidth={1.5} />
        <span>返回</span>
        <span className="ms-auto text-[11px] text-faint font-mono">Esc</span>
      </button>

      {CATEGORIES.map((cat) => {
        const active = cat.id === sel;
        const dot = catDirty(cat.id) > 0;
        const Icon = cat.icon;
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => goto(cat.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "no-drag flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active && "bg-secondary text-foreground font-medium"
            )}
          >
            <Icon size={16} strokeWidth={1.5} />
            <span>{cat.label}</span>
            {dot && <span className="ms-auto size-1.5 shrink-0 rounded-full bg-warn" aria-label="有未保存更改" />}
          </button>
        );
      })}
    </nav>
  );

  function renderSection(id: string): React.ReactNode {
    if (!saved || !draft) return null;

    switch (id) {
      case "startup":
        return (
          <ItemCard title="启动">
            <Row label="开机自启动" end>
              <Switch
                id="launch-at-login"
                aria-label="开机自启动"
                checked={draft.launchAtLogin}
                onCheckedChange={(v) => setDraft({ ...draft, launchAtLogin: v })}
              />
            </Row>
          </ItemCard>
        );

      case "window":
        return (
          <ItemCard title="窗口行为">
            <Row label="关窗最小化到托盘" end>
              <Switch
                id="minimize-to-tray"
                aria-label="关窗最小化到托盘"
                checked={draft.minimizeToTray}
                onCheckedChange={(v) => setDraft({ ...draft, minimizeToTray: v })}
              />
            </Row>
          </ItemCard>
        );

      case "notify":
        return (
          <ItemCard title="系统通知">
            <Row
              label="下载完成时通知"
              hint="该组全部文件下载结束才弹一次系统通知（按组聚合，图集不会逐张弹）；点击通知回到窗口。"
              end
            >
              <Switch
                id="notify-on-done"
                aria-label="下载完成时通知"
                checked={draft.notifyOnDone}
                onCheckedChange={(v) => setDraft({ ...draft, notifyOnDone: v })}
              />
            </Row>
            <Row
              label="下载失败时通知"
              hint="重试用尽仍失败时弹通知，附失败原因；组内部分成功会连同完成数一起播报。"
              end
            >
              <Switch
                id="notify-on-error"
                aria-label="下载失败时通知"
                checked={draft.notifyOnError}
                onCheckedChange={(v) => setDraft({ ...draft, notifyOnError: v })}
              />
            </Row>
          </ItemCard>
        );

      case "clipboard":
        return (
          <ItemCard title="剪贴板">
            <Row
              label="复制链接自动填入"
              hint="复制到含分享链接的文字后，自动填入首页输入框并开始解析。另有一条全局快捷键 Ctrl+Alt+V（不受本开关限制，按下才读一次）：任意界面唤起主窗口并填入当前剪贴板内容。填入只覆盖空输入框或上一条剪贴板内容，不动手输内容；识别纯本地，文本不出本机。"
              end
            >
              <Switch
                id="clipboard-watch"
                aria-label="复制链接自动填入"
                checked={draft.clipboardWatch}
                onCheckedChange={(v) => setDraft({ ...draft, clipboardWatch: v })}
              />
            </Row>
          </ItemCard>
        );

      case "cache":
        return (
          <ItemCard title="本地缓存" desc="只统计本应用自己产生的临时文件；更新包与本机记录只显示占用，不在清理范围。">
            {cacheError && <p className="text-xs text-err">{cacheError}</p>}
            {cache ? (
              <>
                <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {CACHE_ITEMS.map((meta) => {
                    const item = cache.items.find((i) => i.key === meta.key);
                    const bytes = item?.bytes ?? 0;
                    return (
                      <li key={meta.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="flex items-center gap-1.5">
                          {meta.label}
                          <HintInfo text={meta.hint} />
                        </span>
                        <span className={cn("ms-auto tabular-nums", bytes === 0 && "text-disabled")}>
                          {item ? fmtBytes(bytes) : "—"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    共 {fmtBytes(cache.totalBytes)} · 可清理 {fmtBytes(cache.clearableBytes)}
                  </span>
                  <div className="ms-auto flex gap-2">
                    <Button variant="outline" size="sm" disabled={cacheBusy} onClick={() => void scanCache()}>
                      <RefreshCw />
                      重新统计
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={cacheBusy || cache.clearableBytes === 0}
                      className="text-err hover:bg-transparent hover:text-err"
                      onClick={() => setCacheConfirm(true)}
                    >
                      <Trash2 />
                      清理缓存
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{cacheBusy ? "统计中…" : "尚未统计"}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ms-auto"
                  disabled={cacheBusy}
                  onClick={() => void scanCache()}
                >
                  <RefreshCw />
                  统计
                </Button>
              </div>
            )}
          </ItemCard>
        );

      case "log": {
        const logBytes = cache?.items.find((i) => i.key === "logs")?.bytes ?? 0;
        return (
          <ItemCard title="日志" desc="运行日志写到 userData/logs/app.log，超 2 MB 自动轮转。只记录运行事件，不写入 Cookie 与媒体直链。">
            <Row
              label="日志级别"
              hint="「全部」含启动与队列恢复等常规信息；「关闭」停写新行，已落盘的文件仍在，用下方「清理日志」删除。改动保存后立即生效，无需重启。"
              end
            >
              <Select
                value={draft.logLevel}
                onValueChange={(v) => setDraft({ ...draft, logLevel: v as AppSettings["logLevel"] })}
              >
                <SelectTrigger className="w-36" aria-label="日志级别">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="保留天数" hint="按最后写入时间清理超期的日志文件（当前档也在内，下次写入自动重建）；启动与保存设置时各扫一次。" end>
              <PresetSelect
                value={draft.logRetentionDays}
                options={LOG_RETENTION_OPTIONS}
                min={1}
                max={90}
                fmt={(v) => `${v} 天`}
                ariaLabel="日志保留天数"
                onChange={(v) => setDraft({ ...draft, logRetentionDays: v })}
              />
            </Row>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                日志占用 <span className={cn(logBytes === 0 && "text-disabled")}>{fmtBytes(logBytes)}</span>
                {logBytes === 0 && " · 尚无日志"}
              </span>
              <div className="ms-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void openLogDir()}>
                  <FolderOpen />
                  打开日志目录
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cacheBusy || logBytes === 0}
                  className="text-err hover:bg-transparent hover:text-err"
                  onClick={() => void clearLogs()}
                >
                  <Trash2 />
                  清理日志
                </Button>
              </div>
            </div>
          </ItemCard>
        );
      }

      case "dir":
        return (
          <ItemCard title="下载目录">
            <div className="flex gap-2">
              <Input
                value={draft.downloadDir}
                placeholder="默认：系统下载目录"
                onChange={(e) => setDraft({ ...draft, downloadDir: e.target.value })}
              />
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void api.app.pickDownloadDir().then((dir) => dir && setDraft({ ...draft, downloadDir: dir }))}
              >
                <FolderOpen />
                浏览…
              </Button>
            </div>
          </ItemCard>
        );

      case "load":
        return (
          <ItemCard title="并发与节流">
            <Row label="并发线程（1–10）" hint="同时在下载的任务数；住宅带宽建议 3。" end>
              <PresetSelect
                value={draft.maxConcurrent}
                options={CONC_OPTIONS}
                min={1}
                max={10}
                fmt={(v) => `${v} 线程`}
                ariaLabel="并发线程"
                onChange={(v) => setDraft({ ...draft, maxConcurrent: v })}
              />
            </Row>
            <Row label="温和节流" hint="住宅 IP 也怕高频：平台风控升级时用它降速，默认不限（0–60000 毫秒）。" end>
              <PresetSelect
                value={draft.throttleMs}
                options={THROTTLE_OPTIONS}
                min={0}
                max={60000}
                fmt={(v) => (v === 0 ? "不限" : `${v} ms`)}
                ariaLabel="温和节流"
                onChange={(v) => setDraft({ ...draft, throttleMs: v })}
              />
            </Row>
          </ItemCard>
        );

      case "proxy":
        return (
          <ItemCard title="网络代理">
            <Row
              label="代理模式"
              hint="解析、下载与更新检查的网络请求统一走此代理；「跟随系统」即用 Windows 代理设置（Clash 等系统代理开启时自动生效）。"
              end
            >
              <Select
                value={draft.proxyMode}
                onValueChange={(v) => setDraft({ ...draft, proxyMode: v as AppSettings["proxyMode"] })}
              >
                <SelectTrigger className="w-28" aria-label="代理模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">跟随系统</SelectItem>
                  <SelectItem value="off">直接连接</SelectItem>
                  <SelectItem value="manual">自定义</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {draft.proxyMode === "manual" && (
              <Row label="代理地址" hint="http/https 代理均可（如 127.0.0.1:7897，缺协议自动补 http://）；保存后对新请求生效，地址非法时按直连处理。">
                <Input
                  value={draft.proxyUrl}
                  placeholder="http://127.0.0.1:7897"
                  onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })}
                />
              </Row>
            )}
          </ItemCard>
        );

      case "post":
        return (
          <ItemCard title="完成后与容错">
            <Row label="下载完成自动打开所在目录" hint="每个任务完成即在资源管理器定位该文件；并发下载时会连环弹窗，确认再开。" end>
              <Switch
                id="open-folder-done"
                aria-label="下载完成自动打开所在目录"
                checked={draft.openFolderOnDone}
                onCheckedChange={(v) => setDraft({ ...draft, openFolderOnDone: v })}
              />
            </Row>
            <Row label="失败自动重试" hint="网络错/风控抖动自动重试（指数退避 1s/2s/4s），用尽才标失败；0 = 不重试。" end>
              <PresetSelect
                value={draft.retryTimes}
                options={[0, 1, 2, 3]}
                min={0}
                max={3}
                fmt={(v) => (v === 0 ? "不重试" : `${v} 次`)}
                ariaLabel="失败自动重试次数"
                onChange={(v) => setDraft({ ...draft, retryTimes: v })}
              />
            </Row>
            <Row label="取消任务保留断点文件" hint="开：取消后 .part 留在磁盘，同链接再次入队从断点续；关：取消即删，腾磁盘空间。暂停的断点始终保留。" end>
              <Switch
                id="keep-partials"
                aria-label="取消任务保留断点文件"
                checked={draft.keepPartials}
                onCheckedChange={(v) => setDraft({ ...draft, keepPartials: v })}
              />
            </Row>
            <Row label="默认清晰度" hint="新解析结果的清晰度预选：内核推荐 = 分享页默认那档；最高画质 / 最低画质按内核画质档位取极值。仍可手选覆盖。" end>
              <Select
                value={draft.defaultQuality}
                onValueChange={(v) => setDraft({ ...draft, defaultQuality: v as AppSettings["defaultQuality"] })}
              >
                <SelectTrigger className="w-28" aria-label="默认清晰度">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">内核推荐</SelectItem>
                  <SelectItem value="highest">最高画质</SelectItem>
                  <SelectItem value="lowest">最低画质</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </ItemCard>
        );

      case "theme":
        return (
          <ItemCard title="主题">
            <Row label="主题风格" hint="一套风格 = 一整套主题色（底色/线条/焦点色），深浅色各配一档；改选立即预览。" end>
              <Select
                value={draft.themeStyle}
                onValueChange={(v) => setDraft({ ...draft, themeStyle: v as AppSettings["themeStyle"] })}
              >
                <SelectTrigger className="w-28" aria-label="主题风格">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THEME_STYLES.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2">
                        {/* 色点吃 styles.css 层 1.5 的 --wc-dot-* token：色值真源仍在层 1，不在此复制 */}
                        <span
                          aria-hidden
                          className={`size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/15 ${s.dot}`}
                        />
                        {s.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="明暗主题" hint="选择后立即预览；保存后持久生效。「跟随系统」随 Windows 深浅色自动切换。" end>
              <Select
                value={draft.theme}
                onValueChange={(v) => setDraft({ ...draft, theme: v as AppSettings["theme"] })}
              >
                <SelectTrigger className="w-28" aria-label="明暗主题">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">跟随系统</SelectItem>
                  <SelectItem value="dark">深色</SelectItem>
                  <SelectItem value="light">浅色</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </ItemCard>
        );

      case "font":
        return (
          <ItemCard title="界面字体与字号">
            <Row label="字体族" hint="读取本机已安装字体，可搜索；选中立即预览，保存后持久生效。「系统默认」吃 Segoe UI / 雅黑 基座栈，等宽档不受影响（命令仍用等宽）。" end>
              <FontPicker
                value={draft.fontFamily}
                onChange={(v) => setDraft({ ...draft, fontFamily: v })}
                fetchFonts={fetchInstalledFonts}
                ariaLabel="界面字体族"
              />
            </Row>
            <Row label="正文档位" hint="改选立即预览（整屏跟着变），保存后持久生效。默认 13px，可自定义 12–18px；较小档自动少 1px，较大档多 1px。" end>
              <PresetSelect
                value={draft.fontSizePx}
                options={FONT_OPTIONS}
                min={12}
                max={18}
                fmt={(v) => `${v}px`}
                ariaLabel="界面字号"
                onChange={(v) => setDraft({ ...draft, fontSizePx: v })}
              />
            </Row>
          </ItemCard>
        );

      case "fallback":
        return (
          <ItemCard title="线上回落">
            <Row label="本地失败回落线上 API" hint="上游改版坏消息先到不白屏；纯本地党可关。" end>
              <Switch
                checked={draft.fallbackOnline}
                onCheckedChange={(v) => setDraft({ ...draft, fallbackOnline: v })}
                aria-label="本地失败回落线上 API"
              />
            </Row>
            <Row label="线上 API 基址">
              <div className="flex gap-2">
                <Input
                  value={draft.onlineApiBase}
                  aria-invalid={baseUrlError !== null}
                  onChange={(e) => {
                    setDraft({ ...draft, onlineApiBase: e.target.value });
                    setBaseTest({ state: "idle" });
                  }}
                  onBlur={(e) => setBaseUrlError(validateApiBase(e.target.value))}
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={baseTest.state === "testing"}
                  onClick={() => void testApiBase()}
                >
                  {baseTest.state === "testing" ? "测试中…" : "测试连接"}
                </Button>
              </div>
              {baseUrlError && <p className="text-xs text-err">{baseUrlError}</p>}
              {baseTest.state === "ok" && <Badge variant="ok" className="mt-1">可达 {baseTest.msg}</Badge>}
              {baseTest.state === "fail" && <Badge variant="err" className="mt-1">失败：{baseTest.msg}</Badge>}
            </Row>
          </ItemCard>
        );

      case "engines":
        return (
          <ItemCard title="解析引擎" desc="「提供」列是注册表开关：关掉后主进程在调用任何引擎之前就回绝该平台的解析请求，落盘即生效、不等「保存」。其余列只如实汇报本机体检真相，不发抓取、不打平台风控；Cookie 点徽标弹窗粘贴（仅存本机，风险自负）。">
            {engines.length === 0 ? (
              <p className="text-xs text-muted-foreground">未获取到体检数据。</p>
            ) : (
              <div className="rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>平台</TableHead>
                      <TableHead className={ENGINE_COL.supply}>
                        <span className="flex items-center gap-1.5">
                          提供
                          <HintInfo text="关 = 该平台不再对外供给：解析请求在任何引擎被调用之前就被主进程回绝（已入队的下载不受影响）。即时生效，不需要点「保存」。" />
                        </span>
                      </TableHead>
                      <TableHead className={ENGINE_COL.cookie}>Cookie</TableHead>
                      <TableHead className={ENGINE_COL.channel}>通道</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {engines.map((e) => {
                      const cookie = COOKIE_ROWS.find((r) => r.platform === e.platform);
                      return (
                        <TableRow key={e.platform}>
                          <TableCell className="gap-2">
                            <span className="flex items-center gap-2">
                              <PlatformIcon platform={e.platform} />
                              {e.name}
                            </span>
                          </TableCell>
                          <TableCell className={ENGINE_COL.supply}>
                            <Switch
                              aria-label={`提供 ${e.name} 解析`}
                              checked={isEnabled(e.platform, switches)}
                              onCheckedChange={(v) => void togglePlatform(e.platform, v)}
                            />
                          </TableCell>
                          <TableCell className={ENGINE_COL.cookie}>
                            {cookie ? (
                              renderCookieCell(cookie.key)
                            ) : (
                              <span className="text-xs text-disabled">—</span>
                            )}
                          </TableCell>
                          <TableCell className={ENGINE_COL.channel}>
                            {/* 徽标只有一词，三种真相的完整说明挂在悬浮上（纯说明一瞥走 tooltip，带动作的说明才用弹窗） */}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex cursor-help outline-none">
                                  <EngineToneBadge e={e} />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-72 leading-relaxed">
                                {e.detail ?? "无引擎汇报细节"}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {meta && (
              <p className="text-xs tabular-nums text-muted-foreground">
                版本 v{meta.version} · Electron {meta.electron} · 内核 {meta.kernelMode}
              </p>
            )}
          </ItemCard>
        );

      case "about":
        return (
          <>
            <ItemCard title="更新策略" desc="打包发布态生效；开发环境无发布通道，「手动检测更新」显示「当前运行环境没有更新源」属预期。开关保存后立即生效（启动检测自下次启动读取）。">
              <Row label="启动时自动检测更新" hint="打开应用即静默检查一次 GitHub Releases，不弹窗、不打断；失败留在错误态，可在下方「手动检测更新」重试。" end>
                <Switch
                  aria-label="启动时自动检测更新"
                  checked={draft.updateOnStartup}
                  onCheckedChange={(v) => setDraft({ ...draft, updateOnStartup: v })}
                />
              </Row>
              <Row label="静默下载" hint="开=检测到新版本后自动下载更新包；关（默认）需在下方「手动检测更新」点「下载更新」，不偷跑家庭带宽。" end>
                <Switch
                  aria-label="静默下载"
                  checked={draft.updateAutoDownload}
                  onCheckedChange={(v) => setDraft({ ...draft, updateAutoDownload: v })}
                />
              </Row>
              <Row label="手动检测更新" hint="应用不会自动安装：下载完成后点「立即重启」确认安装（setup 包无静默安装，不随退出进行）。" end>
                {update ? (
                  <UpdateActions state={update} onState={onUpdateState} />
                ) : (
                  <span className="pt-1.5 text-sm text-muted-foreground">未获取到更新状态。</span>
                )}
              </Row>
              <Row label="更新通道" end>
                <span className="pt-2 font-mono text-sm">GitHub Releases</span>
              </Row>
            </ItemCard>

            <ItemCard title="版本信息" desc="客户端版本与框架版本。框架版本 = IPC 契约演进号：主进程与渲染进程共用 types/ipc.ts 单一真源，通道或载荷形状不兼容变更时递增。">
              <Row label="客户端版本" end>
                <span className="pt-2 font-mono text-sm">v{meta?.version ?? "—"}</span>
              </Row>
              <Row label="框架版本" end>
                <span className="pt-2 font-mono text-sm">契约 v{CONTRACT_VERSION} · Electron {meta?.electron ?? "—"}</span>
              </Row>
              <Row label="内核版本" end>
                <span className="pt-2 font-mono text-sm">
                  {meta ? `${meta.kernelMode} · ${PLATFORMS.length} 平台` : "—"}
                </span>
              </Row>
            </ItemCard>

            <ItemCard title="随包二进制" desc="完整性档位如实展示：已校验=有 SHA-256 基线且匹配；降级=无基线（仅定位不校验）；已拒绝=哈希不符（不使用，该平台走线上回落）。">
              {!bins || bins.binaries.length === 0 ? (
                <p className="text-xs text-muted-foreground">未获取到二进制状态。</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {bins.binaries.map((b) => (
                    <li key={b.name} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs">{b.name}</span>
                      <IntegrityBadge integrity={b.integrity} />
                      {b.origin && (
                        <span className="cursor-default text-xs text-muted-foreground">来源 {b.origin}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {bins && !bins.manifestLoaded && (
                <Alert variant="warn">
                  <AlertDescription>
                    未加载到随包 manifest.json：本次不做完整性校验。
                    {import.meta.env.DEV ? (
                      <>
                        开发环境可执行
                        <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-xs">node scripts/fetch-binaries.cjs</code>
                        生成。
                      </>
                    ) : (
                      "请重新安装或下载最新版。"
                    )}
                  </AlertDescription>
                </Alert>
              )}
            </ItemCard>

            <ItemCard title="协议框架" desc="本项目以 MIT 协议开源；下列组件按各自上游协议分发，随包二进制（yt-dlp / ffmpeg）独立于本项目许可证。">
              <Row label="本项目许可" end>
                <span className="pt-2 font-mono text-sm">MIT</span>
              </Row>
              <Row label="主要组件">
                <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 font-mono text-xs text-muted-foreground">
                  <span>Electron · MIT</span>
                  <span>React · MIT</span>
                  <span>Radix UI · MIT</span>
                  <span>shadcn/ui · MIT</span>
                  <span>Tailwind CSS · MIT</span>
                  <span>zod · MIT</span>
                  <span>electron-updater · MIT</span>
                  <span>lucide · ISC</span>
                  <span>yt-dlp · Unlicense</span>
                  <span>FFmpeg · LGPL-2.1+</span>
                </div>
              </Row>
              <Row label="数据边界" hint="设置 / 历史 / 队列 / Cookie 全部只存本机 userData；解析与下载直连平台，不经过任何第三方服务器。" end>
                <span className="pt-2 text-sm">全部本机存储</span>
              </Row>
            </ItemCard>
          </>
        );

      default:
        return null;
    }
  }

  async function testApiBase(): Promise<void> {
    const err = validateApiBase(draft?.onlineApiBase ?? "");
    setBaseUrlError(err);
    if (err || !draft) return;
    setBaseTest({ state: "testing" });
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const url = draft.onlineApiBase.trim().replace(/\/+$/, "") + "/api/engines";
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      setBaseTest({ state: res.ok ? "ok" : "fail", msg: `HTTP ${res.status}` });
    } catch (e) {
      setBaseTest({ state: "fail", msg: e instanceof Error ? e.message : String(e) });
    }
  }

  const dirty = totalDirty();
  const curCatDirty = catDirty(sel);

  return (
    <>
      {nav}

      {/* 裁掉切页入场（统一从左滑入）的滑移出界，不越界探入左侧导航 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶栏带：与主页面同款，系统按钮浮在它右端，分类内容从它下面起 */}
        <div aria-hidden className="drag-region h-(--wco-h) shrink-0" />
        <main key={sel} className="flex-1 overflow-y-auto p-4 animate-in fade-in duration-200 slide-in-from-left-3">
          {/* ≤860px：侧栏隐藏，降级为顶部横向 chip */}
          <div className="mb-4 hidden flex-col gap-2 max-[860px]:flex">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              <Button variant="ghost" size="icon-sm" aria-label="返回" onClick={requestExit}>
                <ArrowLeft />
              </Button>
              {CATEGORIES.map((cat) => (
                <Button
                  key={cat.id}
                  size="sm"
                  variant={cat.id === sel ? "default" : "outline"}
                  aria-pressed={cat.id === sel}
                  className="h-7 shrink-0 rounded-full px-3 text-xs"
                  onClick={() => goto(cat.id)}
                >
                  {cat.label}
                </Button>
              ))}
            </div>
          </div>

          <section className="flex w-full flex-col gap-4">
            {/* 卡片列按窗口宽度动态留 3% 左右边距（别再改回固定值或居中 max-w） */}
            <div className="flex flex-col gap-4 px-[3%]">
              {loading ? (
                <Card>
                  <CardHeader>
                    <Skeleton className="h-5 w-28" />
                  </CardHeader>
                  <CardContent className="flex flex-col gap-5 pb-5">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-2/3" />
                  </CardContent>
                </Card>
              ) : (
                catNow.sections.map((s) => <Fragment key={s}>{renderSection(s)}</Fragment>)
              )}
            </div>

            {/* 保存条保持通底毛玻璃：内衬 = p-4 + 3%，按钮与卡片右缘对齐 */}
            <div className="sticky bottom-0 -mx-4 flex min-h-0 items-center justify-end gap-3 border-t border-transparent px-[calc(1rem_+_3%)] py-0 bg-background/85 backdrop-blur-sm transition-colors">
              {savedFlash && !loading && (
                <div className="flex w-full items-center justify-end gap-3 border-t border-border py-3">
                  <Badge variant="ok">已保存 ✓</Badge>
                </div>
              )}
              {(dirty > 0 || saveError) && !loading && (
                <div className="flex w-full items-center gap-3 border-t border-border bg-warn/5 py-3">
                  {saveError && <span className="ms-auto max-w-[48rem] truncate text-xs text-err" title={saveError}>{saveError}</span>}
                  {dirty > 0 && (
                    <>
                      <span className="ms-auto text-xs text-warn tabular-nums">{dirty} 项未保存</span>
                      {curCatDirty > 0 && (
                        <Button variant="outline" size="sm" onClick={() => discardSections(catNow.sections)}>
                          放弃本类更改
                        </Button>
                      )}
                      <Button size="sm" onClick={() => void save()}>
                        保存
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        </main>
      </div>

      <Dialog open={pending !== null} onOpenChange={(v) => !v && setPending(null)}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>有未保存的更改</DialogTitle>
            <DialogDescription>
              {pending?.type === "exit"
                ? `共 ${dirty} 项未保存，退出将丢弃。`
                : `「${catNow.label}」有 ${curCatDirty} 项未保存，切换将丢弃。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              继续编辑
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pending?.type === "exit") {
                  discardAll();
                  setPending(null);
                  doExit();
                } else if (pending?.type === "switch") {
                  discardSections(catNow.sections);
                  setSel(pending.to);
                  setPending(null);
                }
              }}
            >
              放弃更改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cookieRow !== undefined} onOpenChange={(v) => !v && setCookieKey(null)}>
        {cookieRow && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{displayName(cookieRow.platform)} Cookie</DialogTitle>
              <DialogDescription>
                {cookieRow.note}。浏览器登录该平台后 F12 → Application/存储 → Cookies 复制整串；仅存本机，风险自负。
              </DialogDescription>
            </DialogHeader>
            {cookieClearing ? (
              <p className="text-sm text-err">已标记清除，保存后生效。</p>
            ) : (
              <>
                <Textarea
                  value={cookieDraft}
                  onChange={(e) => setCookieDraft(e.target.value)}
                  placeholder="粘贴 Cookie 整串"
                  aria-label={`${displayName(cookieRow.platform)} Cookie`}
                  className="min-h-24 font-mono text-xs"
                />
                {cookieConfigured && (
                  <p className="text-xs text-muted-foreground">当前已配置；填入新值确认后覆盖，保存后生效。</p>
                )}
              </>
            )}
            <DialogFooter>
              {cookieConfigured && !cookieClearing && (
                <Button
                  variant="ghost"
                  className="me-auto text-err hover:bg-transparent hover:text-err"
                  onClick={clearCookie}
                >
                  <Trash2 />
                  清除
                </Button>
              )}
              {cookieClearing && (
                <Button variant="outline" className="me-auto" onClick={undoClearCookie}>
                  撤销清除
                </Button>
              )}
              <Button variant="outline" onClick={() => setCookieKey(null)}>
                取消
              </Button>
              <Button onClick={confirmCookie} disabled={cookieClearing}>
                确认
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={cacheConfirm} onOpenChange={setCacheConfirm}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>清理本地缓存</DialogTitle>
            <DialogDescription>
              删除网络缓存、孤儿断点与临时残留（约 {fmtBytes(cache?.clearableBytes ?? 0)}）。进行中的下载会被避让，
              本机记录与更新包不动。此操作立即生效，不走「保存」。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCacheConfirm(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={cacheBusy} onClick={() => void clearCacheItems()}>
              清理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {notice &&
        createPortal(
          <div
            key={notice.id}
            role="status"
            className="fixed top-4 right-4 z-50 max-w-[24rem] rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
          >
            {notice.text}
          </div>,
          document.body,
        )}
    </>
  );
}

const CUSTOM_VALUE = "__custom__";

/**
 * 数值档位下拉：常用选项平铺在菜单里，末项「自定义」；选自定义后下拉框原位换成输入框，
 * Enter 提交（非法值留在编辑态提示），失焦合法则提交否则取消，Esc 取消回下拉框。
 * 当前值不在档位里时，触发器显示自定义值、菜单项同步显示，重开可再编辑。
 */
function PresetSelect({
  value,
  options,
  min,
  max,
  fmt,
  ariaLabel,
  onChange,
}: {
  value: number;
  options: number[];
  min: number;
  max: number;
  fmt: (v: number) => string;
  ariaLabel: string;
  onChange: (v: number) => void;
}): React.ReactElement {
  const [customMode, setCustomMode] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isPreset = options.includes(value);

  function startCustom(): void {
    setText(String(value));
    setErr(null);
    setCustomMode(true);
  }

  function commit(): boolean {
    const n = Number(text.trim());
    if (!Number.isInteger(n)) {
      setErr("需为整数");
      return false;
    }
    if (n < min || n > max) {
      setErr(`需在 ${min}–${max} 之间`);
      return false;
    }
    onChange(n);
    setCustomMode(false);
    setErr(null);
    return true;
  }

  if (customMode) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex w-28 items-center gap-2">
          <Input
            ref={inputRef}
            autoFocus
            inputMode="numeric"
            aria-label={`${ariaLabel}（自定义值）`}
            aria-invalid={err !== null}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setCustomMode(false);
            }}
            onBlur={() => {
              if (!commit()) setCustomMode(false);
            }}
          />
        </div>
        {err && <p className="text-xs text-err">{err}</p>}
      </div>
    );
  }

  return (
    <Select
      value={isPreset ? String(value) : CUSTOM_VALUE}
      onValueChange={(v) => {
        if (v === CUSTOM_VALUE) startCustom();
        else onChange(Number(v));
      }}
    >
      <SelectTrigger className="w-28" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={String(o)}>
            {fmt(o)}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={CUSTOM_VALUE}>
          {isPreset ? "自定义…" : `自定义 · ${fmt(value)}`}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function ItemCard({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {title}
          {desc && <HintInfo text={desc} />}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 pb-5">{children}</CardContent>
    </Card>
  );
}

function Row({
  label,
  hint,
  end,
  children,
}: {
  label: string;
  hint?: string;
  /** 控件靠右对齐（下拉/开关等紧凑控件用；输入框等占满列的不加） */
  end?: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-4">
      <div className="flex flex-col gap-1 pt-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {hint && <HintInfo text={hint} />}
        </span>
      </div>
      <div className={cn("flex flex-col gap-1.5", end && "items-end")}>{children}</div>
    </div>
  );
}

const INTEGRITY: Record<string, [string, "ok" | "warn" | "secondary"]> = {
  verified: ["已校验", "ok"],
  degraded: ["降级", "warn"],
  rejected: ["已拒绝", "warn"],
  missing: ["未找到", "secondary"],
};

function IntegrityBadge({
  integrity,
}: {
  integrity: BinaryStatusReport["binaries"][number]["integrity"];
}): React.ReactElement {
  const [label, variant] = INTEGRITY[integrity] ?? [integrity, "secondary"];
  return <Badge variant={variant}>{label}</Badge>;
}

/** 三态通道真相：绿=本地内核直连，蓝=经线上回落，灰=不可用（旧版两色 chip 墙表达不完三种真相） */
function EngineToneBadge({ e }: { e: EngineHealth }): React.ReactElement {
  if (!e.ok) return <Badge variant="outline">不可用</Badge>;
  if (e.detail?.includes("本地")) return <Badge variant="ok">本地内核</Badge>;
  return <Badge variant="info">线上回落</Badge>;
}

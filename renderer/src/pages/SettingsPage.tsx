/**
 * 设置模式独立页（2026-10-15）：侧栏整体覆盖主页面导航——一级分类即粒度，
 * 不做二级导航：选中分类后右侧直接堆叠展示该分类下全部可设置项。
 * 脏状态按分类跟踪，切分类/退出有未保存改动时浮层把关
 * （修 UIUX-DESIGN 缺陷 §「切页静默丢未保存内容」：旧版局部 state 切页即卸载）。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, FolderOpen, KeyRound, RefreshCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "~/lib/utils";
import { api, BridgeError } from "../lib/bridge";
import { fmtBytes } from "../lib/format";
import { CACHE_ITEMS as SETTINGS_CACHE_ITEMS } from "../lib/cache-items";
import { SETTINGS_GLYPHS, type AnimGlyph } from "../lib/nav-icons";
import { setFontSize, setTheme, setThemeStyle, setFontFamily } from "../lib/theme";
import { toSettingsPatch } from "../lib/settings-patch";
import {
  buildFilename,
  type FilenamePreset,
} from "../lib/download-plan";
import type {
  AppMeta,
  AppSettings,
  CacheStatus,
  EngineHealth,
  UpdateState,
} from "../../../types/ipc";
import { CONTRACT_VERSION } from "../../../types/ipc";
import {
  ENGINE_INFO,
  PLATFORMS,
  SWITCHABLE_ENGINE_IDS,
  displayName,
  isEnabled,
  isEngineEnabled,
  primaryEngineOf,
  type SwitchableEngineId,
} from "../../../shared/platforms";
import { isCookieLoginKey } from "../../../shared/cookie-login";
import { usePlatformStore } from "../store/platforms";
import { useEngineStore } from "../store/engines";
import { AnimIcon } from "../components/AnimIcon";
import { BrandLogo } from "../components/BrandLogo";
import { PlatformIcon } from "../components/PlatformIcon";
import { UpdateActions } from "../components/Update";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { HintInfo } from "../components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { FontPicker } from "../components/FontPicker";

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
  { key: "KUAISHOU_COOKIE", platform: "kuaishou", note: "可选：仅作者主页资料（简介/获赞/粉丝数）需要，视频解析不用" },
  { key: "YOUTUBE_COOKIE", platform: "youtube", note: "可选：年龄限制 / 需登录才可见的内容" },
];

/** 体检表列宽：table-fixed 下不设宽的「平台」列吃剩余；其余按 `1.5rem + Nem` 定宽（与队列/历史页同口径，跟字号档缩放） */
const ENGINE_COL = {
  /** 列头「状态」二字；列里是开关，2026-10-21 业主指令三列放宽、不再贴着排 */
  supply: "w-[calc(1.5rem+5em)]",
  /** 最宽形态是徽标「未配置」 */
  cookie: "w-[calc(1.5rem+6.5em)]",
  /** 预留并行多枚徽标的宽度（后续一个平台可能同时挂多条通道） */
  channel: "w-[calc(1.5rem+12em)]",
} as const;

/**
 * 字段是否已改：标量走引用比较即可；`filenameExtra` 是对象，必须按值比 ——
 * 否则 setDraft 每次换新对象都会算「脏」，保存按钮会一直亮着。
 */
function fieldChanged(f: keyof AppSettings, draft: AppSettings, saved: AppSettings): boolean {
  if (f === "filenameExtra") {
    const a = draft.filenameExtra;
    const b = saved.filenameExtra;
    return a.quality !== b.quality || a.index !== b.index;
  }
  return draft[f] !== saved[f];
}

/** 标量字段归属哪个设置区块（脏计数/放弃都以区块为粒度）；Cookie 字段的区块 id = 其 key */
const SCALAR_SECTION: Partial<Record<keyof AppSettings, string>> = {
  launchAtLogin: "system",
  minimizeToTray: "system",
  notifyOnDone: "system",
  notifyOnError: "system",
  clipboardWatch: "system",
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
  filenamePreset: "name",
  filenameExtra: "name",
  theme: "theme",
  themeStyle: "theme",
  fontSizePx: "font",
  fontFamily: "font",
  updateOnStartup: "about",
  updateAutoDownload: "about",
};
const SCALAR_FIELDS = Object.keys(SCALAR_SECTION) as (keyof AppSettings)[];

/** 分类图标：动效字形登记在 `lib/nav-icons.ts` 的 SETTINGS_GLYPHS.categories（键 = id）；
 *  九枚都是官方 shadcn registry 拉入仓的 vendored 组件（components/ui/*，见 nav-icons.ts 头注） */
const CATEGORIES: Array<{
  id: string;
  label: string;
  icon: AnimGlyph;
  sections: string[];
}> = [
  { id: "general", label: "通用", icon: SETTINGS_GLYPHS.categories.general, sections: ["system", "cache", "log"] },
  { id: "download", label: "下载", icon: SETTINGS_GLYPHS.categories.download, sections: ["dir", "name", "load", "proxy", "post"] },
  { id: "appearance", label: "外观", icon: SETTINGS_GLYPHS.categories.appearance, sections: ["theme", "font"] },
  { id: "engine", label: "引擎", icon: SETTINGS_GLYPHS.categories.engine, sections: ["engines", ...COOKIE_ROWS.map((r) => r.key)] },
  { id: "about", label: "关于", icon: SETTINGS_GLYPHS.categories.about, sections: ["about"] },
];

/**
 * 设置搜索索引（2026-10-21）：每个可渲染区块的关键词条 —— 卡片标题 + 行标签 + 常用别名。
 * 只供搜索过滤，不参与渲染；改 renderSection 里的某行文案时顺手同步这里。
 * Cookie 行不单列（它们的卡片在 engines 区块里，平台名已随 PLATFORMS 并入该条）。
 */
const SECTION_SEARCH: Record<string, string> = {
  system: "系统设置 开机自启动 自启 关窗 最小化 托盘 系统通知 下载完成 下载失败 提醒 剪贴板 复制链接 自动填入 快捷键 Ctrl+Alt+V 监听",
  cache: "本地缓存 清理缓存 重新统计 占用 临时文件",
  log: "日志 日志级别 保留天数 清理日志 日志目录",
  dir: "下载目录 存储位置 保存位置 浏览",
  name: "文件命名 命名组合 清晰度 序号 文件名 预览",
  load: "并发与节流 并发线程 温和节流 限速 速度 下载",
  proxy: "网络代理 代理模式 代理地址 直连 跟随系统 Clash",
  post: "完成容错 自动打开目录 失败自动重试 断点 默认清晰度",
  theme: "主题 主题风格 深色 浅色 明暗 跟随系统 外观",
  font: "界面字体 字号 字体族 正文档位 字体",
  // 平台显示名/英文名并入引擎条：搜「小红书」「bilibili」都命中平台配置表
  engines: `引擎开关 引擎 mediaget amagi yt-dlp 失败自动回退 回退 主引擎 平台配置 解析引擎 平台 开关 提供 通道 Cookie 体检 ${PLATFORMS.map((p) => `${p.name} ${p.nameEn}`).join(" ")}`,
  about: "关于 更新 检查更新 静默下载 更新通道 版本 协议 许可 MIT 开源",
};

/** 关键词命中判定：多词按空格拆开、每个词都得命中（「代理 clash」「字体 字号」这类组合可用） */
function searchHit(sectionId: string, tokens: string[]): boolean {
  const text = (SECTION_SEARCH[sectionId] ?? "").toLowerCase();
  return text !== "" && tokens.every((t) => text.includes(t));
}

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
/** 保留天数：契约允许 1–90，常用四档 + 自定义；默认 30 */
const LOG_RETENTION_OPTIONS = [3, 7, 14, 30];

/** 预览用的固定样例：不依赖真实解析数据，随时能看懂规则效果 */
const SAMPLE_TITLE = "秋日通勤穿搭";
const SAMPLE_AUTHOR = "小明";

/**
 * 文件命名预设：下拉文案 + 示例（与 download-plan 的 buildFilename 同一套语义）。
 * 示例只给人看「大概长这样」，真名靠下方实时预览。
 */
const FILENAME_PRESETS: Array<{ value: FilenamePreset; label: string; sample: string }> = [
  { value: "title", label: "仅标题", sample: "{标题}" },
  { value: "authorTitle", label: "作者_标题", sample: "{作者}_{标题}" },
  { value: "titleAuthor", label: "标题_作者", sample: "{标题}_{作者}" },
  { value: "titleDate", label: "标题_日期", sample: "{标题}_20261015" },
  { value: "authorTitleDate", label: "作者_标题_日期", sample: "{作者}_{标题}_{日期}" },
];

/**
 * 缓存项文案与展示顺序见 `lib/cache-items.ts`（键 → 中文名的唯一落点，本卡是它唯一的消费方）。
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
  /** 进入设置模式时默认选中的分类（侧栏下载图标直达「关于」；缺省落 CATEGORIES 首项「通用」——
   *  此前硬编码 "download"，点「设置」会跳过通用直接进下载分类，2026-10-15 业主指出后修正） */
  initialCategory?: string;
}): React.ReactElement {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [cookieEdits, setCookieEdits] = useState<Record<string, string>>({});
  const [cookieClears, setCookieClears] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState(initialCategory ?? CATEGORIES[0].id);
  /** 设置搜索：非空时跨分类过滤展示命中的设置卡片（侧栏选中分类保持不动，仅作导航底色） */
  const [query, setQuery] = useState("");
  const [engines, setEngines] = useState<EngineHealth[]>([]);

  const [pending, setPending] = useState<{ type: "switch"; to: string } | { type: "exit" } | null>(null);
  /** Cookie 弹窗：打开的 COOKIE_ROWS key + 草稿文本（打开时从已暂存的编辑值预填） */
  const [cookieKey, setCookieKey] = useState<string | null>(null);
  const [cookieDraft, setCookieDraft] = useState("");
  /** 自动获取：等登录窗口期间禁用按钮；失败原因单独放，不混进 saveError（它不属于「保存」） */
  const [cookieFetching, setCookieFetching] = useState(false);
  const [cookieFetchMsg, setCookieFetchMsg] = useState("");
  /**
   * 本地缓存：扫描是「读磁盘」而非设置草稿，所以不进脏计数——
   * 进「通用」分类时统计一次，之后只由「重新统计 / 清理」刷新；清理结果即时生效，不等「保存」。
   */
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState("");
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const [logConfirm, setLogConfirm] = useState(false);
  const cacheScanned = useRef(false);
  /**
   * 平台开关活在 Zustand 而不是本页草稿：它即时落盘、即时生效，与「保存」无关，
   * 所以不进脏计数（和上面「本地缓存」同一套语义）。
   */
  const switches = usePlatformStore((s) => s.switches);
  const setPlatformEnabled = usePlatformStore((s) => s.setEnabled);
  /**
   * 引擎开关（2026-10-21）：与平台开关同一套语义——即时落盘、即时生效，
   * 不进脏计数、不受「放弃」影响（主进程选路与体检读的是持久值）。
   */
  const engineSwitches = useEngineStore((s) => s.switches);
  const setEngineEnabled = useEngineStore((s) => s.setEnabled);
  const engineFallback = useEngineStore((s) => s.fallback);
  const setEngineFallback = useEngineStore((s) => s.setFallback);
  const allEnginesOff = SWITCHABLE_ENGINE_IDS.every((id) => !isEngineEnabled(id, engineSwitches));

  /** 平台主引擎覆盖层（通道列下拉即写它；缺键 = mediaget） */
  const primaryEngines = usePlatformStore((s) => s.primary);
  const setPrimaryEngine = usePlatformStore((s) => s.setPrimary);

  useEffect(() => {
    void api.settings
      .get()
      .then((s) => {
        setSaved(s);
        setDraft(structuredClone(s));
      })
      .catch(() => {});
    void api.probe.engines().then(setEngines).catch(() => {});
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
      if (SCALAR_SECTION[f] === section && fieldChanged(f, draft, saved)) n++;
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
    setDraft(next);
  }

  function discardAll(): void {
    discardSections(CATEGORIES.flatMap((c) => c.sections));
  }

  function openCookie(key: string): void {
    setCookieKey(key);
    setCookieDraft(cookieEdits[key] ?? "");
    setCookieFetchMsg("");
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
   * 自动获取：主进程开登录窗口，登录后**直接写档**（值不回渲染层）。
   * 所以它和「保存」不是同一条路：抓到只回读一次并把这一行从待保存/待清除里摘掉，
   * 与平台开关、本地缓存清理同一条「立即生效、不受放弃影响」的语义。
   */
  async function autoFetchCookie(): Promise<void> {
    if (!cookieRow || !isCookieLoginKey(cookieRow.key)) return;
    const key = cookieRow.key;
    setCookieFetching(true);
    setCookieFetchMsg("");
    try {
      const r = await api.settings.cookieLogin({ cookieKey: key });
      if (!r.captured) {
        setCookieFetchMsg(
          r.reason === "busy"
            ? "已经有一个登录窗口开着，先在那个窗口里登录或关掉它。"
            : r.reason === "timeout"
              ? "3 分钟内没检测到登录态：重试一次，或改用手动粘贴。"
              : r.reason === "error"
                ? "登录窗口没能打开（可能是代理或网络问题），请手动粘贴。"
                : "没检测到登录态：可能还没登录，或该平台的判据键变了，请手动粘贴。"
        );
        return;
      }
      const next = await api.settings.get();
      setSaved(next);
      // 只合并 cookies：别的字段可能还有未保存的草稿，整表覆盖会把它们抹掉
      setDraft((d) => (d ? { ...d, cookies: { ...next.cookies } } : d));
      setCookieEdits((p) => {
        const c = { ...p };
        delete c[key];
        return c;
      });
      setCookieClears((p) => {
        const c = { ...p };
        delete c[key];
        return c;
      });
      setCookieDraft("");
      setCookieKey(null);
      // 全仓口径：浮空 toast 只播「动作结果」，一句、带档位图标（tests/toast-sonner.test.ts）。
      // 「仅本机」是卡片里常驻的说明，不在这里重复
      toast.success(`${displayName(cookieRow.platform)} Cookie 已获取`);
    } catch (e) {
      setCookieFetchMsg(e instanceof BridgeError ? e.message : String(e));
    } finally {
      setCookieFetching(false);
    }
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
      toast.error(`${displayName(key)}：开关未能落盘，已回滚（${e instanceof BridgeError ? e.message : String(e)}）`);
    }
  }

  /** 引擎开关：同一条纪律——乐观写 + 失败回滚 + 复检让「通道」列当场跟着变 */
  async function toggleEngine(id: SwitchableEngineId, enabled: boolean): Promise<void> {
    try {
      await setEngineEnabled(id, enabled);
      setEngines(await api.probe.engines());
    } catch (e) {
      toast.error(`${ENGINE_INFO[id].label}：开关未能落盘，已回滚（${e instanceof BridgeError ? e.message : String(e)}）`);
    }
  }

  /** 回退开关：关掉 = 只用主引擎，它的失败就是最终答复 */
  async function toggleFallback(enabled: boolean): Promise<void> {
    try {
      await setEngineFallback(enabled);
      setEngines(await api.probe.engines());
    } catch (e) {
      toast.error(`失败自动回退：开关未能落盘，已回滚（${e instanceof BridgeError ? e.message : String(e)}）`);
    }
  }

  /** 通道下拉：选中的引擎成为该平台的主引擎（失败后按回退开关决定是否再试其余） */
  async function choosePrimary(platform: string, engine: SwitchableEngineId): Promise<void> {
    try {
      await setPrimaryEngine(platform, engine);
      setEngines(await api.probe.engines());
    } catch (e) {
      toast.error(`${displayName(platform)}：主引擎未能落盘，已回滚（${e instanceof BridgeError ? e.message : String(e)}）`);
    }
  }

  /**
   * 下拉的显示值：用户挑的引擎今天不在场（被引擎开关关掉 / 二进制缺失）时落到当前
   * 第一可用项——界面不显示一个不存在的选项，但**不静默改写存档**（会话内不改键）。
   */
  function primaryOf(e: EngineHealth): SwitchableEngineId {
    const wanted = primaryEngineOf(e.platform, primaryEngines);
    return e.engineIds.includes(wanted) ? wanted : e.engineIds[0];
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
      setThemeStyle(saved.themeStyle);
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
    const cookies: Record<string, string> = {};
    for (const row of COOKIE_ROWS) {
      const v = (cookieEdits[row.key] ?? "").trim();
      if (v) cookies[row.key] = v;
      else if (cookieClears[row.key]) cookies[row.key] = "";
    }
    try {
      // 开关表只走各自的即时通道（草稿是进页时的旧快照）；Cookie 只提交本次编辑过的键
      const next = await api.settings.set({ ...toSettingsPatch(draft), cookies });
      setSaved(next);
      setDraft(structuredClone(next));
      setCookieEdits({});
      setCookieClears({});
      // 全仓口径：动作结果走统一 toast（图标 + 一句），不再用保存条里的闪现徽标
      toast.success("设置已保存");
    } catch (e) {
      toast.error(`保存失败：${e instanceof BridgeError ? e.message : String(e)}`);
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
      toast.success(`已释放 ${fmtBytes(r.freed)}${stuck.length > 0 ? `；${stuck.join("、")}未能清除` : ""}`);
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
      toast.success(`日志已清空，释放 ${fmtBytes(r.freed)}`);
    } catch (e) {
      setCacheError(e instanceof BridgeError ? e.message : String(e));
    } finally {
      setCacheBusy(false);
      setLogConfirm(false);
    }
  }

  async function openLogDir(): Promise<void> {
    try {
      const r = await api.app.openLogDir();
      if (!r.ok) toast.error("日志目录打开失败");
    } catch {
      toast.error("日志目录打开失败");
    }
  }

  const loading = !saved || !draft;
  const catNow = CATEGORIES.find((c) => c.id === sel) ?? CATEGORIES[0];
  const cookieRow = COOKIE_ROWS.find((r) => r.key === cookieKey);
  const cookieConfigured = cookieRow ? Boolean(saved?.cookies[cookieRow.key]) : false;
  const cookieClearing = cookieRow ? Boolean(cookieClears[cookieRow.key]) && cookieConfigured : false;
  /** 日志占用：缓存快照里 logs 项（与「本地缓存」表共用同一份快照，避免两处数字打架） */
  const logBytes = cache?.items.find((i) => i.key === "logs")?.bytes ?? 0;

  /**
   * 搜索态：命中即定位 —— 内容区只显示当前分类里命中的区块；当前分类没有命中时
   * 自动切到首个命中的分类（见下方 effect，直接 setSel 不走 goto 的放弃把关：
   * 搜索跳转不丢草稿，脏计数按分类原样挂着，用户再手动切回时照常把关）。
   * 侧栏保持原样（2026-10-21 业主定调：不显命中数、不禁用其他分类）。
   */
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const searchTokens = q.split(/\s+/);
  const shownSections = catNow.sections.filter((s) => searchHit(s, searchTokens));
  const anyHit = CATEGORIES.some((c) => c.sections.some((s) => searchHit(s, searchTokens)));

  // 搜索命中即定位：当前分类没有命中就切到首个命中的分类；一个词谁都没命中则原地给空态
  useEffect(() => {
    if (!q) return;
    const tokens = q.split(/\s+/);
    const hit = (s: string): boolean => {
      const text = (SECTION_SEARCH[s] ?? "").toLowerCase();
      return text !== "" && tokens.every((t) => text.includes(t));
    };
    const countIn = (catId: string): number =>
      (CATEGORIES.find((c) => c.id === catId)?.sections ?? []).filter(hit).length;
    if (countIn(sel) > 0) return;
    const target = CATEGORIES.find((c) => countIn(c.id) > 0);
    if (target) setSel(target.id);
  }, [q, sel]);

  /**
   * 设置搜索框（2026-10-21，同日业主调整：挪进侧栏标题之下）：非空即在当前分类内过滤
   * 命中卡片，当前分类无命中时自动定位到首个命中的分栏（见上方 effect）。
   * 侧栏是拖拽区，交互控件须包 no-drag；≤860px 侧栏隐藏，同一份 JSX 复用进顶部 chips 区。
   */
  const searchBox = (
    <div className="no-drag relative">
      <Search
        aria-hidden
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索设置项…"
        aria-label="搜索设置项"
        className="bg-muted/40 ps-9 pe-9 hover:border-input focus-visible:border-input focus-visible:bg-muted/70 focus-visible:ring-0"
      />
      {query && (
        <button
          type="button"
          aria-label="清空搜索"
          onClick={() => setQuery("")}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );

  const nav = (
    <nav
      aria-label="设置导航"
      className="drag-region flex w-(--w-side) shrink-0 flex-col gap-1 border-r border-border bg-panel pb-3 ps-2 pe-2 max-[860px]:hidden"
    >
      {/* 标题行 = 顶栏带（与主外壳的品牌行同款同高）：标题落点与主外壳字标一致——带中心再下移 8px
          （translate-y-2）=「页面顶」与「导航栏顶（56px 线）」的中点，px-3 与导航项左缘对齐。
          mb-3 + gap-1 = 16px 让首个动作行仍落在 56px，与右侧内容对齐 */}
      <div className="mb-3 flex h-(--wco-h) items-center px-3 text-[15px] font-semibold tracking-wide">
        <span className="translate-y-2">设置</span>
      </div>

      <div className="mb-1">{searchBox}</div>

      {CATEGORIES.map((cat) => {
        const active = cat.id === sel;
        const dot = catDirty(cat.id) > 0;
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
            {/* 进入设置页本身就是一次切换：定位到的那枚分类图标挂载即播（animateOnMount，
                见 components/AnimIcon.tsx 头注） */}
            <AnimIcon Icon={cat.icon} active={active} animateOnMount />
            <span>{cat.label}</span>
            {dot && <span className="ms-auto size-1.5 shrink-0 rounded-full bg-warn" aria-label="有未保存更改" />}
          </button>
        );
      })}

      {/* 返回落底（与主外壳底部「设置」按钮同款落位）：mt-auto 压到侧栏左下角 */}
      <div className="mt-auto">
        <button
          type="button"
          onClick={requestExit}
          className="no-drag flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowLeft size={16} strokeWidth={1.5} />
          <span>返回</span>
          <span className="ms-auto text-[11px] text-faint font-mono">Esc</span>
        </button>
      </div>
    </nav>
  );

  function renderSection(id: string): React.ReactNode {
    if (!saved || !draft) return null;

    switch (id) {
      case "system":
        return (
          <ItemCard title="系统设置">
            <Row label="开机自启动" end>
              <Switch
                id="launch-at-login"
                aria-label="开机自启动"
                checked={draft.launchAtLogin}
                onCheckedChange={(v) => setDraft({ ...draft, launchAtLogin: v })}
              />
            </Row>
            <Row label="关窗最小化到托盘" end>
              <Switch
                id="minimize-to-tray"
                aria-label="关窗最小化到托盘"
                checked={draft.minimizeToTray}
                onCheckedChange={(v) => setDraft({ ...draft, minimizeToTray: v })}
              />
            </Row>
            <Row label="下载完成时通知" end>
              <Switch
                id="notify-on-done"
                aria-label="下载完成时通知"
                checked={draft.notifyOnDone}
                onCheckedChange={(v) => setDraft({ ...draft, notifyOnDone: v })}
              />
            </Row>
            <Row label="下载失败时通知" end>
              <Switch
                id="notify-on-error"
                aria-label="下载失败时通知"
                checked={draft.notifyOnError}
                onCheckedChange={(v) => setDraft({ ...draft, notifyOnError: v })}
              />
            </Row>
            <Row label="复制链接自动填入" end>
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
          <ItemCard title="本地缓存">
            {cacheError && <p className="text-xs text-err">{cacheError}</p>}
            {cache ? (
              <>
                <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {CACHE_ITEMS.map((meta) => {
                    const item = cache.items.find((i) => i.key === meta.key);
                    const bytes = item?.bytes ?? 0;
                    return (
                      <li key={meta.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span>{meta.label}</span>
                        <span className={cn("ms-auto tabular-nums", bytes === 0 && "text-disabled")}>
                          {item ? fmtBytes(bytes) : "—"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {/* 更新包缓存不入表（主进程照报契约，但界面不展示），「共」按可见行合计保证与表格对得上 */}
                    共 {fmtBytes(cache.items.filter((i) => i.key !== "update").reduce((n, i) => n + i.bytes, 0))} ·
                    可清理 {fmtBytes(cache.clearableBytes)}
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
        return (
          <ItemCard title="日志" desc="运行日志写到 userData/logs/app.log，超 2 MB 自动轮转。不写 Cookie；失败现场可含媒体直链，仅存本机。">
            <Row
              label="日志级别"
              hint="「关闭」不再写新行，已落盘文件用下方「清理日志」删除；保存后立即生效。"
              end
            >
              <Select
                value={draft.logLevel}
                onValueChange={(v) => setDraft({ ...draft, logLevel: v as AppSettings["logLevel"] })}
              >
                <SelectTrigger className="w-28" aria-label="日志级别">
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
            <Row label="保留天数" end>
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
                  onClick={() => setLogConfirm(true)}
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

      case "name":
        return (
          <ItemCard title="文件命名">
            <Row label="命名组合" end>
              <Select
                value={draft.filenamePreset}
                onValueChange={(v) => setDraft({ ...draft, filenamePreset: v as AppSettings["filenamePreset"] })}
              >
                <SelectTrigger className="w-28" aria-label="命名组合">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILENAME_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="追加清晰度" end>
              <Switch
                id="fn-quality"
                aria-label="追加清晰度"
                checked={draft.filenameExtra.quality}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, filenameExtra: { ...draft.filenameExtra, quality: v } })
                }
              />
            </Row>
            <Row label="多文件加序号" end>
              <Switch
                id="fn-index"
                aria-label="多文件加序号"
                checked={draft.filenameExtra.index}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, filenameExtra: { ...draft.filenameExtra, index: v } })
                }
              />
            </Row>
            <div className="flex items-baseline gap-2 rounded-md bg-muted/40 px-3 py-2">
              <span className="shrink-0 text-xs text-muted-foreground">预览</span>
              <span className="min-w-0 break-all font-mono text-xs">
                {buildFilename(
                  { title: SAMPLE_TITLE, author: SAMPLE_AUTHOR, qualitySuffix: "-1080P", ext: ".mp4" },
                  { preset: draft.filenamePreset, extra: draft.filenameExtra }
                )}
              </span>
            </div>
          </ItemCard>
        );

      case "load":
        return (
          <ItemCard title="并发节流">
            <Row label="并发线程" hint="住宅带宽建议 3。" end>
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
            <Row label="温和节流" hint="平台风控升级时用它降速，默认不限。" end>
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
              <Row label="代理地址" hint="缺协议自动补 http://；地址非法时按直连处理。">
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
          <ItemCard title="完成容错">
            <Row label="下载完成自动打开目录" end>
              <Switch
                id="open-folder-done"
                aria-label="下载完成自动打开目录"
                checked={draft.openFolderOnDone}
                onCheckedChange={(v) => setDraft({ ...draft, openFolderOnDone: v })}
              />
            </Row>
            <Row label="失败自动重试" end>
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
            <Row label="取消任务保留断点文件" end>
              <Switch
                id="keep-partials"
                aria-label="取消任务保留断点文件"
                checked={draft.keepPartials}
                onCheckedChange={(v) => setDraft({ ...draft, keepPartials: v })}
              />
            </Row>
            <Row label="默认清晰度" end>
              <Select
                value={draft.defaultQuality}
                onValueChange={(v) => setDraft({ ...draft, defaultQuality: v as AppSettings["defaultQuality"] })}
              >
                <SelectTrigger className="w-28" aria-label="默认清晰度">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">默认画质</SelectItem>
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
            <Row label="主题风格" end>
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
            <Row label="明暗主题" end>
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
            <Row label="字体族" end>
              <FontPicker
                value={draft.fontFamily}
                onChange={(v) => setDraft({ ...draft, fontFamily: v })}
                fetchFonts={fetchInstalledFonts}
                ariaLabel="界面字体族"
              />
            </Row>
            <Row label="正文档位" end>
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

      case "engines":
        return (
          <>
            {/* 引擎开关（2026-10-21 业主指令）：引擎这一层的「供不供」，放在平台配置之上。
                关掉的引擎在主进程选路与体检里都不再出现——这里不是纯视觉开关。 */}
            <ItemCard
              title="引擎开关"
              desc="关掉的引擎不再参与解析与体检；下方平台表的「主引擎」列会立刻跟着变。关掉平台则这一行不再提供任何解析能力，主引擎也随之锁定。开关即时生效，无需保存。"
            >
              {SWITCHABLE_ENGINE_IDS.map((id) => (
                <Row key={id} label={ENGINE_INFO[id].label} hint={ENGINE_INFO[id].desc} end>
                  <Switch
                    aria-label={`启用 ${ENGINE_INFO[id].label} 引擎`}
                    checked={isEngineEnabled(id, engineSwitches)}
                    onCheckedChange={(v) => void toggleEngine(id, v)}
                  />
                </Row>
              ))}
              <Row
                label="失败自动回退"
                hint="主引擎解析失败后，按上方顺序再试其余可用引擎；关掉则只用主引擎，它的失败就是最终答复。"
                end
              >
                <Switch
                  aria-label="引擎失败自动回退"
                  checked={engineFallback}
                  onCheckedChange={(v) => void toggleFallback(v)}
                />
              </Row>
              {allEnginesOff && (
                <p className="text-xs text-muted-foreground">
                  所有引擎都已关闭：解析不会得到真实结果，请至少打开一个。
                </p>
              )}
            </ItemCard>

            <ItemCard title="平台配置">
            {engines.length === 0 ? (
              <p className="text-xs text-muted-foreground">未获取到体检数据。</p>
            ) : (
              <div className="rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>平台</TableHead>
                      <TableHead className={ENGINE_COL.supply}>状态</TableHead>
                      <TableHead className={ENGINE_COL.cookie}>Cookie</TableHead>
                      <TableHead className={ENGINE_COL.channel}>主引擎</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {engines.map((e) => {
                      const cookie = COOKIE_ROWS.find((r) => r.platform === e.platform);
                      // 平台关掉 = 这一行不提供任何解析引擎能力：主引擎下拉只读，
                      // 别让人以为改个引擎就能绕开供给闸门（主进程在引擎被调用前就回绝）
                      const supplied = isEnabled(e.platform, switches);
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
                              checked={supplied}
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
                            {/* 主引擎下拉（2026-10-21）：选项 = 今天真能解该平台的引擎，
                                选中项先试，失败后按「失败自动回退」决定是否再试其余。
                                平台关掉 = 这一行不提供任何解析引擎能力，下拉禁用（无悬浮说明）。 */}
                            {e.engineIds.length === 0 ? (
                              <Badge variant="outline">不可用</Badge>
                            ) : (
                              <Select
                                value={primaryOf(e)}
                                disabled={!supplied}
                                onValueChange={(v) =>
                                  void choosePrimary(e.platform, v as SwitchableEngineId)
                                }
                              >
                                <SelectTrigger className="w-28" aria-label={`${e.name} 主引擎`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {e.engineIds.map((id) => (
                                    <SelectItem key={id} value={id}>
                                      {ENGINE_INFO[id].label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            </ItemCard>
          </>
        );

      case "about":
        return (
          <>
            {/* 品牌位：「关于」是回答「这是谁」的那一面，字标放在最前；版本号仍归下面的卡片，
                不在这里再抄一遍（数字只有一个真源 = AppMeta） */}
            <div className="flex items-center gap-3">
              <BrandLogo className="h-6 w-auto" />
            </div>

            <ItemCard title="软件更新">
              <Row label="自动检查更新" end>
                <Switch
                  aria-label="自动检查更新"
                  checked={draft.updateOnStartup}
                  onCheckedChange={(v) => setDraft({ ...draft, updateOnStartup: v })}
                />
              </Row>
              <Row label="静默下载" end>
                <Switch
                  aria-label="静默下载"
                  checked={draft.updateAutoDownload}
                  onCheckedChange={(v) => setDraft({ ...draft, updateAutoDownload: v })}
                />
              </Row>
              <Row label="检查更新" end>
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

            <ItemCard title="版本信息">
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

            <ItemCard title="协议框架">
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
            </ItemCard>
          </>
        );

      default:
        return null;
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
        {/* 与 App 主区同一条：常驻滚动条槽，避免内容跨过一屏时整页左右抽动 */}
        <main
          key={sel}
          className="flex-1 overflow-y-auto p-4 animate-in fade-in duration-200 slide-in-from-left-3 [scrollbar-gutter:stable]"
        >
          {/* ≤860px：侧栏隐藏，降级为顶部横向 chip；搜索框随侧栏一起消失，这里补同一份兜底 */}
          <div className="mb-4 hidden flex-col gap-2 max-[860px]:flex">
            {searchBox}
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
              ) : searching ? (
                shownSections.length === 0 ? (
                  /* 正要自动切到命中分栏时不闪空态（anyHit 说明 effect 马上会切走） */
                  anyHit ? null : (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                      没有匹配「{query.trim()}」的设置项
                    </p>
                  )
                ) : (
                  shownSections.map((s) => <Fragment key={s}>{renderSection(s)}</Fragment>)
                )
              ) : (
                catNow.sections.map((s) => <Fragment key={s}>{renderSection(s)}</Fragment>)
              )}
            </div>

            {/* 保存条：浮在内容之上的圆角卡（业主指令 2026-10-19）。
                保存成败的播报走统一 toast（2026-10-21），这里只留「未保存计数 + 动作」。
                只在真有内容时描边——空态不画边，否则底部会留一条没有内容的横线。 */}
            <div
              className={cn(
                "sticky bottom-0 mx-[3%] flex min-h-0 items-center justify-end gap-3 transition-colors",
                !loading && dirty > 0 && "rounded-lg border border-border bg-background/85 shadow-sm backdrop-blur-sm"
              )}
            >
              {dirty > 0 && !loading && (
                <div className="flex w-full items-center gap-3 rounded-lg bg-warn/5 px-3 py-2.5">
                  {dirty > 0 && (
                    <>
                      <span className="ms-auto text-xs text-warn tabular-nums">{dirty} 项未保存</span>
                      {curCatDirty > 0 && (
                        <Button variant="outline" size="sm" onClick={() => discardSections(catNow.sections)}>
                          放弃更改
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
          // max-h + overflow：DialogContent 是 `fixed top-1/2 -translate-y-1/2` 居中，
          // 内容一旦高于视口就上下两头一起被裁（页面本身不可滚），输入框会整段落到屏幕外。
          // Cookie 这层内容最多（说明三行 + 按钮 + 已配置提示 + 输入框 + 页脚），字号档调大或
          // 窗口矮时必现，所以这一张自己兜住高度。
          <DialogContent className="max-h-[calc(100vh-2rem)] max-w-md overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{displayName(cookieRow.platform)} Cookie</DialogTitle>
              <DialogDescription>
                {cookieRow.note}。可在下面的登录窗口里登录后自动抓取；也可在浏览器登录后
                F12 → Application/存储 → Cookies 复制整串粘贴。仅存本机，风险自负。
              </DialogDescription>
            </DialogHeader>
            {cookieClearing ? (
              <p className="text-sm text-err">已标记清除，保存后生效。</p>
            ) : (
              <>
                {isCookieLoginKey(cookieRow.key) ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void autoFetchCookie()}
                        disabled={cookieFetching}
                      >
                        {cookieFetching ? (
                          <RefreshCw className="animate-spin" />
                        ) : (
                          <KeyRound />
                        )}
                        {cookieFetching ? "等待登录…" : "打开登录页自动获取"}
                      </Button>
                      {cookieFetching && (
                        <span className="text-xs text-muted-foreground">
                          在弹出的窗口里登录，完成即自动抓取（值不会显示在这里）
                        </span>
                      )}
                    </div>
                    {cookieFetchMsg && <p className="text-xs text-err">{cookieFetchMsg}</p>}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    该平台不支持自动获取（登录风控过严），请在浏览器登录后手动粘贴。
                  </p>
                )}
                <Textarea
                  value={cookieDraft}
                  onChange={(e) => setCookieDraft(e.target.value)}
                  placeholder="粘贴 Cookie 整串"
                  aria-label={`${displayName(cookieRow.platform)} Cookie`}
                  // field-sizing-fixed + 固定高度：粘贴的是整串几百字符，自动增高会把页脚按钮挤出弹窗
                  className="field-sizing-fixed h-28 overflow-y-auto font-mono text-xs"
                />
                {cookieConfigured && (
                  <p className="text-xs text-muted-foreground">
                    当前已配置；自动获取会当场覆盖并保存，手动填入则确认后再保存。
                  </p>
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
              即将清理本地缓存，预计释放约 {fmtBytes(cache?.clearableBytes ?? 0)}；
              进行中的下载任务不受影响，此操作不可逆。
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

      <Dialog open={logConfirm} onOpenChange={setLogConfirm}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>清理日志</DialogTitle>
            <DialogDescription>
              将删除全部日志文件，预计释放 {fmtBytes(logBytes)}，此操作不可逆。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogConfirm(false)}>
              取消
            </Button>
            <Button variant="destructive" disabled={cacheBusy} onClick={() => void clearLogs()}>
              清理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const CUSTOM_VALUE = "__custom__";

/**
 * 数值档位下拉：常用选项平铺在菜单里，末项「自定义」；选自定义后下拉框原位换成输入框，
 * Enter 提交（非法值留在编辑态提示），失焦合法则提交否则取消，Esc 取消回下拉框。
 * 当前值不在档位里时，触发器显示「值·自定义」、菜单项同步显示，重开可再编辑。
 * Radix 重复选中已选项不触发 onValueChange，故关菜单时兜底强制进输入态（否则第二次进不去）。
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
  // 关菜单兜底要在 onOpenChange 里读最新值，而 Radix 的关闭回调不重渲染，故用 ref 同步
  const isPresetRef = useRef(isPreset);
  isPresetRef.current = isPreset;
  const customModeRef = useRef(customMode);
  customModeRef.current = customMode;

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
      onOpenChange={(open) => {
        // Radix 的坑：重复「选中当前已选中项」时 onValueChange 不触发
        // （useControllableState 受控模式下 value2 === prop 就不调 onChange），
        // 于是第二次点「自定义 · N」既不切自定义态也不关菜单 —— 表现就是「自定义过一次就再也进不去」。
        // 菜单关闭时兜底：仍处于自定义占位且未进输入态，就强制进输入态。
        if (!open && !customModeRef.current && !isPresetRef.current) {
          startCustom();
        }
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
          {isPreset ? "自定义…" : `${fmt(value)}·自定义`}
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

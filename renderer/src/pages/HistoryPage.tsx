/**
 * 历史页：**解析**历史清单（作品 / 作者 / 类型 / 文件数 / 创建时间）。
 * 一条记录在解析成功时就写进历史（业主指令 2026-10-17），下不下载都在 —— 所以这一页不是下载台账：
 * 「文件数」那列写「未下载」的行就是只解析过、还没落地任何文件的作品。
 * 分工（2026-10-14）：本页只讲「哪个作品」——平台、标题、作者、类型、文件数、来源链接；
 * 「哪些文件、下得多大、下到哪」是队列页的资源视图，这里不重复。
 * 表格不带操作列（业主指令 2026-10-15）：唯一的动作「复制作品信息」（含分享链接）跟着作品走，
 * 放在信息卡片的标题行；「打开位置」只对落地文件有意义，就在卡片文件列里 ——
 * 要找文件去队列页，行本身不做任何动作，它只是入口。
 * （首列那枚勾选框是**选择**入口，不是动作列：它只有一枚框，动作全在选中后浮出的底部浮窗里。）
 * 作者列显示的是解析那一刻的快照（点昵称开卡片）；客户端不拉实时主页，
 * 所以粉丝量停在记录当天，这是设计而非缺陷。
 * 行 = 作品：同 groupId（= 分享链接算出的作品键，见 shared/history.ts）的解析行与下载行聚合成一行，
 * 图集的多文件同样一行。旧记录缺 kind/sourceUrl/author（本版本前写入）显示「—」优雅降级；
 * 不存媒体直链（§3 隐私）。
 * 行 = 作品的入口（业主指令 2026-10-15）：点行从底部弹出该作品的详细信息浮层，
 * 开着时点别的行直接换成那个作品、点当前这行收起；
 * 队列页右键「查看作品信息」跳到本页并定位高亮对应行。
 * 多选（业主指令 2026-10-15，spec：docs/superpowers/specs/2026-10-15-history-multiselect-design.md）：
 * Ctrl/⌘+点切换、Shift+点范围、Ctrl+A 全选可见、Esc 清空 —— 无修饰点行照旧开详情，两者不打架。
 * 入口在 10-17 改成**可见的**（业主指令「加可见勾选框 + 表头全选」，推翻 spec 里「勾选框列：不做」）：
 * 首列一枚勾选框，表头那枚是三态（部分选中必须显示成半勾 —— 画成勾则下次点击变清空）。
 * 勾选框走的是与 Ctrl+点**同一个** clickToggle，所以点框选完还能接着 Shift 扩展范围，一条真源。
 * 选中 ≥1 行时动作条以**浮窗**停在窗口底部（业主指令 2026-10-17「不要占位」，工具栏不再被它换掉）：
 * 复制 / 导出 txt / 导出 CSV / 重新解析 / 移除记录（二次确认）· 取消选择。
 * 底部那条带一次只放一层：详情浮层开着时浮窗让位（只让可见性，选择集不动），收起浮层即回来。
 * 「移除记录」不写成「删除」是刻意的：它只撤台账那一行，磁盘上的文件不动，按钮得说它做的事。
 * 重新解析 = 把选中作品的分享链接送回首页输入面（与「导入文件」同一条 识别→批量 流水线，
 * 这里不自己编排解析）；缺来源链接的行跳过并如实报数。
 * 选择集合存行键不随筛选缩水（资源管理器口径）；状态机与导出拼装是纯函数，在
 * renderer/src/lib/history-selection.ts 里可无 DOM 测。
 * 排版（业主指令 2026-10-15 统一，与队列页同口径）：表格与浮层里的文字只有一个字号档位
 * （「设置→外观→界面字号」，默认 13px），列与列之间不分大小；层级只靠字重与色彩 ——
 * 主信息（作品标题、浮层「标题」值）`font-medium` + 前景色，
 * 元数据常规 + muted，数字列 tabular-nums；字体族一律 UI 栈（不混等宽）。
 * 筛选（与队列页同一套交互）：搜索 + 平台 + 时间窗，全部是**渲染层过滤**（§2.3），零契约变更。
 * 一次取满 5000 条（= 主进程 store 的 HISTORY_MAX 上限），所以渲染层过滤看到的就是全部记录 ——
 * 平台选项池来自**未过滤**的这份数据：从前按 platform 回源再拿结果去重当选项，选过一个平台就切不回别的。
 * 首次空与过滤空是两种空态：后者保留工具栏 + 「没有符合条件的记录」+ 清除筛选。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Clock3, Copy } from "lucide-react";
import { api } from "../lib/bridge";
import type { HistoryEntry } from "../../../types/ipc";
import { displayName } from "../../../shared/platforms";
import { PlatformIcon } from "../components/PlatformIcon";
import { cn } from "../lib/utils";
import { groupWorks, type WorkRow } from "../lib/history-works";
import { buildWorkInfoText } from "../lib/work-info";
import {
  buildWorksCsv,
  clickRange,
  clickToggle,
  concatWorkInfo,
  EMPTY_SEL,
  headerCheckState,
  isSelected,
  reparseLinks,
  selectAllVisible,
  type CsvWork,
  type SelState,
} from "../lib/history-selection";
import { fmtBytes, fmtCount, fmtCreated, kindLabel } from "../lib/format";
import { HISTORY_WINDOW } from "../lib/local-limits";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { TruncatedTooltip } from "../components/ui/tooltip";

/** Radix Select 不接受空串作为 value，「全部平台」用一个不会与平台 key 撞车的哨兵 */
const ALL = "__all__";

/** 一次取满：与主进程 store 的 HISTORY_MAX 同值，渲染层过滤因而覆盖全部记录 */
const HISTORY_LIMIT = HISTORY_WINDOW;

type TimeRange = "all" | "today" | "7d" | "30d";

/** 「今天」按自然日切；7/30 天按滚动 24h 窗口（记录量级下没人需要精确到零点） */
const TIME_RANGES: Array<{ key: TimeRange; label: string; within: (ts: number, now: number) => boolean }> = [
  { key: "all", label: "全部时间", within: () => true },
  {
    key: "today",
    label: "今天",
    within: (ts, now) => new Date(ts).toDateString() === new Date(now).toDateString(),
  },
  { key: "7d", label: "近 7 天", within: (ts, now) => now - ts <= 7 * 86_400_000 },
  { key: "30d", label: "近 30 天", within: (ts, now) => now - ts <= 30 * 86_400_000 },
];

/**
 * table-fixed 下「作品」列不设宽 = 吃掉剩余宽度并在此截断；其余列必须显式定宽。
 * 与队列页同口径写成 `1.5rem + Nem`：1.5rem 是 td 的左右内边距（与字号无关），N em 是最坏内容宽，
 * 所以列宽跟着「设置→外观→界面字号」那一档缩放，换档不截字也不重排。
 */
const COL = {
  /** 勾选框列：`size-4` = 1rem 是 rem 定值（不随界面字号伸缩），所以这里加的是 rem 不是 em */
  select: "w-[calc(1.5rem+1rem)]",
  kind: "w-[calc(1.5rem+2.4em)]",
  /** 约 7 个汉字；再窄会把五字昵称切成「@胶片…」这种半截词（超长仍在此截断 + tooltip） */
  author: "w-[calc(1.5rem+5.6em)]",
  /** 表头「文件数」比数字值宽，按表头取 */
  count: "w-[calc(1.5rem+3.2em)]",
  /** 容纳最宽形态「2026-10-13 12:32:04」（8.8em） */
  time: "w-[calc(1.5rem+9em)]",
} as const;

/**
 * 「未下载」是解析历史里一行的正常状态（解析过、没点下载），不是缺数据 ——
 * 所以这一列在它为零时讲状态，而不是显示「0 个」让人以为文件被删了。
 */
const filesCell = (count: number): string => (count === 0 ? "未下载" : `${count} 个`);

export default function HistoryPage({
  focusKey,
  platformFocus,
  onReparse,
}: {
  focusKey?: string | null;
  /** 统计页平台榜带过来的意图：seq 变一次就应用一次（同值复点也要生效） */
  platformFocus?: { key: string; seq: number } | null;
  /** 多选「重新解析」：把分享链接交给首页输入面，由 App 切页（本页不自己编排解析） */
  onReparse: (links: string[]) => void;
}): React.ReactElement {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [platform, setPlatform] = useState<string>("");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [authorRow, setAuthorRow] = useState<WorkRow | null>(null);
  // 作者卡片可见态与数据态分开：关闭只翻 visible，行留着 —— Radix 收起动画（200ms）期间这层还在 DOM，
  // 若把行一起置 null，卡片会先被抽空再淡出，看不见「向下收起」那一段（业主指令 2026-10-15 增强）
  const [authorShown, setAuthorShown] = useState(false);
  const openAuthor = (r: WorkRow) => {
    setAuthorRow(r);
    setAuthorShown(true);
  };
  // 与作者卡片同一处理（业主指令 2026-10-15 修复收起「直接消失」）：关闭只翻 shown，
  // detailRow 留着。Radix 收起那 250ms 里壳层还在 DOM，内容若一起置 null，面板先塌成空壳
  // 再滑走，位移动画完全没有可见内容承载 → 看起来就是瞬间消失。
  const [detailRow, setDetailRow] = useState<WorkRow | null>(null);
  const [detailShown, setDetailShown] = useState(false);
  const openDetail = (r: WorkRow): void => {
    // 再点当前那一行 = 收起（Sheet 注释里的「收起只靠角落按钮 / Esc / 再次点行」）；点别的行只换内容。
    // 判据用 detailShown 不用 detailRow：收起后行数据要为退场动画留着，此时点同一行该重新展开。
    if (detailShown && detailRow?.key === r.key) {
      setDetailShown(false);
      return;
    }
    setDetailRow(r);
    setDetailShown(true);
  };
  const [flashKey, setFlashKey] = useState<string | null>(null);
  /** 多选态（行键集合 + Shift 锚点）；状态机在 lib/history-selection.ts，可无 DOM 测 */
  const [sel, setSel] = useState<SelState>(EMPTY_SEL);
  /** 多选·删除的二次确认（destructive，与「清空历史」同形制） */
  const [selDelOpen, setSelDelOpen] = useState(false);
  // 全局 keydown 只挂一次，但 Ctrl+A 要读**最新的可见行键** —— 用 ref 桥接，避免把 rows 塞进依赖数组反复重挂
  const visibleKeysRef = useRef<string[]>([]);

  useEffect(() => {
    void api.history.list({ limit: HISTORY_LIMIT }).then(setList).catch(() => {});
  }, []);

  // 统计页点榜 → 本页筛到那个平台。平台选项池来自全量数据，所以榜上的键一定在这页可选
  useEffect(() => {
    if (platformFocus) setPlatform(platformFocus.key);
  }, [platformFocus]);

  // Ctrl+F 聚焦搜索框（§3.4 L1）；Ctrl/⌘+A 全选**可见行**（多选，替换语义）；
  // Esc 优先收选择。本 effect 只挂一次，Ctrl+A 要读最新可见行 → 走 visibleKeysRef 桥接
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a") {
        // 输入框/搜索框里 Ctrl+A 是「全选文本」，不抢
        const t = e.target;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        setSel((s) => selectAllVisible(s, visibleKeysRef.current));
      } else if (e.key === "Escape") {
        // 浮层开着时 Esc 归浮层（Radix 自收）；没浮层且有选中才清空选择。
        // 排掉 data-state="closed"：Radix Presence 退场中节点还挂在 DOM 上，
        // 照旧写法会把「刚收起浮层就按 Esc」当成「浮层还开着」而吞掉这次清空。
        if (document.querySelector('[data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"]')) return;
        setSel((s) => (s.keys.length > 0 ? EMPTY_SEL : s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { rows, allRows, platforms } = useMemo(() => {
    // 聚合（解析行 + 下载行 → 一行作品）是纯函数，见 lib/history-works.ts
    const all = groupWorks(list);
    const q = query.trim().toLowerCase();
    const within = TIME_RANGES.find((f) => f.key === timeRange)!.within;
    const now = Date.now();
    const hit = (r: WorkRow): boolean =>
      (platform === "" || r.platform === platform) &&
      within(r.createdAt, now) &&
      (q === "" ||
        `${r.title} ${r.authorName ?? ""} ${r.platform ?? ""} ${displayName(r.platform)} ${r.files.join(" ")} ${r.sourceUrl ?? ""}`
          .toLowerCase()
          .includes(q));
    return {
      rows: all.filter(hit),
      // 未过滤的聚合全集：多选的选择集跨筛选保留（资源管理器口径），复制/导出/删除
      // 都要按**全量**解析行键 —— 只拿 filtered rows 会把「选中后被筛掉的行」静默丢掉
      allRows: all,
      // 选项池来自**未过滤**的聚合结果：跟着 rows 走会让选过一个平台后切不回别的
      platforms: Array.from(new Set(all.map((r) => r.platform).filter((p): p is string => Boolean(p)))),
    };
  }, [list, platform, timeRange, query]);

  // 每次渲染同步可见行键（全局快捷键只挂一次，读 ref 才拿得到最新值）
  const visibleKeys = rows.map((r) => r.key);
  visibleKeysRef.current = visibleKeys;
  /** 选中行按**全量** allRows 解析（键序沿用 allRows：新在前）——被筛掉的选中行不丢 */
  const selectedRows = useMemo(() => {
    const picked = new Set(sel.keys);
    return allRows.filter((r) => picked.has(r.key));
  }, [sel.keys, allRows]);

  /** 底部浮窗动作条的可见条件（业主指令 2026-10-17「不要占位」）：有选中，且作品信息浮层没开着。
   *  底部那条带一次只放一层：浮层是单作品的焦点、z-50 也压得住，所以它优先；收起浮层这条就回来，
   *  选择集一个键都没动 —— 让位是可见性，不是清空。 */
  const barShown = sel.keys.length > 0 && !detailShown;

  /** 浮窗自己的实测高度 → 垫高块照它长。写死数字总有一天对不上：单行是 50px，
   *  窄窗或大界面字号下动作条折成两三行就翻倍，垫少了最后一行仍被压住。 */
  const barRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!barShown || !el) return;
    setBarH(el.getBoundingClientRect().height);
    const ro = new ResizeObserver(() => setBarH(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [barShown]);

  function clearFilters(): void {
    setPlatform("");
    setTimeRange("all");
    setQuery("");
  }

  // 队列页跳转定位：历史是异步到位的，rows.length 变化后再重试一次滚动与高亮
  useEffect(() => {
    if (!focusKey || rows.length === 0) return;
    const el = document.querySelector<HTMLElement>(`[data-group="${CSS.escape(focusKey)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    setFlashKey(focusKey);
    const h = setTimeout(() => setFlashKey(null), 1800);
    return () => clearTimeout(h);
  }, [focusKey, rows.length]);

  function copyInfo(r: WorkRow): void {
    const text = buildWorkInfoText({
      title: r.title,
      platformName: displayName(r.platform),
      kindLabel: r.kind ? kindLabel(r.kind) : undefined,
      fileCount: r.count,
      createdAt: r.createdAt,
      sourceUrl: r.sourceUrl,
      author: r.author,
    });
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success("已复制作品信息"))
      .catch(() => toast.error("复制失败"));
  }

  /** 保存文本文件：Blob + a[download]，零 IPC（Electron 里落系统「另存为」）；
   *  前置 BOM —— 记事本与 Excel 都靠它认 UTF-8，CSV 缺 BOM 中文直接成乱码。
   *  与首页 saveImportTemplate 同一段五行：两处行为不同（那边固定模板、这边动态拼接），
   *  第三处消费出现时再抽公用（spec §6）。 */
  function saveTextFile(fileName: string, text: string, mime: string): void {
    const blob = new Blob([`\uFEFF${text}`], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 选中行 → 「作品信息」文本列表（复制与 txt 导出共用，与单行复制同一真源） */
  function workTexts(rs: WorkRow[]): string[] {
    return rs.map((r) =>
      buildWorkInfoText({
        title: r.title,
        platformName: displayName(r.platform),
        kindLabel: r.kind ? kindLabel(r.kind) : undefined,
        fileCount: r.count,
        createdAt: r.createdAt,
        sourceUrl: r.sourceUrl,
        author: r.author,
      })
    );
  }

  /** 多选·复制：整段进剪贴板 */
  function copySelected(): void {
    const text = concatWorkInfo(workTexts(selectedRows));
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`已复制 ${selectedRows.length} 条作品信息`))
      .catch(() => toast.error("复制失败"));
  }

  /** 多选·导出：txt 全量信息 / CSV 表格档（Excel）。文件名带条数，多次导出可分辨 */
  function exportSelected(fmt: "txt" | "csv"): void {
    const n = selectedRows.length;
    if (fmt === "txt") {
      saveTextFile(`即刻解析-历史-${n}条.txt`, concatWorkInfo(workTexts(selectedRows)), "text/plain");
    } else {
      const works: CsvWork[] = selectedRows.map((r) => ({
        title: r.title,
        authorName: r.authorName,
        platformName: displayName(r.platform),
        kindLabel: r.kind ? kindLabel(r.kind) : undefined,
        count: r.count,
        bytes: r.bytes,
        createdAt: r.createdAt,
        sourceUrl: r.sourceUrl,
        // 落地目录取第一个文件的父目录：单元格里塞 N 条全路径没法看，「在哪」够用
        dir: r.files.length > 0 ? dirOf(r.files[0]) : undefined,
      }));
      saveTextFile(`即刻解析-历史-${n}条.csv`, buildWorksCsv(works, fmtCreated), "text/csv");
    }
    toast.success(`已导出 ${n} 条（${fmt.toUpperCase()}）`);
  }

  /** 多选·重新解析：链接交给首页输入面（与「导入文件」同一条 识别→批量 流），本页只送件。
   *  缺来源链接的行只能跳过 —— 不存直链是隐私红线，分享链接是把作品交回内核的唯一入口。 */
  function reparseSelected(): void {
    const links = reparseLinks(selectedRows);
    if (links.length === 0) {
      toast.error("选中的记录没有来源链接，无法重新解析");
      return;
    }
    const skipped = selectedRows.length - links.length;
    onReparse(links);
    toast.success(
      skipped > 0
        ? `已送回 ${links.length} 条重新解析（${skipped} 条无来源链接已跳过）`
        : `已送回 ${links.length} 条重新解析`
    );
  }

  /** 多选·移除记录（确认弹窗的「移除」按钮调）：以 removeHistory 的返回值为新列表，
   *  不回读 history.list —— 省一次往返，也不给并发留窗口。文件不动，这是它和「删除」的区别 */
  function removeSelected(): void {
    void api.history
      .remove(sel.keys)
      .then((rest) => {
        setList(rest);
        setSel(EMPTY_SEL);
        setSelDelOpen(false);
        toast.success(`已移除 ${selectedRows.length} 条记录（文件仍在磁盘）`);
      })
      .catch(() => toast.error("移除失败"));
  }

  // 首次空（真没记录）与过滤空是两种状态：后者保留工具栏，让人改条件而不是以为历史被清空了
  if (list.length === 0) {
    return (
      // 空态只留标题一行，说明段删掉（业主指令 2026-10-17），剩下这一组在可用高度里垂直居中
      <section className="flex min-h-full flex-col items-center justify-center gap-3 text-center">
        <Clock3 className="size-11 text-faint" strokeWidth={1.5} aria-hidden="true" />
        <div className="font-medium text-sm">暂无历史记录</div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {/* gap-0：Card 自带 gap-4，会在工具栏底线与表头之间垫出 16px 空带——表头看上去比内容行高出一截 */}
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 作者 / 文件名"
            aria-label="搜索历史记录"
            className="h-8 w-56"
          />
          <Select value={platform === "" ? ALL : platform} onValueChange={(v) => setPlatform(v === ALL ? "" : v)}>
            <SelectTrigger size="sm" className="w-36" aria-label="按平台筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部平台</SelectItem>
              {platforms.map((p) => (
                <SelectItem key={p} value={p}>
                  {displayName(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
            <SelectTrigger size="sm" className="w-28" aria-label="按时间筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 工具栏只有这一枚常驻按钮：多选动作条 10-17 起浮到窗口底部、不再来这里换掉它
              （业主指令「多选操作栏不要占位」）。ms-auto 仍挂在本容器上，让按钮单独贴右端 */}
          <Button variant="destructive" size="sm" className="ms-auto" onClick={() => setClearOpen(true)}>
            清空历史
          </Button>
        </div>

        {rows.length === 0 ? (
          <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
            <span>没有符合条件的记录</span>
            <Button size="sm" variant="outline" onClick={clearFilters}>
              清除筛选
            </Button>
          </div>
        ) : (
          /* 底线 = 定宽列 + 作品列可读下限（约 17em）；窗口更窄时横向滚，而不是把作品列压成 0 宽。
             勾选框列宽是 rem 定值（1.5rem 内边距 + 1rem 方框），所以它单独加在 calc 里、不折进 em */
          <Table className="min-w-[calc(41em+2.5rem)]">
            <TableHeader>
              <TableRow>
                <TableHead className={COL.select}>
                  <span className="flex items-center">
                    <Checkbox
                      checked={headerCheckState(sel, visibleKeys)}
                      // 判据读**当前**三态而不是回调送来的值：indeterminate 下 Radix 发的是 `true`
                      // （它按 非勾→勾 循环），照值走就会把「全选可见」做成「清空」。
                      // 语义与 Ctrl+A / Esc 同一条真源：勾 = 替换为可见全部，取消 = 清空
                      onCheckedChange={() =>
                        setSel((s) =>
                          headerCheckState(s, visibleKeys) === true
                            ? EMPTY_SEL
                            : selectAllVisible(s, visibleKeys)
                        )
                      }
                      aria-label="全选可见记录"
                    />
                  </span>
                </TableHead>
                <TableHead>作品</TableHead>
                <TableHead className={COL.author}>作者</TableHead>
                <TableHead className={COL.kind}>类型</TableHead>
                <TableHead className={COL.count}>文件数</TableHead>
                <TableHead className={COL.time}>创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow
                  key={r.key}
                  data-group={r.key}
                  onClick={(e) => {
                    // 修饰键分流（业主指令 2026-10-15）：Ctrl/⌘=切换、Shift=范围，
                    // 两者都**不**开详情；无修饰照旧 openDetail。行内控件（作者名）自己 stopPropagation
                    if (e.ctrlKey || e.metaKey) {
                      setSel((s) => clickToggle(s, visibleKeysRef.current, i));
                      return;
                    }
                    if (e.shiftKey) {
                      setSel((s) => clickRange(s, visibleKeysRef.current, i));
                      return;
                    }
                    openDetail(r);
                  }}
                  className={cn(
                    "cursor-pointer",
                    // 描边保留（整行扫一眼才知道哪些进了动作条，光看左端那枚框要逐行找）
                    isSelected(sel, r.key) && "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/50",
                    flashKey === r.key && "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/50"
                  )}
                >
                  <TableCell className={COL.select}>
                    <span className="flex items-center">
                      <Checkbox
                        checked={isSelected(sel, r.key)}
                        // 与 Ctrl+点同一个 clickToggle：所以点框选完接着 Shift 点还能扩范围，
                        // 不另开一套选择语义；onClick 拦住冒泡，点框不该顺带开出底部浮层
                        onCheckedChange={() => setSel((s) => clickToggle(s, visibleKeys, i))}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`选择 ${r.title}`}
                      />
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex min-w-0 items-center gap-2">
                      {r.platform && <PlatformIcon platform={r.platform} />}
                      <TruncatedTooltip label={r.title}>
                        <span className="min-w-0 truncate font-medium">{r.title}</span>
                      </TruncatedTooltip>
                    </span>
                  </TableCell>
                  <TableCell>
                    {r.authorName ? (
                      <TruncatedTooltip label={`@${r.authorName}`}>
                        <button
                          type="button"
                          className="block w-full min-w-0 cursor-pointer truncate text-start font-medium hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAuthor(r);
                          }}
                        >
                          @{r.authorName}
                        </button>
                      </TruncatedTooltip>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {kindLabel(r.kind)}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {filesCell(r.count)}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {fmtCreated(r.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* 底部垫高只在浮窗出现时存在：`main` 是滚动容器，最后一行若不垫高就永久压在浮窗底下、
          连它的勾选框都点不到。垫的是浮窗实测高度，加上浮窗之下本就有的 39px（卡片内边距 11 +
          根容器 gap 12 + main 的 p-4 底 16），滚到底时最后一行离窗口底必然高过浮窗顶（浮窗离底 16）。
          它不移动表格本身，所以工具栏与表头都不跟着跳。*/}
      {barShown && <div aria-hidden style={{ height: barH }} />}

      {/* 多选动作条：浮在窗口底部（业主指令 2026-10-17「不要占位，以浮窗形式展示在窗口底部」）。
          **必须 portal 到 body**：`main` 自带 page-enter 动画（transform + filter），一旦它成为 fixed 的
          containing block，这套坐标就从窗口缩到内容区（实测中心偏 92px、且跟着滚动走）。
          Sheet / Dialog 同理都是 Portal，这里走同一条链。
          居中参照系与对话框同一条 —— 功能区中心，不含左侧导航栏（UIUX-DESIGN §8.4）；
          `w-max` 是**内容宽**而不是视口宽，所以不需要像对话框那样把宽度换算成 calc，
          只给它一条不超过功能区的不溢出上限，窄窗口下 flex-wrap 往上折而不是横向溢出 */}
      {barShown &&
        createPortal(
          <div
            ref={barRef}
            className="fixed bottom-4 left-[calc(50%_+_var(--w-side)/2)] z-40 flex w-max max-w-[calc(100vw-var(--w-side)-2rem)] -translate-x-1/2 animate-in slide-in-from-bottom-3 flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-pop duration-200"
            role="group"
            aria-label="多选批量操作"
          >
            <span className="tabular-nums text-muted-foreground">已选 {sel.keys.length} 项</span>
            <Button variant="outline" size="sm" onClick={copySelected}>
              <Copy />
              复制
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportSelected("txt")}>
              导出 txt
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportSelected("csv")}>
              导出 CSV
            </Button>
            <Button variant="outline" size="sm" onClick={reparseSelected}>
              重新解析
            </Button>
            {/* 「移除记录」不写「删除」：它只撤台账那一行，磁盘上的文件不动 —— 按钮要说它做的事 */}
            <Button variant="destructive" size="sm" onClick={() => setSelDelOpen(true)}>
              移除记录
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSel(EMPTY_SEL)}>
              取消选择
            </Button>
          </div>,
          document.body
        )}

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>清空全部历史？</DialogTitle>
            <DialogDescription>只删除本机的记录，已下载的文件不会被动。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                void api.history.clear().then(() => {
                  setList([]);
                  setClearOpen(false);
                });
              }}
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 多选·移除记录二次确认（spec §3A：destructive，与「清空历史」同形制）。
          文案带条数 —— 「移除几条」必须出现在确认位上，误删的唯一防线就是这句话。 */}
      <Dialog open={selDelOpen} onOpenChange={setSelDelOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>移除选中的 {selectedRows.length} 条记录？</DialogTitle>
            <DialogDescription>只删除本机的历史记录，已下载的文件不会被动。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSelDelOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={removeSelected}>
              移除记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 作者卡片：两个入口（表格作者列 / 作品信息作者行）同一层浮层，无遮罩 + 非模态
          （业主指令 2026-10-15「作者卡片的呼出不做背景遮罩」）——背景照常可见可点，点卡片外只收这层。
          进出对称：向上出现 / 向下收起（slide ±2rem）。
          曲线单独调：基类退场用 ease，淡出被前置（实测 0.59@50ms）→ 看起来「直接消失」；
          改进入 ease-out / 退场 ease-in + 250ms，前半段留住不透明度，位移才看得见 */}
      <Dialog
        modal={false}
        open={authorShown}
        onOpenChange={(o) => {
          if (!o) setAuthorShown(false);
        }}
      >
        <DialogContent
          showOverlay="light"
          // 说明行已删（业主指令 2026-10-17：卡片只摆作者本身的信息）；Radix 要求显式声明
          // 「这层没有 description」，否则控制台告警并把 aria-describedby 指向空元素
          aria-describedby={undefined}
          className="max-w-sm slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8 data-[state=open]:ease-out data-[state=closed]:ease-in data-[state=closed]:duration-250"
        >
          <DialogHeader>
            <DialogTitle>作者卡片</DialogTitle>
          </DialogHeader>
          {authorRow && (
            <AuthorCard row={authorRow} platformName={displayName(authorRow.platform)} />
          )}
        </DialogContent>
      </Dialog>

      {/* 点作品行 → 底部浮层：该作品的完整信息（表格行只放摘要，这里放全量）。
          非模态 + 无遮罩：上方列表照常可见可点，浮层只是叠在下面那行之上。
          inset-x-4 = 跟 main 的 p-4 同档，浮层左右沿与上方表格卡片对齐（业主指令 2026-10-15） */}
      <Sheet modal={false} open={detailShown} onOpenChange={(o) => { if (!o) setDetailShown(false); }}>
        <SheetContent
          aria-describedby={undefined}
          className="inset-x-4 overflow-hidden"
          onInteractOutside={(event) => {
            // 作者卡片是叠在作品信息之上的另一层 Dialog：它内部的每次点击对 Sheet 而言都是「外部交互」，
            // 默认会把作品信息一起关掉（业主指令 2026-10-15 修复2）。一层点击只关一层：卡片开着时 Sheet 不接受外部关闭
            if (authorShown) {
              event.preventDefault();
              return;
            }
            // 表格行是浮层的入口，不是「别处」：Radix 的外部关闭挂在 document，比 React 根容器上的行
            // onClick 晚一瞬，于是点别的行 = 先开后关、内容却已换成那一行 → 必须再点一次才显示
            // （业主指令 2026-10-15 修复）。行的开合全归 openDetail，浮层外其余区域照常点击关闭。
            if (event.target instanceof Element && event.target.closest("[data-group]")) event.preventDefault();
          }}
        >
          {detailRow && (
            <>
              {/* 平台不占信息行：品牌 SVG 作水印，**以卡片右上角为核心**（业主指令 2026-10-15：
                  「以卡片右上角为核心展示三角区」→「展示 80% 的图标面积」→「倾斜角度反了」）。
                  `-rotate-45`（逆时针）+ `top-11 right-11`（44px）把菱形中心从角点沿 45° 对角往卡内挪 44px：
                  半边 h = 112×√2/2 = 79.2px，两条边各裁掉 (h-44)²/(2h²) = 9.9%，合计 ≈20% → 卡内可见 ≈80%
                  （正方形 ±45° 外轮廓同一枚菱形，改向只翻转图标本身，不破坏上面的面积）；
                  中心再挪 1px 就露出整角，挪到 79px 则退化成贴边不裁。-z-10 沉正文之下，pointer-events-none 不吃点击 */}
              <PlatformIcon
                platform={detailRow.platform}
                className="-z-10 pointer-events-none absolute top-11 right-11 size-28 translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-none opacity-[0.12]"
              />
              {/* 复制动作从表格操作列移进卡片（业主指令 2026-10-15）：一行一个作品，动作跟着作品走，
                  不必先开卡片再回头找图标。业主再指令（2026-10-15）：只留图标、与收起按钮同行且居其左 ——
                  收起按钮是 absolute，留在流式行里无论如何都对不齐，故本枚改为同一套绝对定位（见下）。
                  pe-20 = 让开这两枚按钮（最右一枚到距右边 64px）。 */}
              <SheetHeader className="pe-20">
                <SheetTitle className="text-sm">作品信息</SheetTitle>
              </SheetHeader>
              {/* 与收起按钮配成一对：同为 top-4 + size-4 图标 → 两者盒高相同，垂直中心都落在 24px，
                  所以天然同行对齐；收起占 right-4..right-8(16–32px)，本枚 right-12(48px) 留 16px 间距。
                  视觉上只剩图标，文案收进 title 与 sr-only —— 语义不跟着图标一起消失。 */}
              <button
                type="button"
                title="复制作品信息"
                onClick={() => copyInfo(detailRow)}
                className="absolute top-4 right-12 rounded-sm opacity-60 outline-none transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Copy className="size-4" />
                <span className="sr-only">复制作品信息</span>
              </button>
              <SheetBody>
                <WorkDetail key={detailRow.key} row={detailRow} onOpenAuthor={() => openAuthor(detailRow)} />
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

/**
 * 作者卡片：快照字段逐项展示，缺项不占行；头像加载失败退回首字占位。
 * 名字本身就是「在浏览器打开主页」那条链接（业主指令 2026-10-17 撤掉单独的外链按钮）；
 * 「快照、之后不自动更新」不再写在卡片里 —— 机制口径归文档，界面不常驻说明书（§8.4 同一条原则）。
 */
function AuthorCard({
  row,
  platformName,
}: {
  row: WorkRow;
  platformName: string;
}): React.ReactElement {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const a = row.author;
  if (!a) return <p className="text-muted-foreground">该记录未保存作者信息（此后生效）。</p>;

  const name = a.name ?? a.id ?? "?";

  const stats: Array<{ label: string; value: string }> = [];
  if (a.followerCount != null) stats.push({ label: "粉丝", value: fmtCount(a.followerCount) });
  if (a.followingCount != null) stats.push({ label: "关注", value: fmtCount(a.followingCount) });
  if (a.totalFavorited != null) stats.push({ label: "获赞", value: fmtCount(a.totalFavorited) });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {a.avatar && !avatarFailed ? (
          <img
            src={a.avatar}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
            className="size-12 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-sm"
            aria-hidden="true"
          >
            {name.slice(0, 1)}
          </span>
        )}
        <div className="min-w-0">
          {/* 外链走 <a target=_blank>，由主进程 setWindowOpenHandler 转交系统浏览器；
              不套 text-primary —— 那是动态魔法色，历史页没有封面去设它，会停在中性初值上
              （对比度 1.9:1，看着像禁用）；可点性只靠 hover 下划线与光标 */}
          {a.url ? (
            <TruncatedTooltip label={name}>
              <a
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="block cursor-pointer truncate font-semibold text-sm hover:underline"
              >
                {name}
              </a>
            </TruncatedTooltip>
          ) : (
            <TruncatedTooltip label={name}>
              <span className="block truncate font-semibold text-sm">{name}</span>
            </TruncatedTooltip>
          )}
          {/* 抖音 uid 这类长 ID 一定会被切，截断处同样要给 tooltip（全仓基准） */}
          {a.id && (
            <TruncatedTooltip label={`ID ${a.id}`}>
              <div className="truncate text-muted-foreground">ID {a.id}</div>
            </TruncatedTooltip>
          )}
          {platformName && (
            <TruncatedTooltip label={platformName}>
              <div className="truncate text-muted-foreground">{platformName}</div>
            </TruncatedTooltip>
          )}
        </div>
      </div>

      {stats.length > 0 && (
        <div className="flex gap-5">
          {stats.map((s) => (
            <div key={s.label} className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">{s.label}</span>
              <span className="text-sm font-semibold tabular-nums">{s.value}</span>
            </div>
          ))}
        </div>
      )}

      {a.sign && (
        <TruncatedTooltip label={a.sign}>
          <p className="truncate text-muted-foreground">{a.sign}</p>
        </TruncatedTooltip>
      )}
    </div>
  );
}

/** 浮层里的一行信息：缺项不占行；`valueClassName` 让「作品标题」这一行跟表格主信息列同字重 */
function Field({
  label,
  children,
  valueClassName,
}: {
  label: string;
  children: React.ReactNode;
  valueClassName?: string;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-baseline gap-2 border-b border-border py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("min-w-0", valueClassName)}>{children}</span>
    </div>
  );
}

/** 去掉最后一段路径得到所在目录（win 的 \ 与 posix 的 / 都吃） */
function dirOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

/**
 * 底部浮层的作品详情：表格六列放不下的全量信息 —— 标题全文、字节总量、
 * 来源链接与落地文件（路径本身就是一枚按钮，点了即在资源管理器里定位）。
 * 文件默认只摊开第一个，其余折叠（业主指令 2026-10-17），展开态**不属于作品**：
 * 换行时由调用方的 `key={row.key}` 重新挂载，否则上一个作品展开到的几十行会跟着换过来的作品一起显示。
 * 平台不在此列（业主指令 2026-10-15）：它由卡片右上角的品牌 SVG 水印表达。
 */
function WorkDetail({
  row,
  onOpenAuthor,
}: {
  row: WorkRow;
  onOpenAuthor: () => void;
}): React.ReactElement {
  const [filesOpen, setFilesOpen] = useState(false);
  return (
    <div className="flex flex-col">
      {/* 标题与标签同行、只占一行（业主指令 2026-10-17）：长标题原先在 1fr 列里换成两三行，
          把这张卡撑高、也把下面的字段推下去；截断后全文走 tooltip 预览 */}
      <Field label="标题" valueClassName="font-medium">
        <TruncatedTooltip label={row.title}>
          <span className="block min-w-0 truncate">{row.title}</span>
        </TruncatedTooltip>
      </Field>
      {row.authorName && (
        <Field label="作者">
          <button
            type="button"
            className="cursor-pointer font-medium hover:underline"
            onClick={onOpenAuthor}
          >
            @{row.authorName}
          </button>
        </Field>
      )}
      {row.kind && <Field label="类型">{kindLabel(row.kind)}</Field>}
      <Field label="文件数">{filesCell(row.count)}{row.bytes != null ? ` · ${fmtBytes(row.bytes)}` : ""}</Field>
      <Field label="创建时间">{fmtCreated(row.createdAt)}</Field>
      {row.sourceUrl && (
        <Field label="来源链接">
          <a
            href={row.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center hover:underline"
          >
            <TruncatedTooltip label={row.sourceUrl} contentClassName="max-w-96">
              <span className="min-w-0 truncate">{row.sourceUrl}</span>
            </TruncatedTooltip>
          </a>
        </Field>
      )}
      {/* 没落地文件就不列「文件」：缺项不占行是同层的规矩，未下载的作品到「来源链接」为止。
          两条同批指令（业主 2026-10-17）：**只显示第一个文件，其余折叠**（N 个文件不该把这张卡顶成一片滚动区，
          而「共 N 个」在「文件数」那行已经说了，折叠控件只补「其余还有几个」）；**路径本身就是动作**
          （点了就在资源管理器里定位，不再另挂一枚图标按钮 —— 那枚 28px 的按钮也正是把行高压到 45 的根因）。
          行高由此与其余字段一致：行内不再有比正文行更高的东西。 */}
      {row.files.length > 0 && (
        <Field label="文件">
          <ul className="flex flex-col">
            {(filesOpen ? row.files : row.files.slice(0, 1)).map((f, i) => (
              <li key={f} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void api.app.showInFolder(dirOf(f))}
                  className="min-w-0 cursor-pointer text-left hover:underline"
                >
                  <TruncatedTooltip label={f} contentClassName="max-w-96">
                    <span className="min-w-0 truncate">{f}</span>
                  </TruncatedTooltip>
                </button>
                {i === 0 && row.files.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFilesOpen((o) => !o)}
                    className="text-muted-foreground hover:text-foreground ms-auto flex shrink-0 cursor-pointer items-center gap-1"
                  >
                    {filesOpen ? "收起" : `其余 ${row.files.length - 1} 个`}
                    {filesOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Field>
      )}
    </div>
  );
}

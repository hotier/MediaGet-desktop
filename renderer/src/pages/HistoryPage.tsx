/**
 * 历史页：解析出的作品清单（作品 / 作者 / 类型 / 文件数 / 创建时间）。
 * 分工（2026-10-14）：本页只讲「哪个作品」——平台、标题、作者、类型、文件数、来源链接；
 * 「哪些文件、下得多大、下到哪」是队列页的资源视图，这里不重复。
 * 表格不带操作列（业主指令 2026-10-15）：唯一的动作「复制作品信息」（含分享链接）跟着作品走，
 * 放在信息卡片的标题行；「打开位置」只对落地文件有意义，就在卡片文件列里 ——
 * 要找文件去队列页，行本身不做任何动作，它只是入口。
 * 作者列显示的是下载那一刻的快照（点昵称开卡片）；客户端不拉实时主页，
 * 所以粉丝量停在下载当天，这是设计而非缺陷。
 * 同一 groupId 的图集条目聚合成一行；旧记录缺 kind/sourceUrl/author（本版本前写入）显示「—」优雅降级；不存媒体直链（§3 隐私）。
 * 行 = 作品的入口（业主指令 2026-10-15）：点行从底部弹出该作品的详细信息浮层，
 * 开着时点别的行直接换成那个作品、点当前这行收起；
 * 队列页右键「查看作品信息」跳到本页并定位高亮对应行。
 * 多选（业主指令 2026-10-15，spec：docs/superpowers/specs/2026-10-15-history-multiselect-design.md）：
 * Ctrl/⌘+点切换、Shift+点范围、Ctrl+A 全选可见、Esc 清空 —— 无修饰点行照旧开详情，两者不打架。
 * 选中 ≥1 行时工具栏「清空历史」临时替换为动作条：复制 / 导出 txt / 导出 CSV / 删除（二次确认）。
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
import { toast } from "sonner";
import { Clock3, Copy, ExternalLink, FolderOpen } from "lucide-react";
import { api } from "../lib/bridge";
import type { AuthorSnapshot, HistoryEntry } from "../../../types/ipc";
import { displayName } from "../../../shared/platforms";
import { PlatformIcon } from "../components/PlatformIcon";
import { cn } from "../lib/utils";
import { buildWorkInfoText } from "../lib/work-info";
import {
  clickRange,
  clickToggle,
  concatWorkInfo,
  EMPTY_SEL,
  isSelected,
  selectAllVisible,
  buildWorksCsv,
  type CsvWork,
  type SelState,
} from "../lib/history-selection";
import { fmtBytes, fmtCount, fmtCreated, kindLabel } from "../lib/format";
import { HISTORY_WINDOW } from "../lib/local-limits";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
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
  kind: "w-[calc(1.5rem+2.4em)]",
  /** 约 7 个汉字；再窄会把五字昵称切成「@胶片…」这种半截词（超长仍在此截断 + tooltip） */
  author: "w-[calc(1.5rem+5.6em)]",
  /** 表头「文件数」比数字值宽，按表头取 */
  count: "w-[calc(1.5rem+3.2em)]",
  /** 容纳最宽形态「2026-10-13 12:32:04」（8.8em） */
  time: "w-[calc(1.5rem+9em)]",
} as const;

interface Row {
  key: string;
  platform?: string;
  title: string;
  kind?: string;
  count: number;
  createdAt: number;
  sourceUrl?: string;
  author?: AuthorSnapshot;
  /** 昵称优先，缺昵称退回 ID；两者都没有则不渲染作者单元格 */
  authorName?: string;
  /** 落地文件路径（底部详情浮层逐条列出） */
  files: string[];
  /** 文件字节总数（历史无 records 时 undefined，浮层不显示大小行） */
  bytes?: number;
}

export default function HistoryPage({
  focusKey,
  platformFocus,
}: {
  focusKey?: string | null;
  /** 统计页平台榜带过来的意图：seq 变一次就应用一次（同值复点也要生效） */
  platformFocus?: { key: string; seq: number } | null;
}): React.ReactElement {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [platform, setPlatform] = useState<string>("");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [authorRow, setAuthorRow] = useState<Row | null>(null);
  // 作者卡片可见态与数据态分开：关闭只翻 visible，行留着 —— Radix 收起动画（200ms）期间这层还在 DOM，
  // 若把行一起置 null，卡片会先被抽空再淡出，看不见「向下收起」那一段（业主指令 2026-10-15 增强）
  const [authorShown, setAuthorShown] = useState(false);
  const openAuthor = (r: Row) => {
    setAuthorRow(r);
    setAuthorShown(true);
  };
  // 与作者卡片同一处理（业主指令 2026-10-15 修复收起「直接消失」）：关闭只翻 shown，
  // detailRow 留着。Radix 收起那 250ms 里壳层还在 DOM，内容若一起置 null，面板先塌成空壳
  // 再滑走，位移动画完全没有可见内容承载 → 看起来就是瞬间消失。
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [detailShown, setDetailShown] = useState(false);
  const openDetail = (r: Row): void => {
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
        // 浮层开着时 Esc 归浮层（Radix 自收）；没浮层且有选中才清空选择
        if (document.querySelector('[data-slot="dialog-content"], [data-slot="sheet-content"]')) return;
        setSel((s) => (s.keys.length > 0 ? EMPTY_SEL : s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { rows, allRows, platforms } = useMemo(() => {
    // store 返回新在前；按首次出现序聚组即保持倒序
    const byGroup = new Map<string, HistoryEntry[]>();
    for (const h of list) {
      const key = h.groupId ?? h.id;
      const g = byGroup.get(key);
      if (g) g.push(h);
      else byGroup.set(key, [h]);
    }
    const all: Row[] = [...byGroup.entries()].map(([key, g]) => {
      const head = g[0];
      const count = g.reduce((s, e) => s + e.files.length, 0);
      const author = g.find((e) => e.author)?.author;
      const bytesList = g.map((e) => e.bytes).filter((b): b is number => b != null);
      return {
        key,
        platform: head.platform,
        title: head.title ?? "（未命名）",
        kind: head.kind,
        count,
        createdAt: Math.max(...g.map((e) => e.createdAt)),
        sourceUrl: g.find((e) => e.sourceUrl)?.sourceUrl,
        author,
        authorName: author?.name || author?.id || undefined,
        files: g.flatMap((e) => e.files),
        bytes: bytesList.length > 0 ? bytesList.reduce((s, b) => s + b, 0) : undefined,
      };
    });
    const q = query.trim().toLowerCase();
    const within = TIME_RANGES.find((f) => f.key === timeRange)!.within;
    const now = Date.now();
    const hit = (r: Row): boolean =>
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
  visibleKeysRef.current = rows.map((r) => r.key);
  /** 选中行按**全量** allRows 解析（键序沿用 allRows：新在前）——被筛掉的选中行不丢 */
  const selectedRows = useMemo(() => {
    const picked = new Set(sel.keys);
    return allRows.filter((r) => picked.has(r.key));
  }, [sel.keys, allRows]);

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

  function copyInfo(r: Row): void {
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
  function workTexts(rs: Row[]): string[] {
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

  /** 多选·删除（确认弹窗的「确认删除」按钮调）：以 removeHistory 的返回值为新列表，
   *  不回读 history.list —— 省一次往返，也不给并发留窗口 */
  function removeSelected(): void {
    void api.history
      .remove(sel.keys)
      .then((rest) => {
        setList(rest);
        setSel(EMPTY_SEL);
        setSelDelOpen(false);
        toast.success(`已删除 ${selectedRows.length} 条记录（文件仍在磁盘）`);
      })
      .catch(() => toast.error("删除失败"));
  }

  // 首次空（真没记录）与过滤空是两种状态：后者保留工具栏，让人改条件而不是以为历史被清空了
  if (list.length === 0) {
    return (
      <section className="flex flex-col items-center gap-3 py-16 text-center">
        <Clock3 className="size-11 text-faint" strokeWidth={1.5} aria-hidden="true" />
        <div className="font-medium text-sm">暂无历史记录</div>
        <p className="text-sm text-muted-foreground">解析并下载成功的作品会自动记录在这里。</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <Card className="py-0">
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
          {/* 多选动作条（业主指令 2026-10-15）：选中 ≥1 时「清空历史」整体让位 ——
              同时摆两个 destructive 入口（清空全部 / 删除选中）必然误点，替换是更安全的一侧。
              ms-auto 挂在本容器上而不是按钮上：动作条整组靠右，内部 gap-2 自然排开 */}
          {sel.keys.length === 0 ? (
            <Button variant="destructive" size="sm" className="ms-auto" onClick={() => setClearOpen(true)}>
              清空历史
            </Button>
          ) : (
            <div className="ms-auto flex items-center gap-2">
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
              <Button variant="destructive" size="sm" onClick={() => setSelDelOpen(true)}>
                删除
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSel(EMPTY_SEL)}>
                取消选择
              </Button>
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
            <span>没有符合条件的记录</span>
            <Button size="sm" variant="outline" onClick={clearFilters}>
              清除筛选
            </Button>
          </div>
        ) : (
          /* 底线 = 定宽列 + 作品列可读下限（约 17em）；窗口更窄时横向滚，而不是把作品列压成 0 宽 */
          <Table className="min-w-[41em]">
            <TableHeader>
              <TableRow>
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
                    // 选中态与跳转高亮同款描边（多选不加勾选框列，高亮即「已选」——业主指令）
                    isSelected(sel, r.key) && "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/50",
                    flashKey === r.key && "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary/50"
                  )}
                >
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
                    {r.count} 个
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

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>清空全部下载历史？</DialogTitle>
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

      {/* 多选·删除二次确认（spec §3A：destructive，与「清空历史」同形制）。
          文案带条数 —— 「删几条」必须出现在确认位上，误删的唯一防线就是这句话。 */}
      <Dialog open={selDelOpen} onOpenChange={setSelDelOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除选中的 {selectedRows.length} 条记录？</DialogTitle>
            <DialogDescription>只删除本机的历史记录，已下载的文件不会被动。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSelDelOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={removeSelected}>
              删除
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
          showOverlay={false}
          className="max-w-sm slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8 data-[state=open]:ease-out data-[state=closed]:ease-in data-[state=closed]:duration-250"
        >
          <DialogHeader>
            <DialogTitle>作者卡片</DialogTitle>
            <DialogDescription>下载那一刻解析到的作者信息，之后不会自动更新。</DialogDescription>
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
                <WorkDetail row={detailRow} onOpenAuthor={() => openAuthor(detailRow)} />
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

/** 作者卡片：快照字段逐项展示，缺项不占行；头像加载失败退回首字占位 */
function AuthorCard({
  row,
  platformName,
}: {
  row: Row;
  platformName: string;
}): React.ReactElement {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const a = row.author;
  if (!a) return <p className="text-muted-foreground">该记录未保存作者信息（此后生效）。</p>;

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
            {(a.name ?? a.id ?? "?").slice(0, 1)}
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate font-semibold text-sm">{a.name ?? a.id}</div>
          {a.id && <div className="truncate text-muted-foreground">ID {a.id}</div>}
          {platformName && (
            <div className="truncate text-muted-foreground">{platformName}</div>
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

      {a.sign && <p className="text-muted-foreground">{a.sign}</p>}

      {/* 外链走 <a target=_blank>，由主进程 setWindowOpenHandler 转交系统浏览器；
          样式跟结果卡一致（Button asChild + ExternalLink），不用 text-primary ——
          那是动态魔法色，历史页没有封面去设它，会停在中性初值上（对比度 1.9:1，看着像禁用） */}
      {a.url && (
        <Button asChild variant="outline" size="sm" className="self-start">
          <a href={a.url} target="_blank" rel="noreferrer">
            <ExternalLink />
            在浏览器中打开主页
          </a>
        </Button>
      )}

      <TruncatedTooltip label={row.title}>
        <div className="truncate border-t border-border pt-3 text-muted-foreground">
          作品：{row.title}
        </div>
      </TruncatedTooltip>
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
 * 来源链接与每个落地文件（文件在历史页只给「打开位置」，不显示路径）。
 * 平台不在此列（业主指令 2026-10-15）：它由卡片右上角的品牌 SVG 水印表达。
 */
function WorkDetail({
  row,
  onOpenAuthor,
}: {
  row: Row;
  onOpenAuthor: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col">
      <Field label="标题" valueClassName="font-medium">{row.title}</Field>
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
      <Field label="文件数">{row.count} 个{row.bytes != null ? ` · ${fmtBytes(row.bytes)}` : ""}</Field>
      <Field label="创建时间">{fmtCreated(row.createdAt)}</Field>
      {row.sourceUrl && (
        <Field label="来源链接">
          <a
            href={row.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1 hover:underline"
          >
            <TruncatedTooltip label={row.sourceUrl} contentClassName="max-w-96">
              <span className="min-w-0 truncate">{row.sourceUrl}</span>
            </TruncatedTooltip>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        </Field>
      )}
      <Field label="文件">
        <ul className="flex flex-col">
          {row.files.map((f) => (
            <li key={f} className="flex items-center gap-2 py-1 first:pt-0 last:pb-0">
              <TruncatedTooltip label={f} contentClassName="max-w-96">
                <span className="min-w-0 flex-1 truncate">{f}</span>
              </TruncatedTooltip>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0"
                aria-label="打开位置"
                onClick={() => void api.app.showInFolder(dirOf(f))}
              >
                <FolderOpen />
              </Button>
            </li>
          ))}
        </ul>
      </Field>
    </div>
  );
}

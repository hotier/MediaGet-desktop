/**
 * 队列页：下载的资源视图（文件 / 状态 / 进度 / 大小 / 速度 / 剩余时间 / 创建时间 / 完成时间）。
 * 分工（2026-10-14）：本页讲「哪些文件、下得多大、下到哪、什么时候下的」；「哪个作品」归历史页。
 * 队列只有**一张表**（一个卡片）：表头一份，所有链接的行顺序排在同个 TableBody 里（2026-10-15 业主指令）。
 * 一个链接多条资源（同 groupId）= 表里的「主线程行 + 子行」：主线程行不是另一种卡片，它就是这张八列表格
 * 的一行，只是**自己没有资源**——每格都从子行算出来：
 * 大小 sum、速度 均值、剩余 sum、创建时间 最早、完成时间 最晚（子行不全 done 则「—」）。
 * 速度与剩余的取值口径（业主指令 2026-10-18）：**在动报实时、暂停报暂停那一刻的快照、完成报平均速度**；
 * 排队/失败/已取消没有可信的数，一律「—」（详见 `speedCell()` 与 `aggregate()`）。
 * 默认收起（点标题右侧的箭头展开子行，箭头不放行首——那样主标题会被推离统一的 x）；单资源链接没有主线程行，那一行文件本身就是主线程。
 * 「状态」列 = 徽标 + 至多一颗动作图标（暂停/继续/重试），动作说的就是徽标那个词；
 * 「取消」不再单独占列（2026-10-18 业主指令移除操作列），改由右键菜单「取消下载」承接 ——
 * 暂停/继续仍在徽标里，取消是破坏性动作，藏在菜单里反而少误触。
 * 排版（业主指令 2026-10-15 统一，与历史页同口径）：表格只有一个字号档位（「设置→外观→界面字号」，默认 13px），
 * 列与列之间不分大小；层级只靠字重与色彩 —— 主信息（作品标题）`font-medium` + 前景、子行文件名常规 + 前景、
 * 元数据（大小/速度/剩余/时间/百分比）常规 + muted；数字列 tabular-nums；字体族全 UI 栈，不混等宽。
 * 右键菜单（业主指令 2026-10-15）：不显示文件名（行里就是它）；「查看作品信息」跳历史页定位该作品行。
 * 「完成时间」取档内 `finishedAt`（契约 v13：进过队列的行全部留档，重启后照样回来）；
 * 要看这个作品本身去历史页，这里只是下载台账。
 * 筛选（UIUX-DESIGN §2.2）：状态分段 + 搜索 + 平台 + 时间窗。筛选与分页都在主进程做（SQLite），
 * 本页只持当前已加载页；「加载更多」按稳定游标续页。
 * 筛选的单位是**作品（组）**：组里任一文件命中整组入选，页边界不会切开一个作品（组行聚合要整组才算得对）；
 * 展开时只画命中的子行，组行的数值仍是整组的真实聚合——进度与 `完成/总数` 说的是这个作品，不是筛选结果。
 * 实时事件只更新已加载行：服务端页决定成员，事件只换同一 taskId 的那颗引用。
 * 清理（契约 v4）：表头「清理已结束」与行菜单「从队列移除」都走 `download:clear`，只收终态（完成/失败/已取消）——
 * 进行中就算被点名也由主进程二次拒绝，返回值 `removed` 少了即是拒绝掉的颗数，播报照它说，不报「清理完成」。
 * 清理按钮的颗数跟搜索/平台走、不跟状态分段走：分段是「我在看哪一类」，清理是「这批结束的都要走」，两者不该互相牵制。
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Copy, DownloadCloud, FolderOpen, Info, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "../lib/bridge";
import { cn } from "../lib/utils";
import { avgSpeed, fmtBytes, fmtCreated, fmtEta, fmtSpeed } from "../lib/format";
import type { DownloadTaskView, QueueCursor, QueueFilter } from "../../../types/ipc";
import { canonicalKeys, displayName } from "../../../shared/platforms";
import { QUEUE_PAGE_SIZE } from "../lib/local-limits";
import { PlatformIcon } from "../components/PlatformIcon";
import { Button } from "../components/ui/button";
import { badgeVariants } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger, TruncatedTooltip, HintInfo } from "../components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu";

interface TaskGroup {
  groupId: string;
  /** 整组：组行的每一格都从这里算 */
  tasks: DownloadTaskView[];
  /** 命中搜索/平台筛选的子行（分段计数按它们算，与状态分段无关） */
  hits: DownloadTaskView[];
  /** 命中筛选的子行 */
  visible: DownloadTaskView[];
}

/**
 * 组行的**视图**：渲染需要的一切都在这一个对象里算好。
 * 存在的理由是性能：一个进度事件只换掉 `tasks` 里的一颗引用，但父层重渲时整表的组行
 * 会跟着全部重建 —— 本机同条件 A/B（115 行、60 事件一次 burst）实测每个进度事件
 * 15.8 ms → 3.85 ms 主线程工作量。实时并发 3 路 = 15 事件/秒，按 15.8 算是每秒吃掉
 * 237 ms ≈ 24% 的帧预算，全花在重画那些根本没动的行上。
 * 视图在「筛选条件 + 组内任务引用」都没变时**复用同一个对象**，memo 才拦得住那些行。
 */
interface GroupView extends TaskGroup {
  multi: boolean;
  title: string;
  platform?: string;
  agg: Aggregate;
  /** 组行动作的目标（原实现是渲染时按状态现筛，现在随视图算好，保证引用稳定） */
  activeIds: string[];
  pausedIds: string[];
  errorIds: string[];
}

/** Radix Select 不接受空串作为 value，「全部平台」用一个不会与平台 key 撞车的哨兵 */
const ALL = "__all__";

type StatusFilter = "all" | "active" | "done" | "error" | "canceled";
type TimeRange = "all" | "today" | "7d" | "30d";

/** 时间窗按自然日切，与历史页同口径；服务端吃 DateKey，本地只负责把子行藏到窗外 */
const TIME_RANGES: Array<{ key: TimeRange; label: string }> = [
  { key: "all", label: "全部时间" },
  { key: "today", label: "今天" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
];

/** 分段是「文件状态」的桶（`paused` 归进行中——它就是暂停在那里的一组文件）；已取消与失败分开，重试动作不同 */
const STATUS_FILTERS: Array<{ key: StatusFilter; label: string; match: (s: DownloadTaskView["status"]) => boolean }> = [
  { key: "all", label: "全部状态", match: () => true },
  { key: "active", label: "进行中", match: (s) => s === "queued" || s === "downloading" || s === "paused" },
  { key: "done", label: "完成", match: (s) => s === "done" },
  { key: "error", label: "失败", match: (s) => s === "error" },
  { key: "canceled", label: "已取消", match: (s) => s === "canceled" },
];

/** 行级移除：clear 的入参是数组，单行也包一颗。模块级引用，不随渲染重建 */
const clearOne = (id: string): Promise<unknown> => api.download.clear([id]);

/**
 * table-fixed 下「文件」列不设宽 = 吃掉整行剩余宽度并在此截断；其余列必须显式定宽，
 * 否则会被均分（主线程行与子行同表，宽度由表头那一行决定，所以 th 与 td 共用这一组常量）。
 * 2026-10-15 业主指令：**队列每格单行**（日期与时刻同行、进度条与百分比同行、剩余固定 HH:mm:ss）。
 * 列宽一律写成 `1.5rem + Nem`：1.5rem 是 td 的左右内边距（px-3，与字号无关），
 * N em 是最坏内容宽——写成 em 才会跟着「设置→外观→界面字号」那一档缩放，换档不重排也不截字。
 * 最坏内容实测（13px 档）：状态徽标「失败 12」+ 重试图标 74（汉字 3.2em + 图标 12 + 间距 4 + 徽标内边距 16，
 * 动作图标就在徽标里面：下载中→暂停、已暂停→继续、失败/已取消→重试，排队与完成没有可给的动作就不是按钮）；
 * 大小「999.9 MB」54；速度「999.9 MB/s」65；剩余「99:59:59」48；时间「2025-12-31 23:59:59」114；
 * 百分比 `w-[2.4em]`（「100%」30、「0%」16 —— 不固定位数会让每行的条长短不一），条吃掉剩下的并且每行等长。
 * 2026-10-18 业主指令「加宽状态列 + 保留速度列的数值」：状态 3.6em（46.8 < 74）根本装不下带图标的徽标，
 * 速度 4em（52 < 65）会让「999.9 MB/s」溢出到剩余列 —— 两列各自提到装得下的宽度（5.7 / 5.2em）。
 * MIN_W = 69.7em：定宽内容合计 54.6em + 8 格内边距 14.8em ≈ 69.4em，剩下那点给文件列。
 * 文件列要装下主线程行的「15 平台图标 + 标题 + 28 箭头 + 18 完成数」，实测这些固定件占 113，
 * 底线给到 320 标题才有 211px ≈ 14 个汉字可读（再窄一档只剩 7 个字，等于没标题）。
 * 单行八列放不进默认 1080 窗口（内容宽 794），由表格容器 overflow-x-auto 横向滚；
 * 要整屏不滚只能砍列或砍字号，那由业主定。
 */
const COL = {
  // 2026-10-18 业主指令：状态列与速度列各自放宽到「最坏内容装得下」——
  // 状态徽标含动作图标要 74（5.7em），速度「999.9 MB/s」要 65（5em，给到 5.2em 留余量）。
  // 不从速度列刮宽度去补状态列：**速度列的数值必须完整可见**，两列各长各的，总宽交给 TABLE_MIN_W。
  status: "w-[calc(1.5rem+5.7em)]",
  // 进度/大小/剩余四列（2026-10-18 业主指令：取消列移除，腾出的宽度分给它们）
  progress: "w-[calc(1.5rem+5.7em)]",
  size: "w-[calc(1.5rem+4em)]",
  speed: "w-[calc(1.5rem+5.2em)]",
  eta: "w-[calc(1.5rem+4em)]",
  created: "w-[calc(1.5rem+7em)]",
  finished: "w-[calc(1.5rem+7em)]",
} as const;

/** 定宽内容 54.6em + 8 格内边距 14.8em ≈ 69.4em；66.4 → 69.7 加的就是状态 +2.1em 与速度 +1.2em */
const TABLE_MIN_W = "min-w-[69.7em]";

export default function DownloadsPage({ onNav }: { onNav: OnNav }): React.ReactElement {
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  const [nextCursor, setNextCursor] = useState<QueueCursor | null>(null);
  const [loading, setLoading] = useState(true);
  /** 行级动作后强制回读第一页：游标按改动前的组算过，不能拿旧 cursor 接着翻 */
  const [reloadSeq, setReloadSeq] = useState(0);
  // 主线程默认收起：记住的是「谁被展开了」，而不是「谁被折叠了」——后者要给每个新组预填 id
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  const dateWindow = useMemo(() => {
    if (timeRange === "all") return null;
    const end = new Date();
    const start = new Date(end);
    if (timeRange === "today") start.setHours(0, 0, 0, 0);
    else start.setDate(start.getDate() - (timeRange === "7d" ? 6 : 29));
    const key = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return {
      from: key(start),
      to: key(end),
      firstDay: new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime(),
      nextDay: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime(),
    };
  }, [timeRange]);

  const serverFilter = useMemo<QueueFilter>(
    () => ({
      ...(statusFilter === "all" ? {} : { status: statusFilter }),
      ...(platform ? { platform } : {}),
      ...(dateWindow ? { from: dateWindow.from, to: dateWindow.to } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      limit: QUEUE_PAGE_SIZE,
    }),
    [statusFilter, platform, dateWindow, query]
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setTasks([]);
    setNextCursor(null);
    // 失败必须出声（同 HistoryPage 那条）：一次 `download:list` 报错在屏幕上与「队列真没记录」
    // 完全同形。文案只挂在动作上，不进空态分支。
    void api.download
      .list(serverFilter)
      .then((page) => {
        if (!active) return;
        setTasks(page.rows);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (active) toast.error(`下载队列读取失败：${String(e instanceof Error ? e.message : e)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [serverFilter, reloadSeq]);

  // 事件只更新已加载行：页面成员由服务端筛选决定，这里不做「未知行插到队首」——
  // 那会让一次失败重试把被筛掉的作品硬塞回当前视图。
  useEffect(() => {
    const update = (t: DownloadTaskView): void => setTasks((prev) => mergeLive(prev, t));
    const offs = [
      api.download.onProgress(update),
      api.download.onDone(update),
      api.download.onError(update),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Ctrl+F 聚焦本页搜索框（§3.4 L1）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function loadMore(): void {
    if (!nextCursor || loading) return;
    setLoading(true);
    void api.download
      .list({ ...serverFilter, cursor: nextCursor })
      .then((page) => {
        setTasks((current) => mergePage(current, page.rows));
        setNextCursor(page.nextCursor);
      })
      .catch(() => toast.error("更多下载项读取失败"))
      .finally(() => setLoading(false));
  }

  // 平台选项池来自注册表（不是当前已加载页）：选过一个平台也能切回别的，且不会因为
  // 翻页把某个平台从下拉里翻没。显示名同样直接查注册表，不经 getMeta 异步到达。
  const platforms = useMemo(() => canonicalKeys(), []);

  /** groupId → 上一次的视图；筛选条件与组内任务引用都没变就复用同一个对象 */
  const viewCache = useRef(new Map<string, { key: string; view: GroupView }>());

  const rows = useMemo(() => {
    const byId = new Map<string, DownloadTaskView[]>();
    for (const t of tasks) {
      const g = byId.get(t.groupId);
      if (g) g.push(t);
      else byId.set(t.groupId, [t]);
    }
    const q = query.trim().toLowerCase();
    const matchStatus = STATUS_FILTERS.find((f) => f.key === statusFilter)!.match;
    // 服务端按组筛，返回的是整组任务；子行还要按同一条件再筛一遍——
    // 同一作品里可能有窗外/不命中搜索的文件，它们不该在展开时露出来。
    const inScope = (t: DownloadTaskView): boolean =>
      (platform === "" || t.platform === platform) &&
      (q === "" ||
        `${t.filename} ${t.title ?? ""} ${displayName(t.platform)} ${t.sourceUrl ?? ""}`
          .toLowerCase()
          .includes(q)) &&
      (!dateWindow || (t.createdAt >= dateWindow.firstDay && t.createdAt < dateWindow.nextDay));
    const key = `${q}\u0000${statusFilter}\u0000${platform}\u0000${timeRange}`;
    const nextRows: GroupView[] = [];
    const cache = viewCache.current;
    for (const [groupId, groupTasks] of byId) {
      const prev = cache.get(groupId);
      // 事件只替换变化那一条的引用，未动的组靠引用比较就能确认「视图还是对的」
      const view =
        prev && prev.key === key && sameTasks(prev.view.tasks, groupTasks)
          ? prev.view
          : buildView(groupId, groupTasks, inScope, matchStatus);
      cache.set(groupId, { key, view });
      if (view.visible.length > 0) nextRows.push(view);
    }
    // 队列里已经没有的组要从缓存退出去，否则清完队列缓存只进不出
    for (const id of [...cache.keys()]) if (!byId.has(id)) cache.delete(id);
    return nextRows;
  }, [tasks, statusFilter, query, platform, timeRange, dateWindow]);

  function clearFilters(): void {
    setStatusFilter("all");
    setQuery("");
    setPlatform("");
    setTimeRange("all");
  }

  /**
   * 行级动作。必须是**稳定引用**（useCallback）：行组件靠 memo  bailout，
   * 每次渲染新建一个闭包就等于把所有行都判成「变了」，memo 白挂。
   */
  const act = useCallback(async (fn: (id: string) => Promise<unknown>, id: string) => {
    try {
      await fn(id);
      // 状态可能把这一组筛出当前视图（例如失败筛选下点了重试），回读第一页而不是就地打补丁
      setReloadSeq((n) => n + 1);
    } catch {
      /* 状态竞争（已完成再取消等）忽略 */
    }
  }, []);

  const toggleGroup = useCallback((groupId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  // 首次空（真没任务）与过滤空是两种状态：后者保留工具栏，让人改条件而不是以为队列被清空了
  if (
    tasks.length === 0 &&
    !loading &&
    statusFilter === "all" &&
    platform === "" &&
    timeRange === "all" &&
    query.trim() === ""
  ) {
    return (
      // 空态只留标题一行，说明段删掉（业主指令 2026-10-17）；剩下这一组在可用高度里垂直居中，
      // 不再顶着页头悬在半空
      <section className="flex min-h-full flex-col gap-3">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <DownloadCloud className="size-11 text-faint" strokeWidth={1.5} aria-hidden="true" />
          <div className="font-medium">暂无下载任务</div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {/* gap-0 同历史页：不让 Card 的 gap-4 在工具栏底线与表头之间垫出空带 */}
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
          {/* 筛选器在左，搜索框在右（与历史页同口径） */}
          <div className="flex items-center gap-2">
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger size="sm" className="w-28" aria-label="按状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={platform === "" ? ALL : platform} onValueChange={(v) => setPlatform(v === ALL ? "" : v)}>
              <SelectTrigger size="sm" className="w-28" aria-label="按平台筛选">
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
            {/* 时间筛选：与历史页同口径，按创建时间过滤 */}
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
          </div>
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文件名 / 标题"
            aria-label="搜索下载项"
            className="h-8 w-52 ms-auto"
          />
        </div>
        {/* 只留 pb：pt 会把表头顶离工具栏底线，那 4px 又变成「表头比内容行高」 */}
        <CardContent className="pb-1">
          {rows.length === 0 ? (
            loading ? (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                加载中…
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
                <span>没有符合条件的下载项</span>
                <Button size="sm" variant="outline" onClick={clearFilters}>
                  清除筛选
                </Button>
              </div>
            )
          ) : (
            <div className="overflow-x-auto">
              <QueueTable
                groups={rows}
                expanded={expanded}
                onToggle={toggleGroup}
                onAct={act}
                onNav={onNav}
              />
            </div>
          )}
        </CardContent>
        {nextCursor && (
          <div className="flex justify-center border-t border-border py-2">
            <Button size="sm" variant="ghost" onClick={loadMore} disabled={loading}>
              {loading ? "加载中…" : "加载更多"}
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}

type OnAct = (fn: (id: string) => Promise<unknown>, id: string) => Promise<void>;

/** 跨页跳转：带 groupId 去历史页定位那一行作品 */
type OnNav = (page: "history", groupId: string) => void;

/** 组行九格的数值集（aggregate() 的产物，随 GroupView 一起复用） */
interface Aggregate {
  total: number;
  pct: number;
  /**
   * 「速度」列与「剩余」列的同一个分母：在动取实时均速 → 只剩暂停取暂停快照均速 →
   * 全完成取各文件平均速度的均值（同一组里不把三种口径混着平均，那会造出一个谁也不是的数）。
   */
  speed: number;
  remaining: number;
  anyPaused: boolean;
  running: number;
  failed: number;
  created: number;
  finished: number;
  done: number;
}

/**
 * 「速度」列该显示的数（字节/秒）；0 = 这一格没有可报的数，渲染「—」。
 * - 下载中：实时采样值
 * - 已暂停：**暂停那一刻的快照** —— 主进程 `pause()` 故意不清 speed，且它随队列档落盘（契约 v17），
 *   所以暂停行在重启后照样说得清「当时多快」
 * - 完成：平均速度 = `transferBytes ÷ transferMs`（实际传输时长，契约 v18）。
 *   分子分母必须取自同一段区间：接着旧 `.part` 写的行，`transferBytes` 只覆盖后半程，
 *   用整个 `received` 当分子会把速度凭空翻倍。暂停多久都不进分母 —— 那是「停了」不是「下得慢」
 * - 排队 / 失败 / 已取消：没有可信的数，宁可空着也不报一个别处的值
 */
function speedCell(t: DownloadTaskView): number {
  if (t.status === "downloading" || t.status === "paused") return t.speed > 0 ? t.speed : 0;
  if (t.status !== "done") return 0;
  return avgSpeed(t.transferBytes, t.transferMs > 0 ? t.transferMs : null) ?? 0;
}

/**
 * 主线程行的数据来源：它自己没有资源，每一格都是从子行算出来的。
 * 大小 sum、剩余 sum（= sum(未下完字节)）、创建时间取最早、完成时间取最晚（子行不全 done 则不报）。
 * 速度按状态分档取（见 `speedCell()`）：在动的均速／暂停快照的均速／完成行平均速度的均值。
 * 均速只平均「有数的那几颗」——排队与失败的 speed 是 0，参与平均会把 30 图组里 3 张在动的速度压成 1/10。
 */
function aggregate(tasks: DownloadTaskView[]): Aggregate {
  const sum = (f: (t: DownloadTaskView) => number): number => tasks.reduce((s, t) => s + f(t), 0);
  const total = sum((t) => Math.max(t.total, 0));
  const recv = sum((t) => t.received);
  const allDone = tasks.every((t) => t.status === "done");
  const mean = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const speedsOf = (status: DownloadTaskView["status"]): number[] =>
    tasks.filter((t) => t.status === status).map(speedCell).filter((v) => v > 0);
  const live = speedsOf("downloading");
  const paused = speedsOf("paused");
  const done = speedsOf("done");
  return {
    total,
    pct: total > 0 ? Math.min(100, (recv / total) * 100) : 0,
    speed: live.length > 0 ? mean(live) : paused.length > 0 ? mean(paused) : mean(done),
    remaining: sum((t) => Math.max(t.total - t.received, 0)),
    anyPaused: tasks.some((t) => t.status === "paused"),
    running: tasks.filter((t) => t.status === "downloading").length,
    failed: tasks.filter((t) => t.status === "error").length,
    created: Math.min(...tasks.map((t) => t.createdAt)),
    finished: allDone ? Math.max(...tasks.map((t) => t.finishedAt ?? 0)) : 0,
    done: tasks.filter((t) => t.status === "done").length,
  };
}

/** 组内任务引用逐个相同 = 这一组这一次没有任何变化（mergeLive 只换动过的那一条） */
function sameTasks(a: DownloadTaskView[], b: DownloadTaskView[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** 算一个组的完整视图（筛选、聚合、动作目标）；调用方负责在输入没变时复用它 */
function buildView(
  groupId: string,
  tasks: DownloadTaskView[],
  inScope: (t: DownloadTaskView) => boolean,
  matchStatus: (s: DownloadTaskView["status"]) => boolean
): GroupView {
  const hits = tasks.filter(inScope);
  const ids = (pred: (t: DownloadTaskView) => boolean): string[] =>
    tasks.filter(pred).map((t) => t.taskId);
  return {
    groupId,
    tasks,
    hits,
    visible: hits.filter((t) => matchStatus(t.status)),
    multi: tasks.length > 1,
    title: tasks.find((t) => t.title)?.title ?? tasks[0].filename,
    platform: tasks.find((t) => t.platform)?.platform,
    agg: aggregate(tasks),
    activeIds: ids((t) => t.status === "downloading" || t.status === "queued"),
    pausedIds: ids((t) => t.status === "paused"),
    errorIds: ids((t) => t.status === "error"),
  };
}

/**
 * 队列的唯一一张表：一份列标题，所有链接（主线程行 + 其展开的子行）依次排在同一个 tbody 里。
 * 分成多张表会让每段各有一份列标题——那是同一个展示面重复 N 遍。
 */
function QueueTable({
  groups,
  expanded,
  onToggle,
  onAct,
  onNav,
}: {
  groups: GroupView[];
  expanded: Set<string>;
  onToggle: (groupId: string) => void;
  onAct: OnAct;
  onNav: OnNav;
}): React.ReactElement {
  return (
    <Table className={TABLE_MIN_W}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[calc(1.5rem+16em)]">文件</TableHead>
          <TableHead className={COL.status}>状态</TableHead>
          <TableHead className={COL.progress}>进度</TableHead>
          <TableHead className={COL.size}>大小</TableHead>
          <TableHead className={COL.speed}>速度</TableHead>
          <TableHead className={COL.eta}>剩余</TableHead>
          <TableHead className={COL.created}>创建时间</TableHead>
          <TableHead className={COL.finished}>完成时间</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => {
          // 单资源链接没有主线程行：那一行文件本身就是主线程
          const open = expanded.has(g.groupId);
          return (
            <Fragment key={g.groupId}>
              {g.multi && <GroupRow view={g} open={open} onToggle={onToggle} onAct={onAct} />}
              {(!g.multi || open) &&
                g.visible.map((t) => (
                  <TaskRow key={t.taskId} t={t} nested={g.multi} onAct={onAct} onNav={onNav} />
                ))}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ProgressBar({ pct }: { pct: number }): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <Progress value={pct} className="h-1 min-w-0 flex-1" />
      <span className="w-[2.4em] shrink-0 text-right tabular-nums text-muted-foreground">
        {Math.round(pct)}%
      </span>
    </div>
  );
}

/**
 * 主线程行（一个作品一颗行）。memo 的前提是 `view` 引用稳定 —— 由调用侧的
 * 视图缓存保证（筛选条件与组内任务引用都没变就复用同一个对象）。
 */
const GroupRow = memo(function GroupRow({
  view,
  open,
  onToggle,
  onAct,
}: {
  view: GroupView;
  open: boolean;
  onToggle: (groupId: string) => void;
  onAct: OnAct;
}): React.ReactElement {
  const a = view.agg;
  const { title, platform } = view;
  const batch = (ids: string[], fn: (id: string) => Promise<unknown>) =>
    void (async () => {
      for (const id of ids) await onAct(fn, id);
    })();
  // 聚合行同样只有一颗动作，按优先级取：在动→全部暂停；暂停→继续全部；有失败→重试失败项
  const action =
    a.running > 0
      ? { label: "全部暂停", icon: <Pause />, run: () => batch(view.activeIds, api.download.pause) }
      : a.anyPaused
        ? { label: "继续全部", icon: <Play />, run: () => batch(view.pausedIds, api.download.resume) }
        : a.failed > 0
          ? { label: "重试失败项", icon: <RotateCcw />, run: () => batch(view.errorIds, api.download.resume) }
          : undefined;
  const [label, variant] = groupBadge(view.tasks);
  return (
    <TableRow className="bg-muted/40">
      <TableCell>
        <div className="flex min-w-0 items-center gap-2">
          <PlatformIcon platform={platform} />
          <TruncatedTooltip label={title}>
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          </TruncatedTooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0"
                aria-expanded={open}
                aria-label={`${open ? "收起" : "展开"} ${title} 的 ${view.visible.length} 个文件`}
                onClick={() => onToggle(view.groupId)}
              >
                {open ? <ChevronDown /> : <ChevronRight />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{open ? "收起" : "展开"}</TooltipContent>
          </Tooltip>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {a.done}/{view.tasks.length}
          </span>
        </div>
      </TableCell>
      <TableCell className={COL.status}>
        <StatusPill label={label} variant={variant} action={action} />
      </TableCell>
      <TableCell className={COL.progress}>
        <ProgressBar pct={a.pct} />
      </TableCell>
      <TableCell className={`${COL.size} whitespace-nowrap tabular-nums text-muted-foreground`}>
        {a.total > 0 ? fmtBytes(a.total) : "—"}
      </TableCell>
      <TableCell className={`${COL.speed} whitespace-nowrap tabular-nums text-muted-foreground`}>
        {fmtSpeed(a.speed)}
      </TableCell>
      <TableCell className={`${COL.eta} whitespace-nowrap tabular-nums text-muted-foreground`}>
        {fmtEta(a.remaining, a.speed)}
      </TableCell>
      <TableCell className={COL.created}>
        <TimeCell ts={a.created} />
      </TableCell>
      <TableCell className={COL.finished}>
        {a.finished > 0 ? <TimeCell ts={a.finished} /> : <Dash />}
      </TableCell>
    </TableRow>
  );
});

function Dash(): React.ReactElement {
  return <span className="text-muted-foreground">—</span>;
}

/**
 * 文件行。`t` 的引用只在**这一条**任务有事件时变化（mergeLive 只换动过的那一颗），
 * 加上 onAct/onNav 都是稳定引用，所以每个进度事件真正重渲染的只有它自己那一行。
 */
const TaskRow = memo(function TaskRow({
  t,
  nested,
  onAct,
  onNav,
}: {
  t: DownloadTaskView;
  nested: boolean;
  onAct: OnAct;
  onNav: OnNav;
}): React.ReactElement {
  const action = rowAction(t, onAct);
  // 取消/移除的互斥判据（原来喂给操作列那颗按钮，列撤掉后只剩右键菜单在用）：
  // 在动的行给「取消下载」，终态行给「从队列移除」，同一行不会两个都给
  const canCancel = t.status === "queued" || t.status === "downloading" || t.status === "paused";
  // 复制走主进程代发（契约 v11）：renderer 的 `navigator.clipboard` 被「所有权限请求一律拒」
  // 的权限钩子挡死，此前这三枚右键动作点了毫无回执。回执用浮空 toast 而不是页内一行 Alert——
  // 后者在内容流里，会为一句「已复制」把整张队列表往下顶。
  const copy = (text: string): void => {
    void api.app
      .copyText(text)
      .then(() => toast.success("已复制"))
      .catch(() => toast.error("复制失败"));
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow>
          <TableCell>
            <div className="flex min-w-0 items-center gap-2">
              {/* 子行不重复平台图标，但要占住同一个图标位：标题的 x 才和主标题对齐（缩进会变成错位） */}
              {nested ? (
                <span className="size-[15px] shrink-0" aria-hidden="true" />
              ) : (
                <PlatformIcon platform={t.platform} />
              )}
              <TruncatedTooltip label={t.error ?? t.filename}>
                <span className="min-w-0 truncate">{t.filename}</span>
              </TruncatedTooltip>
              {/* 「这一行刚刚自己动过」收进 info 图标（契约 v12 的 note）：常驻一列说明会把
                  状态列撑破，而这条信息只在想知道「为什么它重试过」时才需要读 */}
              {t.note && <HintInfo text={t.note} />}
            </div>
          </TableCell>
          <TableCell className={COL.status}>
            <StatusPill
              label={STATUS[t.status][0]}
              variant={STATUS[t.status][1]}
              status={t.status}
              action={action}
            />
          </TableCell>
          <TableCell className={COL.progress}>
            {t.total > 0 ? (
              <ProgressBar pct={Math.min(100, (t.received / t.total) * 100)} />
            ) : t.status === "downloading" ? (
              <Progress value={0} className="h-1" />
            ) : (
              <Dash />
            )}
          </TableCell>
          <TableCell className={`${COL.size} whitespace-nowrap tabular-nums text-muted-foreground`}>
            {t.total > 0 ? fmtBytes(t.total) : t.received > 0 ? fmtBytes(t.received) : "—"}
          </TableCell>
          <TableCell className={`${COL.speed} whitespace-nowrap tabular-nums text-muted-foreground`}>
            {fmtSpeed(speedCell(t))}
          </TableCell>
          {/* 暂停行保留「暂停那一刻」的剩余时间：remaining 与 speed 都冻结在暂停时，重算即快照 */}
          <TableCell className={`${COL.eta} whitespace-nowrap tabular-nums text-muted-foreground`}>
            {t.status === "downloading" || t.status === "paused"
              ? fmtEta(t.total - t.received, t.speed)
              : "—"}
          </TableCell>
          <TableCell className={COL.created}>
            <TimeCell ts={t.createdAt} />
          </TableCell>
          <TableCell className={COL.finished}>
            {t.status === "done" && t.finishedAt ? <TimeCell ts={t.finishedAt} /> : <Dash />}
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {t.status === "done" && t.filePath && (
          <ContextMenuItem onSelect={() => void api.app.showInFolder(t.filePath!)}>
            <FolderOpen />
            打开所在文件夹
          </ContextMenuItem>
        )}
        {action && (
          <ContextMenuItem onSelect={action.run}>
            {action.icon}
            {action.label}
          </ContextMenuItem>
        )}
        {t.url && (
          <ContextMenuItem onSelect={() => copy(t.url)}>
            <Copy />
            复制下载链接
          </ContextMenuItem>
        )}
        {t.status === "done" && t.filePath && (
          <ContextMenuItem onSelect={() => copy(t.filePath!)}>
            <Copy />
            复制文件路径
          </ContextMenuItem>
        )}
        {t.error && (
          <ContextMenuItem onSelect={() => copy(t.error!)}>
            <Copy />
            复制失败原因
          </ContextMenuItem>
        )}
        {canCancel && (
          <ContextMenuItem variant="destructive" onSelect={() => void onAct(api.download.cancel, t.taskId)}>
            <X />
            取消下载
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => onNav("history", t.groupId)}>
          <Info />
          查看作品信息
        </ContextMenuItem>
        {!canCancel && (
          <ContextMenuItem variant="destructive" onSelect={() => void onAct(clearOne, t.taskId)}>
            <Trash2 />
            从队列移除
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** 已加载行才吃事件；未知行留给服务端筛选决定它该不该出现（返回原引用，不触发重渲） */
function mergeLive(list: DownloadTaskView[], t: DownloadTaskView): DownloadTaskView[] {
  const i = list.findIndex((x) => x.taskId === t.taskId);
  if (i < 0) return list;
  const next = [...list];
  next[i] = t;
  return next;
}

/** 续页按 taskId 去重：组不跨页切开，但实时覆盖与页数据在边界上仍可能撞同一颗 */
function mergePage(list: DownloadTaskView[], page: DownloadTaskView[]): DownloadTaskView[] {
  const seen = new Set(list.map((t) => t.taskId));
  return [...list, ...page.filter((t) => !seen.has(t.taskId))];
}

const STATUS: Record<DownloadTaskView["status"], [string, "secondary" | "ok" | "warn"]> = {
  queued: ["排队", "secondary"],
  downloading: ["下载中", "ok"],
  paused: ["已暂停", "warn"],
  done: ["完成", "ok"],
  error: ["失败", "warn"],
  canceled: ["已取消", "secondary"],
};

/**
 * 状态列只有一件东西：**徽标**，而徽标自己就是那颗动作按钮——图标放在标签里面，
 * 「下载中」这个词和暂停这件事是同一个可点区域，不再需要在下面另摆一颗图标去找。
 * 一个状态只对应一个动作：下载中→暂停、已暂停→继续、失败/已取消→重试（重试同样走 resume，
 * 主进程按 `.part` 续传）；排队没什么可暂停、完成没什么可重做，这两态的徽标就不是按钮。
 * `h-7` 是必需的：徽标要撑到 28px 才和同表其他行的 28px 控件一起把行高钉在 45，
 * 否则「完成」这种无动作态的行会比别的行矮一截。
 */
function StatusPill({
  label,
  variant,
  status,
  action,
}: {
  label: string;
  variant: "secondary" | "ok" | "warn";
  status?: string;
  action?: { label: string; icon: React.ReactNode; run: () => void };
}): React.ReactElement {
  const cls = cn(badgeVariants({ variant }), "h-7 rounded-sm px-2 text-sm tabular-nums");
  if (!action)
    return (
      <span className={cls} data-status={status}>
        {label}
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            cls,
            "cursor-pointer hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          )}
          aria-label={`${action.label}（${label}）`}
          data-status={status}
          onClick={action.run}
        >
          {label}
          {action.icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  );
}

/** 子行的徽标动作：见 StatusPill 的一态一动作口径 */
function rowAction(
  t: DownloadTaskView,
  onAct: OnAct
): { label: string; icon: React.ReactNode; run: () => void } | undefined {
  if (t.status === "downloading")
    return { label: "暂停", icon: <Pause />, run: () => void onAct(api.download.pause, t.taskId) };
  if (t.status === "paused")
    return { label: "继续", icon: <Play />, run: () => void onAct(api.download.resume, t.taskId) };
  if (t.status === "error" || t.status === "canceled")
    return { label: "重试", icon: <RotateCcw />, run: () => void onAct(api.download.resume, t.taskId) };
  return undefined;
}

/**
 * 主线程行的状态：下载中 > 进行中（只剩排队）> 有失败（带数量）> 已暂停 > 完成。
 * 「下载中」要和「进行中」分开，是因为子行本来就用这两个词，聚合行说「下载中」
 * 而组里其实一张都没在动（只有排队的）就成了假象。
 * 失败压过「已暂停」是因为组里只要有一颗红点，收起状态下也该被看见。
 */
function groupBadge(tasks: DownloadTaskView[]): [string, "secondary" | "ok" | "warn"] {
  const n = (s: DownloadTaskView["status"]): number => tasks.filter((t) => t.status === s).length;
  const running = n("downloading");
  const queued = n("queued");
  const err = n("error");
  const paused = n("paused");
  return running > 0
    ? ["下载中", "ok"]
    : queued > 0
      ? ["进行中", "secondary"]
      : err > 0
        ? [`失败 ${err}`, "warn"]
        : paused > 0
          ? ["已暂停", "warn"]
          : ["完成", "ok"];
}

/** 单行时间（今天/昨天/带年份 + 到秒）；溢出走截断，不换行 —— 队列每格都只有一行 */
function TimeCell({ ts }: { ts: number }): React.ReactElement {
  const text = fmtCreated(ts);
  return (
    <TruncatedTooltip label={text}>
      <span className="block truncate tabular-nums text-muted-foreground">{text}</span>
    </TruncatedTooltip>
  );
}

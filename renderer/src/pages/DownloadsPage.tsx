/**
 * 队列页：下载的资源视图（文件 / 状态 / 进度 / 大小 / 速度 / 剩余时间 / 创建时间 / 完成时间 / 操作）。
 * 分工（2026-10-14）：本页讲「哪些文件、下得多大、下到哪、什么时候下的」；「哪个作品」归历史页。
 * 队列只有**一张表**（一个卡片）：表头一份，所有链接的行顺序排在同个 TableBody 里（2026-10-15 业主指令）。
 * 一个链接多条资源（同 groupId）= 表里的「主线程行 + 子行」：主线程行不是另一种卡片，它就是这张九列表格
 * 的一行，只是**自己没有资源**——每格都从子行算出来：
 * 大小 sum、速度 均值、剩余 sum、创建时间 最早、完成时间 最晚（子行不全 done 则「—」）。
 * 默认收起（点标题右侧的箭头展开子行，箭头不放行首——那样主标题会被推离统一的 x）；单资源链接没有主线程行，那一行文件本身就是主线程。
 * 「状态」列 = 徽标 + 至多一颗动作图标（暂停/继续/重试），动作说的就是徽标那个词；「操作」列只留取消与位置。
 * 排版（业主指令 2026-10-15 统一，与历史页同口径）：表格只有一个字号档位（「设置→外观→界面字号」，默认 13px），
 * 列与列之间不分大小；层级只靠字重与色彩 —— 主信息（作品标题）`font-medium` + 前景、子行文件名常规 + 前景、
 * 元数据（大小/速度/剩余/时间/百分比）常规 + muted；数字列 tabular-nums；字体族全 UI 栈，不混等宽。
 * 右键菜单（业主指令 2026-10-15）：不显示文件名（行里就是它）；「查看作品信息」跳历史页定位该作品行。
 * 「完成时间」只在本进程存活期内有值：重启后已完成任务不再回队列（见 downloader.snapshot 过滤 done），
 * 要找历史时刻去历史页。
 * 筛选（UIUX-DESIGN §2.2）：状态分段 + 搜索 + 平台，全部是**渲染层过滤**（`download:list` 返回的就是全量，零契约变更）。
 * 筛选的单位是**作品（组）**：组里任一文件命中就出现在列表里，展开时只画命中的子行；组行的数值仍是整组的真实聚合
 * ——进度与 `完成/总数` 说的是这个作品，不是筛选结果。分段计数按「含 N 个此类文件的组」数，所以各段之和可以大于「全部」。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, DownloadCloud, FolderOpen, Info, Pause, Play, RotateCcw, X } from "lucide-react";
import { api } from "../lib/bridge";
import { cn } from "../lib/utils";
import { fmtBytes, fmtCreated, fmtEta } from "../lib/format";
import type { AppMeta, DownloadTaskView } from "../../../types/ipc";
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
import { Tooltip, TooltipContent, TooltipTrigger, TruncatedTooltip } from "../components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";

interface TaskGroup {
  groupId: string;
  /** 整组：组行的每一格都从这里算 */
  tasks: DownloadTaskView[];
  /** 命中筛选的子行 */
  visible: DownloadTaskView[];
}

/** Radix Select 不接受空串作为 value，「全部平台」用一个不会与平台 key 撞车的哨兵 */
const ALL = "__all__";

type StatusFilter = "all" | "active" | "done" | "error" | "canceled";

/** 分段是「文件状态」的桶（`paused` 归进行中——它就是暂停在那里的一组文件）；已取消与失败分开，重试动作不同 */
const STATUS_FILTERS: Array<{ key: StatusFilter; label: string; match: (s: DownloadTaskView["status"]) => boolean }> = [
  { key: "all", label: "全部", match: () => true },
  { key: "active", label: "进行中", match: (s) => s === "queued" || s === "downloading" || s === "paused" },
  { key: "done", label: "完成", match: (s) => s === "done" },
  { key: "error", label: "失败", match: (s) => s === "error" },
  { key: "canceled", label: "已取消", match: (s) => s === "canceled" },
];

/**
 * table-fixed 下「文件」列不设宽 = 吃掉整行剩余宽度并在此截断；其余列必须显式定宽，
 * 否则会被均分（主线程行与子行同表，宽度由表头那一行决定，所以 th 与 td 共用这一组常量）。
 * 2026-10-15 业主指令：**队列每格单行**（日期与时刻同行、进度条与百分比同行、剩余固定 HH:mm:ss）。
 * 列宽一律写成 `1.5rem + Nem`：1.5rem 是 td 的左右内边距（px-3，与字号无关），
 * N em 是最坏内容宽——写成 em 才会跟着「设置→外观→界面字号」那一档缩放，换档不重排也不截字。
 * 最坏内容实测（13px 档）：状态徽标「失败 12」+ 重试图标 74（汉字 3.2em + 图标 12 + 间距 4 + 徽标内边距 16，
 * 动作图标就在徽标里面：下载中→暂停、已暂停→继续、失败/已取消→重试，排队与完成没有可给的动作就不是按钮）；
 * 大小「999.9 MB」54；速度「999.9 MB/s」65；剩余「99:59:59」48；时间「2025-12-31 23:59:59」114；
 * 操作一颗 40px 文本按钮（取消 与 位置 互斥，同一行不会同现）；进度列 96 = 内边距 24 + 条 34 + 间距 6 + 百分比。
 * 百分比 `w-[2.4em]`（「100%」30、「0%」16 —— 不固定位数会让每行的条长短不一），条吃掉剩下的并且每行等长。
 * MIN_W = 86em（13px 档 = 1118）：定宽约 794 + 文件列底线 320。文件列要装下主线程行的
 * 「15 平台图标 + 标题 + 28 箭头 + 18 完成数」，实测这些固定件占 113，
 * 底线给到 320 标题才有 211px ≈ 14 个汉字可读（再窄一档只剩 7 个字，等于没标题）。
 * 单行九列放不进默认 1080 窗口（内容宽 794），由表格容器 overflow-x-auto 横向滚；
 * 要整屏不滚只能砍列或砍字号，那由业主定。
 */
const COL = {
  status: "w-[calc(3.5rem+3.6em)]",
  progress: "w-24",
  size: "w-[calc(1.5rem+4.4em)]",
  speed: "w-[calc(1.5rem+5.2em)]",
  eta: "w-[calc(1.5rem+3.9em)]",
  created: "w-[calc(1.5rem+9em)]",
  finished: "w-[calc(1.5rem+9em)]",
  actions: "w-[calc(1.5rem+3.2em)]",
} as const;

const TABLE_MIN_W = "min-w-[86em]";

export default function DownloadsPage({
  meta,
  onNav,
}: {
  meta: AppMeta | null;
  onNav: OnNav;
}): React.ReactElement {
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  // 主线程默认收起：记住的是「谁被展开了」，而不是「谁被折叠了」——后者要给每个新组预填 id
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.download.list().then(setTasks).catch(() => {});
    const offs = [
      api.download.onProgress((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onDone((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onError((t) => setTasks((prev) => upsert(prev, t))),
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

  const nameOf = useCallback(
    (key?: string): string => (key && meta?.platforms.find((p) => p.key === key)?.name) || key || "",
    [meta]
  );

  // 选项池来自**未过滤**的队列：跟着结果走会让选过一个平台后切不回别的（历史页 §2.3 的那个 bug）
  const platforms = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.platform).filter((p): p is string => Boolean(p)))),
    [tasks]
  );

  const { rows, counts } = useMemo(() => {
    const byId = new Map<string, TaskGroup>();
    for (const t of tasks) {
      let g = byId.get(t.groupId);
      if (!g) {
        g = { groupId: t.groupId, tasks: [], visible: [] };
        byId.set(t.groupId, g);
      }
      g.tasks.push(t);
    }
    const q = query.trim().toLowerCase();
    const matchStatus = STATUS_FILTERS.find((f) => f.key === statusFilter)!.match;
    const inScope = (t: DownloadTaskView): boolean =>
      (platform === "" || t.platform === platform) &&
      (q === "" ||
        `${t.filename} ${t.title ?? ""} ${t.platform ?? ""} ${nameOf(t.platform)} ${t.url} ${t.sourceUrl ?? ""}`
          .toLowerCase()
          .includes(q));
    const nextCounts = Object.fromEntries(STATUS_FILTERS.map((f) => [f.key, 0])) as Record<StatusFilter, number>;
    const nextRows: TaskGroup[] = [];
    for (const g of byId.values()) {
      const hits = g.tasks.filter(inScope);
      for (const f of STATUS_FILTERS) if (hits.some((t) => f.match(t.status))) nextCounts[f.key] += 1;
      const visible = hits.filter((t) => matchStatus(t.status));
      if (visible.length > 0) nextRows.push({ ...g, visible });
    }
    return { rows: nextRows, counts: nextCounts };
  }, [tasks, statusFilter, query, platform, nameOf]);

  function clearFilters(): void {
    setStatusFilter("all");
    setQuery("");
    setPlatform("");
  }

  async function act(fn: (id: string) => Promise<unknown>, id: string): Promise<void> {
    try {
      await fn(id);
      setTasks(await api.download.list());
    } catch {
      /* 状态竞争（已完成再取消等）忽略 */
    }
  }

  function toggleGroup(groupId: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  if (tasks.length === 0) {
    return (
      <section className="flex flex-col items-center gap-3 py-16 text-center">
        <DownloadCloud className="size-11 text-faint" strokeWidth={1.5} aria-hidden="true" />
        <div className="font-medium">暂无下载任务</div>
        <p className="text-sm text-muted-foreground">解析成功后点「下载」即入队；批量图集会整组显示进度。</p>
        <p className="text-sm text-muted-foreground">断点续传：重启后未完成任务自动恢复；.part 存在则 Range 续传。</p>
      </section>
    );
  }

  return (
    <section>
      <Card className="py-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={statusFilter === f.key ? "default" : "outline"}
              aria-pressed={statusFilter === f.key}
              disabled={counts[f.key] === 0 && statusFilter !== f.key}
              className="h-7 rounded-full px-3"
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
              <span className="tabular-nums opacity-70">{counts[f.key]}</span>
            </Button>
          ))}
          <div className="ms-auto flex items-center gap-2">
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件名 / 标题"
              aria-label="搜索下载项"
              className="h-8 w-52"
            />
            <Select value={platform === "" ? ALL : platform} onValueChange={(v) => setPlatform(v === ALL ? "" : v)}>
              <SelectTrigger size="sm" className="w-36" aria-label="按平台筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部平台</SelectItem>
                {platforms.map((p) => (
                  <SelectItem key={p} value={p}>
                    {nameOf(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CardContent className="py-1">
          {rows.length === 0 ? (
            <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
              <span>没有符合条件的下载项</span>
              <Button size="sm" variant="outline" onClick={clearFilters}>
                清除筛选
              </Button>
            </div>
          ) : (
            <QueueTable
              groups={rows}
              expanded={expanded}
              onToggle={toggleGroup}
              onAct={act}
              onNav={onNav}
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

type OnAct = (fn: (id: string) => Promise<unknown>, id: string) => Promise<void>;

/** 跨页跳转：带 groupId 去历史页定位那一行作品 */
type OnNav = (page: "history", groupId: string) => void;

/**
 * 主线程行的数据来源：它自己没有资源，每一格都是从子行算出来的。
 * 大小 sum、剩余 sum（= sum(未下完字节) / 均速）、创建时间取最早、完成时间取最晚（子行不全 done 则不报）。
 * 均速只平均「在动的那些文件」——排队与完成的 speed 是 0，参与平均会把 30 图组里 3 张在动的速度压成 1/10。
 */
function aggregate(tasks: DownloadTaskView[]): {
  total: number;
  pct: number;
  meanSpeed: number;
  remaining: number;
  anyActive: boolean;
  anyPaused: boolean;
  running: number;
  failed: number;
  created: number;
  finished: number;
  done: number;
} {
  const sum = (f: (t: DownloadTaskView) => number): number => tasks.reduce((s, t) => s + f(t), 0);
  const total = sum((t) => Math.max(t.total, 0));
  const recv = sum((t) => t.received);
  const allDone = tasks.every((t) => t.status === "done");
  return {
    total,
    pct: total > 0 ? Math.min(100, (recv / total) * 100) : 0,
    meanSpeed: (() => {
      const moving = tasks.filter((t) => t.speed > 0);
      return moving.length > 0 ? sum((t) => t.speed) / moving.length : 0;
    })(),
    remaining: sum((t) => Math.max(t.total - t.received, 0)),
    anyActive: tasks.some((t) => t.status === "downloading" || t.status === "queued"),
    anyPaused: tasks.some((t) => t.status === "paused"),
    running: tasks.filter((t) => t.status === "downloading").length,
    failed: tasks.filter((t) => t.status === "error").length,
    created: Math.min(...tasks.map((t) => t.createdAt)),
    finished: allDone ? Math.max(...tasks.map((t) => t.finishedAt ?? 0)) : 0,
    done: tasks.filter((t) => t.status === "done").length,
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
  groups: TaskGroup[];
  expanded: Set<string>;
  onToggle: (groupId: string) => void;
  onAct: OnAct;
  onNav: OnNav;
}): React.ReactElement {
  return (
    <Table className={TABLE_MIN_W}>
      <TableHeader>
        <TableRow>
          <TableHead>文件</TableHead>
          <TableHead className={COL.status}>状态</TableHead>
          <TableHead className={COL.progress}>进度</TableHead>
          <TableHead className={COL.size}>大小</TableHead>
          <TableHead className={COL.speed}>速度</TableHead>
          <TableHead className={COL.eta}>剩余</TableHead>
          <TableHead className={COL.created}>创建时间</TableHead>
          <TableHead className={COL.finished}>完成时间</TableHead>
          <TableHead className={COL.actions} aria-label="操作" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => {
          // 单资源链接没有主线程行：那一行文件本身就是主线程
          const multi = g.tasks.length > 1;
          return (
            <Fragment key={g.groupId}>
              {multi && (
                <GroupRow group={g} open={expanded.has(g.groupId)} onToggle={onToggle} onAct={onAct} />
              )}
              {(!multi || expanded.has(g.groupId)) &&
                g.visible.map((t) => (
                  <TaskRow key={t.taskId} t={t} nested={multi} onAct={onAct} onNav={onNav} />
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

function GroupRow({
  group,
  open,
  onToggle,
  onAct,
}: {
  group: TaskGroup;
  open: boolean;
  onToggle: (groupId: string) => void;
  onAct: OnAct;
}): React.ReactElement {
  const a = aggregate(group.tasks);
  const title = group.tasks.find((t) => t.title)?.title ?? group.tasks[0].filename;
  const platform = group.tasks.find((t) => t.platform)?.platform;
  const batch = (pred: (t: DownloadTaskView) => boolean, fn: (id: string) => Promise<unknown>) =>
    void (async () => {
      for (const t of group.tasks) if (pred(t)) await onAct(fn, t.taskId);
    })();
  // 聚合行同样只有一颗动作，按优先级取：在动→全部暂停；暂停→继续全部；有失败→重试失败项
  const action =
    a.running > 0
      ? {
          label: "全部暂停",
          icon: <Pause />,
          run: () => batch((t) => t.status === "downloading" || t.status === "queued", api.download.pause)
        }
      : a.anyPaused
        ? { label: "继续全部", icon: <Play />, run: () => batch((t) => t.status === "paused", api.download.resume) }
        : a.failed > 0
          ? { label: "重试失败项", icon: <RotateCcw />, run: () => batch((t) => t.status === "error", api.download.resume) }
          : undefined;
  const [label, variant] = groupBadge(group.tasks);
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
                aria-label={`${open ? "收起" : "展开"} ${title} 的 ${group.visible.length} 个文件`}
                onClick={() => onToggle(group.groupId)}
              >
                {open ? <ChevronDown /> : <ChevronRight />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{open ? "收起" : "展开"}</TooltipContent>
          </Tooltip>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {a.done}/{group.tasks.length}
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
        {a.meanSpeed > 0 ? `${fmtBytes(a.meanSpeed)}/s` : "—"}
      </TableCell>
      <TableCell className={`${COL.eta} whitespace-nowrap tabular-nums text-muted-foreground`}>
        {a.anyActive ? fmtEta(a.remaining, a.meanSpeed) : "—"}
      </TableCell>
      <TableCell className={COL.created}>
        <TimeCell ts={a.created} />
      </TableCell>
      <TableCell className={COL.finished}>
        {a.finished > 0 ? <TimeCell ts={a.finished} /> : <Dash />}
      </TableCell>
      <TableCell className={COL.actions} />
    </TableRow>
  );
}

function Dash(): React.ReactElement {
  return <span className="text-muted-foreground">—</span>;
}

function TaskRow({
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
  const canCancel = t.status === "queued" || t.status === "downloading" || t.status === "paused";
  const copy = (text: string) => void navigator.clipboard.writeText(text);
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
            {t.speed > 0 ? `${fmtBytes(t.speed)}/s` : "—"}
          </TableCell>
          <TableCell className={`${COL.eta} whitespace-nowrap tabular-nums text-muted-foreground`}>
            {t.status === "downloading" ? fmtEta(t.total - t.received, t.speed) : "—"}
          </TableCell>
          <TableCell className={COL.created}>
            <TimeCell ts={t.createdAt} />
          </TableCell>
          <TableCell className={COL.finished}>
            {t.status === "done" && t.finishedAt ? <TimeCell ts={t.finishedAt} /> : <Dash />}
          </TableCell>
          <TableCell className={COL.actions}>
            <div className="flex items-center justify-end gap-1">
              {canCancel && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-sm" onClick={() => void onAct(api.download.cancel, t.taskId)}>
                  取消
                </Button>
              )}
              {t.status === "done" && t.filePath && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-sm"
                  onClick={() => void api.app.showInFolder(t.filePath!)}
                >
                  位置
                </Button>
              )}
            </div>
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
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
        <ContextMenuItem onSelect={() => onNav("history", t.groupId)}>
          <Info />
          查看作品信息
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copy(t.url)}>
          <Copy />
          复制下载链接
        </ContextMenuItem>
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
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => void onAct(api.download.cancel, t.taskId)}>
              <X />
              取消下载
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function upsert(list: DownloadTaskView[], t: DownloadTaskView): DownloadTaskView[] {
  const i = list.findIndex((x) => x.taskId === t.taskId);
  if (i < 0) return [t, ...list];
  const next = [...list];
  next[i] = t;
  return next;
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

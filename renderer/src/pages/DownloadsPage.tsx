/**
 * 队列页：下载的资源视图（文件 / 状态 / 进度 / 大小 / 速度 / 剩余时间 / 创建时间 / 完成时间 / 操作）。
 * 分工（2026-10-14）：本页讲「哪些文件、下得多大、下到哪、什么时候下的」；「哪个作品」归历史页。
 * 队列只有**一张表**（一个卡片）：表头一份，所有链接的行顺序排在同个 TableBody 里（2026-10-15 业主指令）。
 * 一个链接多条资源（同 groupId）= 表里的「主线程行 + 子行」：主线程行不是另一种卡片，它就是这张九列表格
 * 的一行，只是**自己没有资源**——每格都从子行算出来：
 * 大小 sum、速度 均值、剩余 sum、创建时间 最早、完成时间 最晚（子行不全 done 则「—」）。
 * 默认收起（点标题右侧的箭头展开子行，箭头不放行首——那样主标题会被推离统一的 x）；单资源链接没有主线程行，那一行文件本身就是主线程。
 * 「状态」列 = 徽标 + 至多一颗动作图标（暂停/继续/重试），动作说的就是徽标那个词；「操作」列只留取消与位置。
 * 「完成时间」只在本进程存活期内有值：重启后已完成任务不再回队列（见 downloader.snapshot 过滤 done），
 * 要找历史时刻去历史页。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, DownloadCloud, Pause, Play, RotateCcw } from "lucide-react";
import { api } from "../lib/bridge";
import { cn } from "../lib/utils";
import { fmtBytes, fmtCreated, fmtEta } from "../lib/format";
import type { DownloadTaskView } from "../../../types/ipc";
import { PlatformIcon } from "../components/PlatformIcon";
import { Button } from "../components/ui/button";
import { badgeVariants } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

interface TaskGroup {
  groupId: string;
  tasks: DownloadTaskView[];
}

/**
 * table-fixed 下「文件」列不设宽 = 吃掉整行剩余宽度并在此截断；其余列必须显式定宽，
 * 否则会被均分（主线程行与子行同表，宽度由表头那一行决定，所以 th 与 td 共用这一组常量）。
 * 2026-10-15 业主指令：**队列每格单行**（日期与时刻同行、进度条与百分比同行、剩余固定 HH:mm:ss）。
 * 每列宽 = 最坏内容 + 单元格左右内边距 24（td 是 px-3），逐个实测：
 * 状态 徽标**自己内含那颗动作图标**（业主指令「放到失败或者进行中的那个标签里面」），一态一动作：
 * 下载中→暂停、已暂停→继续、失败/已取消→重试，排队和完成没有可给的动作就不是按钮。
 * 最坏内容是「失败 12」+重试 = 74（汉字 26/39、图标 12、间距 4、徽标左右内边距 16）→ 列宽 104（可用 80）；
 * 进度 条+「100%」→96（业主指令「进度条那一列太宽了」，从 128 收到 96）：
 * 百分比定宽 `w-8`（32，实测「100%」29、「0%」16 —— 不固定位数会让每行的条长短不一），间距 6、内边距 24，
 * 剩下 **34 全给条且每行等长**；再窄条就没粗细可言了。大小「999.9 MB」47→72；
 * 速度「999.9 MB/s」55→80；剩余「99:59:59」47→72；时间「2025-12-31 23:59:59」109→136；
 * 操作 只剩一颗 40px 文本按钮（取消 与 位置 互斥，同一行不会同现）= 40→64。
 * MIN_W = 定宽 760 + 文件列底线 320 = 1080：文件列要装下主线程行的
 * 「15 平台图标 + 标题 + 28 箭头 + 18 完成数」，实测这些固定件占 113，
 * 底线给到 320 标题才有 211px ≈ 14 个汉字可读（136 那一档只剩 7 个字，等于没标题）。
 * 单行九列放不进默认 1080 窗口（内容宽 794），由表格容器 overflow-x-auto 横向滚；
 * 要整屏不滚只能砍列或砍字号，那由业主定。
 */
const COL = {
  status: "w-[6.5rem]",
  progress: "w-24",
  size: "w-[4.5rem]",
  speed: "w-20",
  eta: "w-[4.5rem]",
  created: "w-[8.5rem]",
  finished: "w-[8.5rem]",
  actions: "w-16",
} as const;

const TABLE_MIN_W = "min-w-[67.5rem]";

export default function DownloadsPage(): React.ReactElement {
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  // 主线程默认收起：记住的是「谁被展开了」，而不是「谁被折叠了」——后者要给每个新组预填 id
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void api.download.list().then(setTasks).catch(() => {});
    const offs = [
      api.download.onProgress((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onDone((t) => setTasks((prev) => upsert(prev, t))),
      api.download.onError((t) => setTasks((prev) => upsert(prev, t))),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const groups = useMemo<TaskGroup[]>(() => {
    const byId = new Map<string, TaskGroup>();
    for (const t of tasks) {
      let g = byId.get(t.groupId);
      if (!g) {
        g = { groupId: t.groupId, tasks: [] };
        byId.set(t.groupId, g);
      }
      g.tasks.push(t);
    }
    return [...byId.values()];
  }, [tasks]);

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
        <div className="font-medium text-sm">暂无下载任务</div>
        <p className="text-xs text-muted-foreground">解析成功后点「下载」即入队；批量图集会整组显示进度。</p>
        <p className="text-xs text-muted-foreground">断点续传：重启后未完成任务自动恢复；.part 存在则 Range 续传。</p>
      </section>
    );
  }

  return (
    <section>
      <Card className="py-0">
        <CardContent className="py-1">
          <QueueTable
            groups={groups}
            expanded={expanded}
            onToggle={toggleGroup}
            onAct={act}
          />
        </CardContent>
      </Card>
    </section>
  );
}

type OnAct = (fn: (id: string) => Promise<unknown>, id: string) => Promise<void>;

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
}: {
  groups: TaskGroup[];
  expanded: Set<string>;
  onToggle: (groupId: string) => void;
  onAct: OnAct;
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
                g.tasks.map((t) => <TaskRow key={t.taskId} t={t} nested={multi} onAct={onAct} />)}
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
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
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
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
            {title}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            aria-expanded={open}
            aria-label={`${open ? "收起" : "展开"} ${title} 的 ${group.tasks.length} 个文件`}
            onClick={() => onToggle(group.groupId)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </Button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
      <TableCell className={`${COL.size} whitespace-nowrap text-xs tabular-nums text-muted-foreground`}>
        {a.total > 0 ? fmtBytes(a.total) : "—"}
      </TableCell>
      <TableCell className={`${COL.speed} whitespace-nowrap text-xs tabular-nums`}>
        {a.meanSpeed > 0 ? `${fmtBytes(a.meanSpeed)}/s` : "—"}
      </TableCell>
      <TableCell className={`${COL.eta} whitespace-nowrap text-xs tabular-nums`}>
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
  return <span className="text-xs text-muted-foreground">—</span>;
}

function TaskRow({
  t,
  nested,
  onAct,
}: {
  t: DownloadTaskView;
  nested: boolean;
  onAct: OnAct;
}): React.ReactElement {
  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-0 items-center gap-2">
          {/* 子行不重复平台图标，但要占住同一个图标位：标题的 x 才和主标题对齐（缩进会变成错位） */}
          {nested ? (
            <span className="size-[15px] shrink-0" aria-hidden="true" />
          ) : (
            <PlatformIcon platform={t.platform} />
          )}
          <span className="min-w-0 truncate" title={t.error ?? t.filename}>
            {t.filename}
          </span>
        </div>
      </TableCell>
      <TableCell className={COL.status}>
        <StatusPill
          label={STATUS[t.status][0]}
          variant={STATUS[t.status][1]}
          status={t.status}
          action={rowAction(t, onAct)}
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
      <TableCell className={`${COL.size} whitespace-nowrap text-xs tabular-nums text-muted-foreground`}>
        {t.total > 0 ? fmtBytes(t.total) : t.received > 0 ? fmtBytes(t.received) : "—"}
      </TableCell>
      <TableCell className={`${COL.speed} whitespace-nowrap text-xs tabular-nums`}>
        {t.speed > 0 ? `${fmtBytes(t.speed)}/s` : "—"}
      </TableCell>
      <TableCell className={`${COL.eta} whitespace-nowrap text-xs tabular-nums`}>
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
          {(t.status === "queued" || t.status === "downloading" || t.status === "paused") && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void onAct(api.download.cancel, t.taskId)}>
              取消
            </Button>
          )}
          {t.status === "done" && t.filePath && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => void api.app.showInFolder(t.filePath!)}
                >
                  位置
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t.filePath}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </TableCell>
    </TableRow>
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
  const cls = cn(badgeVariants({ variant }), "h-7 rounded-sm px-2 tabular-nums");
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
    <span className="block truncate text-xs tabular-nums text-muted-foreground" title={text}>
      {text}
    </span>
  );
}

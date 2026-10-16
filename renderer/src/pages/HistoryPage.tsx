/**
 * 历史页：解析出的作品清单（作品 / 作者 / 类型 / 文件数 / 创建时间 / 操作）。
 * 分工（2026-10-14）：本页只讲「哪个作品」——平台、标题、作者、类型、文件数、来源链接；
 * 「哪些文件、下得多大、下到哪」是队列页的资源视图，这里不重复。
 * 因此操作列也不碰资源：唯一的动作是把这一行的信息复制成文本（含分享链接），
 * 「打开位置」已撤 —— 要找文件去队列页。
 * 作者列显示的是下载那一刻的快照（点昵称开卡片）；客户端不拉实时主页，
 * 所以粉丝量停在下载当天，这是设计而非缺陷。
 * 同一 groupId 的图集条目聚合成一行；旧记录缺 kind/sourceUrl/author（本版本前写入）显示「—」优雅降级；不存媒体直链（§3 隐私）。
 * 行 = 作品的入口（业主指令 2026-10-15）：点行从底部弹出该作品的详细信息浮层；
 * 队列页右键「查看作品信息」跳到本页并定位高亮对应行。
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
import { Clock3, Copy, ExternalLink, FolderOpen } from "lucide-react";
import { api } from "../lib/bridge";
import type { AuthorSnapshot, HistoryEntry } from "../../../types/ipc";
import { displayName } from "../../../shared/platforms";
import { PlatformIcon } from "../components/PlatformIcon";
import { cn } from "../lib/utils";
import { buildWorkInfoText } from "../lib/work-info";
import { fmtBytes, fmtCount, fmtCreated, kindLabel } from "../lib/format";
import { HISTORY_WINDOW } from "../lib/local-limits";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Alert, AlertDescription } from "../components/ui/alert";
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
import { Tooltip, TooltipContent, TooltipTrigger, TruncatedTooltip } from "../components/ui/tooltip";

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
  actions: "w-16",
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
  const [toast, setToast] = useState<string>("");
  const [clearOpen, setClearOpen] = useState(false);
  const [authorRow, setAuthorRow] = useState<Row | null>(null);
  // 作者卡片可见态与数据态分开：关闭只翻 visible，行留着 —— Radix 收起动画（200ms）期间这层还在 DOM，
  // 若把行一起置 null，卡片会先被抽空再淡出，看不见「向下收起」那一段（业主指令 2026-10-15 增强）
  const [authorShown, setAuthorShown] = useState(false);
  const openAuthor = (r: Row) => {
    setAuthorRow(r);
    setAuthorShown(true);
  };
  const [detailRow, setDetailRow] = useState<Row | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);

  useEffect(() => {
    void api.history.list({ limit: HISTORY_LIMIT }).then(setList).catch(() => {});
  }, []);

  // 统计页点榜 → 本页筛到那个平台。平台选项池来自全量数据，所以榜上的键一定在这页可选
  useEffect(() => {
    if (platformFocus) setPlatform(platformFocus.key);
  }, [platformFocus]);

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

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  const { rows, platforms } = useMemo(() => {
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
      // 选项池来自**未过滤**的聚合结果：跟着 rows 走会让选过一个平台后切不回别的
      platforms: Array.from(new Set(all.map((r) => r.platform).filter((p): p is string => Boolean(p)))),
    };
  }, [list, platform, timeRange, query]);

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
      .then(() => setToast("已复制作品信息"))
      .catch(() => setToast("复制失败"));
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
      {toast && (
        <Alert>
          <AlertDescription>{toast}</AlertDescription>
        </Alert>
      )}

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
          /* 底线 = 定宽列 + 作品列可读下限（约 17em）；窗口更窄时横向滚，而不是把作品列压成 0 宽 */
          <Table className="min-w-[46em]">
            <TableHeader>
              <TableRow>
                <TableHead>作品</TableHead>
                <TableHead className={COL.author}>作者</TableHead>
                <TableHead className={COL.kind}>类型</TableHead>
                <TableHead className={COL.count}>文件数</TableHead>
                <TableHead className={COL.time}>创建时间</TableHead>
                <TableHead className={`${COL.actions} text-end`} aria-label="操作" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.key}
                  data-group={r.key}
                  onClick={() => setDetailRow(r)}
                  className={cn(
                    "cursor-pointer",
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
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <IconAction label="复制作品信息" onClick={() => copyInfo(r)}>
                        <Copy />
                      </IconAction>
                    </div>
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
      <Sheet modal={false} open={detailRow !== null} onOpenChange={(o) => { if (!o) setDetailRow(null); }}>
        <SheetContent
          aria-describedby={undefined}
          className="inset-x-4 overflow-hidden"
          onInteractOutside={(event) => {
            // 作者卡片是叠在作品信息之上的另一层 Dialog：它内部的每次点击对 Sheet 而言都是「外部交互」，
            // 默认会把作品信息一起关掉（业主指令 2026-10-15 修复2）。一层点击只关一层：卡片开着时 Sheet 不接受外部关闭
            if (authorShown) event.preventDefault();
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
              <SheetHeader>
                <SheetTitle className="text-sm">作品信息</SheetTitle>
              </SheetHeader>
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

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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

/**
 * 结果卡：三层结构（信息层 / 选择层 / 下载清单层），样式走 shadcn + Tailwind utility。
 *
 * 契约依据 docs/ARCHITECTURE.md §3，字段消费见 docs/UIUX-DESIGN.md §2.1。
 * 「点下载 = IPC 入队主进程流式落盘」，直链本身不呈现给用户点选
 * （README「直链时效」决策）。
 *
 * 三层各自的职责边界：
 *  - 信息层：封面/标题/平台/作者/统计/音乐 —— 只读，帮用户确认「解析到的是不是这个东西」；
 *  - 选择层：清晰度 —— 改它只改下载计划，不被队列状态锁死；
 *  - 下载清单层：将要落盘的每一项（带勾选与回落标注），主按钮文案由它生成。
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { api } from "../lib/bridge";
import {
  buildPlan,
  buildQualityPlan,
  deriveShape,
  DEFAULT_FILENAME_EXTRA,
  type FilenameExtra,
  type FilenamePreset,
  type QualityStrategy,
} from "../lib/download-plan";
import { fmtClock, fmtCount, fmtDuration } from "../lib/format";
import { buildAuthorSnapshot } from "../../../shared/author";
import { pickWorkStat, workStatItems } from "../../../shared/work-stat";
import type { ParseData, ParseRunOutcome } from "../../../types/ipc";
import { displayName } from "../../../shared/platforms";
import { PlatformIcon } from "./PlatformIcon";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Alert, AlertDescription } from "./ui/alert";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger, TruncatedTooltip } from "./ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * 直链计龄的标注阈值（不是过期判据）。业主质疑「你确定有效期只有 5 分钟吗」之后实测过：
 * 抖音播放链整串查询里没有任何时间签名，封面图的签名约 14 天，内核 README 那句「分钟级」
 * 只是各家 CDN 的经验下限。既然这个数在真实结果里无法验证，就不许再拿它改按钮语义
 * （旧版会把主按钮换成「重新解析并下载」，用户以为不重新解析就下不动）；现在它只决定
 * 什么时候在时间旁边补一句实话。真过期的处理在失败之后：见 `electron/main/link-renew.ts`。
 */
const LINK_TTL_MS = 5 * 60 * 1000;

/** 超过这个条数就默认折叠，避免图集/多 P 把整屏占掉 */
const PLAN_COLLAPSE_AT = 3;

export function ResultCard({
  outcome,
  sourceUrl,
  parsedAt,
  onQueued,
  onRetry,
  onNavigate,
}: {
  outcome: ParseRunOutcome;
  /** 用户输入的分享链接（写历史用，非直链） */
  sourceUrl?: string;
  /** 这条结果到手的时刻（epoch ms）：切页重挂载后直链计龄接着算，见下面的 resultAge */
  parsedAt?: number;
  onQueued: (count: number) => void;
  /** 失败态 [重试]：由页面重新发起解析（直链过期不再走这里，改由主进程下载侧续链） */
  onRetry?: () => void;
  /**
   * 失败态「去配置 Cookie」：打开设置并直达分类 id（引擎页 = "engine"）。
   * 缺省时该按钮不渲染 —— 不给点了没反应的假按钮。
   */
  onNavigate?: (category: string) => void;
}): React.ReactElement {
  const { result, via, fallbackReason, durationMs } = outcome;
  const data = result.data;
  const [queued, setQueued] = useState(false);
  const [err, setErr] = useState("");
  /** null = 还没手选，用内核主直链对应档位（SSR 与首帧都走这条，不等 effect 纠正） */
  const [qualityIdx, setQualityIdx] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [planOpen, setPlanOpen] = useState(false);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);

  // 清晰度预选策略（设置→下载）：随每次解析重读，组件复用不重挂载也能拿到最新值
  const [qualityStrategy, setQualityStrategy] = useState<QualityStrategy>("main");
  // 命名规则同源重读；缺省为「仅标题 + 多文件序号」，与 buildPlan 的 rule 缺省一致
  const [naming, setNaming] = useState<{ preset: FilenamePreset; extra: FilenameExtra }>({
    preset: "title",
    extra: DEFAULT_FILENAME_EXTRA,
  });
  useEffect(() => {
    void api.settings
      .get()
      .then((s) => {
        setQualityStrategy(s.defaultQuality);
        setNaming({ preset: s.filenamePreset, extra: s.filenameExtra });
      })
      .catch(() => {});
  }, [outcome]);

  // 解析成功后 15s 心跳计龄：过阈值只改「下面那行时间怎么说」，不改按钮（见 LINK_TTL_MS 的注释）
  const [resultAge, setResultAge] = useState(0);
  useEffect(() => {
    if (result.code !== 200) return;
    // 起算点是解析到手那一刻（首页带进来的 parsedAt），不是本卡挂载那一刻：
    // 切页会让结果卡重挂载，按挂载时间算就等于每次回到首页都把一条早过期的链显示成「刚拿到」。
    const startedAt = parsedAt ?? Date.now();
    const age = (): void => setResultAge(Math.max(0, Date.now() - startedAt));
    age();
    const timer = setInterval(age, 15_000);
    return () => clearInterval(timer);
  }, [outcome, result.code, parsedAt]);
  const linkAged = resultAge >= LINK_TTL_MS;

  // 新一轮解析 = 全新卡片状态：队列锁、勾选、清晰度、计龄都不该带过来。
  // 依赖只写 outcome：清晰度切换会重算 plan，那时不能把用户的勾选与队列提示清掉。
  useEffect(() => {
    setQueued(false);
    setErr("");
    setQualityIdx(null);
    setExcluded(new Set());
    // 与上面计龄同一个起算点：本 effect 声明在后，写回 0 会把刚算出来的真实年龄抹掉
    setResultAge(parsedAt ? Math.max(0, Date.now() - parsedAt) : 0);
    // 短清单（≤3 项）摊开，长清单（图集/多 P）折叠 —— 结果卡不许吃掉整屏
    const fresh = buildQualityPlan(data, qualityStrategy);
    setPlanOpen(buildPlan(data, fresh.options[fresh.primaryIndex]).length <= PLAN_COLLAPSE_AT);
    // 只随解析结果重置；策略读新值迟到由下方 memo 纠正
  }, [outcome, data, parsedAt]);

  const qualityPlan = useMemo(() => buildQualityPlan(data, qualityStrategy), [data, qualityStrategy]);
  const qualityOptions = qualityPlan.options;
  const activeIdx = Math.min(qualityIdx ?? qualityPlan.primaryIndex, Math.max(0, qualityOptions.length - 1));
  const plan = useMemo(
    () => buildPlan(data, qualityOptions[activeIdx], naming),
    [data, qualityOptions, activeIdx, naming]
  );
  const selected = useMemo(() => plan.filter((p) => !excluded.has(p.id)), [plan, excluded]);

  const platformName = displayName(result.platform ?? "");

  async function enqueue(): Promise<void> {
    setErr("");
    if (selected.length === 0) {
      onQueued(0);
      return;
    }
    try {
      await api.download.enqueue({
        items: selected.map((p) => ({
          url: p.url,
          filename: p.filename,
          kind: p.kind,
        })),
        meta: {
          platform: result.platform,
          title: data?.title ?? data?.desc,
          sourceUrl,
          author: buildAuthorSnapshot(data),
        },
      });
      setQueued(true);
      onQueued(selected.length);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }

  // Ctrl+D = 下载全部（结果卡可见时，§3.4 L1）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "d") {
        if (selected.length > 0) {
          e.preventDefault();
          void enqueue();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, plan, result.code]);

  if (result.code !== 200) {
    return (
      <ParseFailure
        msg={result.msg}
        failType={result.failType}
        platformName={platformName}
        fallbackReason={fallbackReason}
        via={via}
        durationMs={durationMs}
        onRetry={onRetry}
        onOpenSource={sourceUrl ? () => void openExternal(sourceUrl) : undefined}
        onConfigureCookie={onNavigate ? () => onNavigate("engine") : undefined}
      />
    );
  }

  const images = (data?.images ?? []).filter(Boolean);
  const stats = buildStatItems(data);
  const shape = deriveShape(data);

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          {/* —— 第一眼：封面 + 标题（平台图标在标题左边）—— */}
          <div className="flex gap-3">
            {data?.cover && (
              <img
                src={data.cover}
                alt=""
                referrerPolicy="no-referrer"
                className="aspect-video w-32 shrink-0 rounded-md border border-border object-cover"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <TruncatedTooltip label={data?.title || data?.desc || "（无标题）"}>
                <h2 className="truncate font-semibold text-[15px]">
                  {platformName && (
                    <span className="inline-flex items-center gap-1.5 me-1">
                      <PlatformIcon platform={result.platform} />
                    </span>
                  )}
                  {data?.title || data?.desc || "（无标题）"}
                </h2>
              </TruncatedTooltip>
              {/* 视频详细直接展示，不做收起展开 */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {data?.author && (
                  <span className="inline-flex items-center gap-1">
                    {data.avatar && (
                      <img
                        src={data.avatar}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="size-3.5 rounded-full object-cover"
                      />
                    )}
                    {data.author}
                  </span>
                )}
                {typeof data?.duration === "number" && data.duration > 0 && (
                  <span className="tabular-nums">
                    {Math.round(data.duration > 100000 ? data.duration / 1000 : data.duration)}s
                  </span>
                )}
                {stats.length > 0 && stats.slice(0, 2).map((s) => (
                  <span key={s.label} className="tabular-nums">
                    {s.label}{s.value}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* —— 形态专属区块：直接展示 —— */}
          {shape === "gallery" && <GalleryBlock images={images} onPreview={setPreviewIdx} />}

          {shape === "audio" && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
              {data?.music?.author && (
                <span className="font-medium">
                  ♪ {data.music.author}
                  {data.music.title ? ` - ${data.music.title}` : ""}
                </span>
              )}
              {data?.lyrics && (
                <button
                  type="button"
                  onClick={() => setLyricsOpen((v) => !v)}
                  className="text-muted-foreground underline-offset-2 hover:underline"
                >
                  {lyricsOpen ? "收起歌词" : "查看歌词"}
                </button>
              )}
            </div>
          )}
          {shape === "audio" && lyricsOpen && data?.lyrics && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {data.lyrics}
            </pre>
          )}

          {shape === "multi-video" && (
            <ol className="flex flex-col gap-1.5">
              {(data?.videos ?? []).map((v, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] tabular-nums">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{v.title || `分 P ${i + 1}`}</span>
                  {v.durationFormat && <span className="shrink-0 tabular-nums">{v.durationFormat}</span>}
                </li>
              ))}
            </ol>
          )}

          {shape === "text" && (
            <div className="flex flex-col gap-2 rounded-md border border-dashed border-border px-3 py-4 text-center">
              <p className="text-xs text-muted-foreground">纯文字内容，没有可下载的文件</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void copyText(data?.title ?? data?.desc ?? "")}>
                  复制文字
                </Button>
                {sourceUrl && (
                  <Button size="sm" variant="outline" onClick={() => void openExternal(sourceUrl)}>
                    <ExternalLink />
                    打开原页面
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* —— 操作区：与上方信息拉开 —— */}
          <Separator />

          {/* —— 下载配置按钮 + 主操作 —— */}
          <div className="flex flex-wrap items-center gap-3">
            {plan.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => setPlanOpen(true)}>
                配置下载
                <ChevronDown className="ms-1 size-3.5" />
              </Button>
            )}
            {data?.embedOnly ? (
              <Button asChild>
                <a href={data.embedUrl ?? data.url ?? "#"} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  在浏览器中打开播放
                </a>
              </Button>
            ) : (
              <Button onClick={() => void enqueue()} disabled={selected.length === 0}>
                {queued ? "再次下载所选" : selected.length === 1 ? "下载" : `下载 ${selected.length} 项`}
              </Button>
            )}
            {queued && <Badge variant="ok">已加入队列 ✓</Badge>}
            {linkAged && !data?.embedOnly && (
              <span className="text-xs text-muted-foreground">链可能已过期，下载会自动重新取链</span>
            )}
            {!data?.embedOnly && data?.embedUrl && !data.url && !data.videos?.length && (
              <Button asChild variant="link" size="sm" className="h-auto px-0">
                <a href={data.embedUrl} target="_blank" rel="noreferrer">
                  官方播放页
                </a>
              </Button>
            )}
          </div>
          {err && (
            <Alert variant="destructive">
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ViaBadge via={via} />
            <span className="tabular-nums">{fmtDuration(durationMs)}</span>
            {parsedAt && <span className="tabular-nums">解析于 {fmtClock(parsedAt)}</span>}
            {via === "local" && durationMs < 50 && <Badge variant="secondary">缓存命中</Badge>}
            {fallbackReason && (
              <span className="flex flex-wrap items-center gap-2">
                <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setReasonOpen((v) => !v)}>
                  {reasonOpen ? "收起" : "为什么走了线上？"}
                </Button>
                {reasonOpen && <span className="text-xs">{fallbackReason}</span>}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 下载配置 Dialog：清晰度 + 文件清单 */}
      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>下载配置</DialogTitle>
            <DialogDescription className="sr-only">选择清晰度与要下载的文件</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {/* 清晰度选择 */}
            {qualityOptions.length > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">清晰度</span>
                {qualityOptions.map((q, i) => (
                  <Button
                    key={`${q.label}-${i}`}
                    size="sm"
                    variant={i === activeIdx ? "default" : "outline"}
                    className="h-7 rounded-full px-3 text-xs"
                    onClick={() => setQualityIdx(i)}
                  >
                    {q.label}
                  </Button>
                ))}
              </div>
            )}
            {/* 文件清单 */}
            <div>
              <p className="mb-2 text-sm font-medium">文件清单</p>
              <ul className="flex flex-col gap-1.5">
                {plan.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={p.id}
                      checked={!excluded.has(p.id)}
                      onCheckedChange={() =>
                        setExcluded((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        })
                      }
                    />
                    <label htmlFor={p.id} className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="shrink-0 text-xs text-muted-foreground">{p.label}</span>
                      <TruncatedTooltip label={p.filename}>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{p.filename}</span>
                      </TruncatedTooltip>
                      {p.fallbackNote && <Badge variant="warn">{p.fallbackNote}</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setPlanOpen(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 图集预览：Radix Dialog 接管 Esc 与焦点，页面级 Esc 因此让位 */}
      <Dialog open={previewIdx !== null && !!images[previewIdx]} onOpenChange={(v) => !v && setPreviewIdx(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              图片预览 {previewIdx !== null ? previewIdx + 1 : 0}/{images.length}
            </DialogTitle>
            <DialogDescription className="sr-only">图集逐张预览</DialogDescription>
          </DialogHeader>
          {previewIdx !== null && images[previewIdx] && (
            <img
              src={images[previewIdx]}
              alt=""
              referrerPolicy="no-referrer"
              className="max-h-[60vh] w-full rounded-md bg-sunken object-contain"
            />
          )}
          <DialogFooter>
            {previewIdx !== null && previewIdx > 0 && (
              <Button variant="outline" size="sm" onClick={() => setPreviewIdx((i) => (i === null ? i : i - 1))}>
                <ArrowLeft />
                上一张
              </Button>
            )}
            {previewIdx !== null && previewIdx < images.length - 1 && (
              <Button variant="outline" size="sm" onClick={() => setPreviewIdx((i) => (i === null ? i : i + 1))}>
                下一张
                <ArrowRight />
              </Button>
            )}
            <Button size="sm" onClick={() => setPreviewIdx(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** stat / 频道 / 抖音微博等平台各异计数 → 统一「标签 数值」行。
 *
 *  作品级那八档走 `pickWorkStat` + `workStatItems`——与历史 txt、表格导出读的是同一张
 *  `WORK_STAT_SLOTS`，所以「屏幕上叫点赞、表里叫喜欢」这种漂移不会发生；
 *  作者级三档（粉丝/投稿/获赞）走 `buildAuthorSnapshot`，与写进历史的那份同源。 */
function buildStatItems(data?: ParseData): Array<{ label: string; value: string }> {
  const fmt = (label: string, value: number) => ({ label, value: fmtCount(value) });
  const a = buildAuthorSnapshot(data);
  const authorSlots: Array<{ label: string; value?: number }> = [
    { label: "粉丝", value: a?.followerCount },
    { label: "投稿", value: a?.videoCount },
    { label: "获赞", value: a?.totalFavorited },
  ];
  return [
    ...workStatItems(pickWorkStat(data)).map((s) => fmt(s.label, s.value)),
    ...authorSlots.flatMap((x) => (x.value === undefined ? [] : [fmt(x.label, x.value)])),
  ];
}

function ViaBadge({ via }: { via: "local" | "online" | "mock" }): React.ReactElement {
  const label = via === "local" ? "本地内核" : via === "online" ? "线上回落" : "mock 骨架";
  return <Badge variant={via === "local" ? "ok" : via === "online" ? "warn" : "secondary"}>{label}</Badge>;
}


/** 图集形态的主视觉：缩略网格 + 大图预览（Radix Dialog 接管 Esc 与焦点） */
function GalleryBlock({
  images,
  onPreview,
}: {
  images: string[];
  onPreview: (i: number) => void;
}): React.ReactElement {
  return (
    <ul className="grid grid-cols-4 gap-2">
      {images.slice(0, 8).map((src, i) => (
        <li key={i}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onPreview(i)}
                aria-label={`查看第 ${i + 1} 张图`}
                className="relative block aspect-square w-full overflow-hidden rounded-md border border-border outline-none transition-all hover:border-ring hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
                {i === 7 && images.length > 8 && (
                  <span className="absolute inset-0 flex items-center justify-center bg-[var(--overlay)] text-sm font-medium text-popover-foreground">
                    +{images.length - 8}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>查看第 {i + 1} 张图</TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/** 打开外链：统一走 shell（renderer 不自己 window.open） */
async function openExternal(url: string): Promise<void> {
  try {
    await api.app.openExternal(url);
  } catch {
    /* 打不开就保持现状，不弹错打断用户 */
  }
}

/** 复制纯文字内容：与 `openExternal` 同一条理由走主进程代发（契约 v11）——本窗口的
 *  `navigator.clipboard` 被「所有权限请求一律拒」的权限钩子挡死，写下去永远 reject。
 *  静默失败会被读成「按钮坏了」，所以动作要有回执。 */
async function copyText(text: string): Promise<void> {
  if (!text) {
    toast.info("这条内容没有可复制的文字");
    return;
  }
  try {
    await api.app.copyText(text);
    toast.success("已复制");
  } catch {
    toast.error("复制失败");
  }
}

/**
 * 解析失败态：按 failType 给「下一步做什么」，而不是只回一句 msg。
 *
 * 契约的 failType 是内核分好类的（mediaGet CLAUDE.md：bot-gated / sources-down /
 * source-unavailable / script-error），此前界面完全没用它 —— 结果是用户看到一句
 * 「解析失败」不知道该重试、该换链接，还是该去配 Cookie。
 */
const FAILURE_GUIDE: Record<
  string,
  { title: string; hint: string; actions: Array<"retry" | "browser" | "cookie"> }
> = {
  "bot-gated": {
    title: "平台要求登录或验证",
    hint: "内容对游客有限制，不是软件故障。在引擎页配置该平台 Cookie 后通常可解析。",
    actions: ["cookie", "browser", "retry"],
  },
  "sources-down": {
    title: "解析接口暂时不可用",
    hint: "上游接口网络异常或风控，稍后重试一般会好。",
    actions: ["retry", "browser"],
  },
  "source-unavailable": {
    title: "内容已失效或需要权限",
    hint: "原内容可能已删除、转为私密，或需要会员权限。",
    actions: ["browser"],
  },
  "script-error": {
    title: "解析脚本出错",
    hint: "平台页面结构可能已变更，可重试一次；持续出现请反馈。",
    actions: ["retry", "browser"],
  },
};

function ParseFailure({
  msg,
  failType,
  platformName,
  fallbackReason,
  via,
  durationMs,
  onRetry,
  onOpenSource,
  onConfigureCookie,
}: {
  msg: string;
  failType?: string;
  platformName: string;
  fallbackReason?: string;
  via: "local" | "online" | "mock";
  durationMs: number;
  onRetry?: () => void;
  onOpenSource?: () => void;
  onConfigureCookie?: () => void;
}): React.ReactElement {
  const guide = failType ? FAILURE_GUIDE[failType] : undefined;
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-[15px]">{guide?.title ?? "解析失败"}</h2>
          {platformName && (
            <Badge variant="outline" className="gap-1.5">
              {platformName}
            </Badge>
          )}
          {failType && <Badge variant="warn">{failType}</Badge>}
        </div>

        <p className="text-sm text-muted-foreground">{guide?.hint ?? msg}</p>

        {/* 原始 msg 始终可达：guide 覆盖的是「人话」，底层原因不能藏起来 */}
        {guide && (
          <button
            type="button"
            onClick={() => setDetailOpen((v) => !v)}
            className="flex items-center gap-1 self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {detailOpen ? "收起技术详情" : "技术详情"}
            {detailOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        )}
        {detailOpen && (
          <p className="rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs break-all text-muted-foreground">
            {msg}
          </p>
        )}

        {fallbackReason && (
          <p className="text-xs text-muted-foreground">
            本地内核不可用，已走线上回落：{fallbackReason}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {guide?.actions.includes("retry") && onRetry && (
            <Button size="sm" onClick={onRetry}>
              重试
            </Button>
          )}
          {guide?.actions.includes("cookie") && onConfigureCookie && (
            <Button size="sm" variant="outline" onClick={onConfigureCookie}>
              去配置 Cookie
            </Button>
          )}
          {guide?.actions.includes("browser") && onOpenSource && (
            <Button size="sm" variant="outline" onClick={onOpenSource}>
              <ExternalLink />
              在浏览器打开
            </Button>
          )}
          {!guide && onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              重试
            </Button>
          )}
          <ViaBadge via={via} />
          <span className="text-xs tabular-nums text-muted-foreground">{fmtDuration(durationMs)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

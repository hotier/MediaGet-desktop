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
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { api } from "../lib/bridge";
import { buildPlan, buildQualityPlan, type QualityStrategy, summarize } from "../lib/download-plan";
import { fmtCount, fmtDuration } from "../lib/format";
import { buildAuthorSnapshot } from "../lib/work-info";
import type { AppMeta, ParseRunOutcome } from "../../../types/ipc";
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

/** 直链时效：超过 5 分钟内核给的直链大概率已过期（README「分钟级」） */
const LINK_TTL_MS = 5 * 60 * 1000;

/** 超过这个条数就默认折叠，避免图集/多 P 把整屏占掉 */
const PLAN_COLLAPSE_AT = 3;

export function ResultCard({
  outcome,
  meta,
  sourceUrl,
  onQueued,
  onRetry,
}: {
  outcome: ParseRunOutcome;
  meta?: AppMeta | null;
  /** 用户输入的分享链接（写历史用，非直链） */
  sourceUrl?: string;
  onQueued: (count: number) => void;
  /** 失败态 [重试] / 直链过期后 [重新解析并下载]：由页面重新发起解析 */
  onRetry?: () => void;
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

  // 清晰度预选策略（设置→下载）：随每次解析重读，组件复用不重挂载也能拿到最新值
  const [qualityStrategy, setQualityStrategy] = useState<QualityStrategy>("main");
  useEffect(() => {
    void api.settings
      .get()
      .then((s) => setQualityStrategy(s.defaultQuality))
      .catch(() => {});
  }, [outcome]);

  // 解析成功后 15s 心跳计龄，超 TTL 按钮改为「重新解析并下载」
  const [resultAge, setResultAge] = useState(0);
  useEffect(() => {
    if (result.code !== 200) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setResultAge(Date.now() - startedAt), 15_000);
    return () => clearInterval(timer);
  }, [outcome, result.code]);
  const linkAged = resultAge >= LINK_TTL_MS;

  // 新一轮解析 = 全新卡片状态：队列锁、勾选、清晰度、计龄都不该带过来。
  // 依赖只写 outcome：清晰度切换会重算 plan，那时不能把用户的勾选与队列提示清掉。
  useEffect(() => {
    setQueued(false);
    setErr("");
    setQualityIdx(null);
    setExcluded(new Set());
    setResultAge(0);
    // 短清单（≤3 项）摊开，长清单（图集/多 P）折叠 —— 结果卡不许吃掉整屏
    const fresh = buildQualityPlan(data, qualityStrategy);
    setPlanOpen(buildPlan(data, fresh.options[fresh.primaryIndex]).length <= PLAN_COLLAPSE_AT);
    // 只随解析结果重置；策略读新值迟到由下方 memo 纠正
  }, [outcome, data]);

  const qualityPlan = useMemo(() => buildQualityPlan(data, qualityStrategy), [data, qualityStrategy]);
  const qualityOptions = qualityPlan.options;
  const activeIdx = Math.min(qualityIdx ?? qualityPlan.primaryIndex, Math.max(0, qualityOptions.length - 1));
  const plan = useMemo(
    () => buildPlan(data, qualityOptions[activeIdx]),
    [data, qualityOptions, activeIdx]
  );
  const selected = useMemo(() => plan.filter((p) => !excluded.has(p.id)), [plan, excluded]);

  const platformName = useMemo(() => {
    if (!result.platform) return "";
    return meta?.platforms.find((p) => p.key === result.platform)?.name ?? result.platform;
  }, [meta, result.platform]);

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

  /** 直链已过期：先重新解析，新结果到手自动入队（按钮说的就是它做的事） */
  const reparseQueueRef = useRef(false);
  function reparseThenDownload(): void {
    reparseQueueRef.current = true;
    onRetry?.();
  }
  useEffect(() => {
    if (!reparseQueueRef.current) return;
    reparseQueueRef.current = false;
    if (result.code === 200 && plan.length > 0) void enqueue();
  }, [outcome, result.code, plan, selected]);

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
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <h2 className="font-semibold text-[15px]">解析失败</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {result.msg}
            {result.failType && <Badge variant="warn">{result.failType}</Badge>}
          </p>
          {fallbackReason && <p className="text-xs text-muted-foreground">回落原因：{fallbackReason}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {onRetry && (
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

  const images = (data?.images ?? []).filter(Boolean);
  const stats = buildStatItems(data);
  const planSummary = summarize(selected);

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4 py-4">
          {/* —— 信息层 —— */}
          <div className="flex gap-4">
            {data?.cover && (
              <img
                src={data.cover}
                alt=""
                referrerPolicy="no-referrer"
                className="aspect-video w-40 shrink-0 rounded-md border border-border object-cover"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <TruncatedTooltip label={data?.title || data?.desc || "（无标题）"}>
                <h2 className="truncate font-semibold text-[15px]">{data?.title || data?.desc || "（无标题）"}</h2>
              </TruncatedTooltip>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {platformName && (
                  <Badge variant="outline" className="gap-1.5 ps-1">
                    <PlatformIcon platform={result.platform} />
                    {platformName}
                  </Badge>
                )}
                {data?.author && (
                  <span className="inline-flex items-center gap-1.5">
                    {data.avatar && (
                      <img
                        src={data.avatar}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="size-4 rounded-full object-cover"
                      />
                    )}
                    @{data.author}
                  </span>
                )}
                {typeof data?.duration === "number" && data.duration > 0 && (
                  <span className="tabular-nums">
                    {Math.round((data.duration > 100000 ? data.duration / 1000 : data.duration))}s
                  </span>
                )}
                {data?.type && <Badge variant="secondary">{typeLabel(data.type)}</Badge>}
              </div>
              {stats.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                  {stats.map((s) => (
                    <span key={s.label}>
                      {s.label} {s.value}
                    </span>
                  ))}
                  {data?.statsUnreliable && (
                    <Badge variant="warn" className="gap-1">
                      <AlertTriangle />
                      数据可能不准
                    </Badge>
                  )}
                </div>
              )}
              {(data?.music?.author || data?.core) && (
                <p className="text-xs text-muted-foreground">
                  {data.music?.author && `♪ ${data.music.author}${data.music.title ? ` - ${data.music.title}` : ""}`}
                  {data.core && (data.music?.author ? ` · 高潮片段 ${data.core}` : `高潮片段 ${data.core}`)}
                </p>
              )}
            </div>
          </div>

          {data?.desc && data.desc !== data.title && (
            <TruncatedTooltip label={data.desc} contentClassName="max-w-96">
              <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{data.desc}</p>
            </TruncatedTooltip>
          )}

          {images.length > 0 && (
            <ul className="grid grid-cols-4 gap-2">
              {images.slice(0, 8).map((src, i) => (
                <li key={i}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setPreviewIdx(i)}
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
          )}

          {/* —— 选择层：清晰度（队列状态不锁它，换清晰度是为了再下一份）—— */}
          {qualityOptions.length > 1 && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="选择清晰度">
              <span className="text-xs text-muted-foreground">清晰度</span>
              {qualityOptions.map((q, i) => (
                <Button
                  key={`${q.label}-${i}`}
                  size="sm"
                  variant={i === activeIdx ? "default" : "outline"}
                  aria-pressed={i === activeIdx}
                  className="h-7 rounded-full px-3 text-xs"
                  onClick={() => setQualityIdx(i)}
                >
                  {q.label}
                </Button>
              ))}
            </div>
          )}

          {/* —— 下载清单层：点之前就知道会得到什么 —— */}
          <Separator />
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setPlanOpen((v) => !v)}
              aria-expanded={planOpen}
              disabled={plan.length === 0}
              className="flex items-center gap-2 self-start text-sm outline-none disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="font-medium">下载清单</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {selected.length === 0 ? "未选择任何文件" : planSummary}
                {selected.length !== plan.length && `（已排除 ${plan.length - selected.length}）`}
              </span>
              {planOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
            {planOpen && (
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
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {data?.embedOnly ? (
              <Button asChild>
                <a href={data.embedUrl ?? data.url ?? "#"} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  在浏览器中打开播放
                </a>
              </Button>
            ) : (
              <Button onClick={() => void (linkAged && onRetry ? reparseThenDownload() : enqueue())} disabled={selected.length === 0}>
                {linkAged && onRetry
                  ? "重新解析并下载"
                  : queued
                    ? "再次下载所选"
                    : selected.length === 1
                      ? "下载"
                      : `下载 ${selected.length} 项`}
              </Button>
            )}
            {queued && <Badge variant="ok">已加入队列 ✓</Badge>}
            {linkAged && !queued && (
              <span className="text-xs text-muted-foreground">直链已超 {Math.round(LINK_TTL_MS / 60000)} 分钟，先重新解析</span>
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

/** stat / 频道 / 抖音微博等平台各异计数 → 统一「标签 数值」行（契约字段，此前全未消费） */
function buildStatItems(data?: {
  stat?: object;
  subscriberCount?: number;
  videoCount?: number;
  channelViews?: number;
  views?: number;
  like?: number;
  retweets?: number;
  replies?: number;
  followerCount?: number;
  totalFavorited?: number;
}): Array<{ label: string; value: string }> {
  if (!data) return [];
  const out: Array<{ label: string; value: string }> = [];
  const push = (label: string, n: number | undefined) => {
    if (typeof n === "number" && n >= 0) out.push({ label, value: fmtCount(n) });
  };
  const s = data.stat as Record<string, number | undefined> | undefined;
  push("播放", s?.view ?? data.views ?? data.channelViews);
  push("弹幕", s?.danmaku);
  push("点赞", s?.like ?? data.like);
  push("转发", data.retweets);
  push("评论", s?.reply ?? data.replies);
  push("收藏", s?.favorite);
  push("投币", s?.coin);
  push("分享", s?.share);
  push("粉丝", data.followerCount ?? data.subscriberCount);
  push("投稿", data.videoCount);
  push("获赞", data.totalFavorited);
  return out;
}

function ViaBadge({ via }: { via: "local" | "online" | "mock" }): React.ReactElement {
  const label = via === "local" ? "本地内核" : via === "online" ? "线上回落" : "mock 骨架";
  return <Badge variant={via === "local" ? "ok" : via === "online" ? "warn" : "secondary"}>{label}</Badge>;
}

/** 契约里的 type 是英文枚举，界面不能直接把枚举值当文案（未知值原样显示，便于排查新平台） */
const TYPE_LABEL: Record<string, string> = {
  video: "视频",
  image: "图集",
  music: "音乐",
  text: "图文",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

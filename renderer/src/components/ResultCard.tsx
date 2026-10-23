/**
 * 结果卡：一套通用骨架铺所有平台/资源形态，不在卡片里按 `type` 分叉。
 *
 * 骨架由四段组成，形态差异只决定「哪几段出现」：
 *  - 主视觉：封面（没有封面时按形态给图标占位）+ 时长 / 图片数徽标，可点即预览；
 *  - 身份带：平台图标 + 标题 + 作者头像昵称 + 作品计数；
 *  - 附加区：音乐/歌词、纯文字说明，按 `ResourceMix` 叠加出现；
 *  - 动作条：资源列表（就地展开，靠左）+ 清晰度 + 下载（靠右）；
 *
 * 预览入口两处：主视觉封面与资源清单**每一行**，都进同一扇预览窗。序列 = 清单里所有
 * 可预览项（视频 / 独立音轨 / 图片，`kind !== "file"`），左右箭头与 `←`/`→` 顺着翻；
 * 卡面只留一张主视觉，多 P 明细与图集缩略条不再铺在卡上。
 *
 * 为什么不用 `ResourceShape` 互斥分类：同一份结果常常同时是「视频 + 图片 + 多档清晰度」
 * （抖音图文、微博多图带视频），互斥分类必然丢掉其中一半。`describeResourceMix` 只回答
 * 「有几种什么」，各段自己决定要不要画。
 *
 * 契约依据 docs/ARCHITECTURE.md §3，字段消费见 docs/UIUX-DESIGN.md §2.1。
 * 「点下载 = IPC 入队主进程流式落盘」，直链本身不呈现给用户点选
 * （README「直链时效」决策）；预览走主进程代理（mgpreview:），渲染层自己不发外链，
 * 链也不显示、不入库。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, CircleEuro, CircleFadingPlay, ExternalLink, FileText, Heart, Images, ListTree, MessageCircle, MessageCircleText, Music, Pause, Play, RefreshCw, Share2, StarCheck } from "lucide-react";
import { api } from "../lib/bridge";
import {
  buildPlan,
  buildQualityPlan,
  DEFAULT_FILENAME_EXTRA,
  describeResourceMix,
  type FilenameExtra,
  type FilenamePreset,
  type PlanEntry,
  type QualityStrategy,
} from "../lib/download-plan";
import { fmtClock, fmtCount, fmtDuration } from "../lib/format";
import { mseTrackMime } from "../lib/fmp4";
import { cn } from "../lib/utils";
import { buildAuthorSnapshot } from "../../../shared/author";
import { pickWorkStat, workStatItems } from "../../../shared/work-stat";
import { buildImageSrc, buildPreviewLink } from "../../../shared/preview-link";
import type { ParseData, ParseRunOutcome } from "../../../types/ipc";
import {
  ENGINE_INFO,
  asSwitchableEngine,
  displayName,
  type EngineId,
} from "../../../shared/platforms";
import { AuthorAvatar } from "./AuthorAvatar";
import { BrandLoader } from "./BrandLoader";
import { PlatformIcon } from "./PlatformIcon";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Alert, AlertDescription } from "./ui/alert";
import { HintInfo, Tooltip, TooltipContent, TooltipTrigger, TruncatedTooltip } from "./ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogSlideMotion,
} from "./ui/dialog";
import { AuthorCard } from "./AuthorCard";
import { MsePreviewVideo } from "./MsePreviewVideo";

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
  /**
   * 重新解析（主进程侧带 `skipCache`）：失败态是 [重试]，成功态是动作条上的
   * [重新解析]（业主 2026-10-23：直链过期、或刚换了引擎时需要一条强制重解的入口）。
   * 下载侧的 403 续链不经过这里，那是主进程自己按作品键再解析一次。
   */
  onRetry?: () => void;
  /**
   * 失败态「去配置 Cookie」：打开设置并直达分类 id（引擎页 = "engine"）。
   * 缺省时该按钮不渲染 —— 不给点了没反应的假按钮。
   */
  onNavigate?: (category: string) => void;
}): React.ReactElement {
  const { result, via, viaEngine, durationMs } = outcome;
  const data = result.data;
  /**
   * 回退轨迹（v32）：把「谁失败过、失败在哪个码/哪类原因」摆出来——
   * 卡片上的引擎名只答「谁解的」，「为什么不是主引擎」要靠这条轨迹。
   * 只有真发生过失败才展示：一次成功的轨迹是噪音。
   */
  const attempts = outcome.attempts ?? [];
  const fallbackTrail =
    attempts.some((a) => !a.ok)
      ? attempts
          .map((a) =>
            a.ok
              ? `${ENGINE_INFO[a.engine].label}：成功`
              : `${ENGINE_INFO[a.engine].label}：失败 ${a.code}${a.failType ? `（${a.failType}）` : ""}${a.msg ? ` — ${a.msg}` : ""}`
          )
          .join("；")
      : null;
  const [err, setErr] = useState("");
  /** null = 还没手选，用内核主直链对应档位（SSR 与首帧都走这条，不等 effect 纠正） */
  const [qualityIdx, setQualityIdx] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [planOpen, setPlanOpen] = useState(false);
  /** 清单里某一项的预览：只在弹窗开着的这段时间里活着（直链不进历史/日志） */
  const [previewEntry, setPreviewEntry] = useState<PlanEntry | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  /**
   * 还没吐出头一帧。双轨 DASH 优先走 MSE 边拉边播（一般秒开）；回退到主进程合流后，
   * 十秒级等待是正常范围——两种都要有这层提示，否则用户看到的就是「一直转圈」。
   */
  const [previewLoading, setPreviewLoading] = useState(false);
  /**
   * 首帧是否已到手：决定封面层淡出、画面淡入。
   *
   * 与 `previewLoading` 分开是因为两者语义不同——`previewLoading` 会在播放中途卡顿时
   * 又亮起来（`waiting`），而「第一次出画」只发生一次，重播/拖动都不该再让画面重新淡入。
   */
  const [previewReady, setPreviewReady] = useState(false);
  /**
   * 开关与内容分家：关闭时先把 `open` 置假、内容留到退场动画跑完再释放。
   * 以前是一关就把 entry 清空，退场期间框里一个字节都没有，调多长都像「啪一下消失」。
   */
  const [previewOpen, setPreviewOpen] = useState(false);
  /**
   * 预览视频的播放态：驱动舞台正中那枚播放/暂停按钮（业主指令 2026-10-19：
   * 原生控制条里的播/停挪到画面正中央）。原生那枚由 `.preview-video` 的伪元素藏掉，
   * 状态只认媒体元素自己的 play / pause / ended 事件，不在点击处乐观翻转——
   * 自动播放被系统拦掉时，按钮得如实停在「播放」上。
   */
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * MSE 预览失败后，这一条退回「主进程合流」的老路（ffmpeg 出片再播）。
   * 失败只影响当前这一项，翻页/重开时重置——别让上一档的编码不支持连坐到下一档。
   */
  const [mseFallback, setMseFallback] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  /** 作者卡片：与历史页同一个组件、同一套开合（非模态 + 轻遮罩），数据就是这份解析快照 */
  const [authorCardOpen, setAuthorCardOpen] = useState(false);

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

  // 新一轮解析 = 全新卡片状态：勾选、清晰度、计龄都不该带过来。
  // 依赖只写 outcome：清晰度切换会重算 plan，那时不能把用户的勾选清掉。
  useEffect(() => {
    setErr("");
    setQualityIdx(null);
    setExcluded(new Set());
    // 资源列表默认收起，由用户点「资源列表」就地展开
    setPlanOpen(false);
    setPreviewEntry(null);
    setPreviewFailed(false);
    setPreviewOpen(false);
    setMseFallback(false);
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

  /**
   * 预览框真正写进 src 的那条链。音视频与图片**都**经主进程代理：CSP 只放行 `'self'`
   * 让媒体外链过不去，而微博图床连**空 Referer** 都回 403，`<img>` 同样带不上防盗链头
   * （实测见 `shared/preview-link.ts` 的 `buildImageSrc`）。代理链建不出来（地址过不了安全闸、
   * 或是站内相对路由这类根本不该进 src 的形状）时没有可试的，两类都进失败说明。
   */
  /**
   * 预览要不要带音频轨 —— 直接问下载计划那一项（`previewEntry.audioUrl`），这里不再自己
   * 判一遍扩展名。判两次就会分裂：YouTube 的 DASH 链长在 `googlevideo.com/videoplayback`
   * 上，没有 `.m4s` 可认，预览与下载各判各的，最后一边有声一边没声
   * （2026-10-21 用户报「YouTube 视频在预览页调不了音量」，根因就是这里只认 `.m4s`：
   * 选到高于主链的档后 `<video>` 里根本没有音轨，Chromium 连音量按钮都不画）。
   * 音频条目自己不能再带音频轨。
   */
  const dashAudio = previewEntry?.kind === "video" ? previewEntry.audioUrl : undefined;
  const previewSrc =
    previewEntry === null
      ? null
      : previewEntry.kind === "video" || previewEntry.kind === "audio"
        ? buildPreviewLink(previewEntry.url, result.platform, dashAudio)
        : buildImageSrc(previewEntry.url, result.platform);

  /**
   * 双轨 DASH 走 MSE（2026-10-23 业主定调「凡是 dash 流都要边缓存边播放」）：
   * 两条轨道各有 codec/容器才建得出 SourceBuffer；缺字段（渐进式、B站未登录的 durl、
   * 内核没回元数据）时为 null，预览按原路直接播或合流，行为不变。
   * `mseFallback` 是单向闸：这一条失败后退回合流，翻到下一项再给 MSE 一次机会。
   */
  const mseMime = useMemo(
    () => (previewEntry?.kind === "video" ? mseTrackMime(previewEntry) : null),
    [previewEntry]
  );

  /** 缺省 = 下载勾选中的那批（Ctrl+D 与动作条按钮）；传条目 = 只下这一条 */
  async function enqueue(list: PlanEntry[] = selected): Promise<void> {
    setErr("");
    if (list.length === 0) {
      onQueued(0);
      return;
    }
    try {
      await api.download.enqueue({
        items: list.map((p) => ({
          url: p.url,
          audioUrl: p.audioUrl,
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
      // 入队反馈由 `onQueued` 的宿主（HomePage）发 toast —— 它知道数量与下一步去哪；
      // 这里再播一条就是同一个动作两声提示（2026-10-18 实测撞了双 toast，业主点名）
      onQueued(list.length);
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
        via={via}
        engine={viaEngine}
        durationMs={durationMs}
        onRetry={onRetry}
        onOpenSource={sourceUrl ? () => void openExternal(sourceUrl) : undefined}
        onConfigureCookie={onNavigate ? () => onNavigate("engine") : undefined}
      />
    );
  }

  const stats = buildStatItems(data);
  const mix = describeResourceMix(data);
  const author = buildAuthorSnapshot(data);
  const authorName = author?.name ?? "";
  const primaryEntry =
    plan.find((p) => p.kind === "video") ??
    plan.find((p) => p.kind === "image") ??
    plan.find((p) => p.kind === "audio") ??
    null;
  const canPreview = !data?.embedOnly && primaryEntry !== null;
  const durationText =
    data?.durationFormat ??
    // `ParseData.duration` 是**毫秒**（内核 d.ts 硬口径：抖音/YouTube/tiktok/B站顶层与分P/X 均已换算），
    // 一律 /1000。旧代码按 `> 100000` 猜单位，1 分 30 秒的短片毫秒值（90867）落在阈值下被当成秒，
    // 显示成 25:14:27 —— 2026-10-19 事故。
    (typeof data?.duration === "number" && data.duration > 0
      ? fmtMediaDuration(data.duration / 1000)
      : undefined);
  const title = data?.title || data?.desc || "（无标题）";

  /**
   * 主视觉封面的 src：建不出来（地址过不了安全闸，或站内相对路由这类根本不该进 src 的形状）
   * 就降级成形态占位图标。2026-10-18 事故里旧内核吐的相对路由被原样写进 src，
   * 演的是「图裂了」而不是报错。预览弹窗里的图走 `previewSrc`，同一条 `buildImageSrc`。
   */
  const coverSrc = mix.cover ? buildImageSrc(mix.cover, result.platform) : null;

  /** 预览的封面占位层：封面只属于主链那条视频，翻到别的档位时没有对应封面，不拿它冒充 */
  const previewCoverSrc =
    previewEntry?.url === data?.url && coverSrc ? coverSrc : undefined;

  /** 开预览：内容先就位再开门，入场那一帧就有画面，不会闪一下空框 */
  function showPreview(p: PlanEntry): void {
    setPreviewFailed(false);
    // 音视频从「打开」就可能进入等待（dash 双轨合流），先亮加载态；图片不等
    setPreviewLoading(p.kind === "video" || p.kind === "audio");
    setPreviewReady(false);
    setMseFallback(false);
    setPreviewEntry(p);
    setPreviewOpen(true);
  }

  /** 主视觉入口：封面点开就是清单里第一条可预览资源，之后靠左右箭头顺着翻 */
  function openPrimaryPreview(): void {
    if (!primaryEntry) return;
    showPreview(primaryEntry);
  }

  /** 清单行自己的预览入口：从这条资源进同一扇窗，两侧箭头仍按清单顺序翻 */
  function previewRow(p: PlanEntry): void {
    showPreview(p);
  }

  /**
   * 预览序列 = 清单里**所有能预览的项**，按 plan 顺序排：分 P、独立音轨与图片都在里面。
   *
   * 图片曾走另一扇「图集弹窗」，两套状态/两份动画/两条入口；图文混合时更糟——
   * 第一条是视频，点封面后序列只有它自己，`length > 1` 不成立，两侧箭头根本不出现。
   * 现在只有一扇窗：视频、图片、音频共用这个序列，序号与文件名都在固定底栏。
   */
  const previewItems = plan.filter((p) => p.kind !== "file");
  const previewSeqIdx = previewEntry
    ? previewItems.findIndex((p) => p.url === previewEntry.url)
    : -1;

  function stepPreview(delta: number): void {
    const next = previewItems[previewSeqIdx + delta];
    if (!next) return;
    setPreviewFailed(false);
    // 与 showPreview 同一口径：翻到音视频就先亮加载态，别等新元素的 loadstart 抢进来
    setPreviewLoading(next.kind === "video" || next.kind === "audio");
    setPreviewReady(false);
    setMseFallback(false);
    setPreviewEntry(next);
  }

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          {/* —— 主视觉 + 身份带 + 动作条 + 资源清单：所有形态共用同一骨架 ——
              两列网格：左列就是封面宽（9rem = w-36），右列是内容。
              动作条与资源清单都跨两列：前者让「资源列表」贴卡片左缘，后者让展开的
              条目也落在封面同一条左边缘上，整卡只有一条左基准线。 */}
          <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3">
            <button
              type="button"
              onClick={openPrimaryPreview}
              disabled={!canPreview}
              aria-label={canPreview ? (mix.videoCount > 0 ? "预览视频" : "预览图片") : undefined}
              className={cn(
                "group relative aspect-video w-36 shrink-0 self-start overflow-hidden rounded-md border border-border bg-sunken text-muted-foreground",
                canPreview &&
                  "cursor-pointer outline-none transition-all hover:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              )}
            >
              {coverSrc ? (
                <img
                  src={coverSrc}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-full object-cover"
                />
              ) : (
                <span className="flex size-full items-center justify-center">
                  {mix.videoCount > 0 ? (
                    <Play className="size-6" />
                  ) : mix.imageCount > 0 ? (
                    <Images className="size-6" />
                  ) : mix.hasAudio ? (
                    <Music className="size-6" />
                  ) : (
                    <FileText className="size-6" />
                  )}
                </span>
              )}
              {mix.videoCount > 0 && canPreview && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
                  <Play className="size-6 fill-current text-white" />
                </span>
              )}
              {(durationText || mix.imageCount > 0) && (
                /* 角标压在任意封面上，底色两档主题都是深遮罩（--overlay = veil），
                   文字必须取「遮罩上的浅字」而不是 --text：浅色主题的 --text(#1b1e21)
                   与 veil(#1b1e21d9) 同色，角标等于隐形字。 */
                <span className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-[var(--overlay)] px-1 text-[11px] tabular-nums text-[color:var(--text-on-veil)]">
                  {/* 时长不只属于视频：音乐条目同样需要它，主视觉角标是唯一展示位 */}
                  {durationText ?? null}
                  {durationText && mix.imageCount > 0 ? " · " : null}
                  {mix.imageCount > 0 ? (
                    <>
                      <Images className="size-3" />
                      {mix.imageCount}
                    </>
                  ) : null}
                </span>
              )}
            </button>
            <div className="flex min-w-0 flex-col gap-1.5">
              <TruncatedTooltip label={title}>
                <h2 className="truncate font-semibold text-[15px]">
                  {platformName && (
                    <span className="inline-flex items-center gap-1.5 me-1">
                      <PlatformIcon platform={result.platform} />
                    </span>
                  )}
                  {title}
                </h2>
              </TruncatedTooltip>

              {/* 作者：确认「是不是这个人和这条作品」，比作者级统计更常用。
                  发布日期 2026-10-18 业主指令移除（解析那一刻的时刻仍随历史/导出留档，
                  卡面不再摆——各平台填法与时区解释成本高于卡面收益） */}
              {authorName && (
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <AuthorAvatar
                    avatar={author?.avatar}
                    name={authorName}
                    platform={result.platform}
                    sizeClassName="size-4"
                    textClassName="text-[9px]"
                  />
                  {/* 名字可点：开的是历史页那张作者卡片（粉丝/关注/获赞/简介都在里面），
                      卡片里名字才是打开主页的外链——两处同一个组件、同一套口径 */}
                  <TruncatedTooltip label={authorName}>
                    <button
                      type="button"
                      onClick={() => setAuthorCardOpen(true)}
                      className="min-w-0 flex-1 cursor-pointer truncate text-start hover:underline"
                    >
                      {authorName}
                    </button>
                  </TruncatedTooltip>
                </div>
              )}

              {/* 作品计数：图标 + 数值，标签只在 tooltip 里给（图标认不出时悬停能问） */}
              {stats.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {stats.map((s) => (
                    <Tooltip key={s.key}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          {s.icon}
                          {s.value}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {s.label} {s.value}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              )}

            </div>

            {/* 动作条：跨两列的整行，「展开资源」贴卡片左缘（与封面同一条左边缘），
                就地展开的链接式开关，不是下拉；清晰度与下载靠右。
                构成摘要（「视频 2 · 图 2」）2026-10-18 业主指令移除——
                下载按钮上的项数已经把「点下去会得到几颗」说清楚了，再排一行构成是重复信息。 */}
            <div className="col-span-full flex flex-wrap items-center justify-end gap-2">
              {plan.length > 0 && !data?.embedOnly && (
                <Button
                  size="sm"
                  variant="link"
                  className="me-auto h-auto px-0 hover:no-underline"
                  onClick={() => setPlanOpen((v) => !v)}
                >
                  <ListTree className="size-3.5" />
                  {planOpen ? "收起资源" : "展开资源"}
                </Button>
              )}
              {/* 清晰度在下载动作旁，不再藏在资源清单里：设置里那档只是默认值，
                  用户每次下载都可以改。选择器读同一份 qualityOptions，所以清单里的
                  文件名与下载按钮的项数会当场跟着变。 */}
              {plan.length > 0 && !data?.embedOnly && qualityOptions.length > 1 && (
                <Select value={String(activeIdx)} onValueChange={(v) => setQualityIdx(Number(v))}>
                  {/* 宽度只够放档位名（2026-10-21 业主「清晰度下拉框宽度减小」）：88px 里
                      固定开销（左右内边距 + 间距 + chevron）占 40px，所以内边距同步收到 2——
                      只收宽度不收内边距，「1080P」会先被截成「1080…」。展开后的选项不受这里限制。 */}
                  <SelectTrigger size="sm" className="w-[5.5rem] shrink-0 px-2" aria-label="下载清晰度">
                    <SelectValue />
                  </SelectTrigger>
                  {/* 列表跟着 trigger 收窄（2026-10-21 业主「下拉出现的列表宽度也减小」）：
                      基座 `min-w-[8rem]` 是给普通宽度下拉留的地板，而 Viewport 自己已经
                      `min-w-[var(--radix-select-trigger-width)]`，所以这里把地板去掉即可——
                      列表最窄就是 trigger 宽（88px）。清晰度文案统一成 `720P` / `2160P` 之后
                      档位名都很短，列表仍按内容自然变宽，不做硬截断。 */}
                  <SelectContent className="min-w-0">
                    {qualityOptions.map((q, i) => (
                      <SelectItem key={`${q.label}-${i}`} value={String(i)}>
                        {q.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {data?.embedOnly ? (
                <Button asChild size="sm">
                  <a href={data.embedUrl ?? data.url ?? "#"} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    在浏览器中打开播放
                  </a>
                </Button>
              ) : plan.length > 0 ? (
                // 文案不随「是否入过队」变化：入队反馈在 toast 里，按钮只回答「下几项」
                <Button size="sm" onClick={() => void enqueue()} disabled={selected.length === 0}>
                  {selected.length === 1 ? "下载" : `下载 ${selected.length} 项`}
                </Button>
              ) : mix.textOnly ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyText(data?.title ?? data?.desc ?? "")}
                  >
                    复制文字
                  </Button>
                  {sourceUrl && (
                    <Button size="sm" variant="outline" onClick={() => void openExternal(sourceUrl)}>
                      <ExternalLink className="size-3.5" />
                      打开原页面
                    </Button>
                  )}
                </>
              ) : data?.embedUrl ? (
                <Button asChild variant="outline" size="sm">
                  <a href={data.embedUrl} target="_blank" rel="noreferrer">
                    官方播放页
                  </a>
                </Button>
              ) : null}
            </div>

            {/* —— 可下载资源：跨两列，条目靠左对齐「资源列表」与封面那条边 ——
                -ms-3 抵掉底色块自己的 px-3：块的左缘留在卡片内 8px（不顶边框也不丢面板感），
                而条目文字正好回到 x=0，与按钮、封面同一条竖线。
                文件清单由「资源列表」就地展开（清晰度在动作条，不在这里） —— */}
            {planOpen && plan.length > 0 && (
              <div className="col-span-full -ms-3 flex flex-col gap-3 rounded-md bg-muted/40 px-3 py-3">
                <ul className="flex flex-col gap-1.5">
                  {plan.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
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
                        <TruncatedTooltip label={p.filename}>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">{p.filename}</span>
                        </TruncatedTooltip>
                        {p.fallbackNote && <Badge variant="warn">{p.fallbackNote}</Badge>}
                      </label>
                      {/* 每条资源自带预览与单条下载：不必先勾选、也不必去底部找批量按钮。
                          file 类没有可渲染的预览（弹窗只会说「不支持」），不摆假按钮 ——
                          当前 buildPlan 也不产 file，这条只是守住将来的入口。 */}
                      <div className="flex shrink-0 items-center gap-2">
                        {p.kind !== "file" && (
                          <Button
                            size="sm"
                            variant="link"
                            className="h-auto px-0 text-xs"
                            onClick={() => previewRow(p)}
                          >
                            预览
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="link"
                          className="h-auto px-0 text-xs"
                          onClick={() => void enqueue([p])}
                        >
                          下载
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* —— 附加区：按 ResourceMix 叠加，出现哪一段由数据决定。
              多图/多 P 不再在卡面铺缩略条或分 P 明细（业主指令 2026-10-18）：卡上只留一张
              主视觉，其余资源从这张封面点进去翻页预览，或展开「资源列表」逐条处理 —— */}
          {mix.hasAudio && (data?.music || data?.lyrics) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
              {(data?.music?.author || data?.music?.title) && (
                <span className="font-medium">
                  ♪ {[data.music?.author, data.music?.title].filter(Boolean).join(" - ")}
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
          {mix.hasAudio && lyricsOpen && data?.lyrics && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {data.lyrics}
            </pre>
          )}

          {mix.textOnly && !data?.embedOnly && (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
              纯文字内容，没有可下载的文件
            </p>
          )}

          {err && (
            <Alert variant="destructive">
              <AlertDescription>{err}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ViaBadge via={via} engine={viaEngine} />
            {fallbackTrail && (
              <span className="inline-flex items-center gap-1">
                <Badge variant="warn">回退</Badge>
                <HintInfo text={fallbackTrail} />
              </span>
            )}
            <span className="tabular-nums">{fmtDuration(durationMs)}</span>
            {parsedAt && <span className="tabular-nums">解析于 {fmtClock(parsedAt)}</span>}
            {via === "local" && durationMs < 50 && <Badge variant="secondary">缓存命中</Badge>}
            {/* 强制重新解析（业主 2026-10-23）：带 `skipCache` 重走一遍引擎选路 —— 直链过期
                要新签名、或刚换了引擎而卡片还是旧引擎那份结果，都靠这一颗。放在这行元信息里
                而不是下载动作条：它是「这份结果从哪来」的补救动作，不参与「下几项」的决策。 */}
            {onRetry && (
              <Button
                size="sm"
                variant="link"
                className="ms-auto h-auto px-0 text-xs hover:no-underline"
                onClick={onRetry}
              >
                <RefreshCw className="size-3" />
                重新解析
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 资源预览：一扇窗装下清单里所有可预览项（视频 / 图片 / 音频），按 plan 顺序左右翻。
          图片直接解码，音视频经主进程代理（mgpreview:）取流；DASH 分轨（bilibili 的 .m4s
          视频流与音频流分开）在这里放不出画面是浏览器解码限制，不是链错——下载走主进程合流。
          **固定舞台**：高度锁死，翻页时外框不跳，竖图也能吃满高度；标题/序号全在底栏，
          不再让文件名长短去改变窗格尺寸。 */}
      <Dialog
        open={previewOpen}
        onOpenChange={(v) => {
          setPreviewOpen(v);
          if (!v) {
            setPreviewFailed(false);
            setPreviewPlaying(false);
          }
        }}
      >
        {/* 与作者卡片同一套开合动效（`dialogSlideMotion`：上浮进入 / 下沉退场，250ms）。
            退场跑完才释放 entry —— 见上面 previewEntry 那段注释 */}
        <DialogContent
          // 上/左/右 40px；底部 `pb-7`（28px）——底栏是一行 16px 的文字，居中在 36px 的条里，
          // 文字底缘距框 28+10 ≈ 38，观感与上方 40 对齐；若也留 40，底面会明显比顶面空
          className={cn("max-w-4xl p-10 pb-7", dialogSlideMotion)}
          onAnimationEnd={() => {
            if (!previewOpen) setPreviewEntry(null);
          }}
          onKeyDown={(e) => {
            // 播放器自己吃方向键（seek），只在非媒体元素上接管左右键翻页
            if (e.target instanceof HTMLMediaElement) return;
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              stepPreview(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              stepPreview(1);
            }
          }}
        >
          {/* 标题不再上屏：可访问名仍要给 Radix 一份，不然控制台会告警 */}
          <DialogTitle className="sr-only">资源预览</DialogTitle>
          <DialogDescription className="sr-only">
            {previewEntry ? `${previewEntry.label}：${previewEntry.filename}` : "资源预览"}
          </DialogDescription>

          {/* 舞台：固定高度，媒体等比放进来；音频与失败说明同样落在舞台中央。
              用 flex 而不是 grid 居中：grid 的隐式行高是 auto，`max-h-full` 在那层会退化成
              「没有上限」（百分比高度参照不定高），图片按原始像素铺开再被 overflow 裁掉。
              flex 容器高度是确定的 64vh，`max-h-full` 才真正生效。
              顶部那条缝由弹窗的 `p-10` 提供（内置 X 占 16~32px），这里不再单独加 margin。
              `relative` + 命名 group：中央那枚播放/暂停按钮按舞台居中——`object-contain` 的
              视频在舞台里本来就走中，视频的几何中心与舞台中心重合，不额外套一层定位壳。 */}
          <div className="group/video relative flex h-[64vh] max-h-[calc(100dvh-10rem)] items-center justify-center overflow-hidden rounded-md bg-sunken">
            {previewFailed || previewSrc === null ? (
              <p className="px-6 text-center text-xs text-muted-foreground">
                预览加载失败：平台可能拒发，或这条直链已经过期。下载不受影响。
              </p>
            ) : previewEntry?.kind === "image" ? (
              <img
                src={previewSrc}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => setPreviewFailed(true)}
                className="max-h-full max-w-full object-contain"
              />
            ) : previewEntry?.kind === "video" ? (
              // 视频一开就播（业主指令 2026-10-19）：预览本身就是人点开的，属于有手势的播放，
              // 不额外做静音兜底 —— 无声自动播放比不播更让人以为「没声」是坏点。
              // `key` 必须按 src 走：翻页时元素被复用的话，autoPlay 只在首次挂载生效，第二页就不播了。
              // 原生控件只留「进度 / 音量 / 时间」（业主指令 2026-10-19：去掉全屏与下载）。
              // 播放/暂停挪到画面正中央：`controlsList` 管不到单枚按钮，原生那枚由
              // `.preview-video::-webkit-media-controls-play-button` 藏掉（styles.css），
              // 中央这枚接管开关；播放中自动淡出，鼠标进舞台再浮出来。
              <>
                {/* 封面占位层（2026-10-21 业主「复用视频封面图，在封面图上加载转圈，加载出来之后渐入」）：
                    不走 `poster` 属性——poster 画在 `<video>` 自己的盒子里，跟首帧同生共死，
                    想「先封面、再淡入画面」就没有调节点了。这里单独一层，`previewReady` 一到
                    就淡出，底下那块 `opacity-0 → 100` 正好接上，两层都是 `size-full object-contain`，
                    信箱框一致，不会跳尺寸。非主链的档位没有对应封面（`coverSrc` 是主视频那张），
                    就只留转圈，不拿别的封面冒充。 */}
                {previewCoverSrc && (
                  <img
                    src={previewCoverSrc}
                    alt=""
                    aria-hidden="true"
                    referrerPolicy="no-referrer"
                    className={cn(
                      "pointer-events-none absolute inset-0 size-full object-contain transition-opacity duration-300",
                      previewReady ? "opacity-0" : "opacity-100"
                    )}
                  />
                )}
                {mseMime && !mseFallback && previewEntry.audioUrl ? (
                  // 双轨 DASH 走 MSE：两条轨道边拉边 append，首帧不再等整段 ffmpeg 合流。
                  // 任一环节失败由播放器回调 `onFallback`，当场换回下面这条合流 `<video>`——
                  // 预览可以慢一点，但不能黑屏。
                  <MsePreviewVideo
                    key={`mse:${previewEntry.url}`}
                    videoRef={previewVideoRef}
                    videoUrl={previewEntry.url}
                    audioUrl={previewEntry.audioUrl}
                    platform={result.platform}
                    videoMime={mseMime.video}
                    audioMime={mseMime.audio}
                    durationMs={data?.duration}
                    showControls={!previewLoading}
                    className={cn(
                      "preview-video size-full object-contain transition-opacity duration-300",
                      previewReady ? "opacity-100" : "opacity-0"
                    )}
                    onFallback={() => {
                      setMseFallback(true);
                      setPreviewLoading(true);
                      setPreviewReady(false);
                      setPreviewPlaying(false);
                    }}
                    onLoadStart={() => setPreviewLoading(true)}
                    onCanPlay={() => {
                      setPreviewLoading(false);
                      setPreviewReady(true);
                    }}
                    onWaiting={() => setPreviewLoading(true)}
                    onStalled={() => setPreviewLoading(true)}
                    onPlay={() => {
                      setPreviewLoading(false);
                      setPreviewPlaying(true);
                    }}
                    onPlaying={() => {
                      setPreviewLoading(false);
                      setPreviewReady(true);
                    }}
                    onPause={() => setPreviewPlaying(false)}
                    onEnded={() => setPreviewPlaying(false)}
                  />
                ) : (
                  <video
                    key={previewSrc}
                    ref={previewVideoRef}
                    src={previewSrc}
                    // 加载期间摘掉 `controls`（业主 2026-10-23「禁用原生的加载转圈动画」）：
                    // Chromium 的缓冲指示 `-internal-media-controls-loading-panel` 长在控件
                    // shadow DOM 里，CSS 选不到、JS 删不掉（Stack Overflow 那条结论）——
                    // 想让那颗深色圆盘不出现，只有「没有控件」这一条路。手搭控件是另一个量级的改动，
                    // 而加载时控件本来也没得点（进度条动不了），先按这条做，加载完立刻挂回来。
                    controls={!previewLoading}
                    controlsList="nodownload nofullscreen noremoteplayback noplaybackrate"
                    // 最右那枚「⋮」不是全屏，是溢出菜单：里面还剩一项（画中画 / 投屏 / 播放速度）
                    // 它就不会消失。三样都得关：能力属性管前两个，速度走 controlsList 的
                    // `noplaybackrate`（Chromium 105+）。菜单空了，按钮自然不再渲染 —— 比藏按钮可靠。
                    disablePictureInPicture
                    disableRemotePlayback
                    playsInline
                    autoPlay
                    onLoadStart={() => setPreviewLoading(true)}
                    onCanPlay={() => {
                      setPreviewLoading(false);
                      setPreviewReady(true);
                    }}
                    // canplay 之后才到的卡顿走 waiting/stalled：拖动进度条、高质量档吃不满带宽
                    // 都会先转圈再续播，没有这两个监听就只有一片静默的静止画面
                    onWaiting={() => setPreviewLoading(true)}
                    onStalled={() => setPreviewLoading(true)}
                    onError={() => {
                      setPreviewLoading(false);
                      setPreviewFailed(true);
                    }}
                    onPlay={() => {
                      setPreviewLoading(false);
                      setPreviewPlaying(true);
                    }}
                    onPlaying={() => {
                      setPreviewLoading(false);
                      setPreviewReady(true);
                    }}
                    onPause={() => setPreviewPlaying(false)}
                    onEnded={() => setPreviewPlaying(false)}
                    // 首帧到手前整块透明，让下面那张封面占位；`size-full` 是为了让两层的
                    // `object-contain` 算出同一个信箱框，淡入时才不会「啪」地换尺寸
                    className={cn(
                      "preview-video size-full object-contain transition-opacity duration-300",
                      previewReady ? "opacity-100" : "opacity-0"
                    )}
                  />
                )}
                {/* 加载态：三点跳动 + 一句话（业主 2026-10-23：「文案统一改为：正在加载中......」）。
                    文案不再分段——原先 2.5s 后按「ffmpeg 合流慢 / 带宽慢」改写原因，
                    业主明确只要一句「在加载」，不要替用户推断为什么慢。
                    字形用品牌点阵（`BrandLoader`）而不是 `Loader2 + animate-spin`：转环是系统语汇，
                    盖在画面上像浏览器自己在转圈。
                    `role=status` 让读屏也知道在等，而不是把一段静默当成失败。
                    遮罩只压 25%：底下是封面，压太重就白铺了这张图。 */}
                {previewLoading && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="pointer-events-none absolute inset-0 z-[5] flex animate-in flex-col items-center justify-center gap-3 bg-black/25 fade-in-0 duration-200"
                  >
                    <BrandLoader className="text-white/90 drop-shadow" />
                    <p className="px-6 text-center text-xs text-white/90 drop-shadow">正在加载中......</p>
                  </div>
                )}
                <button
                  type="button"
                  aria-label={previewPlaying ? "暂停" : "播放"}
                  onClick={() => {
                    const v = previewVideoRef.current;
                    if (!v) return;
                    if (v.paused || v.ended) void v.play().catch(() => {});
                    else v.pause();
                  }}
                  className={cn(
                    "absolute top-1/2 left-1/2 z-10 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full",
                    "border border-white/20 bg-black/55 text-white shadow-pop backdrop-blur-sm transition-opacity",
                    "hover:bg-black/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    previewPlaying && "opacity-0 group-hover/video:opacity-100 focus-visible:opacity-100",
                    // 加载中让位给点阵（业主 2026-10-23「暂停按钮和加载中动画重合了」）：
                    // 两者原本同心，56px 圆钮正好把三颗点连文案一起吞进去。加载态只该说一件事
                    // ——「在等」——所以这颗按钮在加载期间整个不挂出来；`hidden` 而不是 `opacity-0`，
                    // 否则 `group-hover:opacity-100` 会让它一 hover 又浮回来压住点阵。
                    // 代价：缓冲卡顿时点不了暂停（原生控件此刻也摘掉了，见 `controls` 那条），
                    // 换来的是「点了没反应」与「点了把加载当成卡死」两种误读都消失。
                    previewLoading && "hidden"
                  )}
                >
                  {previewPlaying ? (
                    <Pause className="size-6 fill-current" />
                  ) : (
                    <Play className="size-6 fill-current" />
                  )}
                </button>
              </>
            ) : previewEntry?.kind === "audio" ? (
              <div className="flex w-full max-w-sm flex-col items-center gap-4 px-6">
                <Music className="size-10 text-muted-foreground" />
                {/* 音频的原生控件同样带一枚下载按钮，按同一条口径关掉（全屏对音频本就不存在） */}
                <audio
                  src={previewSrc}
                  controls
                  controlsList="nodownload noremoteplayback noplaybackrate"
                  onCanPlay={() => setPreviewLoading(false)}
                  onError={() => {
                    setPreviewLoading(false);
                    setPreviewFailed(true);
                  }}
                  className="w-full"
                />
              </div>
            ) : (
              <p className="px-6 text-center text-xs text-muted-foreground">该类型不支持预览。</p>
            )}
          </div>

          {/* 底栏：文件名 + 序号，固定高度（文件名可截断，悬停看全名） */}
          <div className="flex h-9 items-center gap-3">
            <TruncatedTooltip label={previewEntry?.filename ?? ""}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {previewEntry?.filename ?? ""}
              </span>
            </TruncatedTooltip>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {previewSeqIdx >= 0 ? `${previewSeqIdx + 1} / ${previewItems.length}` : "1 / 1"}
            </span>
          </div>

          {/* 翻页按钮沉到舞台两侧留白里（不压视频 controls）；只有一条资源时不摆 */}
          {previewSeqIdx >= 0 && previewItems.length > 1 && (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="上一个"
                disabled={previewSeqIdx <= 0}
                onClick={() => stepPreview(-1)}
                className="absolute top-1/2 left-1 z-10 -translate-y-1/2 rounded-full bg-card/90 shadow-pop backdrop-blur-sm"
              >
                <ArrowLeft />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="下一个"
                disabled={previewSeqIdx >= previewItems.length - 1}
                onClick={() => stepPreview(1)}
                className="absolute top-1/2 right-1 z-10 -translate-y-1/2 rounded-full bg-card/90 shadow-pop backdrop-blur-sm"
              >
                <ArrowRight />
              </Button>
            </>
          )}

        </DialogContent>
      </Dialog>

      {/* 作者卡片：与历史页共用 `components/AuthorCard`；非模态 + 轻遮罩，
          点卡片外只收这一层（与历史页「呼出不做背景遮罩」同一条口径） */}
      <Dialog open={authorCardOpen} onOpenChange={setAuthorCardOpen} modal={false}>
        <DialogContent
          showOverlay="light"
          aria-describedby={undefined}
          className={cn("max-w-sm", dialogSlideMotion)}
        >
          <DialogHeader>
            <DialogTitle>作者卡片</DialogTitle>
          </DialogHeader>
          <AuthorCard
            author={author}
            platform={result.platform}
            platformName={displayName(result.platform)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** stat / 频道 / 抖音微博等平台各异计数 → 统一「图标 + 数值」行。
 *
 *  只返回作品级统计（点赞/播放/评论/分享/收藏等），不包含作者相关数据。 */
function buildStatItems(
  data?: ParseData
): Array<{ key: string; label: string; icon: React.ReactElement; value: string }> {
  const STAT_ICON_MAP: Record<string, React.ReactElement> = {
    view: <CircleFadingPlay className="size-3.5" />,
    danmaku: <MessageCircleText className="size-3.5" />,
    like: <Heart className="size-3.5" />,
    retweet: <Share2 className="size-3.5" />,
    reply: <MessageCircle className="size-3.5" />,
    favorite: <StarCheck className="size-3.5" />,
    coin: <CircleEuro className="size-3.5" />,
    share: <Share2 className="size-3.5" />,
  };
  return workStatItems(pickWorkStat(data)).map((s) => ({
    key: s.key,
    label: s.label,
    icon: STAT_ICON_MAP[s.key] ?? <span className="size-3.5 inline-block" />,
    value: fmtCount(s.value),
  }));
}

/**
 * 结果来源徽标：报「实际解出这条结果的引擎名」（mediaget / amagi / yt-dlp），
 * 不再是笼统的「本地内核」——用户在设置里能挑主引擎，结果卡就得如实对账是谁解的。
 *
 * - `viaEngine` 缺省（旧快照 / mock 兜底）时退回「本地内核」这个总称，不猜引擎；
 * - `via === "mock"` 永远说「mock 骨架」：演示数据不许冒充某个真引擎的产物。
 */
function ViaBadge({
  via,
  engine,
}: {
  via: "local" | "mock";
  engine?: EngineId;
}): React.ReactElement {
  if (via === "mock") return <Badge variant="secondary">mock 骨架</Badge>;
  const id = asSwitchableEngine(engine);
  return <Badge variant="ok">{id ? ENGINE_INFO[id].label : "本地内核"}</Badge>;
}

/**
 * 媒体时长（秒）→ 02:59 / 1:02:59。
 *
 * 与 `fmtDuration` 分开：那个报的是「耗时 ms」（解析用了多久），这里是「片子多长」，
 * 单位与量级都不一样，共用一把尺会把 3 分钟的视频写成 180000 ms。
 */
function fmtMediaDuration(seconds: number): string {
  const total = Math.round(seconds);
  const p = (n: number): string => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
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
  via,
  engine,
  durationMs,
  onRetry,
  onOpenSource,
  onConfigureCookie,
}: {
  msg: string;
  failType?: string;
  platformName: string;
  via: "local" | "mock";
  /** 交出这条失败答复的引擎（失败也要说清是哪个引擎答的） */
  engine?: EngineId;
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
          <ViaBadge via={via} engine={engine} />
          <span className="text-xs tabular-nums text-muted-foreground">{fmtDuration(durationMs)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

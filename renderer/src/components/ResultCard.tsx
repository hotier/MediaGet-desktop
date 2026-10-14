/**
 * 结果卡：媒体信息 + 「下载」直达（点下载 = IPC 入队主进程流式落盘，
 * 直链本身不呈现给用户点选 —— README「直链时效」决策）。
 *
 * P4 补全（docs/UIUX-DESIGN §2.1）：全部消费契约里已有、此前渲染层漏读的字段 ——
 * qualities / videos[].qualities、images 网格、stat/avatar/music/creator 元数据、
 * embedOnly、fallbackReason 折叠、缓存命中、失败重试、直链 5 分钟时效。零 IPC 变更。
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/bridge";
import type { AppMeta, DownloadItem, ParsedVideoQuality, ParseRunOutcome } from "../../../types/ipc";
import { PlatformIcon } from "./PlatformIcon";

/** 直链时效：超过 5 分钟内核给的直链大概率已过期（README「分钟级」） */
const LINK_TTL_MS = 5 * 60 * 1000;

interface QualityOption {
  label: string;
  /** qualities[].url；null = 用内核给的主 data.url */
  url: string | null;
  /** 文件名后缀（'' = 不加） */
  suffix: string;
  /** 音频项：并入单项下载而非替代主视频 */
  audio?: boolean;
}

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
  /** 失败态 [重试]：由页面重新发起解析 */
  onRetry?: () => void;
}): React.ReactElement {
  const { result, via, fallbackReason, durationMs } = outcome;
  const data = result.data;
  const [queued, setQueued] = useState(false);
  const [err, setErr] = useState("");
  const [qualityIdx, setQualityIdx] = useState(0);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);

  // 解析成功后 15s 心跳计龄，超 TTL 按钮改为「重新解析并下载」
  const [resultAge, setResultAge] = useState(0);
  useEffect(() => {
    if (result.code !== 200) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setResultAge(Date.now() - startedAt), 15_000);
    return () => clearInterval(timer);
  }, [outcome]);
  const linkAged = resultAge >= LINK_TTL_MS;

  const platformName = useMemo(() => {
    if (!result.platform) return "";
    return meta?.platforms.find((p) => p.key === result.platform)?.name ?? result.platform;
  }, [meta, result.platform]);

  const qualityOptions = useMemo<QualityOption[]>(() => {
    const opts: QualityOption[] = (data?.qualities ?? []).map((q: ParsedVideoQuality) => ({
      label: q.label || `${q.quality}P`,
      url: q.url,
      suffix: `-${q.label || `${q.quality}P`}`,
    }));
    if (data?.url) opts.unshift({ label: data.qualityLabel || "默认", url: null, suffix: "" });
    if (data?.audioUrl) opts.push({ label: "仅音频", url: data.audioUrl, suffix: "", audio: true });
    return opts;
  }, [data]);

  const items = useMemo<DownloadItem[]>(() => {
    if (!data || result.code !== 200) return [];
    const list: DownloadItem[] = [];
    const title = data.title || data.desc || data.name || "media";
    const sel = qualityOptions[qualityIdx];
    // 主视频 / 音乐：按选中清晰度取直链（契约 qualities），无 qualities 时用主 url
    if (sel && !sel.audio) {
      const url = sel.url ?? data.url;
      if (url) list.push({ url, filename: `${title}${sel.suffix}.mp4`, kind: "video" });
    }
    if (data.audioUrl && (!sel || sel.audio)) {
      list.push({ url: data.audioUrl, filename: `${title}.mp3`, kind: "audio" });
    }
    // 多分P（bilibili 等）：按选中清晰度的 label 在同 label 项里取对应画质，取不到回落该 P 默认
    for (const [i, v] of (data.videos ?? []).entries()) {
      const byLabel = sel?.suffix && sel.url !== null
        ? v.qualities?.find((q) => (q.label || `${q.quality}P`) === sel.suffix.slice(1))
        : undefined;
      const url = byLabel?.url ?? v.url;
      if (url) list.push({ url, filename: `${title}-P${i + 1}.mp4`, kind: "video" });
    }
    // 图集（小红书/微博图文）：整组入队
    for (const [i, img] of (data.images ?? []).entries()) {
      if (img) list.push({ url: img, filename: `${title}-${i + 1}.jpg`, kind: "image" });
    }
    return list;
  }, [result, data, qualityOptions, qualityIdx]);

  // Ctrl+D = 下载全部（结果卡可见时，§3.4 L1）；Esc 关图片模态
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && previewIdx !== null) {
        setPreviewIdx(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "d") {
        if (items.length > 0 && !queued) {
          e.preventDefault();
          void downloadAll();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, queued, previewIdx]);

  if (result.code !== 200) {
    return (
      <div className="card">
        <div className="card-title">解析失败</div>
        <p>
          {result.msg}
          {result.failType && <span className="chip warn">{result.failType}</span>}
        </p>
        {fallbackReason && <p className="hint">回落原因：{fallbackReason}</p>}
        <div className="download-row">
          {onRetry && (
            <button onClick={onRetry}>重试</button>
          )}
          <ViaChip via={via} />
          <span>{fmtDuration(durationMs)}</span>
        </div>
      </div>
    );
  }

  async function downloadAll(): Promise<void> {
    setErr("");
    if (items.length === 0) {
      onQueued(0);
      return;
    }
    try {
      await api.download.enqueue({
        items,
        meta: {
          platform: result.platform,
          title: data?.title ?? data?.desc,
          sourceUrl,
        },
      });
      setQueued(true);
      onQueued(items.length);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }

  const images = (data?.images ?? []).filter(Boolean);
  const stats = buildStatItems(data);

  return (
    <div className="card result">
      <div className="result-head">
        {data?.cover && <img className="cover" src={data.cover} alt="" referrerPolicy="no-referrer" />}
        <div className="result-info">
          <div className="card-title">{data?.title || data?.desc || "（无标题）"}</div>
          <div className="meta-lines">
            {platformName && (
              <span className="chip chip-icon">
                <PlatformIcon platform={result.platform} />
                {platformName}
              </span>
            )}
            {data?.author && (
              <span className="author">
                {data.avatar && <img className="avatar" src={data.avatar} alt="" referrerPolicy="no-referrer" />}
                @{data.author}
              </span>
            )}
            {typeof data?.duration === "number" && data.duration > 0 && (
              <span>{Math.round((data.duration > 100000 ? data.duration / 1000 : data.duration))}s</span>
            )}
            {data?.type && <span className="chip">{data.type}</span>}
          </div>
          {stats.length > 0 && (
            <div className="meta-lines num">
              {stats.map((s) => (
                <span key={s.label}>
                  {s.label} {s.value}
                </span>
              ))}
              {data?.statsUnreliable && (
                <span className="chip warn" title="该平台统计接口不保证准确">⚠︎ 数据可能不准</span>
              )}
            </div>
          )}
          {(data?.music?.author || data?.core) && (
            <div className="hint">
              {data.music?.author && `♪ ${data.music.author}${data.music.title ? ` - ${data.music.title}` : ""}`}
              {data.core && (data.music?.author ? ` · 高潮片段 ${data.core}` : `高潮片段 ${data.core}`)}
            </div>
          )}
        </div>
      </div>

      {data?.desc && data.desc !== data.title && <p className="desc">{data.desc}</p>}

      {qualityOptions.length > 1 && (
        <div className="quality-select" role="radiogroup" aria-label="选择清晰度">
          {qualityOptions.map((q, i) => (
            <button
              key={`${q.label}-${i}`}
              className={`chip-btn${i === qualityIdx ? " on" : ""}`}
              role="radio"
              aria-checked={i === qualityIdx}
              onClick={() => setQualityIdx(i)}
              disabled={queued}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <ul className="img-grid">
          {images.slice(0, 8).map((src, i) => (
            <li key={i}>
              <button
                className="img-thumb"
                onClick={() => setPreviewIdx(i)}
                aria-label={`查看第 ${i + 1} 张图`}
              >
                <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
                {i === 7 && images.length > 8 && <span className="more">+{images.length - 8}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="download-row">
        {data?.embedOnly ? (
          <a className="primary-link" href={data.embedUrl ?? data.url ?? "#"} target="_blank" rel="noreferrer">
            ↗ 在浏览器中打开播放
          </a>
        ) : (
          <button className="primary" onClick={() => void downloadAll()} disabled={queued || items.length === 0}>
            {queued
              ? "已加入队列 ✓"
              : linkAged
                ? "重新解析并下载"
                : items.length > 1
                  ? `下载全部（${items.length}）`
                  : items.length === 1
                    ? "下载"
                    : "无可下载文件"}
          </button>
        )}
        {linkAged && !queued && <span className="hint">直链可能已过期，重新解析后再下载</span>}
        {!data?.embedOnly && data?.embedUrl && !data.url && !data.videos?.length && (
          <a className="linkish" href={data.embedUrl} target="_blank" rel="noreferrer">
            ↗ 官方播放页
          </a>
        )}
      </div>
      {err && <div className="banner error">{err}</div>}

      <div className="via-line">
        <ViaChip via={via} />
        <span>{fmtDuration(durationMs)}</span>
        {via === "local" && durationMs < 50 && <span className="chip">缓存命中</span>}
        {fallbackReason && (
          <span className="expand">
            <button className="linkish" onClick={() => setReasonOpen((v) => !v)}>
              {reasonOpen ? "收起" : "为什么走了线上？"}
            </button>
            {reasonOpen && <span className="hint">{fallbackReason}</span>}
          </span>
        )}
      </div>

      {previewIdx !== null && images[previewIdx] && (
        <div
          className="img-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`图片预览 ${previewIdx + 1}/${images.length}`}
          onClick={() => setPreviewIdx(null)}
        >
          <img
            className="img-full"
            src={images[previewIdx]}
            alt=""
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="img-modal-bar" onClick={(e) => e.stopPropagation()}>
            <span className="hint">
              {previewIdx + 1} / {images.length}
            </span>
            <div className="ops">
              {previewIdx > 0 && <button onClick={() => setPreviewIdx(previewIdx - 1)}>上一张</button>}
              {previewIdx < images.length - 1 && (
                <button onClick={() => setPreviewIdx(previewIdx + 1)}>下一张</button>
              )}
              <button onClick={() => setPreviewIdx(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
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

function fmtCount(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return n.toLocaleString("zh-CN");
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

function ViaChip({ via }: { via: "local" | "online" | "mock" }): React.ReactElement {
  const label = via === "local" ? "本地内核" : via === "online" ? "线上回落" : "mock 骨架";
  return <span className={`chip ${via === "local" ? "ok" : via === "online" ? "warn" : ""}`}>{label}</span>;
}

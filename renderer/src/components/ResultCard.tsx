/**
 * 结果卡：媒体信息 + 「下载」直达（点下载 = IPC 入队主进程流式落盘，
 * 直链本身不呈现给用户点选 —— README「直链时效」决策）。
 */
import { useMemo, useState } from "react";
import { api } from "../lib/bridge";
import type { DownloadItem, ParseRunOutcome } from "../../../types/ipc";

export function ResultCard({
  outcome,
  onQueued,
}: {
  outcome: ParseRunOutcome;
  onQueued: (count: number) => void;
}): React.ReactElement {
  const { result, via, fallbackReason, durationMs } = outcome;
  const data = result.data;
  const [queued, setQueued] = useState(false);
  const [err, setErr] = useState("");

  const items = useMemo<DownloadItem[]>(() => {
    if (!data || result.code !== 200) return [];
    const list: DownloadItem[] = [];
    const title = data.title || data.desc || data.name || "media";
    // 主视频 / 音频
    if (data.url) {
      list.push({ url: data.url, filename: `${title}.mp4`, kind: "video" });
    }
    if (data.audioUrl) {
      list.push({ url: data.audioUrl, filename: `${title}.mp3`, kind: "audio" });
    }
    // 多分P（bilibili 等）
    for (const [i, v] of (data.videos ?? []).entries()) {
      if (v.url) list.push({ url: v.url, filename: `${title}-P${i + 1}.mp4`, kind: "video" });
    }
    // 图集（小红书/微博图文）：整组入队
    for (const [i, img] of (data.images ?? []).entries()) {
      if (img) list.push({ url: img, filename: `${title}-${i + 1}.jpg`, kind: "image" });
    }
    return list;
  }, [result, data]);

  if (result.code !== 200) {
    return (
      <div className="card">
        <div className="card-title">解析失败</div>
        <p>
          {result.msg}
          {result.failType && <span className="chip warn">{result.failType}</span>}
        </p>
        {fallbackReason && <p className="hint">回落原因：{fallbackReason}</p>}
        <ViaLine via={via} ms={durationMs} />
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
        },
      });
      setQueued(true);
      onQueued(items.length);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <div className="card result">
      <div className="result-head">
        {data?.cover && <img className="cover" src={data.cover} alt="" referrerPolicy="no-referrer" />}
        <div className="result-info">
          <div className="card-title">{data?.title || data?.desc || "（无标题）"}</div>
          <div className="meta-lines">
            {result.platform && <span className="chip">{result.platform}</span>}
            {data?.author && <span>@{data.author}</span>}
            {typeof data?.duration === "number" && data.duration > 0 && (
              <span>{Math.round((data.duration > 100000 ? data.duration / 1000 : data.duration))}s</span>
            )}
            {data?.qualityLabel && <span className="chip">{data.qualityLabel}</span>}
            {data?.type && <span className="chip">{data.type}</span>}
          </div>
        </div>
      </div>

      {data?.desc && data.desc !== data.title && (
        <p className="desc">{data.desc}</p>
      )}

      <div className="download-row">
        <button className="primary" onClick={() => void downloadAll()} disabled={queued || items.length === 0}>
          {queued
            ? "已加入队列 ✓"
            : items.length > 1
              ? `下载全部（${items.length}）`
              : items.length === 1
                ? "下载"
                : "无可下载文件"}
        </button>
        {data?.embedUrl && (
          <span className="hint">该平台仅支持官方嵌入播放（无直链）</span>
        )}
      </div>
      {err && <div className="banner error">{err}</div>}
      <ViaLine via={via} ms={durationMs} reason={fallbackReason} />
    </div>
  );
}

function ViaLine({ via, ms, reason }: { via: string; ms: number; reason?: string }): React.ReactElement {
  const label =
    via === "local" ? "本地内核" : via === "online" ? "线上回落" : "mock 骨架";
  return (
    <div className="via-line">
      <span className={`chip ${via === "local" ? "ok" : via === "online" ? "warn" : ""}`}>{label}</span>
      <span>{ms} ms</span>
      {reason && <span className="hint">{reason}</span>}
    </div>
  );
}

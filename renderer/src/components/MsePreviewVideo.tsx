/**
 * MSE 预览播放器（2026-10-23 业主定调：凡是 dash 流都要边缓存边播）。
 *
 * 双轨 DASH 的预览由这里接管：两条轨道各开一个 `SourceBuffer`，边拉边 append，
 * 首帧不再等「整段 ffmpeg 合流」。任何一步不成立（codec 不支持、init 段没来、
 * 拉流失败、20s 没出画面）都交给 `onFallback`，由结果卡换回既有的合流 `<video>`
 * 路径——预览可以慢一点，但不能黑屏。
 *
 * 拖动：既有的顺序流没有回溯能力，首屏拉流时顺手解析 `sidx` 建「媒体秒 → 分片首字节」
 * 索引；越界 seek 中断当前取流，按 Range 从目标分片重开一条顺序流。上游不给 206 时
 * 交回合流路径，不拿一条永远追不上的流硬撑。
 */
import { useEffect, useRef } from "react";
import { buildPreviewLink } from "../../../shared/preview-link";
import {
  concatBoxes,
  Fmp4Parser,
  locateSegment,
  parseSidx,
  type SegmentIndex,
} from "../lib/fmp4";

export interface MsePreviewVideoProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** 上游直链（不是 mgpreview 链，组件内部建链） */
  videoUrl: string;
  audioUrl: string;
  platform?: string;
  /** 由 `mseTrackMime()` 拼好的两条 SourceBuffer MIME */
  videoMime: string;
  audioMime: string;
  durationMs?: number;
  className?: string;
  /**
   * 是否挂原生控件。加载中由调用方关掉：Chromium 的缓冲指示长在控件 shadow DOM 里
   * （`-internal-media-controls-loading-panel`），CSS/JS 都碰不到它，只能靠「没有控件」
   * 让它根本不出现（业主 2026-10-23「禁用原生的加载转圈」）。
   */
  showControls?: boolean;
  /** 任何一步失败：调用方切回合流 <video> */
  onFallback: () => void;
  onLoadStart?: () => void;
  onCanPlay?: () => void;
  onWaiting?: () => void;
  onStalled?: () => void;
  onPlaying?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
}

interface Chunk {
  bytes: Uint8Array;
  init: boolean;
}

interface Track {
  kind: "video" | "audio";
  sb: SourceBuffer;
  queue: Chunk[];
  waiters: (() => void)[];
  busy: boolean;
  done: boolean;
  ended: boolean;
  /** 已 append 的媒体分片数（init 不算） */
  appended: number;
  /** 最近一个媒体分片覆盖的媒体秒数；音轨闸门按它自适应 */
  span: number;
  /** 本次 append 前的缓冲末端，用来量 span */
  measureFrom: number;
  measuring: boolean;
  /** init 段已 append：续拉时不再解析 init */
  initSent: boolean;
  /** 首个 sidx 解析出的字节索引；没有就维持顺序追赶，拖远只能等 */
  index: SegmentIndex | null;
  /** 当前下载会话覆盖的起点（秒）；回拖判断「续流能否接上」 */
  sessionStart: number;
  /** 每次取流递增：被 seek 中断的旧会话迟到数据一律丢弃 */
  generation: number;
  /** 正在进行的取流；seek 重拉时按轨中断 */
  controller: AbortController | null;
  /** SourceBuffer 空闲后要续拉的字节位置 */
  pendingByte: number | null;
  /** 续拉前先清掉这个时间点之后的缓冲，防止与旧会话重叠 */
  pendingClearFrom: number | null;
}

/** 队列超过这个条数就暂停读网络，别把整条轨道攒进内存 */
const MAX_QUEUED_CHUNKS = 4;
/** 多久没出画面就判定失败并回退（秒级；不是网络总超时） */
const FIRST_FRAME_TIMEOUT_MS = 20_000;
/**
 * 最多领先播放位置多少秒去拉流。
 *
 * 不设上限时，CDN 快、播放器慢，几秒钟就能把 SourceBuffer 灌到 Chromium 的配额；
 * 而兜底淘汰只能删「播放位置之前」的缓冲，刚开播时无物可删（2026-10-23 实测：
 * 5 小时视频 6 秒内 quota 溢出 → 回退合流）。按秒数限流比按分片数可靠。
 */
const MAX_AHEAD_SECONDS = 60;

const bufferedEndOf = (sb: SourceBuffer): number =>
  sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;

export function MsePreviewVideo(props: MsePreviewVideoProps) {
  const {
    videoRef,
    videoUrl,
    audioUrl,
    platform,
    videoMime,
    audioMime,
    durationMs,
    className,
    showControls = true,
    onLoadStart,
    onCanPlay,
    onWaiting,
    onStalled,
    onPlaying,
    onPlay,
    onPause,
    onEnded,
  } = props;
  /** 回调不进 effect 依赖：父组件每次渲染都会给新的函数身份，重跑会把播放打断 */
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let dead = false;
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const tracks: Track[] = [];
    let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
    let seekTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = (reason: string): void => {
      if (dead) return;
      dead = true;
      // 诊断用：回退本身是设计内行为，但失败原因决定下一档该不该再试 MSE
      console.warn("[mse] fallback:", reason);
      cleanup();
      callbacks.current.onFallback();
    };

    const resolveWaiters = (track: Track): void => {
      if (track.queue.length > MAX_QUEUED_CHUNKS) return;
      for (const wake of track.waiters.splice(0)) wake();
    };

    /**
     * 音轨不许抢跑。声音只有几十 kb/s，放开拉会在几秒内囤到读前上限，而视频轨
     * 常被 CDN 卡在 1x 上下；媒体时钟靠音频继续走，画面却没有数据——表现就是
     * 「画面在缓冲，进度条数字还在涨」（2026-10-23 实测：音频领先 85s，每个
     * 视频分片交界处时钟越界 2.8s 才 waiting）。
     *
     * 闸门按「上一个音频分片的时长」留余量，保证 append 之后音频末端不超过视频
     * 末端；分片时长实测 5.02s，不写死。视频轨自己不受限。
     */
    const canAppend = (track: Track): boolean => {
      if (track.kind === "video") return true;
      if (track.queue[0]?.init) return true;
      const video = tracks.find((t) => t.kind === "video");
      if (!video || video.appended < 1) return false;
      return bufferedEndOf(video.sb) - bufferedEndOf(track.sb) >= track.span - 0.25;
    };

    const pump = (track: Track): void => {
      if (dead || mediaSource.readyState !== "open" || track.busy || track.sb.updating) return;
      const next = track.queue[0];
      if (!next) {
        if (track.done && !track.ended) {
          track.ended = true;
          if (tracks.length === 2 && tracks.every((t) => t.ended) && mediaSource.readyState === "open") {
            try {
              mediaSource.endOfStream();
            } catch {
              /* 已经结束/关闭：没有可收尾的 */
            }
          }
        }
        return;
      }
      if (!canAppend(track)) return;
      track.busy = true;
      track.measureFrom = bufferedEndOf(track.sb);
      track.measuring = !next.init;
      try {
        track.sb.appendBuffer(next.bytes as BufferSource);
        track.queue.shift();
      } catch (err) {
        track.busy = false;
        track.measuring = false;
        // 缓冲满了：丢掉播放位置之前的一段，再重试当前分片；其它错误直接回退
        if ((err as DOMException)?.name === "QuotaExceededError") evict(track);
        else fail(`append:${(err as DOMException)?.name ?? String(err)}`);
        return;
      }
      resolveWaiters(track);
    };

    const evict = (track: Track): void => {
      const current = video.currentTime;
      if (!track.sb.buffered.length) {
        fail("evict:empty");
        return;
      }
      const start = track.sb.buffered.start(0);
      const end = Math.min(track.sb.buffered.end(0), Math.max(0, current - 30));
      if (end - start <= 1) {
        fail("evict:small");
        return;
      }
      try {
        track.sb.remove(start, end);
      } catch {
        fail("evict:remove");
      }
    };

    /** 已缓冲到的媒体时间相对播放位置的领先量（秒） */
    const readAhead = (track: Track): number => {
      const b = track.sb.buffered;
      return b.length ? b.end(b.length - 1) - video.currentTime : 0;
    };

    /** 追上播放位置前不再读网络：timeupdate 推进后自动放行，兜底 1s 轮询 */
    const waitAheadRoom = async (track: Track): Promise<void> => {
      while (!dead && readAhead(track) > MAX_AHEAD_SECONDS) {
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            video.removeEventListener("timeupdate", wake);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(wake, 1000);
          video.addEventListener("timeupdate", wake);
        });
      }
    };

    const queuedRoom = (track: Track): Promise<void> => {
      if (track.queue.length <= MAX_QUEUED_CHUNKS) return Promise.resolve();
      return new Promise<void>((resolve) => track.waiters.push(resolve));
    };

    /**
     * 从 `fromByte` 开始顺序拉一条轨。
     *
     * `fromByte > 0` 只会由越界 seek 触发：那时 init 已经在 SourceBuffer 里，直接从
     * sidx 指出的分片边界续 append。媒体时间从目标处重新开始，缓冲区中间留出空洞是
     * 正常形态——播放器只取播放位置那一段，不会去读空洞。
     */
    const pull = async (track: Track, fromByte = 0): Promise<void> => {
      const link = buildPreviewLink(track.kind === "video" ? videoUrl : audioUrl, platform);
      if (!link) {
        fail("no-link");
        return;
      }
      const generation = (track.generation += 1);
      const controller = new AbortController();
      track.controller = controller;
      const stale = (): boolean => dead || track.generation !== generation;
      try {
        const response = await fetch(link, {
          signal: controller.signal,
          headers: fromByte > 0 ? { Range: `bytes=${fromByte}-` } : undefined,
        });
        if (stale()) return;
        if (!response.ok || !response.body) {
          fail(`http:${response.status}`);
          return;
        }
        // 续拉必须真拿到 206：中间层无视 Range 回整段时，顺序读永远追不到目标位置，
        // 与其让用户对着转圈等，不如交回合流路径（它对本地文件走真 Range）
        if (fromByte > 0 && response.status !== 206) {
          fail(`range-ignored:${response.status}`);
          return;
        }
        const reader = response.body.getReader();
        const parser = new Fmp4Parser();
        let initParts: Uint8Array[] = [];
        let fragment: Uint8Array[] | null = null;
        let streamOffset = fromByte;

        for (;;) {
          await waitAheadRoom(track);
          if (stale()) return;
          const { done, value } = await reader.read();
          if (stale()) return;
          if (done) break;
          for (const box of parser.push(value)) {
            const boxOffset = streamOffset;
            streamOffset += box.bytes.length;
            if (!track.initSent) {
              initParts.push(box.bytes);
              if (box.type === "moov") {
                track.queue.push({ bytes: concatBoxes(initParts), init: true });
                initParts = [];
                track.initSent = true;
                pump(track);
              }
              continue;
            }
            if (box.type === "sidx") {
              // 只有首次全量拉流会遇到；续拉从分片边界开始，sidx 不在请求区间里
              if (!track.index) {
                const index = parseSidx(box.bytes, boxOffset);
                if (index) {
                  track.index = index;
                  // sidx 到手前用户就可能已经拖远了：到手后补一次越界判定
                  scheduleSeekCheck();
                }
              }
              continue;
            }
            if (box.type === "moof") {
              fragment = [box.bytes];
            } else if (box.type === "mdat" && fragment) {
              track.queue.push({ bytes: concatBoxes([...fragment, box.bytes]), init: false });
              fragment = null;
              pump(track);
            }
            // styp/free/mfra：顺序 append 用不到，跳过
          }
          await queuedRoom(track);
          if (stale()) return;
        }
        if (stale()) return;
        if (!track.initSent) {
          fail("no-init");
          return;
        }
        track.done = true;
        pump(track);
      } catch (err) {
        if (!stale() && !controller.signal.aborted) {
          fail(`pull:${(err as DOMException)?.name ?? String(err)}:${(err as Error)?.message ?? ""}`);
        }
      }
    };

    /** SourceBuffer 同一时刻只能做一件事：remove 与 appendBuffer 必须排队 */
    const startPending = (track: Track): void => {
      if (dead || track.pendingByte == null) return;
      if (track.busy || track.sb.updating) return; // updateend 会再进这里
      const from = track.pendingByte;
      const clearFrom = track.pendingClearFrom;
      track.pendingByte = null;
      track.pendingClearFrom = null;
      if (clearFrom != null) {
        const end =
          Number.isFinite(mediaSource.duration) && mediaSource.duration > clearFrom
            ? mediaSource.duration
            : clearFrom + 3600;
        try {
          // 丢掉落点之后的旧缓冲：顺序续流会从这里往后重新 append，留着就撞时间戳
          track.sb.remove(clearFrom, end);
        } catch {
          /* buffer 已 detach：cleanup 会收尾 */
        }
      }
      void pull(track, from);
    };

    /**
     * 把一条轨切到目标时间所在的分片重拉。
     *
     * 中断旧会话而不是让它继续跑：旧队列里排的是另一段媒体，append 进来只会白占配额
     * 与带宽。`generation` 保证旧会话迟到的块不会再入队。
     */
    const restartTrack = (track: Track, time: number): void => {
      if (!track.index) return;
      const segment = locateSegment(track.index, time);
      if (!segment) return;
      // 已经在拉这一段（拖动中连续触发）就不重来，避免同一段反复请求
      if (Math.abs(track.sessionStart - segment.startTime) < 0.05) return;
      track.generation += 1;
      track.controller?.abort();
      track.controller = null;
      track.queue.length = 0;
      for (const wake of track.waiters.splice(0)) wake();
      track.done = false;
      track.ended = false;
      track.measuring = false;
      track.sessionStart = segment.startTime;
      track.pendingByte = segment.offset;
      track.pendingClearFrom = segment.startTime;
      startPending(track);
    };

    /**
     * seek 之后的续流判定。
     *
     * - 两轨都覆盖目标：不动，顺序流自己会追上；落点在会话起点之前的旧缓冲里时，从
     *   区间末端续拉把中间的空洞填上；
     * - 任一轨没覆盖目标：从目标所在分片重拉。**不能只看视频轨**——视频按 60s 预读
     *   常常拥有音频还没有的区间，只看视频会把「有画面没声音」判成已覆盖，两种轨都停在原地。
     */
    const applySeek = (): void => {
      if (dead || tracks.length < 2) return;
      const videoTrack = tracks.find((t) => t.kind === "video");
      const audioTrack = tracks.find((t) => t.kind === "audio");
      if (!videoTrack?.index || !audioTrack?.index) return;
      const target = video.currentTime;
      /** 目标所在缓冲区间的末端；不在任何区间里返回 -1 */
      const containingEnd = (sb: SourceBuffer): number => {
        const b = sb.buffered;
        for (let i = 0; i < b.length; i += 1) {
          if (target >= b.start(i) - 0.05 && target < b.end(i) - 0.25) return b.end(i);
        }
        return -1;
      };
      const videoEnd = containingEnd(videoTrack.sb);
      const sessionStart = videoTrack.sessionStart;
      let restartAt: number | null = null;
      if (videoEnd >= 0 && containingEnd(audioTrack.sb) >= 0) {
        if (videoEnd < sessionStart - 1) restartAt = videoEnd;
      } else {
        restartAt = target;
      }
      if (restartAt == null) return;
      restartTrack(videoTrack, restartAt);
      restartTrack(audioTrack, restartAt);
    };

    /** 拖动时 seeking 会连发：停稳 150ms 再决定从哪续拉 */
    const scheduleSeekCheck = (): void => {
      if (dead) return;
      if (seekTimer) clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = undefined;
        applySeek();
      }, 150);
    };

    const onVideoError = (): void => fail(`video-error:${video.error?.code ?? "?"}:${video.error?.message ?? ""}`);

    const onSourceOpen = (): void => {
      if (dead) return;
      let vMime = "";
      let aMime = "";
      try {
        vMime = videoMime;
        aMime = audioMime;
        if (!MediaSource.isTypeSupported(vMime) || !MediaSource.isTypeSupported(aMime)) {
          fail(`unsupported:${vMime}|${aMime}`);
          return;
        }
        // 时长先写进 MediaSource：进度条一开始就是对的，不必等最后一个分片
        if (durationMs && Number.isFinite(durationMs) && durationMs > 0) {
          mediaSource.duration = durationMs / 1000;
        }
        const videoSb = mediaSource.addSourceBuffer(vMime);
        const audioSb = mediaSource.addSourceBuffer(aMime);
        const videoTrack: Track = {
          kind: "video",
          sb: videoSb,
          queue: [],
          waiters: [],
          busy: false,
          done: false,
          ended: false,
          appended: 0,
          span: 0,
          measureFrom: 0,
          measuring: false,
          initSent: false,
          index: null,
          sessionStart: 0,
          generation: 0,
          controller: null,
          pendingByte: null,
          pendingClearFrom: null,
        };
        const audioTrack: Track = {
          kind: "audio",
          sb: audioSb,
          queue: [],
          waiters: [],
          busy: false,
          done: false,
          ended: false,
          appended: 0,
          span: 0,
          measureFrom: 0,
          measuring: false,
          initSent: false,
          index: null,
          sessionStart: 0,
          generation: 0,
          controller: null,
          pendingByte: null,
          pendingClearFrom: null,
        };
        tracks.push(videoTrack, audioTrack);
        for (const track of tracks) {
          track.sb.addEventListener("updateend", () => {
            track.busy = false;
            if (track.measuring) {
              const end = bufferedEndOf(track.sb);
              const b = track.sb.buffered;
              // 分片落在空洞里（seek 后续拉）时 measureFrom 是旧缓冲末端，量出来会是
              // 「空洞 + 一个分片」。按新区间起点量，否则闸门会要求一个永远达不到的领先量
              const rangeStart = b.length ? b.start(b.length - 1) : end;
              const span = rangeStart > track.measureFrom + 0.01 ? end - rangeStart : end - track.measureFrom;
              if (span > 0.25) track.span = span;
              track.appended += 1;
              track.measuring = false;
            }
            // 有 seek 在等：先把 remove + 续拉补上（它们也占用 SourceBuffer）
            startPending(track);
            // 闸门看的是另一条轨的进度：视频每落一段都要回头放行音频
            for (const other of tracks) pump(other);
            resolveWaiters(track);
          });
        }
        void pull(videoTrack);
        void pull(audioTrack);
      } catch (err) {
        fail(`sourceopen:${(err as DOMException)?.name ?? String(err)}`);
      }
    };

    const cleanup = (): void => {
      if (firstFrameTimer) clearTimeout(firstFrameTimer);
      if (seekTimer) clearTimeout(seekTimer);
      mediaSource.removeEventListener("sourceopen", onSourceOpen);
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("seeking", scheduleSeekCheck);
      for (const track of tracks) {
        track.controller?.abort();
        track.controller = null;
        for (const wake of track.waiters.splice(0)) wake();
      }
      try {
        video.pause();
      } catch {
        /* 已经卸载 */
      }
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        /* 元素已经不在文档里 */
      }
      URL.revokeObjectURL(objectUrl);
    };

    mediaSource.addEventListener("sourceopen", onSourceOpen);
    mediaSource.addEventListener("error", () => fail("media-source-error"));
    video.addEventListener("error", onVideoError);
    video.addEventListener("seeking", scheduleSeekCheck);
    // 首帧看门狗：合流路径最慢也就十几秒，20s 还没画面说明这条路走不通
    firstFrameTimer = setTimeout(() => {
      if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) fail("watchdog");
    }, FIRST_FRAME_TIMEOUT_MS);
    const clearWatchdog = (): void => {
      if (firstFrameTimer) clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
    };
    video.addEventListener("canplay", clearWatchdog);
    video.addEventListener("playing", clearWatchdog);

    video.src = objectUrl;
    video.load();

    return () => {
      dead = true;
      cleanup();
    };
    // 回调经 ref 读取，不进依赖；依赖只放会改变媒体数据源的东西
  }, [videoUrl, audioUrl, platform, videoMime, audioMime, durationMs, videoRef]);

  return (
    <video
      ref={videoRef}
      controls={showControls}
      controlsList="nodownload nofullscreen noremoteplayback noplaybackrate"
      disablePictureInPicture
      disableRemotePlayback
      playsInline
      autoPlay
      preload="auto"
      onLoadStart={onLoadStart}
      onCanPlay={onCanPlay}
      onWaiting={onWaiting}
      onStalled={onStalled}
      onPlaying={onPlaying}
      onPlay={onPlay}
      onPause={onPause}
      onEnded={onEnded}
      className={className}
    />
  );
}

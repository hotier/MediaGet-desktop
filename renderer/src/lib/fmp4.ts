/**
 * 双轨 DASH 预览的 MSE 底座（2026-10-23）。
 *
 * 只做两件纯事：把一路 fMP4 字节流切成「init / media 分片」，以及从计划项拼出
 * `SourceBuffer` 需要的 MIME。播放器本身在 `components/MsePreviewVideo.tsx`——
 * 这里不碰 DOM，才能用 Node 单测把分片边界钉死。
 *
 * 为什么不在服务端合流后流式喂 `<video>`：普通 MP4 的 moov 必须整段定稿，
 * 双轨还得由播放器层拼；MSE 两个 SourceBuffer 才能做到「拉一段、播一段」。
 */

export type MseTrackMime = { video: string; audio: string };

/** 计划项里与 MSE 相关的字段（只取所需，下载计划与测试都能直接传） */
export interface MseEntryMeta {
  audioUrl?: string;
  videoCodecs?: string;
  videoMimeType?: string;
  audioCodecs?: string;
  audioMimeType?: string;
}

function withCodecs(mime: string, codecs: string): string {
  // 上游偶尔把 codecs 一起写进 mimeType；已有就不重复拼
  return /\bcodecs\s*=/i.test(mime) ? mime : `${mime}; codecs="${codecs}"`;
}

/**
 * 双轨项 → 两条 SourceBuffer MIME；缺任一项都不算可播：
 * 单文件（渐进式）走 `<video>` 直读，缺 codec 的双轨项回退主进程合流。
 */
export function mseTrackMime(entry: MseEntryMeta): MseTrackMime | null {
  const { audioUrl, videoCodecs, videoMimeType, audioCodecs, audioMimeType } = entry;
  if (!audioUrl || !videoCodecs || !videoMimeType || !audioCodecs || !audioMimeType) return null;
  const video = withCodecs(videoMimeType, videoCodecs);
  const audio = withCodecs(audioMimeType, audioCodecs);
  // 只认 mp4 / webm 容器；其它（flv、ts…）交给 ffmpeg
  if (!/^(video|audio)\/(mp4|webm)\b/i.test(videoMimeType)) return null;
  if (!/^(video|audio)\/(mp4|webm)\b/i.test(audioMimeType)) return null;
  return { video, audio };
}

export interface Fmp4Box {
  type: string;
  /** 含 8/16 字节头的完整盒 */
  bytes: Uint8Array;
}

const BOX_HEADER = 8;

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readU64(bytes: Uint8Array, offset: number): number {
  return readU32(bytes, offset) * 2 ** 32 + readU32(bytes, offset + 4);
}

function readType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * 顶层盒切分器：`push()` 吃任意大小的网络块（分片边界与盒边界无关），
 * 吐出的每个 `bytes` 都是一个完整顶层盒。
 *
 * 只处理 fMP4 的常见形状：`size=0`（延伸到文件尾）是旧式单文件 MP4 的收尾写法，
 * DASH 分片用不到，直接判坏让预览回退，别拿半截 mdat 去喂 MSE。
 */
export class Fmp4Parser {
  private buf = new Uint8Array(0);
  private start = 0;
  private end = 0;

  push(chunk: Uint8Array): Fmp4Box[] {
    if (chunk.length > 0) {
      this.reserve(chunk.length);
      this.buf.set(chunk, this.end);
      this.end += chunk.length;
    }
    const out: Fmp4Box[] = [];
    for (;;) {
      const available = this.end - this.start;
      if (available < BOX_HEADER) break;
      let size = readU32(this.buf, this.start);
      const type = readType(this.buf, this.start + 4);
      let headerSize = BOX_HEADER;
      if (size === 1) {
        if (available < 16) break;
        size = readU64(this.buf, this.start + 8);
        headerSize = 16;
      }
      if (size === 0) throw new Error(`fMP4 box ${type} uses size=0`);
      if (!Number.isSafeInteger(size) || size < headerSize) throw new Error(`invalid fMP4 box ${type}`);
      if (available < size) break;
      out.push({ type, bytes: this.buf.slice(this.start, this.start + size) });
      this.start += size;
    }
    return out;
  }

  /** 还没拼成完整盒的字节数（诊断用） */
  get pendingBytes(): number {
    return this.end - this.start;
  }

  private reserve(extra: number): void {
    if (this.end + extra <= this.buf.length) return;
    const live = this.end - this.start;
    if (live + extra <= this.buf.length) {
      this.buf.copyWithin(0, this.start, this.end);
    } else {
      const next = new Uint8Array(Math.max(64 * 1024, (live + extra) * 2));
      next.set(this.buf.subarray(this.start, this.end));
      this.buf = next;
    }
    this.start = 0;
    this.end = live;
  }
}

export interface SidxReference {
  /** 子段字节长度 */
  size: number;
  /** 子段时长（timescale 单位） */
  duration: number;
}

/** `sidx`：分片的媒体时间与字节位置一一对应，拖着进度条跳段全靠它 */
export interface SegmentIndex {
  timescale: number;
  /** 首个子段的呈现时间（timescale 单位） */
  earliestTime: number;
  /** 首个子段首字节在整条文件中的偏移 */
  mediaStart: number;
  references: SidxReference[];
}

/**
 * 解析 `sidx`（Segment Index Box）。
 *
 * 只认 v0/v1 两种标准形状。`reference_type=1` 的层级索引（指向别的 sidx）不展开——
 * 单文件 DASH 分片索引都是叶子引用，碰上层级索引就当作「没有索引」，维持顺序拉取。
 *
 * `boxOffset` 是这个盒在整条文件里的起始偏移：按规范子段起点是「盒尾 + first_offset」，
 * 没有这个基准只能算出流内相对位置，拿去发 Range 就会错位。
 */
export function parseSidx(bytes: Uint8Array, boxOffset = 0): SegmentIndex | null {
  if (bytes.length < BOX_HEADER + 4 || readType(bytes, 4) !== "sidx") return null;
  const declared = readU32(bytes, 0);
  const headerSize = declared === 1 ? 16 : BOX_HEADER;
  if (declared === 1 && bytes.length < 16) return null;
  const end = declared === 1 ? readU64(bytes, 8) : declared;
  if (end > bytes.length) return null;
  const version = bytes[headerSize];
  if (version !== 0 && version !== 1) return null;

  const base = headerSize + 4; // reference_ID 起点
  const timescale = readU32(bytes, base + 4);
  if (timescale <= 0) return null;
  const earliestTime = version === 0 ? readU32(bytes, base + 8) : readU64(bytes, base + 8);
  const firstOffset = version === 0 ? readU32(bytes, base + 12) : readU64(bytes, base + 16);
  const countAt = base + (version === 0 ? 18 : 26);
  if (countAt + 2 > end) return null;
  const count = (bytes[countAt] << 8) | bytes[countAt + 1];
  const refsAt = countAt + 2;
  // count=0 说明这条轨没有分段索引；截断的 sidx 也不拿来硬算偏移
  if (count === 0 || refsAt + count * 12 > end) return null;

  const references: SidxReference[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = refsAt + i * 12;
    const size = readU32(bytes, at) & 0x7fffffff;
    const duration = readU32(bytes, at + 4);
    if (size === 0) return null;
    references.push({ size, duration });
  }
  return { timescale, earliestTime, mediaStart: boxOffset + end + firstOffset, references };
}

export interface SegmentSeek {
  /** 子段首字节在整条文件中的偏移 */
  offset: number;
  /** 该子段的呈现起点（秒） */
  startTime: number;
  /** 该子段的时长（秒） */
  duration: number;
}

/**
 * 目标播放时间 → 该从哪个子段开始拉。
 *
 * 超过最后一个子段时夹回末段：拖到接近片尾时问的是「最后一段在哪」，不是文件外的偏移。
 */
export function locateSegment(index: SegmentIndex, timeSeconds: number): SegmentSeek | null {
  const { references, timescale } = index;
  if (!references.length || timescale <= 0) return null;
  const target = Number.isFinite(timeSeconds) && timeSeconds > 0 ? timeSeconds : 0;
  let offset = index.mediaStart;
  let start = index.earliestTime / timescale;
  for (const ref of references) {
    const duration = ref.duration / timescale;
    if (target < start + duration) return { offset, startTime: start, duration };
    offset += ref.size;
    start += duration;
  }
  const last = references[references.length - 1];
  return {
    offset: offset - last.size,
    startTime: start - last.duration / timescale,
    duration: last.duration / timescale,
  };
}

/** 把 init 的若干盒（ftyp/free/moov…）拼成一次 append 的载荷 */
export function concatBoxes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

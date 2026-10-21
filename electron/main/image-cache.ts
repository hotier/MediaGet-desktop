/**
 * 预览代理的图片内存缓存（2026-10-21：作者头像切页重载）。
 *
 * 为什么要它：头像走的是 `mgpreview://` 自定义 scheme，而 Chromium 的磁盘 HTTP 缓存
 * 只服务 http/https（`HttpCache` 由 `URLRequestHttpJob` 承担），自定义 scheme 的响应进不去；
 * 页面容器的 `key={page}` 又让每次切页都重建整棵子树，`<img>` 全是新节点。两头一叠，
 * 同一个头像就会被反复请回主进程、再打到上游图床——图床自己给的 `max-age=31536000` 白给。
 *
 * 只缓存小图：视频/音频有 Range 请求，语义完全不同（拖动进度条要的是区间，不是整段），
 * 在 `preview-protocol` 那一侧按「无 Range + 响应是 image/*」两条闸拦在外面。
 *
 * 隐私：**键是直链的哈希**，条目只在进程内存里，不落盘、不进日志——与 `link-identity.ts`
 * 同一条红线（直链只活在内存里过一遍）。
 */
import { createHash } from "node:crypto";

/** 单条上限：头像/缩略图都在这个量级，超了就不是「小图」了（上限外的直接不缓存） */
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
/** 总预算：按 24 条 2MB 或几百张头像算都够，且不至于把主进程堆内存吃出问题 */
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 400;
/** 与解析结果缓存、合流产物同一条 TTL（24h）——本机加速层，过期丢掉没有任何正确性代价 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ImageCacheEntry {
  body: Buffer;
  contentType: string;
  /** 上游给的缓存语义，命中时原样回给渲染层（没有就不发这个头） */
  cacheControl?: string;
}

export interface ImageCacheOptions {
  maxBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  /** 时间源（测试注入，避免用真等待验 TTL） */
  now?: () => number;
}

export interface ImageCache {
  get(key: string): ImageCacheEntry | undefined;
  /** 超过单条上限/总预算的图**不写入**，也不抛错——缓存是加速层，不能反过来制造失败 */
  set(key: string, body: Buffer, contentType: string, cacheControl?: string): void;
  clear(): void;
  /** 单条上限：调用方据此在**读体之前**决定要不要攒进内存（超了照旧流式转发） */
  readonly maxEntryBytes: number;
  readonly bytes: number;
  readonly size: number;
}

/** 直链 → 缓存键：定长哈希，条目结构里不留直链原文 */
export function imageCacheKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

interface Stored {
  body: Buffer;
  contentType: string;
  cacheControl?: string;
  expiresAt: number;
}

export function createImageCache(options: ImageCacheOptions = {}): ImageCache {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  /** Map 的插入顺序就是 LRU 顺序：读到就删了重插，淘汰永远从最前面拿 */
  const map = new Map<string, Stored>();
  let bytes = 0;

  function drop(key: string): void {
    const entry = map.get(key);
    if (!entry) return;
    bytes -= entry.body.length;
    map.delete(key);
  }

  /** 只清过期项。不这么做的话，长期只读少数几个键的会话里过期条目会一直占着预算 */
  function sweep(): void {
    const t = now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= t) drop(key);
    }
  }

  return {
    get(key: string) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        drop(key);
        return undefined;
      }
      // 命中也算一次使用：删了重插把它挪到队尾
      map.delete(key);
      map.set(key, entry);
      return { body: entry.body, contentType: entry.contentType, cacheControl: entry.cacheControl };
    },

    set(key: string, body: Buffer, contentType: string, cacheControl?: string) {
      if (body.length === 0 || body.length > maxEntryBytes || body.length > maxBytes) return;
      sweep();
      drop(key);
      map.set(key, { body, contentType, cacheControl, expiresAt: now() + ttlMs });
      bytes += body.length;
      // 先按条目数，再按字节预算；顺序无关紧要，两个闸都要过
      while (map.size > maxEntries || bytes > maxBytes) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
    },

    clear() {
      map.clear();
      bytes = 0;
    },

    get maxEntryBytes() {
      return maxEntryBytes;
    },

    get bytes() {
      return bytes;
    },

    get size() {
      return map.size;
    },
  };
}

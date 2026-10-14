/**
 * 结果缓存注入件（core-adapter/cache）
 *
 * 对应 docs/ARCHITECTURE.md §2「本地适配层职责」：
 * 线上 result-cache 用 Cloudflare Cache API（24h）；Electron 无 `caches` 全局，
 * 桌面注入内存 LRU（同 TTL）。
 *
 * 实现直接复用内核自带的 `createTtlCache`（mediaGet/src/lib/api-utils.js ——
 * 纯 Node 模块、无 Next 依赖，属于允许 import 的 src/lib/** 边界内），
 * 语义与线上内存兜底路径完全一致，不自造第二套缓存逻辑。
 */
import { createTtlCache } from "@/lib/api-utils";

/** 与线上 result-cache.js 的 TTL_SECONDS 对齐（24h） */
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ResultCacheStore {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  readonly size: number;
}

/**
 * 桌面结果缓存：内存 LRU（上限 500 与内核 MEMORY_MAX 对齐，
 * 桌面单机场景足够——条目丢了就重新解析，无正确性依赖）。
 */
export function createResultCache(): ResultCacheStore {
  return createTtlCache({ max: 500, ttlMs: TTL_MS }) as ResultCacheStore;
}

/**
 * 结果缓存注入件（core-adapter/cache）
 *
 * 对应 docs/ARCHITECTURE.md §2「本地适配层职责」：
 * 线上 result-cache 用 Cloudflare Cache API（24h）；Electron 无 `caches` 全局，
 * 桌面注入内存 TTL cache（同 TTL）。
 */

/** 与线上 result-cache.js 的 TTL_SECONDS 对齐（24h） */
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ResultCacheStore {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  readonly size: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * 桌面结果缓存：内存 TTL（上限 500，桌面单机场景足够——条目丢了就重新解析，无正确性依赖）。
 */
export function createResultCache(): ResultCacheStore {
  const max = 500;
  const map = new Map<string, CacheEntry>();

  function sweep() {
    const now = Date.now();
    for (const [k, v] of map) {
      if (v.expiresAt <= now) map.delete(k);
    }
  }

  return {
    get(key: string) {
      sweep();
      const entry = map.get(key);
      return entry?.value;
    },
    set(key: string, value: unknown) {
      sweep();
      if (map.size >= max) {
        // LRU: 删最老的
        const oldest = map.keys().next().value;
        if (oldest) map.delete(oldest);
      }
      map.set(key, { value, expiresAt: Date.now() + TTL_MS });
    },
    delete(key: string) {
      return map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}

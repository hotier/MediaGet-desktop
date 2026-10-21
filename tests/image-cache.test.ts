/**
 * 预览代理的图片内存缓存（2026-10-21「切页头像重载」的修法是加这一层）。
 *
 * 这几条钉的都是「加速层不许变成故障源」：超限不写、过期就丢、淘汰按最近使用，
 * 以及缓存键里不留直链原文（隐私红线）。
 */
import { describe, expect, it } from "vitest";
import { createImageCache, imageCacheKey } from "../electron/main/image-cache";

const buf = (n: number): Buffer => Buffer.alloc(n, 1);

describe("imageCacheKey（直链 → 定长哈希）", () => {
  it("同一条直链稳定，不同直链不撞，且键里不含原串", () => {
    const url = "https://i0.hdslb.com/bfs/face/abc.jpg?sign=SECRET";
    const key = imageCacheKey(url);
    expect(key).toBe(imageCacheKey(url));
    expect(key).not.toContain("hdslb");
    expect(key).not.toContain("SECRET");
    expect(key).toHaveLength(32);
    expect(imageCacheKey("https://example.com/a.jpg")).not.toBe(key);
  });
});

describe("createImageCache", () => {
  it("写入后能原样取回（含 content-type 与上游缓存语义）", () => {
    const cache = createImageCache();
    cache.set("k", buf(16), "image/jpeg", "max-age=31536000");
    const hit = cache.get("k");
    expect(hit?.body.length).toBe(16);
    expect(hit?.contentType).toBe("image/jpeg");
    expect(hit?.cacheControl).toBe("max-age=31536000");
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(16);
  });

  it("过期的条目当未命中，并立刻把占用的字节释放掉", () => {
    let now = 1_000;
    const cache = createImageCache({ ttlMs: 100, now: () => now });
    cache.set("k", buf(8), "image/png");
    now = 1_050;
    expect(cache.get("k")?.body.length).toBe(8);
    now = 1_101;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });

  it("超过单条上限的图不写入（也不抛错）", () => {
    const cache = createImageCache({ maxEntryBytes: 10 });
    cache.set("big", buf(11), "image/png");
    expect(cache.get("big")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.maxEntryBytes).toBe(10);
  });

  it("总预算按最近最少使用淘汰：先丢最旧的那张", () => {
    const cache = createImageCache({ maxBytes: 30, maxEntryBytes: 100 });
    cache.set("a", buf(10), "image/png");
    cache.set("b", buf(10), "image/png");
    cache.set("c", buf(10), "image/png");
    cache.set("d", buf(10), "image/png"); // 超预算 → 丢 a
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("d")).toBeDefined();
    expect(cache.bytes).toBe(30);
  });

  it("命中一次就算使用过：被读过的不会被先淘汰", () => {
    const cache = createImageCache({ maxBytes: 30, maxEntryBytes: 100 });
    cache.set("a", buf(10), "image/png");
    cache.set("b", buf(10), "image/png");
    cache.set("c", buf(10), "image/png");
    cache.get("a"); // a 变成最近使用，队首成了 b
    cache.set("d", buf(10), "image/png");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
  });

  it("条目数上限同样生效（小图很多时按条数收敛）", () => {
    const cache = createImageCache({ maxEntries: 2, maxBytes: 1_000, maxEntryBytes: 100 });
    cache.set("a", buf(1), "image/png");
    cache.set("b", buf(1), "image/png");
    cache.set("c", buf(1), "image/png");
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
  });

  it("覆盖同一个键只留一份，字节数按新的算", () => {
    const cache = createImageCache();
    cache.set("k", buf(10), "image/png");
    cache.set("k", buf(4), "image/jpeg");
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(4);
    expect(cache.get("k")?.contentType).toBe("image/jpeg");
  });

  it("clear 之后一切归零", () => {
    const cache = createImageCache();
    cache.set("a", buf(8), "image/png");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

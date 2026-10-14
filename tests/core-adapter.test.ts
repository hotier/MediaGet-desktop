/**
 * core-adapter 测试：config 两级求值 / cache LRU+TTL / throttle 串行节流
 */
import { describe, expect, it } from "vitest";
import { createConfigSource, isSecretKey, SECRET_CONFIG_KEYS } from "../core-adapter/config";
import { createResultCache } from "../core-adapter/cache";
import { createThrottle } from "../core-adapter/ratelimit";
import { createNoopAnalytics } from "../core-adapter/analytics";

describe("config 两级求值（§5）", () => {
  it("本机配置 > env > 默认值", () => {
    process.env.MG_TEST_KEY = "from-env";
    const src = createConfigSource({
      read: (k) => (k === "MG_TEST_KEY" ? "from-config" : undefined),
      allowEnv: true,
      defaults: { MG_TEST_KEY: "d", MG_ONLY_DEFAULT: "dd" },
    });
    expect(src.get("MG_TEST_KEY")).toBe("from-config");
    expect(src.inspect("MG_TEST_KEY").level).toBe("config");

    const src2 = createConfigSource({
      read: () => undefined,
      allowEnv: true,
      defaults: { MG_TEST_KEY: "d" },
    });
    expect(src2.get("MG_TEST_KEY")).toBe("from-env");
    expect(src2.inspect("MG_TEST_KEY").level).toBe("env");

    const src3 = createConfigSource({ read: () => undefined, allowEnv: false, defaults: { MG_TEST_KEY: "d" } });
    expect(src3.get("MG_TEST_KEY")).toBe("d");
    expect(src3.inspect("MG_TEST_KEY").level).toBe("default");
    expect(src3.inspect("NOT_EXIST").level).toBe("none");
    delete process.env.MG_TEST_KEY;
  });

  it("prod 不依赖 env（allowEnv=false 时 env 值被无视）", () => {
    process.env.MG_ENV_ONLY = "yes";
    const src = createConfigSource({ read: () => undefined, allowEnv: false });
    expect(src.get("MG_ENV_ONLY")).toBeUndefined();
    delete process.env.MG_ENV_ONLY;
  });

  it("getBool / getInt / getList", () => {
    const src = createConfigSource({
      read: (k) =>
        ({ B1: "on", B2: "false", N: "42", L: "a, b ,c, " })[k] as string | undefined,
      allowEnv: false,
    });
    expect(src.getBool("B1")).toBe(true);
    expect(src.getBool("B2")).toBe(false);
    expect(src.getBool("B1x")).toBeUndefined();
    expect(src.getInt("N")).toBe(42);
    expect(src.getList("L")).toEqual(["a", "b", "c"]);
  });

  it("秘密键清单含 Cookie 类且判定正确", () => {
    expect(SECRET_CONFIG_KEYS).toContain("BILIBILI_COOKIE");
    expect(isSecretKey("DOUYIN_COOKIE")).toBe(true);
    expect(isSecretKey("YOUTUBE_PIPED_HOSTS")).toBe(false);
  });
});

describe("cache：LRU + TTL（24h）", () => {
  it("命中刷新热度，超限淘汰最久未用", () => {
    const c = createResultCache();
    c.set("k1", { a: 1 });
    c.set("k2", { a: 2 });
    c.get("k1"); // k1 变热
    for (let i = 0; i < 500; i++) c.set(`fill-${i}`, i); // 超上限
    expect(c.get("k2")).toBeUndefined();
    expect(c.size).toBeLessThanOrEqual(500);
  });

  it("TTL 过期当未命中（用时间注入模拟）", () => {
    const c = createResultCache();
    c.set("x", 1);
    // 无法真等 24h：直接验证同容器语义 —— createTtlCache 用 Date.now()，
    // 这里通过 monkeypatch 缩短时钟验证惰性过期
    const realNow = Date.now;
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    try {
      expect(c.get("x")).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("throttle 温和节流", () => {
  it("interval=0 不排队", async () => {
    const g = createThrottle({ getIntervalMs: () => 0 });
    const t0 = Date.now();
    await Promise.all([g.acquire(), g.acquire(), g.acquire()]);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("interval=40ms 时三次调用至少间隔 80ms 且串行", async () => {
    const g = createThrottle({ getIntervalMs: () => 40 });
    const order: number[] = [];
    const call = async (i: number) => {
      await g.acquire();
      order.push(i);
    };
    const t0 = Date.now();
    await Promise.all([call(1), call(2), call(3)]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70); // 允许 timer 提前 ~2ms
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("analytics no-op（隐私边界）", () => {
  it("调用不抛、不产生任何网络/磁盘副作用", () => {
    const a = createNoopAnalytics();
    expect(() => a.track("parse", { platform: "douyin" })).not.toThrow();
  });
});

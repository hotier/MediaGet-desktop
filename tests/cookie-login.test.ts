/**
 * 登录抓取 Cookie 的纯逻辑（2026-10-19 业主指令：Cookie 会过期，导入要顺手）。
 *
 * 这三条判据错了都不会编译失败，只会让用户「点了自动获取，界面说已配置，解析却失败」——
 * 比没做这个功能更难排查。所以把它们钉成断言：域过滤、登录态判据、Cookie 头拼接。
 */
import { describe, expect, it } from "vitest";
import {
  COOKIE_LOGIN_KEYS,
  COOKIE_LOGIN_TARGETS,
  MAX_COOKIE_HEADER,
  buildCookieHeader,
  filterCookies,
  hasLoginMarker,
  isAllowedNavigation,
} from "../shared/cookie-login";
import { SECRET_CONFIG_KEYS } from "../core-adapter/config";

describe("规则表", () => {
  it("四个键都在内核机密键表里（否则抓到也铺不进 process.env）", () => {
    for (const key of COOKIE_LOGIN_KEYS) {
      expect(SECRET_CONFIG_KEYS as readonly string[]).toContain(key);
    }
  });

  it("登录页一律 https，且落在自己的域内", () => {
    for (const key of COOKIE_LOGIN_KEYS) {
      const t = COOKIE_LOGIN_TARGETS[key];
      expect(t.url.startsWith("https://")).toBe(true);
      expect(isAllowedNavigation(t.url, t.domains)).toBe(true);
      expect(t.markers.length).toBeGreaterThan(0);
    }
  });
});

describe("filterCookies（域过滤）", () => {
  const domains = ["xiaohongshu.com"];

  it("裸域与子域都收，前导点不影响", () => {
    const out = filterCookies(
      [
        { name: "a", value: "1", domain: "xiaohongshu.com" },
        { name: "b", value: "2", domain: ".xiaohongshu.com" },
        { name: "c", value: "3", domain: "www.xiaohongshu.com" },
      ],
      domains
    );
    expect(out.map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("别家域与相似后缀一律不收", () => {
    const out = filterCookies(
      [
        { name: "x", value: "1", domain: "evil-xiaohongshu.com" },
        { name: "y", value: "2", domain: "example.com" },
        { name: "z", value: "3" },
      ],
      domains
    );
    expect(out).toEqual([]);
  });
});

describe("hasLoginMarker（登录态判据）", () => {
  it("任一 marker 出现即算已登录", () => {
    expect(hasLoginMarker(["a", "sessionid"], ["sessionid", "sid_guard"])).toBe(true);
  });

  it("只有匿名键时不算：否则会把半份 Cookie 存成「已配置」", () => {
    expect(hasLoginMarker(["ttwid", "did"], ["sessionid", "sid_guard"])).toBe(false);
  });
});

describe("buildCookieHeader（拼串）", () => {
  it("同名只留第一条，markers 排最前", () => {
    const header = buildCookieHeader(
      [
        { name: "z", value: "1" },
        { name: "SESSDATA", value: "s" },
        { name: "z", value: "2" },
        { name: "a", value: "3" },
      ],
      ["SESSDATA"]
    );
    expect(header).toBe("SESSDATA=s; a=3; z=1");
  });

  it("超长时整条跳过而不是截半条（半条 value 会被平台判成「配置了但无效」）", () => {
    const header = buildCookieHeader(
      [
        { name: "SESSDATA", value: "s" },
        { name: "big", value: "x".repeat(50) },
      ],
      ["SESSDATA"],
      20
    );
    expect(header).toBe("SESSDATA=s");
    expect(header.length).toBeLessThanOrEqual(MAX_COOKIE_HEADER);
  });

  it("空集合 → 空串（调用方据此判「没抓到」）", () => {
    expect(buildCookieHeader([])).toBe("");
  });
});

describe("isAllowedNavigation（登录窗口导航闸门）", () => {
  const domains = ["xiaohongshu.com"];

  it("本域与子域的 https 放行", () => {
    expect(isAllowedNavigation("https://www.xiaohongshu.com/explore", domains)).toBe(true);
  });

  it("外域、http、以及「查询串里带域名」的形状一律拒", () => {
    expect(isAllowedNavigation("https://evil.com/", domains)).toBe(false);
    expect(isAllowedNavigation("https://evil.com/?x=xiaohongshu.com", domains)).toBe(false);
    expect(isAllowedNavigation("http://www.xiaohongshu.com/explore", domains)).toBe(false);
    expect(isAllowedNavigation("not-a-url", domains)).toBe(false);
  });
});

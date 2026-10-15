/**
 * 代理纯函数：manual 地址归一 + Electron resolveProxy 规则解析。
 * 应用层胶水（undici dispatcher / session.setProxy）在 dev 实测覆盖，这里守住解析边界。
 */
import { describe, expect, it } from "vitest";
import { normalizeProxyUrl, proxyUrlFromRule } from "../electron/main/proxy";

describe("normalizeProxyUrl（manual 模式地址归一）", () => {
  it("缺 scheme 补 http://，带 scheme 原样保留", () => {
    expect(normalizeProxyUrl("127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
    expect(normalizeProxyUrl("http://127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
    expect(normalizeProxyUrl("https://proxy.lan:8443")).toBe("https://proxy.lan:8443");
  });

  it("丢弃 path/query，保留 userinfo（带鉴权的代理）", () => {
    expect(normalizeProxyUrl("http://127.0.0.1:7897/some/path?x=1")).toBe("http://127.0.0.1:7897");
    expect(normalizeProxyUrl("user:pass@10.0.0.2:3128")).toBe("http://user:pass@10.0.0.2:3128");
  });

  it("空串 / 非法 / 非 http(s) 协议 → null（按直连处理）", () => {
    expect(normalizeProxyUrl("")).toBe(null);
    expect(normalizeProxyUrl("   ")).toBe(null);
    expect(normalizeProxyUrl("not a url")).toBe(null);
    expect(normalizeProxyUrl("socks5://127.0.0.1:1080")).toBe(null);
    expect(normalizeProxyUrl("ftp://127.0.0.1:21")).toBe(null);
  });
});

describe("proxyUrlFromRule（Electron resolveProxy 规则解析）", () => {
  it("PROXY / HTTPS 条目 → http 代理 URL；取首个命中", () => {
    expect(proxyUrlFromRule("PROXY 127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
    expect(proxyUrlFromRule("HTTPS proxy.lan:8443")).toBe("http://proxy.lan:8443");
    expect(proxyUrlFromRule("SOCKS 127.0.0.1:1080;PROXY 127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
  });

  it("DIRECT / 空 / 仅 SOCKS → null（直连）", () => {
    expect(proxyUrlFromRule("DIRECT")).toBe(null);
    expect(proxyUrlFromRule("")).toBe(null);
    expect(proxyUrlFromRule("SOCKS 127.0.0.1:1080")).toBe(null);
    expect(proxyUrlFromRule("DIRECT;PROXY a:1;")).toBe("http://a:1");
  });
});

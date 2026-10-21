/**
 * 预览代理链的编解码与安全闸（2026-10-18 业主定调「放开 CSP + 主进程代理取流」）。
 *
 * 钉住两件事：① 直链的签名段全在查询串里，编码一错就断链（断掉的那半截正是最敏感的一段）；
 * ② 代理链的查询串来自渲染层，主进程照它取流等于「替我访问任意地址」——内网、回环、
 * 云主机元数据接口都必须在这一层就回绝，两侧各跑一遍同一份判据。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_SCHEME,
  buildImageSrc,
  buildPreviewLink,
  isDashSegment,
  readPreviewTarget,
} from "../shared/preview-link";

const CDN = "https://v26.douyinvod.com/a/b.mp4?video_id=v1&sign=S1&expires=100";

describe("buildPreviewLink / readPreviewTarget（往返）", () => {
  it("直链带 ? 与 & 也不断链：解出来的正是原来那条", () => {
    const link = buildPreviewLink(CDN, "douyin");
    expect(link).not.toBeNull();
    expect(link?.startsWith(`${PREVIEW_SCHEME}://`)).toBe(true);
    expect(readPreviewTarget(link!)).toEqual({ url: CDN, platform: "douyin" });
  });

  it("不带平台键也能往返（Referer 是可选的，UA 一定带）", () => {
    const link = buildPreviewLink(CDN)!;
    expect(link).not.toContain("p=");
    expect(readPreviewTarget(link)).toEqual({ url: CDN });
  });

  it("空白平台名视同没给", () => {
    const link = buildPreviewLink(CDN, "  ");
    expect(link).not.toContain("p=");
    expect(readPreviewTarget(link!)).toEqual({ url: CDN });
  });
});

/**
 * B站登录态 dash 的音频轨（2026-10-21）：视频轨是 video-only 分片，必须把音频轨一起交给
 * 主进程合流。两条链都过同一道公网闸；音频轨不合法时只丢它，不废掉整条预览链。
 */
describe("dash 音频轨（第二条直链）", () => {
  const VIDEO = "https://upos-sz-mirrorcos.bilivideo.com/v/80.m4s?e=1&deadline=9";
  const AUDIO = "https://upos-sz-mirrorcos.bilivideo.com/a/30280.m4s?e=1&deadline=9";

  it("带音频的链能往返出 audioUrl（合流判据就是它存在）", () => {
    const link = buildPreviewLink(VIDEO, "bilibili", AUDIO)!;
    expect(readPreviewTarget(link)).toEqual({ url: VIDEO, platform: "bilibili", audioUrl: AUDIO });
  });

  it("音频轨过不了公网闸 → 只带视频，不把代理扩成第二条通道", () => {
    const link = buildPreviewLink(VIDEO, "bilibili", "http://127.0.0.1:9220/audio.m4s")!;
    expect(readPreviewTarget(link)).toEqual({ url: VIDEO, platform: "bilibili" });
  });

  it("音频与主链相同 → 不重复带（durl 单文件本身含音轨）", () => {
    const link = buildPreviewLink(VIDEO, "bilibili", VIDEO)!;
    expect(readPreviewTarget(link)).toEqual({ url: VIDEO, platform: "bilibili" });
  });

  it("解链时伪造的 `a=` 指向内网也会被丢掉", () => {
    const forged =
      `${PREVIEW_SCHEME}://media/?u=${encodeURIComponent(VIDEO)}` +
      `&a=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`;
    expect(readPreviewTarget(forged)).toEqual({ url: VIDEO });
  });

  it("isDashSegment 只看路径扩展名（签名串里带 .m4s 不算）", () => {
    expect(isDashSegment(VIDEO)).toBe(true);
    expect(isDashSegment("https://upos.hdslb.com/single.mp4?x=.m4s")).toBe(false);
    expect(isDashSegment("https://upos.hdslb.com/single.mp4")).toBe(false);
    expect(isDashSegment("not a url")).toBe(false);
    expect(isDashSegment("https://cdn.example.invalid/a.m4s")).toBe(true);
  });
});

describe("安全闸（只放行公网 http(s)）", () => {
  const rejected = [
    "http://127.0.0.1/x.mp4",
    "http://localhost/x.mp4",
    "http://a.localhost/x.mp4",
    "http://10.0.0.1/x.mp4",
    "http://172.16.0.9/x.mp4",
    "http://192.168.1.1/x.mp4",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/x.mp4",
    "http://0.0.0.0/x.mp4",
    "http://[::1]/x.mp4",
    "http://[fd00::1]/x.mp4",
    "http://[fe80::1]/x.mp4",
    "http://[::ffff:127.0.0.1]/x.mp4",
    "http://2130706433/x.mp4", // 十进制写法，URL 规范化后就是 127.0.0.1
    "http://0x7f.1/x.mp4",
    "http://intranet/x.mp4",
    "http://svc.local/x.mp4",
    "file:///C:/secrets/config.json",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
    "http://u:p@public.example.com/x.mp4",
  ];
  for (const bad of rejected) {
    it(`${bad} → 不建链`, () => {
      expect(buildPreviewLink(bad, "bilibili")).toBeNull();
    });
  }

  it("公网 CDN、公网 IP 字面量（v4/v6）都放行", () => {
    expect(buildPreviewLink("https://xy.mipush.com/cdn-x.m4s?m=1&l=2", "bilibili")).not.toBeNull();
    expect(buildPreviewLink("https://93.184.216.34/a.mp4", "bilibili")).not.toBeNull();
    expect(buildPreviewLink("https://[2606:4700::6810:a1]/a.mp4", "bilibili")).not.toBeNull();
  });

  it("解链侧重跑同一份判据：手搓一条指向回环的代理链也取不到", () => {
    const forged = `${PREVIEW_SCHEME}://media/?u=${encodeURIComponent("http://127.0.0.1:9220/json")}`;
    expect(readPreviewTarget(forged)).toBeNull();
  });

  it("非代理 scheme、缺 u、坏串一律 null", () => {
    expect(readPreviewTarget("https://v.douyinvod.com/a.mp4")).toBeNull();
    expect(readPreviewTarget(`${PREVIEW_SCHEME}://media/`)).toBeNull();
    expect(readPreviewTarget(`${PREVIEW_SCHEME}://media/?u=`)).toBeNull();
    expect(readPreviewTarget("not a url")).toBeNull();
    expect(readPreviewTarget("")).toBeNull();
  });
});

/**
 * 接线守卫（源码层事实，同 `tests/boundaries.test.ts` 的手法）。这条路线的两个前提被人顺手
 * 改掉都是**静默**失败：CSP 的 `media-src` 放开成 `https:` 等于渲染层自己出外链（闸与 Referer
 * 一起绕过），而 `<video>` 的 src 不走代理就回到本批立项时那句「预览加载失败」。
 */
describe("接线：CSP 只认自家 scheme，媒体 src 必经代理", () => {
  const html = readFileSync(fileURLToPath(new URL("../renderer/index.html", import.meta.url)), "utf8");
  const card = readFileSync(
    fileURLToPath(new URL("../renderer/src/components/ResultCard.tsx", import.meta.url)),
    "utf8"
  );

  it("media-src 恰好是 'self' + 代理 scheme，没多出 https:", () => {
    const mediaSrc = /media-src\s+([^;"]+)/.exec(html)?.[1]?.trim();
    expect(mediaSrc).toBe(`'self' ${PREVIEW_SCHEME}:`);
  });

  it("音视频的 src 由 buildPreviewLink 生成；图片同走代理（buildImageSrc）", () => {
    expect(card).toContain("buildPreviewLink(previewEntry.url, result.platform, dashAudio)");
    // 音频轨要带，但判据只在下载计划那一处（`dashAudioFor`）：渲染层若自己再按扩展名判一次，
    // YouTube 的 googlevideo 链（pathname 是 /videoplayback，没有 `.m4s`）就会被漏掉——
    // 选中高于主链的档后 `<video>` 里没有音轨，Chromium 连音量按钮都不画（2026-10-21 用户报）
    expect(card).toContain("previewEntry.audioUrl");
    expect(card).not.toContain("isDashSegment(previewEntry.url)");
    // 2026-10-18 实测推翻「img 直接吃原链」：微博图床对空 Referer 也回 403，`<img>` 带不上
    // 防盗链头。图片与音视频共用代理链；回落只放行绝对 http(s)（img-src 里的 https:）与
    // data:，站内相对路由返回 null，调用方画占位而不是演「图裂了」。
    expect(card).toContain("buildImageSrc(previewEntry.url, result.platform)");
  });
});

/**
 * buildImageSrc：图片 src 的三档规则（2026-10-18 微博事故的回归守卫）。
 *
 * 事故全貌：parse-core 0.1.2 把微博（m.weibo.cn 通道）/小红书/B站的图片与头像改写成 web 宿主的
 * **站内相对路由** `/api/image?url=<编码直链>`，桌面没有这条路由；而回落分支原样写进 `<img src>`，
 * 一张注定 404 的图，界面上演的是「图裂了」而不是任何报错（同一份解析里 type 还被兜底路径写死成
 * video、互动计数整段缺失）。内核 1.0.0 起移除该模式（1.1.0 零残留），桌面侧钉死不再承接它。
 */
describe("buildImageSrc（代理优先；回落只放行浏览器自己能安全的地址）", () => {
  const SINA = "https://wx3.sinaimg.cn/large/6adef0aegy1ihyvg25l3ej20zu1z1ka6.jpg";

  it("公网图床直链 → 代理链（防盗链头只有主进程带得上）", () => {
    const src = buildImageSrc(SINA, "weibo");
    expect(src?.startsWith(`${PREVIEW_SCHEME}://`)).toBe(true);
    expect(readPreviewTarget(src!)).toEqual({ url: SINA, platform: "weibo" });
  });

  it("data: 内联图原样放行（不发起网络请求，dev mock 的头像封面都是它）", () => {
    const uri = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";
    expect(buildImageSrc(uri, "weibo")).toBe(uri);
  });

  it("绝对 http(s) 回落原链（图床不吃 Referer 时少一跳；img-src 放行 https:）", () => {
    expect(buildImageSrc("https://cdn.example.invalid/1.jpg", "douyin")).toBe(
      "https://cdn.example.invalid/1.jpg"
    );
    expect(buildImageSrc("http://cdn.local/1.jpg", "douyin")).toBe("http://cdn.local/1.jpg");
  });

  // 事故形态本体：0.1.2 内核吐出来的站内相对路由。盘上存量（那段时间写进 history/queue 的
  // 作者头像）读侧解出来复活 —— 图真的画出来，比返回 null 画占位更进一步。
  it("站内相对路由串：0.1.2 形状解出来复活，按正常图床直链建代理链", () => {
    const poisoned = `/api/image?url=${encodeURIComponent(SINA)}`;
    const src = buildImageSrc(poisoned, "weibo");
    expect(src?.startsWith(`${PREVIEW_SCHEME}://`)).toBe(true);
    expect(readPreviewTarget(src!)).toEqual({ url: SINA, platform: "weibo" });
  });

  it("解不出公网直链的相对路由 → null（写进 src 只会得到一张必坏的图）", () => {
    expect(buildImageSrc("/api/image?url=not-a-url", "weibo")).toBeNull();
    expect(buildImageSrc("/api/image?url=", "weibo")).toBeNull();
    expect(buildImageSrc("/api/image?url=" + encodeURIComponent("http://127.0.0.1/x.jpg"), "weibo")).toBeNull();
    expect(buildImageSrc("/static/logo.png", "weibo")).toBeNull();
    expect(buildImageSrc("api/image?url=x", "weibo")).toBeNull(); // 缺前导斜杠，不是该形状
  });

  it("其它 scheme 与坏串一律 null（不写进 src）", () => {
    expect(buildImageSrc("javascript:alert(1)", "weibo")).toBeNull();
    expect(buildImageSrc("file:///C:/a.jpg", "weibo")).toBeNull();
    expect(buildImageSrc("blob:https://app/x", "weibo")).toBeNull();
    expect(buildImageSrc("not a url", "weibo")).toBeNull();
    expect(buildImageSrc("", "weibo")).toBeNull();
  });
});

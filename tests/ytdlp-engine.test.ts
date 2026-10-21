/**
 * yt-dlp 引擎的映射分支（2026-10-21 YouTube 接入后补齐）。
 *
 * 只测纯逻辑：给一份 yt-dlp 的 `-J` 形状喂进去，看落出来的 `ParseData` 对不对。
 * 客户端一律注入假桩，**绝不真跑二进制**（离线套件禁网络，而且 yt-dlp 会打真站点）。
 */
import { describe, expect, it } from "vitest";
import { createYtdlpEngine, ytdlpClaims } from "../electron/main/ytdlp-engine";

interface FakeInfo {
  (url: string): unknown | Promise<unknown>;
}

function makeEngine(
  info: FakeInfo,
  calls: string[] = [],
  cookie?: string,
  seen: Array<{ cookies?: string } | undefined> = []
) {
  return createYtdlpEngine({
    getBinaryPath: () => "C:/fake/yt-dlp.exe",
    getCookie: () => cookie,
    makeClient: () => ({
      getInfoAsync: async (url: string, options?: { flatPlaylist?: boolean; cookies?: string }) => {
        calls.push(url);
        seen.push(options);
        return info(url);
      },
    }),
  });
}

const YT_INFO = {
  id: "dQw4w9WgXcQ",
  title: "测试视频",
  description: "简介文本",
  uploader: "频道名",
  uploader_id: "@chan",
  uploader_url: "https://www.youtube.com/@chan",
  channel: "频道名",
  channel_id: "UC123",
  channel_url: "https://www.youtube.com/channel/UC123",
  channel_follower_count: 9000,
  duration: 213.6,
  thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  view_count: 1_000_000,
  like_count: 5000,
  comment_count: 300,
  formats: [
    // 音频档：只有 acodec
    { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 129, url: "https://rr1.googlevideo.com/a.m4a" },
    // 渐进式：视频+音频同文件，360P
    { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, url: "https://rr1.googlevideo.com/18.mp4" },
    // 渐进式里的最高档 720P
    { format_id: "22", vcodec: "avc1.64001F", acodec: "mp4a.40.2", height: 720, url: "https://rr1.googlevideo.com/22.mp4" },
    // video-only 1080P：进 qualities，不能当主直链
    { format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080, url: "https://rr1.googlevideo.com/137.mp4" },
    // DRM 档：解出来也下不动，冒充能力只会让用户拿到打不开的文件
    { format_id: "999", vcodec: "av01", acodec: "none", height: 2160, has_drm: true, url: "https://rr1.googlevideo.com/drm.mp4" },
  ],
};

const runYoutube = (info: FakeInfo, url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ", calls: string[] = []) =>
  makeEngine(info, calls).run({ platform: "youtube", url });

describe("yt-dlp × YouTube", () => {
  it("主直链取渐进式最高档，video-only 只进 qualities，DRM 档剔除", async () => {
    const out = await runYoutube(() => YT_INFO);
    expect(out.ok).toBe(true);
    const data = out.ok ? out.result.data : undefined;
    expect(data?.url).toBe("https://rr1.googlevideo.com/22.mp4");
    expect(data?.audioUrl).toBe("https://rr1.googlevideo.com/a.m4a");
    expect(data?.qualities?.map((q) => q.quality)).toEqual([1080, 720, 360]);
    expect(data?.qualities?.some((q) => q.url.includes("drm"))).toBe(false);
  });

  it("契约字段按 YT 口径落位：duration 是毫秒、订阅数进 subscriberCount、来源标 yt-dlp", async () => {
    const out = await runYoutube(() => YT_INFO);
    const data = out.ok ? out.result.data : undefined;
    // yt-dlp 给秒（213.6），契约要毫秒
    expect(data?.duration).toBe(213_600);
    expect(data?.subscriberCount).toBe(9000);
    expect(data?.author).toBe("频道名");
    expect(data?.authorId).toBe("@chan");
    expect(data?.authorUrl).toBe("https://www.youtube.com/@chan");
    expect(data?.videoId).toBe("dQw4w9WgXcQ");
    expect(data?.source).toBe("yt-dlp");
    expect(data?.stat).toEqual({ view: 1_000_000, like: 5000, reply: 300 });
  });

  it("频道订阅数缺位时就是 undefined：不拿 0 冒充", async () => {
    const out = await runYoutube(() => ({ ...YT_INFO, channel_follower_count: undefined }));
    expect((out.ok ? out.result.data : undefined)?.subscriberCount).toBeUndefined();
  });

  it("播放列表取第一条条目", async () => {
    const out = await runYoutube(() => ({
      _type: "playlist",
      entries: [{ ...YT_INFO, id: "first", title: "第一条" }, { ...YT_INFO, id: "second", title: "第二条" }],
    }));
    expect((out.ok ? out.result.data : undefined)?.title).toBe("第一条");
  });

  it("空播放列表如实失败，不吐半截数据", async () => {
    const out = await runYoutube(() => ({ _type: "playlist", entries: [] }));
    expect(out.ok).toBe(false);
    expect(out.ok ? 0 : out.result?.code).toBe(404);
  });

  it("yt-dlp 的登录/风控报错归到 bot-gated，而不是笼统的脚本错误", async () => {
    const out = await runYoutube(() => {
      throw new Error("Sign in to confirm you’re not a bot");
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.result?.failType).toBe("bot-gated");
  });

  it("没有可用直链时 ok:false，允许换下一个引擎", async () => {
    const out = await runYoutube(() => ({ ...YT_INFO, formats: [] }));
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.reason).toBe("no-media");
  });
});

describe("作者卡片补全（头像 / 简介 / 订阅数）", () => {
  /** 频道页形状：`--flat-playlist` 的频道结果，简介与头像都在这里，视频 JSON 里没有 */
  const CHANNEL = {
    _type: "playlist",
    id: "UC123",
    title: "频道名",
    description: "频道简介：修表二十年",
    channel_follower_count: 12345,
    thumbnails: [
      { id: "banner_uncropped", url: "https://yt3.googleusercontent.com/banner.jpg" },
      { id: "avatar_uncropped", url: "https://yt3.googleusercontent.com/avatar.jpg" },
    ],
  };

  it("头像取 thumbnails 里的 avatar_uncropped，不拿视频封面冒充", async () => {
    const out = await runYoutube(() => ({
      ...YT_INFO,
      thumbnails: [
        { id: "hqdefault", url: "https://i.ytimg.com/vi/x/hqdefault.jpg" },
        { id: "avatar_uncropped", url: "https://yt3.googleusercontent.com/avatar.jpg" },
      ],
    }));
    const data = out.ok ? out.result.data : undefined;
    expect(data?.avatar).toBe("https://yt3.googleusercontent.com/avatar.jpg");
  });

  it("没有 avatar 条目时留空：宁可缺一格，也不拿封面顶替作者头像", async () => {
    const out = await runYoutube(() => ({
      ...YT_INFO,
      thumbnails: [{ id: "hqdefault", url: "https://i.ytimg.com/vi/x/hqdefault.jpg" }],
    }));
    expect((out.ok ? out.result.data : undefined)?.avatar).toBeUndefined();
  });

  it("主直链的档位名写进 qualityLabel：选择器不再只能叫它「默认」", async () => {
    const out = await runYoutube(() => YT_INFO);
    // 渐进式最高档是 22 = 720P（1080 那条是 video-only，不能当主链）
    expect((out.ok ? out.result.data : undefined)?.qualityLabel).toBe("720P");
  });

  it("再解析一次频道页：简介与头像补进结果，订阅数仍以视频页为准", async () => {
    const calls: string[] = [];
    const out = await makeEngine(
      (url) => (url.includes("/@chan") ? CHANNEL : YT_INFO),
      calls
    ).run({ platform: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

    const data = out.ok ? out.result.data : undefined;
    expect(data?.sign).toBe("频道简介：修表二十年");
    expect(data?.avatar).toBe("https://yt3.googleusercontent.com/avatar.jpg");
    expect(data?.subscriberCount).toBe(9000);
    // 第二次请求打的是频道页，且是 flat 模式（只拿元数据，不展开视频列表）
    expect(calls).toEqual([
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/@chan",
    ]);
  });

  it("频道页拿不到（撞风控/超时）不影响解析：已经拿到的照常交出", async () => {
    const out = await makeEngine((url) => {
      if (url.includes("/@chan")) throw new Error("Sign in to confirm you’re not a bot");
      return YT_INFO;
    }).run({ platform: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

    expect(out.ok).toBe(true);
    const data = out.ok ? out.result.data : undefined;
    expect(data?.title).toBe("测试视频");
    expect(data?.sign).toBeUndefined();
  });
});

describe("用户自配 Cookie（YouTube 年龄限制 / 登录墙）", () => {
  /** Cookie 这条路要三个钩子联动，单独装配比往 makeEngine 上堆参数更清楚 */
  function makeCookieEngine(
    info: FakeInfo,
    cookie: string | undefined,
    hooks: {
      seen?: Array<{ cookies?: string } | undefined>;
      prepared?: Array<{ platform: string; header: string }>;
      cleaned?: { count: number };
      file?: { path: string } | null;
    } = {}
  ) {
    return createYtdlpEngine({
      getBinaryPath: () => "C:/fake/yt-dlp.exe",
      getCookie: () => cookie,
      prepareCookieFile: async (platform, header) => {
        hooks.prepared?.push({ platform, header });
        const file = hooks.file === undefined ? { path: "C:/tmp/mediaget-ytdlp/yt-youtube-ab12.txt" } : hooks.file;
        if (!file) return null;
        return {
          path: file.path,
          cleanup: async () => {
            if (hooks.cleaned) hooks.cleaned.count += 1;
          },
        };
      },
      makeClient: () => ({
        getInfoAsync: async (url: string, options?: { flatPlaylist?: boolean; cookies?: string }) => {
          hooks.seen?.push(options);
          return info(url);
        },
      }),
    });
  }

  it("传下去的是 cookiefile 路径，不是 Cookie 头串（--cookies 只认文件）", async () => {
    const seen: Array<{ cookies?: string } | undefined> = [];
    const prepared: Array<{ platform: string; header: string }> = [];
    const cleaned = { count: 0 };
    const out = await makeCookieEngine(() => YT_INFO, "SID=abc; HSID=def", { seen, prepared, cleaned }).run({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(out.ok).toBe(true);
    expect(prepared).toEqual([{ platform: "youtube", header: "SID=abc; HSID=def" }]);
    expect(seen[0]?.cookies).toBe("C:/tmp/mediaget-ytdlp/yt-youtube-ab12.txt");
    expect(seen[0]?.cookies).not.toContain("SID=");
    // 用完即删：临时文件不该留在盘上
    expect(cleaned.count).toBe(1);
  });

  it("没配 / 只有空白：不写文件、不传这个选项，走匿名路径", async () => {
    const seen: Array<{ cookies?: string } | undefined> = [];
    const prepared: Array<{ platform: string; header: string }> = [];
    await makeCookieEngine(() => YT_INFO, "   ", { seen, prepared }).run({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(prepared).toEqual([]);
    expect(seen[0]?.cookies).toBeUndefined();
  });

  it("落不成文件（prepare 返回 null）按没配处理，不拿头串硬塞", async () => {
    const seen: Array<{ cookies?: string } | undefined> = [];
    await makeCookieEngine(() => YT_INFO, "SID=abc", { seen, file: null }).run({
      platform: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(seen[0]?.cookies).toBeUndefined();
  });

  it("失败路径也要清掉临时文件", async () => {
    const cleaned = { count: 0 };
    const out = await makeCookieEngine(
      () => {
        throw new Error("Sign in to confirm you’re not a bot");
      },
      "SID=SUPER-SECRET-VALUE",
      { cleaned }
    ).run({ platform: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(out.ok).toBe(false);
    expect(cleaned.count).toBe(1);
    // 报错里带上 Cookie 值等于把凭据写进日志
    const result = out.ok ? undefined : out.result;
    expect(JSON.stringify(result)).not.toContain("SUPER-SECRET-VALUE");
  });
});

describe("能力位（注册表 ready ∧ 自报覆盖）", () => {
  it("YouTube 已升 ready：这是 2026-10-21 接入生效的那一条", () => {
    expect(ytdlpClaims("youtube")).toBe(true);
  });

  it("还没升 ready 的平台不会被自报覆盖「顺手打开」", () => {
    // twitter/instagram 在 YTDLP_PLATFORMS 里，但注册表仍是 unknown → 不生效
    expect(ytdlpClaims("twitter")).toBe(false);
    expect(ytdlpClaims("instagram")).toBe(false);
  });

  it("注册表和自报都不含的平台一律不主张", () => {
    expect(ytdlpClaims("bilibili")).toBe(false);
  });
});

/**
 * 下载计划的纯函数分支：卡片按钮上的「下载 N 项」与用户真正会落盘的清单都从这里出，
 * 展开错了不会报错、只会静默多下/少下一颗。只钉语义最容易错的两档。
 */
import { describe, expect, it } from "vitest";
import {
  buildFilename,
  buildPlan,
  buildQualityPlan,
  normalizeQualityLabel,
} from "../renderer/src/lib/download-plan";
import type { ParseData } from "../types/ipc";

describe("buildQualityPlan 的档位来源", () => {
  it("B站形态：档位只挂在 videos[].qualities 上时照样出多档", () => {
    const data = {
      title: "t",
      url: "https://cdn/p1-1080.m4s",
      videos: [
        {
          url: "https://cdn/p1-1080.m4s",
          qualities: [
            { quality: 80, label: "1080P", url: "https://cdn/p1-1080.m4s" },
            { quality: 64, label: "720P", url: "https://cdn/p1-720.m4s" },
          ],
        },
        {
          url: "https://cdn/p2-1080.m4s",
          qualities: [
            { quality: 80, label: "1080P", url: "https://cdn/p2-1080.m4s" },
            { quality: 64, label: "720P", url: "https://cdn/p2-720.m4s" },
          ],
        },
      ],
    };
    const plan = buildQualityPlan(data);
    expect(plan.options.map((o) => o.label)).toEqual(["1080P", "720P"]);
    expect(plan.primaryIndex).toBe(0);
    // 选 720P：主视频与分 P 各自落到同档，主视频不会被下两遍
    expect(buildPlan(data, plan.options[1]).map((p) => [p.id, p.url])).toEqual([
      ["main", "https://cdn/p1-720.m4s"],
      ["p-1", "https://cdn/p2-720.m4s"],
    ]);
  });
});

describe("buildPlan 的清晰度档位", () => {
  it("「仅音频」是排他档：只落音频，不把各分 P 的视频带进来", () => {
    const data = {
      title: "t",
      url: "https://cdn/v.mp4",
      audioUrl: "https://cdn/a.m4s",
      videos: [{ url: "https://cdn/p1.mp4" }, { url: "https://cdn/p2.mp4" }],
    };
    const audio = buildQualityPlan(data).options.find((o) => o.audio);
    if (!audio) throw new Error("data.audioUrl 应当产出一个「仅音频」档");
    expect(buildPlan(data, audio).map((p) => p.kind)).toEqual(["audio"]);
  });

  it("默认档保留主视频与各分 P，同一 URL 只算一项", () => {
    const data = {
      title: "t",
      url: "https://cdn/p1.mp4",
      videos: [{ url: "https://cdn/p1.mp4" }, { url: "https://cdn/p2.mp4" }],
    };
    expect(buildPlan(data).map((p) => p.id)).toEqual(["main", "p-1"]);
  });
});

describe("一个分 P 就是一份资源（契约 v36）", () => {
  it("音轨与双轨身份只认这一 P 自己带的那条，不借顶层", () => {
    const data = {
      title: "合集",
      // 顶层那条音轨属于主链（P1）：配到 P2 上就是「画面是 P2、声音是 P1」，
      // 比无声更难发现——文件能播、听着像另一集
      audioUrl: "https://cdn/p1-a.m4s",
      url: "https://cdn/p1-v.m4s",
      videoCodecs: "avc1.640032",
      videos: [
        { page: 1, url: "https://cdn/p1-v.m4s", audioUrl: "https://cdn/p1-a.m4s", videoCodecs: "avc1.640032", audioCodecs: "mp4a.40.2" },
        { page: 2, url: "https://cdn/p2-v.m4s", audioUrl: "https://cdn/p2-a.m4s", videoCodecs: "avc1.64001f", audioCodecs: "mp4a.40.2", audioMimeType: "audio/mp4" },
      ],
    };
    const p2 = buildPlan(data).find((e) => e.id === "p-1");
    expect(p2?.audioUrl).toBe("https://cdn/p2-a.m4s");
    expect(p2?.videoCodecs).toBe("avc1.64001f");
    expect(p2?.audioCodecs).toBe("mp4a.40.2");
    expect(p2?.audioMimeType).toBe("audio/mp4");
  });

  it("渐进式分 P 没有音轨键：保持单流，不拿顶层音轨硬配", () => {
    const data = {
      title: "合集",
      url: "https://cdn/p1.mp4",
      audioUrl: "https://cdn/top-a.m4s",
      videos: [{ page: 1, url: "https://cdn/p1.mp4" }, { page: 2, url: "https://cdn/p2.mp4" }],
    };
    expect(buildPlan(data).find((e) => e.id === "p-1")?.audioUrl).toBeUndefined();
  });

  it("某一 P 没有所选档位：显式挂降级提示并落它自己的默认直链", () => {
    const data = {
      title: "合集",
      page: 1,
      url: "https://cdn/p1-1080.m4s",
      // 真机形态：登录态大会员稿件里逐 P 档位并不齐（P2 常只到 720P）
      qualities: [
        { quality: 80, label: "1080P", url: "https://cdn/p1-1080.m4s" },
        { quality: 64, label: "720P", url: "https://cdn/p1-720.m4s" },
      ],
      videos: [
        {
          page: 1,
          url: "https://cdn/p1-1080.m4s",
          qualities: [
            { quality: 80, label: "1080P", url: "https://cdn/p1-1080.m4s" },
            { quality: 64, label: "720P", url: "https://cdn/p1-720.m4s" },
          ],
        },
        { page: 2, url: "https://cdn/p2-default.m4s", qualities: [{ quality: 64, label: "720P", url: "https://cdn/p2-720.m4s" }] },
      ],
    };
    const q1080 = buildQualityPlan(data).options.find((o) => o.label === "1080P");
    if (!q1080) throw new Error("档位表里应当有 1080P");
    const plan = buildPlan(data, q1080);
    const p2 = plan.find((e) => e.id === "p-1");
    // 静默降档的后果是「用户以为下了 1080P」，所以提示必须显式，文件名也不许挂 -1080P
    expect(p2?.fallbackNote).toBe("无 1080P，用默认清晰度");
    expect(p2?.url).toBe("https://cdn/p2-default.m4s");
    expect(p2?.filename).toBe("P2.mp4");
    // P1 与主链同 URL，去重后只留主链那一条：它命中了所选档位，不该挂降级提示
    const main = plan.find((e) => e.id === "main");
    expect(main?.fallbackNote).toBeUndefined();
    expect(main?.url).toBe("https://cdn/p1-1080.m4s");
    expect(main?.filename).toBe("P1-1080P.mp4");
  });

  it("某一 P 缺席时编号认 `page`，标签与文件名都不跟着下标前移", () => {
    const data = {
      title: "合集",
      page: 1,
      url: "https://cdn/p1.m4s",
      videos: [{ page: 1, url: "https://cdn/p1.m4s" }, { page: 3, url: "https://cdn/p3.m4s" }],
    };
    const plan = buildPlan(data);
    expect(plan.map((p) => p.label)).toEqual(["视频 · P1 · 默认", "分 P 3"]);
    expect(plan.map((p) => p.filename)).toEqual(["P1.mp4", "P3.mp4"]);
  });

  it("主链带 P 号：解析 P1 与解析 P2 不会落成同一个文件名", () => {
    const videos = [
      { page: 1, url: "https://cdn/p1.m4s" },
      { page: 2, url: "https://cdn/p2.m4s" },
    ];
    const firstName = (page: number): string =>
      buildPlan({ title: "合集", page, url: `https://cdn/p${page}.m4s`, videos })[0].filename;
    expect(firstName(1)).toBe("P1.mp4");
    expect(firstName(2)).toBe("P2.mp4");
  });

  it("分P 用自己那一集的标题，P 号作前缀（业主 2026-10-23「统一改为 P1-XXXX」）", () => {
    const data = {
      title: "合集",
      page: 1,
      url: "https://cdn/p1.m4s",
      videos: [
        { page: 1, title: "开端", url: "https://cdn/p1.m4s" },
        { page: 2, title: "第二集", url: "https://cdn/p2.m4s" },
      ],
    };
    expect(buildPlan(data).map((p) => p.filename)).toEqual(["P1-开端.mp4", "P2-第二集.mp4"]);
    // 「多文件加序号」关掉 = 不挂 P 号前缀（与原 `-P2` 后缀同一个开关语义）
    expect(
      buildPlan(data, undefined, { preset: "title", extra: { quality: true, index: false } }).map(
        (p) => p.filename
      )
    ).toEqual(["开端.mp4", "第二集.mp4"]);
  });

  it("分P 只写自己的名字：与合集同名照常显示，缺名字时只留 P 号", () => {
    // 实测形态（BV1rgap62Ez5）：P1 的 part 就是稿件标题，P2 是「日-<稿件标题>」
    const named = {
      title: "《原神》过场动画",
      page: 1,
      url: "https://cdn/p1.m4s",
      videos: [
        { page: 1, title: "《原神》过场动画", url: "https://cdn/p1.m4s" },
        { page: 2, title: "日-《原神》过场动画", url: "https://cdn/p2.m4s" },
      ],
    };
    expect(buildPlan(named).map((p) => p.filename)).toEqual([
      "P1-《原神》过场动画.mp4",
      "P2-日-《原神》过场动画.mp4",
    ]);
    // 引擎没给这一 P 名字时不拿合集标题顶替（P1 报的那个点），只留 P 号
    const nameless = {
      title: "合集",
      page: 1,
      url: "https://cdn/p1.m4s",
      videos: [{ page: 1, url: "https://cdn/p1.m4s" }, { page: 2, url: "https://cdn/p2.m4s" }],
    };
    expect(buildPlan(nameless).map((p) => p.filename)).toEqual(["P1.mp4", "P2.mp4"]);
  });
});

describe("清晰度文案归一（业主 2026-10-23：一律 720P / 1080P）", () => {
  it("剥掉平台修饰词，只留分辨率", () => {
    expect(normalizeQualityLabel("高清 1080P")).toBe("1080P");
    expect(normalizeQualityLabel("流畅 360P")).toBe("360P");
    expect(normalizeQualityLabel("720p")).toBe("720P");
    expect(normalizeQualityLabel("1080")).toBe("1080P");
  });

  it("同分辨率的增强档落成 1080P+（高码率 / 高帧率不与普通档撞名）", () => {
    expect(normalizeQualityLabel("1080P 高码率")).toBe("1080P+");
    expect(normalizeQualityLabel("1080P60 高帧率")).toBe("1080P+");
    expect(normalizeQualityLabel("高清 1080P+")).toBe("1080P+");
    // 普通档不许被误标成「+」
    expect(normalizeQualityLabel("高清 1080P")).toBe("1080P");
    expect(normalizeQualityLabel("4K 超清")).toBe("2160P");
  });

  it("4K / 8K 落成 P 记法", () => {
    expect(normalizeQualityLabel("4K 超清")).toBe("2160P");
    expect(normalizeQualityLabel("8K 超高清")).toBe("4320P");
  });

  it("抽不到分辨率：先剥修饰词，空了自己看档位数值，像分辨率才用", () => {
    // 快手：height 就是分辨率
    expect(normalizeQualityLabel("超清", 1080)).toBe("1080P");
    // B站 qn（80 = 1080P）不能写成 80P，宁可留「默认」
    expect(normalizeQualityLabel("高清", 80)).toBe("默认");
    expect(normalizeQualityLabel(undefined)).toBe("默认");
    // 真没有分辨率的专有档原样保留，不瞎猜数字
    expect(normalizeQualityLabel("杜比视界")).toBe("杜比视界");
  });
});

describe("buildQualityPlan 的同名档位", () => {
  it("上游把两档标成同一句话时只留一个芯片（两个 1080P 会让用户分不清）", () => {
    const data = {
      title: "t",
      // 主链是保留下来的那一档：不会被 unshift 出「默认」芯片
      url: "https://cdn/116.m4s",
      qualities: [
        { quality: 116, label: "高清 1080P", url: "https://cdn/116.m4s" },
        { quality: 80, label: "高清 1080P", url: "https://cdn/80.m4s" },
        { quality: 64, label: "高清 720P", url: "https://cdn/64.m4s" },
      ],
    };
    const plan = buildQualityPlan(data);
    // 芯片只写分辨率（业主 2026-10-23）：上游的「高清 / 高码率」等修饰词一律不进下拉
    expect(plan.options.map((o) => o.label)).toEqual(["1080P", "720P"]);
    // 保留的是先出现（引擎降序 = 更高档）的那条
    expect(plan.options[0].url).toBe("https://cdn/116.m4s");
  });

  it("主链与另一档同名（YouTube 360P 的渐进式 vs DASH）时保留主链那条，不再补「默认」", () => {
    const data = {
      title: "t",
      // 主链是渐进式 360P（带音轨）；同分辨率的 DASH video-only 排在它前面
      url: "https://rr/18.mp4",
      qualityLabel: "360P",
      qualities: [
        { quality: 360, label: "360P", url: "https://rr/134.mp4" },
        { quality: 360, label: "360P", url: "https://rr/18.mp4" },
      ],
    };
    const plan = buildQualityPlan(data);
    // 2026-10-21 用户报「莫名多一个默认档」：主链被同名去重挤掉才会出现它
    expect(plan.options.map((o) => o.label)).toEqual(["360P"]);
    expect(plan.options[0].url).toBe("https://rr/18.mp4");
    expect(plan.primaryIndex).toBe(0);
  });

  it("主链压根不在档位表里时补一条，名字用内核给的档位名而不是「默认」", () => {
    const data = {
      title: "t",
      url: "https://rr/main.mp4",
      qualityLabel: "480P",
      qualities: [{ quality: 720, label: "720P", url: "https://rr/720.mp4" }],
    };
    const plan = buildQualityPlan(data);
    expect(plan.options.map((o) => o.label)).toEqual(["480P", "720P"]);
    expect(plan.primaryIndex).toBe(0);
  });
});

describe("buildFilename 的命名预设（v26 连接符统一为下划线）", () => {
  const ctx = {
    title: "秋日通勤穿搭",
    author: "小明",
    qualitySuffix: "-1080P",
    ext: ".mp4",
  };
  // 固定时刻：日期预设的可复现性不靠碰运气
  const now = new Date(2026, 9, 21, 12, 0, 0);
  const extra = { quality: false, index: false };

  it("authorTitle / titleAuthor：下划线连接，作者缺失退化为仅标题", () => {
    expect(buildFilename(ctx, { preset: "authorTitle", extra }, now)).toBe("小明_秋日通勤穿搭.mp4");
    expect(buildFilename(ctx, { preset: "titleAuthor", extra }, now)).toBe("秋日通勤穿搭_小明.mp4");
    expect(buildFilename({ ...ctx, author: undefined }, { preset: "titleAuthor", extra }, now)).toBe(
      "秋日通勤穿搭.mp4"
    );
  });

  it("authorTitleDate：三要素全上，作者缺失就是 titleDate", () => {
    expect(buildFilename(ctx, { preset: "authorTitleDate", extra }, now)).toBe("小明_秋日通勤穿搭_20261021.mp4");
    expect(buildFilename({ ...ctx, author: undefined }, { preset: "authorTitleDate", extra }, now)).toBe(
      "秋日通勤穿搭_20261021.mp4"
    );
  });
});

describe("buildPlan 的图集形态", () => {
  it("主直链 = 首张图时不展开成视频项：五张图就是五个 .jpg，第一张不会变成 .mp4", () => {
    // 内核微博图集分支：url 与 cover 都写成 images[0]。旧口径把它当主视频，
    // 计划第一项是 kind=video、文件名 .mp4 —— 落盘得到一个打不开的文件，界面上却不报错。
    const imgs = ["https://wx3.sinaimg.cn/a.jpg", "https://wx4.sinaimg.cn/b.jpg"];
    const data: ParseData = { title: "t", type: "image", url: imgs[0], cover: imgs[0], images: imgs };
    const plan = buildPlan(data, buildQualityPlan(data).options[0]);
    expect(plan.map((p) => p.kind)).toEqual(["image", "image"]);
    expect(plan.map((p) => p.filename)).toEqual(["t-1.jpg", "t-2.jpg"]);
  });
});

/**
 * DASH 双轨一律合流（契约 v33）。下载计划这一层只负责把音频轨挂到视频项上，
 * 真正的并流在下载器里；这里钉的是「挂对了没有、有没有多产一条重复音频」。
 */
describe("buildPlan 的 DASH 音频轨", () => {
  it("主链是 .m4s 且有 audioUrl → 视频项带着它，且不再额外产「音频」项", () => {
    const data = {
      title: "t",
      url: "https://upos.hdslb.com/v/80.m4s?e=1",
      audioUrl: "https://upos.hdslb.com/a/30280.m4s?e=1",
    };
    const plan = buildPlan(data);
    // 默认档只有一条：音频已并入视频，再产一条就是让用户白下一个重复文件
    expect(plan.map((p) => p.id)).toEqual(["main"]);
    expect(plan[0].audioUrl).toBe(data.audioUrl);
  });

  it("渐进式单文件不叠音频轨：durl / 其它平台的 mp4 本身就有声音", () => {
    const data = { title: "t", url: "https://cdn/v.mp4", audioUrl: "https://cdn/a.m4s" };
    const plan = buildPlan(data);
    expect(plan[0].audioUrl).toBeUndefined();
    expect(plan.map((p) => p.id)).toEqual(["main"]);
  });

  it("选了高于主链的档：YouTube 的链没有 .m4s，也必须挂音轨（否则静音且没有音量按钮）", () => {
    const data = {
      title: "t",
      // 主链是渐进式 360P（自带音轨）；1080P 是 googlevideo 的 video-only 链
      url: "https://rr/18.mp4",
      audioUrl: "https://rr/audio.m4a",
      qualityLabel: "360P",
      qualities: [
        { quality: 1080, label: "1080P", url: "https://rr/videoplayback?itag=137" },
        { quality: 360, label: "360P", url: "https://rr/18.mp4" },
      ],
    };
    const hd = buildQualityPlan(data).options.find((o) => o.label === "1080P");
    if (!hd) throw new Error("应当有 1080P 档");
    const entry = buildPlan(data, hd)[0];
    expect(entry.url).toBe("https://rr/videoplayback?itag=137");
    expect(entry.audioUrl).toBe(data.audioUrl);
  });

  it("选中主链那条时不白合一次：它自己就有音轨", () => {
    const data = {
      title: "t",
      url: "https://rr/18.mp4",
      audioUrl: "https://rr/audio.m4a",
      qualityLabel: "360P",
      qualities: [
        { quality: 1080, label: "1080P", url: "https://rr/videoplayback?itag=137" },
        { quality: 360, label: "360P", url: "https://rr/18.mp4" },
      ],
    };
    const sd = buildQualityPlan(data).options.find((o) => o.label === "360P");
    if (!sd) throw new Error("应当有 360P 档");
    expect(buildPlan(data, sd)[0].audioUrl).toBeUndefined();
  });

  it("用户明确选「仅音频」时照旧单独产音频项（排他档不变）", () => {
    const data = { title: "t", url: "https://upos.hdslb.com/v/80.m4s", audioUrl: "https://cdn/a.m4s" };
    const audio = buildQualityPlan(data).options.find((o) => o.audio);
    if (!audio) throw new Error("应当有「仅音频」档");
    const plan = buildPlan(data, audio);
    expect(plan.map((p) => p.kind)).toEqual(["audio"]);
    expect(plan[0].url).toBe(data.audioUrl);
  });
});

/**
 * MSE 预览的轨道身份（契约 v35）：计划项要一路带着两条轨的 codec/容器，
 * 结果卡才能建 SourceBuffer 边拉边播；缺一项就该由 `mseTrackMime` 判 null 并回退合流。
 */
describe("buildPlan 的 MSE 轨道身份", () => {
  it("默认档是双轨 DASH 时，视频项带齐视频轨与音频轨身份", () => {
    const data: ParseData = {
      title: "t",
      url: "https://upos.hdslb.com/v/80.m4s?e=1",
      audioUrl: "https://upos.hdslb.com/a/30280.m4s?e=1",
      videoCodecs: "avc1.64001f",
      videoMimeType: "video/mp4",
      audioCodecs: "mp4a.40.2",
      audioMimeType: "audio/mp4",
    };
    const entry = buildPlan(data)[0];
    expect(entry).toMatchObject({
      audioUrl: data.audioUrl,
      videoCodecs: "avc1.64001f",
      videoMimeType: "video/mp4",
      audioCodecs: "mp4a.40.2",
      audioMimeType: "audio/mp4",
    });
  });

  it("选中具体档位时跟档位的 codec 走，不沿用它顶上那条主链的", () => {
    const data: ParseData = {
      title: "t",
      url: "https://upos.hdslb.com/v/80.m4s",
      audioUrl: "https://upos.hdslb.com/a/30280.m4s",
      videoCodecs: "avc1.64001f",
      videoMimeType: "video/mp4",
      audioCodecs: "mp4a.40.2",
      audioMimeType: "audio/mp4",
      qualities: [
        { quality: 120, label: "4K", url: "https://upos.hdslb.com/v/120.m4s", codecs: "av01.0.08M.08", mimeType: "video/mp4" },
        { quality: 80, label: "1080P", url: "https://upos.hdslb.com/v/80.m4s", codecs: "avc1.64001f", mimeType: "video/mp4" },
      ],
    };
    // 「4K」按清晰度文案归一落成 2160P（业主 2026-10-23：一律 P 记法）
    const uhd = buildQualityPlan(data).options.find((o) => o.label === "2160P");
    if (!uhd) throw new Error("应当有 2160P 档");
    const entry = buildPlan(data, uhd)[0];
    expect(entry.videoCodecs).toBe("av01.0.08M.08");
    expect(entry.videoMimeType).toBe("video/mp4");
    // 音频轨只有顶层一条，身份跟着它走
    expect(entry.audioCodecs).toBe("mp4a.40.2");
  });

  it("渐进式主链即便带了 audioUrl（如抖音 BGM）也不产轨道身份：它走 <video> 直读", () => {
    const data: ParseData = {
      title: "t",
      url: "https://cdn/v.mp4",
      audioUrl: "https://cdn/bgm.mp3",
    };
    const entry = buildPlan(data)[0];
    expect(entry.audioUrl).toBeUndefined();
    expect(entry.videoCodecs).toBeUndefined();
    expect(entry.audioCodecs).toBeUndefined();
  });
});

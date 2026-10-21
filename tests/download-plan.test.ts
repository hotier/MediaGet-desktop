/**
 * 下载计划的纯函数分支：卡片按钮上的「下载 N 项」与用户真正会落盘的清单都从这里出，
 * 展开错了不会报错、只会静默多下/少下一颗。只钉语义最容易错的两档。
 */
import { describe, expect, it } from "vitest";
import { buildFilename, buildPlan, buildQualityPlan } from "../renderer/src/lib/download-plan";
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
    expect(plan.options.map((o) => o.label)).toEqual(["高清 1080P", "高清 720P"]);
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

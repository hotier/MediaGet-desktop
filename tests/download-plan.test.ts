/**
 * 下载计划的纯函数分支：卡片按钮上的「下载 N 项」与用户真正会落盘的清单都从这里出，
 * 展开错了不会报错、只会静默多下/少下一颗。只钉语义最容易错的两档。
 */
import { describe, expect, it } from "vitest";
import { buildPlan, buildQualityPlan } from "../renderer/src/lib/download-plan";
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

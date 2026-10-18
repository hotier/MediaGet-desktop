/**
 * `describeResourceMix` 是结果卡通用骨架的数据源：它只回答「这份结果里有几种什么」，
 * 不再像旧的 `deriveShape` 那样把形态互斥分类（视频 + 图片会被判成其中一种，另一半直接消失）。
 * 卡的哪一段出现由它决定，所以「同一条 URL 只算一个视频」「封面从哪来」这类口径要钉住。
 */
import { describe, expect, it } from "vitest";
import { describeResourceMix } from "../renderer/src/lib/download-plan";

describe("describeResourceMix", () => {
  it("没有 data = 纯文字，不给任何媒体计数", () => {
    const mix = describeResourceMix(undefined);
    expect(mix).toEqual({ videoCount: 0, imageCount: 0, hasAudio: false, textOnly: true });
  });

  it("主直链与 videos[0] 是同一份时只算一个视频", () => {
    const mix = describeResourceMix({
      url: "https://cdn/p1.mp4",
      videos: [{ url: "https://cdn/p1.mp4" }],
    });
    expect(mix.videoCount).toBe(1);
    expect(mix.textOnly).toBe(false);
    expect(mix.primaryVideo?.url).toBe("https://cdn/p1.mp4");
  });

  it("多 P 按去重后的视频 URL 计数", () => {
    const mix = describeResourceMix({
      url: "https://cdn/p1.mp4",
      videos: [{ url: "https://cdn/p1.mp4" }, { url: "https://cdn/p2.mp4" }, { url: "https://cdn/p3.mp4" }],
    });
    expect(mix.videoCount).toBe(3);
  });

  it("视频 + 图片同时保留，不互相吞掉", () => {
    const mix = describeResourceMix({
      url: "https://cdn/v.mp4",
      images: ["https://cdn/1.jpg", "https://cdn/2.jpg"],
    });
    expect(mix.videoCount).toBe(1);
    expect(mix.imageCount).toBe(2);
    expect(mix.textOnly).toBe(false);
  });

  it("仅音频不是纯文字", () => {
    const mix = describeResourceMix({ audioUrl: "https://cdn/a.mp3" });
    expect(mix.hasAudio).toBe(true);
    expect(mix.videoCount).toBe(0);
    expect(mix.textOnly).toBe(false);
  });

  it("只有文字 = textOnly", () => {
    const mix = describeResourceMix({ title: "一条动态", desc: "正文" });
    expect(mix.textOnly).toBe(true);
    expect(mix.primaryVideo).toBeUndefined();
  });

  it("图集帖的主直链就是首图：不算视频，也不给主视频", () => {
    // 内核微博分支 `url = images[0]` + `type: "image"`（2026-10-18 实测载荷同形）。
    // 旧口径无条件把 data.url 记成视频，五张图的帖子会显示成「视频 1 · 图 5」。
    const mix = describeResourceMix({
      type: "image",
      url: "https://wx3.sinaimg.cn/1.jpg",
      cover: "https://wx3.sinaimg.cn/1.jpg",
      images: ["https://wx3.sinaimg.cn/1.jpg", "https://wx4.sinaimg.cn/2.jpg"],
    });
    expect(mix.videoCount).toBe(0);
    expect(mix.imageCount).toBe(2);
    expect(mix.primaryVideo).toBeUndefined();
    expect(mix.textOnly).toBe(false);
  });

  it("视频 + 附图时主直链不在 images 里，照旧算一个视频", () => {
    const mix = describeResourceMix({
      url: "https://wx3.sinaimg.cn/v.mp4",
      images: ["https://wx3.sinaimg.cn/1.jpg"],
    });
    expect(mix.videoCount).toBe(1);
    expect(mix.primaryVideo?.url).toBe("https://wx3.sinaimg.cn/v.mp4");
  });

  it("封面优先级：平台封面 → 首图 → 分 P 封面 → 音乐封面", () => {
    expect(
      describeResourceMix({
        cover: "https://cdn/cover.jpg",
        images: ["https://cdn/1.jpg"],
        videos: [{ url: "https://cdn/v.mp4", cover: "https://cdn/p-cover.jpg" }],
        music: { author: "a", avatar: "https://cdn/m.jpg" },
      }).cover
    ).toBe("https://cdn/cover.jpg");

    expect(
      describeResourceMix({
        images: ["https://cdn/1.jpg"],
        videos: [{ url: "https://cdn/v.mp4", cover: "https://cdn/p-cover.jpg" }],
        music: { author: "a", avatar: "https://cdn/m.jpg" },
      }).cover
    ).toBe("https://cdn/1.jpg");

    expect(
      describeResourceMix({
        videos: [{ url: "https://cdn/v.mp4", cover: "https://cdn/p-cover.jpg" }],
        music: { author: "a", avatar: "https://cdn/m.jpg" },
      }).cover
    ).toBe("https://cdn/p-cover.jpg");

    expect(describeResourceMix({ music: { author: "a", avatar: "https://cdn/m.jpg" } }).cover).toBe(
      "https://cdn/m.jpg"
    );
  });
});

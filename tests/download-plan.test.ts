/**
 * 下载计划（结果卡清单层）纯函数单测。
 *
 * 守的是三件容易静默出错的事：
 *  1. 多 P 请求的清晰度不存在时，必须显式回落并标注，不能悄悄下低清；
 *  2. 同一一直链被 url 与 videos[0] 双写时只下一份；
 *  3. 「仅音频」不能附带主视频。
 */
import { describe, expect, it } from "vitest";
import { buildPlan, buildQualityOptions, buildQualityPlan, summarize } from "../renderer/src/lib/download-plan";
import type { ParseData } from "../types/ipc";

const base: ParseData = { title: "示例视频", url: "https://cdn/a.mp4" };

describe("buildQualityPlan", () => {
  it("主直链本身就是某一档：该档只出现一次，且被默认选中", () => {
    const data: ParseData = {
      title: "示例视频",
      url: "https://cdn/720.mp4",
      qualityLabel: "720P",
      qualities: [
        { quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" },
        { quality: 720, label: "720P", url: "https://cdn/720.mp4" },
      ],
      audioUrl: "https://cdn/a.mp3",
    };
    const plan = buildQualityPlan(data);
    expect(plan.options.map((o) => o.label)).toEqual(["1080P", "720P", "仅音频"]);
    expect(plan.primaryIndex).toBe(1);
    // 默认下的必须是内核给的那条，而不是列表里最高的那档
    expect(buildPlan(data, plan.options[plan.primaryIndex])[0].url).toBe("https://cdn/720.mp4");
  });

  it("主直链不在 qualities 里才补一个默认档 chip，并占首位", () => {
    const data: ParseData = {
      ...base,
      qualityLabel: "720P",
      qualities: [{ quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" }],
    };
    const plan = buildQualityPlan(data);
    expect(plan.options.map((o) => o.label)).toEqual(["720P", "1080P"]);
    expect(plan.primaryIndex).toBe(0);
    expect(plan.options[0].url).toBeNull();
  });

  it("无 url 也无 qualities 时只剩音频选项", () => {
    expect(buildQualityOptions({ audioUrl: "https://cdn/a.mp3" })).toEqual([
      { label: "仅音频", url: "https://cdn/a.mp3", suffix: "", audio: true },
    ]);
  });
});

describe("buildPlan", () => {
  it("单视频（默认清晰度）→ 一项，文件名不带后缀", () => {
    const opts = buildQualityOptions(base);
    expect(buildPlan(base, opts[0])).toEqual([
      { id: "main", label: "视频 · 默认", kind: "video", url: "https://cdn/a.mp4", filename: "示例视频.mp4" },
    ]);
  });

  it("选中清晰度写进标签与文件名", () => {
    const data: ParseData = { ...base, qualities: [{ quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" }] };
    const plan = buildPlan(data, buildQualityOptions(data)[1]);
    expect(plan[0]).toMatchObject({ label: "视频 · 1080P", url: "https://cdn/1080.mp4", filename: "示例视频-1080P.mp4" });
  });

  it("多 P：缺失的请求清晰度显式回落并标注，不静默降级", () => {
    const data: ParseData = {
      ...base,
      qualities: [{ quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" }],
      videos: [
        { url: "https://cdn/p1.mp4", qualities: [{ quality: 1080, label: "1080P", url: "https://cdn/p1-1080.mp4" }] },
        { url: "https://cdn/p2.mp4", qualities: [{ quality: 720, label: "720P", url: "https://cdn/p2-720.mp4" }] },
      ],
    };
    const plan = buildPlan(data, buildQualityOptions(data)[1]);
    const p2 = plan.find((p) => p.id === "p-1");
    expect(p2).toMatchObject({ url: "https://cdn/p2.mp4", fallbackNote: "无 1080P，用默认清晰度" });
    expect(plan.find((p) => p.id === "p-0")?.url).toBe("https://cdn/p1-1080.mp4");
  });

  it("图集逐张成项（标签含序号，文件名含序号）", () => {
    const data: ParseData = { title: "合集", images: ["https://cdn/1.jpg", "https://cdn/2.jpg"] };
    expect(buildPlan(data).map((p) => p.label)).toEqual(["图 1/2", "图 2/2"]);
    expect(buildPlan(data)[1].filename).toBe("合集-2.jpg");
  });

  it("选「仅音频」= 只有音频项", () => {
    const data: ParseData = { ...base, audioUrl: "https://cdn/a.mp3" };
    const audio = buildQualityOptions(data).find((o) => o.audio)!;
    expect(buildPlan(data, audio).map((p) => p.kind)).toEqual(["audio"]);
  });

  it("同一直链双写（url 与 videos[0]）只保留一项", () => {
    const data: ParseData = { ...base, videos: [{ url: "https://cdn/a.mp4" }] };
    expect(buildPlan(data, buildQualityOptions(data)[0])).toHaveLength(1);
  });

  it("无数据 / 无可用媒体 → 空计划（按钮据此禁用，不产生空任务）", () => {
    expect(buildPlan(undefined)).toEqual([]);
    expect(buildPlan({ title: "只有标题" })).toEqual([]);
  });
});

describe("summarize", () => {
  it("按类型汇总，供按钮与摘要行使用", () => {
    const data: ParseData = {
      title: "t",
      url: "https://cdn/a.mp4",
      audioUrl: "https://cdn/a.mp3",
      videos: [{ url: "https://cdn/p2.mp4" }],
      images: ["https://cdn/1.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg"],
    };
    expect(summarize(buildPlan(data))).toBe("视频 2 · 图 3 · 音频 1");
  });
});

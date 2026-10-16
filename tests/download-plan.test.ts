/**
 * 下载计划（结果卡清单层）纯函数单测。
 *
 * 守的是三件容易静默出错的事：
 *  1. 多 P 请求的清晰度不存在时，必须显式回落并标注，不能悄悄下低清；
 *  2. 同一一直链被 url 与 videos[0] 双写时只下一份；
 *  3. 「仅音频」不能附带主视频。
 */
import { describe, expect, it } from "vitest";
import {
  buildFilename,
  buildPlan,
  buildQualityOptions,
  buildQualityPlan,
  summarize,
  clampTitle,
  deriveShape,
  ellipsizeMiddle,
  TITLE_MAX_LEN,
  type FilenameExtra,
  type FilenamePreset,
} from "../renderer/src/lib/download-plan";
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

  it("highest/lowest 策略按 tier 极值移动默认选中，音频档不参与", () => {
    const data: ParseData = {
      title: "示例视频",
      url: "https://cdn/720.mp4",
      qualities: [
        { quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" },
        { quality: 720, label: "720P", url: "https://cdn/720.mp4" },
        { quality: 480, label: "480P", url: "https://cdn/480.mp4" },
      ],
      audioUrl: "https://cdn/a.mp3",
    };
    expect(buildQualityPlan(data, "highest").primaryIndex).toBe(0);
    expect(buildQualityPlan(data, "lowest").primaryIndex).toBe(2);
    // main 仍指向内核主直链那档
    expect(buildQualityPlan(data, "main").primaryIndex).toBe(1);
  });

  it("单档或无 tier 时策略不改变默认选中", () => {
    const single: ParseData = {
      url: "https://cdn/a.mp4",
      qualities: [{ quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" }],
    };
    expect(buildQualityPlan(single, "highest").primaryIndex).toBe(0);
    const noTier: ParseData = { url: "https://cdn/a.mp4" };
    expect(buildQualityPlan(noTier, "lowest").primaryIndex).toBe(0);
  });

  it("主直链不在 qualities 里时，highest 选中最高档而非补位的默认档", () => {
    const data: ParseData = {
      url: "https://cdn/unknown.mp4",
      qualityLabel: "标清",
      qualities: [
        { quality: 480, label: "480P", url: "https://cdn/480.mp4" },
        { quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" },
      ],
    };
    const plan = buildQualityPlan(data, "highest");
    expect(plan.primaryIndex).toBe(2);
    expect(plan.options[2].label).toBe("1080P");
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

describe("buildFilename 命名规则", () => {
  const ctx = { title: "秋日通勤穿搭", author: "小明", qualitySuffix: "-1080P", ext: ".mp4" };
  const extra = (quality: boolean, index = false): FilenameExtra => ({ quality, index });
  const FIXED = new Date(2026, 9, 15); // 2026-10-15（本地时区，避免时区偏移导致跨日）

  it("仅标题：现状行为，不加任何后缀", () => {
    expect(buildFilename(ctx, { preset: "title", extra: extra(false) })).toBe("秋日通勤穿搭.mp4");
  });

  it("作者 - 标题 / 标题 - 作者：两个方向", () => {
    expect(buildFilename(ctx, { preset: "authorTitle", extra: extra(false) })).toBe("小明 - 秋日通勤穿搭.mp4");
    expect(buildFilename(ctx, { preset: "titleAuthor", extra: extra(false) })).toBe("秋日通勤穿搭 - 小明.mp4");
  });

  it("标题_日期：日期取入队时刻，格式 YYYYMMDD", () => {
    expect(buildFilename(ctx, { preset: "titleDate", extra: extra(false) }, FIXED)).toBe(
      "秋日通勤穿搭_20261015.mp4"
    );
  });

  it("缺作者时退化为仅标题，不留空连接符", () => {
    const noAuthor = { title: "只有标题", ext: ".mp4" };
    expect(buildFilename(noAuthor, { preset: "authorTitle", extra: extra(false) })).toBe("只有标题.mp4");
    expect(buildFilename(noAuthor, { preset: "titleAuthor", extra: extra(false) })).toBe("只有标题.mp4");
  });

  it("空标题回落 media（与旧 buildPlan 的兜底一致）", () => {
    expect(buildFilename({ title: "", ext: ".jpg" }, { preset: "title", extra: extra(false) })).toBe("media.jpg");
  });

  it("清晰度开关：关=不加，开=加后缀", () => {
    expect(buildFilename(ctx, { preset: "title", extra: extra(false) })).toBe("秋日通勤穿搭.mp4");
    expect(buildFilename(ctx, { preset: "title", extra: extra(true) })).toBe("秋日通勤穿搭-1080P.mp4");
  });

  it("序号开关：图集 -3 / 分P -P2", () => {
    const idx = extra(false, true);
    expect(buildFilename({ ...ctx, indexSuffix: "-3", ext: ".jpg" }, { preset: "title", extra: idx })).toBe(
      "秋日通勤穿搭-3.jpg"
    );
    expect(buildFilename({ ...ctx, indexSuffix: "-P2" }, { preset: "title", extra: idx })).toBe(
      "秋日通勤穿搭-P2.mp4"
    );
  });

  it("两个开关独立叠加：主体 + 清晰度 + 序号", () => {
    expect(buildFilename({ ...ctx, indexSuffix: "-2" }, { preset: "authorTitle", extra: extra(true, true) })).toBe(
      "小明 - 秋日通勤穿搭-1080P-2.mp4"
    );
  });

  it("标题限长 15 字：只压标题，作者/后缀/扩展名不受限", () => {
    const longTitle = "秋日通勤穿搭分享第".repeat(20); // 200 字
    const out = buildFilename(
      {
        title: longTitle,
        author: "小明",
        qualitySuffix: "-1080P",
        indexSuffix: "-3",
        ext: ".mp4",
      },
      { preset: "authorTitle", extra: { quality: true, index: true } }
    );
    // 标题部分恰好 15 字（含省略号），作者与后缀原样保留
    expect(out).toBe(`小明 - ${clampTitle(longTitle)}-1080P-3.mp4`);
    expect(clampTitle(longTitle)).toHaveLength(TITLE_MAX_LEN);
    expect(out.endsWith("-1080P-3.mp4")).toBe(true);
    expect(out).toContain("小明"); // 作者没被砍
    // 限制只作用于标题：200 字的标题被压到 15，作者与后缀原样留下
    expect(longTitle.length).toBeGreaterThan(80);
    expect(out).toHaveLength(`小明 - ${clampTitle(longTitle)}-1080P-3.mp4`.length);
  });

  it("标题未超 15 字则原样保留（不引入省略号）", () => {
    expect(clampTitle("秋日通勤穿搭")).toBe("秋日通勤穿搭"); // 6 字
    expect(clampTitle("一二三四五六七八九十")).toBe("一二三四五六七八九十"); // 恰好 10 字
    const exact = "标".repeat(TITLE_MAX_LEN);
    expect(clampTitle(exact)).toBe(exact);
    expect(clampTitle("标".repeat(TITLE_MAX_LEN + 1))).toHaveLength(TITLE_MAX_LEN);
  });

  it("ellipsizeMiddle：头尾都保留、预算严格、emoji 不劈成半个代理", () => {
    expect(ellipsizeMiddle("abcdefghij", 20)).toBe("abcdefghij");
    // 40 字压到 20：走「保留前后 + 省略」分支
    const mid = ellipsizeMiddle("标题内容".repeat(10), 20);
    expect(mid).toHaveLength(20);
    expect(mid).toContain("…");
    expect(mid.startsWith("标题内容")).toBe(true);
    expect(mid.endsWith("标题内容")).toBe(true);
    // 预算小到连省略号都放不下时降级为纯截断（不抛错、不留省略号）
    const tiny = ellipsizeMiddle("标题内容".repeat(10), 2);
    expect(tiny).toHaveLength(2);
    expect(tiny).not.toContain("…");
    // 切点落在 emoji 中间时，两侧都不留半个代理：
    // 逐码元判定「高位后必须跟低位」，比正则更直白也更不易写错
    const withEmoji = ellipsizeMiddle("😀".repeat(20), 20);
    expect(withEmoji).toContain("…");
    for (let i = 0; i < withEmoji.length; i++) {
      const code = withEmoji.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // 高代理后面必须紧跟低位代理，否则就是半个 emoji
        expect(withEmoji.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(withEmoji.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
        i++;
      } else {
        expect(code).toBeLessThan(0xd800); // 孤立低代理同样非法
      }
    }
  });
});

describe("buildPlan 应用命名规则", () => {
  const data: ParseData = {
    title: "合集",
    author: "小明",
    url: "https://cdn/a.mp4",
    images: ["https://cdn/1.jpg", "https://cdn/2.jpg"],
  };
  const rule = { preset: "authorTitle" as FilenamePreset, extra: { quality: false, index: true } };

  it("规则贯穿视频 / 音频 / 图集三项", () => {
    const plan = buildPlan({ ...data, audioUrl: "https://cdn/a.mp3" }, undefined, rule);
    expect(plan.map((p) => p.filename)).toEqual([
      "小明 - 合集.mp4",
      "小明 - 合集.mp3",
      "小明 - 合集-1.jpg",
      "小明 - 合集-2.jpg",
    ]);
  });

  it("缺省 rule = 现状行为（旧调用点与旧配置不变）", () => {
    expect(buildPlan(data)[0].filename).toBe("合集.mp4");
    expect(buildPlan(data).find((p) => p.id === "img-1")?.filename).toBe("合集-2.jpg");
  });
});

describe("deriveShape 资源形态", () => {
  it("按实际拿到的媒体数组判形态，不信契约 type", () => {
    // 抖音图集实测会返回 type:"text"，若按 type 判会错成文字
    expect(deriveShape({ type: "text", images: ["https://cdn/1.jpg"] })).toBe("gallery");
    expect(deriveShape({ type: "video", videos: [{ url: "a" }, { url: "b" }] })).toBe("multi-video");
    expect(deriveShape({ type: "image", url: "https://cdn/a.mp4" })).toBe("single-video");
    expect(deriveShape({ audioUrl: "https://cdn/a.mp3" })).toBe("audio");
    expect(deriveShape({ title: "只有文字" })).toBe("text");
    expect(deriveShape(undefined)).toBe("text");
  });

  it("单个 videos 项不算多视频（那是主视频的另一种写法）", () => {
    expect(deriveShape({ url: "https://cdn/a.mp4", videos: [{ url: "https://cdn/a.mp4" }] })).toBe("single-video");
  });

  it("空 images / 空 videos 数组不改变判定", () => {
    expect(deriveShape({ url: "https://cdn/a.mp4", images: [], videos: [] })).toBe("single-video");
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

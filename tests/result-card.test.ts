/**
 * 结果卡渲染冒烟（react-dom/server，无 DOM）：
 * 不测样式、不测交互，只测「给定契约形态，卡片结构能否成立」——
 * 三层里最容易崩的是下载清单层（多 P / 图集 / 仅音频 / embedOnly / 失败态）。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ResultCard } from "../renderer/src/components/ResultCard";
import type { ParseRunOutcome } from "../types/ipc";

function outcome(data: ParseRunOutcome["result"]["data"], extra: Partial<ParseRunOutcome> = {}): ParseRunOutcome {
  return {
    result: { code: 200, msg: "解析成功", platform: "bilibili", data },
    via: "local",
    durationMs: 120,
    ...extra,
  };
}

const render = (o: ParseRunOutcome): string =>
  renderToStaticMarkup(createElement(ResultCard, { outcome: o, meta: null, onQueued: () => {} }));

describe("ResultCard 三层结构", () => {
  it("信息层：标题/平台/统计行按契约渲染", () => {
    const html = render({
      result: { code: 200, msg: "ok", platform: "bilibili", data: { title: "测试标题", author: "UP主", type: "video", stat: { view: 12345 } } },
      via: "local",
      durationMs: 120,
    });
    expect(html).toContain("测试标题");
    expect(html).toContain("@UP主");
    expect(html).toContain("播放 1.2万");
    // 契约枚举不能当界面文案直出
    expect(html).toContain(">视频<");
    expect(html).not.toContain(">video<");
  });

  it("清单层：摘要行统计各类条目，多 P 缺清晰度显式标注", () => {
    const html = render({
      result: {
        code: 200,
        msg: "ok",
        platform: "bilibili",
        data: {
          title: "合集",
          url: "https://cdn/p1.mp4",
          videos: [{ url: "https://cdn/p1.mp4" }, { url: "https://cdn/p2.mp4" }],
          images: ["https://cdn/1.jpg", "https://cdn/2.jpg"],
        },
      },
      via: "local",
      durationMs: 120,
    });
    // 初始折叠：只显示摘要与开关，不铺满整屏
    expect(html).toContain("下载清单");
    // 内核把主视频同时写进 url 与 videos[0].url，这一份必须折叠成一项而不是下两遍
    expect(html).toContain("视频 2 · 图 2");
    expect(html).not.toContain("分 P 1");
    expect(html).toContain("下载 4 项");
    // 默认清晰度不设「想要的画质」，因此不该出现回落标注
    expect(html).not.toContain("无 1080P，用默认清晰度");
  });

  it("选择层：清晰度多于一个才出现", () => {
    const withQualities = render(
      outcome({
        title: "t",
        url: "https://cdn/d.mp4",
        qualities: [{ quality: 1080, label: "1080P", url: "https://cdn/1080.mp4" }],
      })
    );
    expect(withQualities).toContain("选择清晰度");
    expect(withQualities).toContain("1080P");
    expect(render(outcome({ title: "t", url: "https://cdn/d.mp4" }))).not.toContain("选择清晰度");
  });

  it("按钮文案由清单生成（多项=「下载 N 项」）", () => {
    const html = render(
      outcome({ title: "t", url: "https://cdn/a.mp4", images: ["https://cdn/1.jpg", "https://cdn/2.jpg"] })
    );
    expect(html).toContain("下载 3 项");
  });

  it("embedOnly：不给下载按钮，只给浏览器打开", () => {
    const html = render(outcome({ title: "t", embedOnly: true, embedUrl: "https://play/x" }));
    expect(html).toContain("在浏览器中打开播放");
    expect(html).not.toContain("下载 1 项");
  });

  it("失败态：原文案 + failType + 重试", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, {
        outcome: { result: { code: 500, msg: "风控拦截", failType: "bot-gated" }, via: "local", durationMs: 80 },
        meta: null,
        onQueued: () => {},
        onRetry: () => {},
      })
    );
    expect(html).toContain("解析失败");
    expect(html).toContain("bot-gated");
    expect(html).toContain("重试");
  });
});

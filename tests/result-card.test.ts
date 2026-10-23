/**
 * 结果卡渲染冒烟（react-dom/server，无 DOM）：
 * 不测样式、不测交互，只测「给定契约形态，通用骨架的各段能否成立」——
 * 最容易崩的是下载清单层（多 P / 图集 / 仅音频 / embedOnly / 失败态），
 * 以及「视频 + 图片」这类旧互斥分类会丢一半的混合形态。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ResultCard } from "../renderer/src/components/ResultCard";
import { TooltipProvider } from "../renderer/src/components/ui/tooltip";
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
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ResultCard, { outcome: o, onQueued: () => {} }))
  );

describe("ResultCard 通用骨架", () => {
  it("身份带：标题带平台图标、作者与计数直出、契约枚举不外泄", () => {
    const html = render({
      result: {
        code: 200,
        msg: "ok",
        platform: "bilibili",
        data: { title: "测试标题", author: "UP主", type: "video", url: "https://cdn/a.mp4", stat: { view: 12345 } },
      },
      via: "local",
      durationMs: 120,
    });
    expect(html).toContain("测试标题");
    expect(html).toContain("logos/bilibili.svg"); // 平台图标挂在标题左边
    expect(html).toContain("lucide-circle-fading-play"); // 播放 = 图标
    expect(html).toContain("1.2万");
    expect(html).not.toContain("播放 1.2万"); // 文字标签已撤（业主精简：图标 + 数值直显）
    expect(html).toContain("UP主"); // 作者回到身份带（确认「是谁的作品」）
    // 契约枚举不能当界面文案直出
    expect(html).not.toContain(">video<");
  });

  it("作者行：无头像时首字占位，只留昵称（发布日期已撤）", () => {
    const html = render(
      outcome({ title: "t", url: "https://cdn/a.mp4", author: "小明", time: 1_700_000_000 })
    );
    expect(html).toContain(">小<"); // AuthorAvatar 无图退路
    expect(html).toContain("小明");
    // 2026-10-18 业主指令：发布时间移出卡面（历史/导出仍留档）。
    // data.time 照旧在场，卡上一个「发布」字样都不该有——防它从别的入口长回来。
    expect(html).not.toContain("发布");
  });

  it("单一形态不打徽标：形态与 type 都不许在信息层占位", () => {
    const html = render({
      result: { code: 200, msg: "ok", platform: "qsmusic", data: { title: "歌", type: "text", url: "https://cdn/a.mp3" } },
      via: "local",
      durationMs: 30,
    });
    expect(html).not.toContain("单视频");
    expect(html).not.toContain("文字");
  });

  it("清单层默认折叠：文件行要点开才铺", () => {
    const html = render({
      result: {
        code: 200,
        msg: "ok",
        platform: "bilibili",
        data: {
          title: "合集",
          url: "https://cdn/p1.mp4",
          qualities: [
            { quality: 1080, label: "1080P", url: "https://cdn/p1-1080.m4s" },
            { quality: 720, label: "720P", url: "https://cdn/p1-720.m4s" },
          ],
          videos: [{ url: "https://cdn/p1.mp4" }, { url: "https://cdn/p2.mp4" }],
          images: ["https://cdn/1.jpg", "https://cdn/2.jpg"],
        },
      },
      via: "local",
      durationMs: 120,
    });
    expect(html).toContain("展开资源"); // 开关在
    // 靠左（业主指令 2026-10-18）：DOM 顺序上它排在清晰度与下载之前，
    // 摘要把它挤到右侧的那版布局不许回来
    expect(html.indexOf("展开资源")).toBeLessThan(html.indexOf("下载清晰度"));
    expect(html.indexOf("展开资源")).toBeLessThan(html.indexOf("下载 4 项"));
    // 动作条不放预览按钮（主视觉本身就是入口）；行内「预览/下载」随清单展开才出现，
    // 收起时一个都不该提前铺
    expect(html).not.toContain(">预览<");
    expect(html).toContain('aria-label="预览视频"'); // 主视觉入口仍在
    expect(html).toContain("下载清晰度"); // 清晰度在动作条（设置里只是默认值）
    expect(html).not.toContain("合集.mp4"); // 文件行没铺开
    expect(html).not.toContain("合集-P1.mp4");
    expect(html).not.toContain("无 1080P，用默认清晰度");
    // 构成摘要（「视频 N · 图 N」）2026-10-18 业主指令撤出动作条：下载按钮的项数
    // 已经把「点下去会得到几颗」说清楚，再排一行是重复信息。反向钉住，防它长回来。
    expect(html).not.toContain("视频 2 · 图 2");
    // 去重仍必须在：内核把主视频同时写进 url 与 videos[0].url，这一份只下一次
    expect(html).toContain("下载 4 项");
    expect(html).not.toContain("下载 5 项");
    // 多 P 不再铺在卡面（业主 2026-10-18：多资源只留一张封面，其余从封面点进去翻页）——
    // 收起态一条分 P 明细都不该出现，全部分 P 只在资源列表里
    expect(html).not.toContain("分 P 1");
    expect(html).not.toContain("分 P 2");
  });

  it("视频 + 图片：主视觉只放一张，图片不再铺缩略条", () => {
    const html = render(
      outcome({
        title: "混合",
        url: "https://cdn/v.mp4",
        cover: "https://cdn/cover.jpg",
        images: ["https://cdn/1.jpg", "https://cdn/2.jpg"],
        duration: 179_000,
      })
    );
    expect(html).toContain("02:59"); // 时长进主视觉角标，不再挤在统计行
    // 缩略条已撤：两张图都只在图集弹窗里，卡面一块封面到底
    expect(html).not.toContain("查看第 1 张图");
    expect(html).not.toContain("查看第 2 张图");
    expect(html).toContain("下载 3 项");
  });

  it("时长单位恒为毫秒：1 分 30 秒不许显示成 25 小时（2026-10-19 事故）", () => {
    // 事故形状：短片毫秒值 90867 落在旧代码「> 100000 才当毫秒」的阈值下，
    // 被当成秒 → 25:14:27。内核 d.ts 写明 ParseData.duration 全平台统一毫秒，
    // 故此断言钉在 /1000 这一条上，不留「猜单位」的余地。
    const html = render(outcome({ title: "短片", url: "https://cdn/s.mp4", duration: 90_867 }));
    expect(html).toContain("01:31");
    expect(html).not.toContain("25:14:27");
  });

  it("纯图集：封面就是第一张图，其余只在预览弹窗里翻", () => {
    const html = render(outcome({ title: "图集", images: ["https://cdn/1.jpg", "https://cdn/2.jpg"] }));
    expect(html).toContain('aria-label="预览图片"'); // 封面仍是图集入口
    expect(html).not.toContain("查看第 1 张图");
    expect(html).not.toContain("查看第 2 张图");
    expect(html).toContain("下载 2 项");
  });

  it("单档清晰度不出选择器：没有可选项就不摆一个只有一项的下拉", () => {
    const html = render(outcome({ title: "t", url: "https://cdn/a.mp4" }));
    expect(html).not.toContain("下载清晰度");
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
    expect(html).not.toContain("展开资源");
  });

  it("失败态：按 failType 给标题与下一步动作", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, {
        outcome: { result: { code: 500, msg: "风控拦截", failType: "bot-gated" }, via: "local", durationMs: 80 },
        sourceUrl: "https://v.douyin.com/abc/",
        onQueued: () => {},
        onRetry: () => {},
      })
    );
    // failType 决定标题与动作：bot-gated 不是说「解析失败」而是说「平台要登录」
    expect(html).toContain("平台要求登录或验证");
    expect(html).toContain("bot-gated");
    expect(html).toContain("重试");
    expect(html).toContain("在浏览器打开");
    // 原始 msg 不能藏：技术详情默认折叠（不默认铺技术文本），但入口必须在
    expect(html).toContain("技术详情");
  });

  it("失败态：未知 failType 回落原文案，不猜", () => {
    const html = renderToStaticMarkup(
      createElement(ResultCard, {
        outcome: { result: { code: 500, msg: "某种新错误", failType: "brand-new" }, via: "local", durationMs: 80 },
        onQueued: () => {},
        onRetry: () => {},
      })
    );
    expect(html).toContain("解析失败");
    expect(html).toContain("某种新错误");
  });
});

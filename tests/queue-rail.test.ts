/**
 * 队列轨渲染冒烟（react-dom/server，无 DOM）：右栏是解析页与队列状态的唯一连接，
 * 守三件事——完成/取消的不占位、进度百分比来自契约、空态有引导而不是一片空白。
 * shadcn 迁移后断言只看语义（role/aria/data 钩子与文案），不看 class 名：
 * utility 串是主题的实现细节，钉住它等于每次换样式都改测试。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueRail } from "../renderer/src/components/QueueRail";
import type { DownloadTaskView } from "../types/ipc";

function task(over: Partial<DownloadTaskView>): DownloadTaskView {
  return {
    taskId: "t-1",
    groupId: "g-1",
    url: "https://mirror.example/a.mp4",
    filename: "示例视频.mp4",
    kind: "video",
    status: "downloading",
    received: 50,
    total: 100,
    speed: 1024 * 1024,
    createdAt: 0,
    ...over,
  };
}

const render = (tasks: DownloadTaskView[]): string =>
  renderToStaticMarkup(createElement(QueueRail, { tasks, onShowAll: () => {} }));

describe("QueueRail", () => {
  it("下载中：文件名 + 百分比 + 进度条", () => {
    const html = render([task({})]);
    expect(html).toContain("示例视频.mp4");
    expect(html).toContain("50%");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
  });

  it("完成与已取消不占右栏（右栏只关心还没结束的事）", () => {
    const html = render([
      task({ taskId: "a", status: "done" }),
      task({ taskId: "b", status: "canceled" }),
    ]);
    expect(html).toContain("暂无进行中的任务");
    expect(html).not.toContain('data-slot="progress"');
  });

  it("未知总长时显示已收字节而不是百分比", () => {
    const html = render([task({ total: 0, received: 2 * 1024 * 1024 })]);
    expect(html).toContain("2.0 MB");
    expect(html).not.toMatch(/>\d+%</);
  });

  it("失败态标色并带上任务状态文案", () => {
    const html = render([task({ status: "error", error: "HTTP 403" })]);
    expect(html).toContain("失败");
    expect(html).toContain('data-status="error"');
    expect(html).toContain('title="HTTP 403"');
  });

  it("超过 8 条折叠，计数仍显示全量", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      task({ taskId: `t-${i}`, filename: `秋日通勤穿搭-${i + 1}.jpg` })
    );
    const html = render(many);
    expect(html).toContain("秋日通勤穿搭-8.jpg");
    expect(html).not.toContain("秋日通勤穿搭-9.jpg");
    expect(html).toContain(">12<");
  });

  it("空队列也给「打开完整队列」出口，右栏不塌成空白", () => {
    expect(render([])).toContain("打开完整队列");
  });
});

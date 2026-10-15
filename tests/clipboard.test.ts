/**
 * 剪贴板监听（electron/main/clipboard.ts）：
 * 开启前不轮询、开启瞬间认账已有内容、变化才识别、未识别/超长不投递。
 * 假时钟驱动间隔（异步链用 advanceTimersByTimeAsync 冲）；readText / identify 注入，不碰 Electron。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClipboardWatcher } from "../electron/main/clipboard";
import type { IdentifyOutcome } from "../types/ipc";

const LINK = "看看这个 https://v.douyin.com/abc123/ 的视频";

function harness() {
  let current = "";
  const links: IdentifyOutcome[] = [];
  const watcher = createClipboardWatcher({
    readText: () => current,
    identify: (text) => {
      const url = text.match(/https?:\/\/\S+/)?.[0] ?? null;
      const platform = url && /douyin/.test(url) ? "douyin" : "";
      return {
        platform,
        platformName: platform ? "抖音" : "",
        url,
        kind: url ? (text.trim() === url ? "url" : "share-text") : "unknown",
      };
    },
    onLink: (l) => links.push(l),
    intervalMs: 50,
  });
  return {
    watcher,
    links,
    setClipboard: (t: string) => {
      current = t;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("剪贴板监听", () => {
  it("未开启：轮询不发生", async () => {
    const { watcher, links, setClipboard } = harness();
    setClipboard(LINK);
    await vi.advanceTimersByTimeAsync(500);
    expect(links).toHaveLength(0);
    watcher.dispose();
  });

  it("开启瞬间认账已有内容：只有之后的新复制才触发", async () => {
    const { watcher, links, setClipboard } = harness();
    setClipboard("开启前的旧内容 https://v.douyin.com/old/");
    watcher.setEnabled(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(links).toHaveLength(0);

    setClipboard(LINK);
    await vi.advanceTimersByTimeAsync(50);
    expect(links).toEqual([
      { platform: "douyin", platformName: "抖音", url: "https://v.douyin.com/abc123/", kind: "share-text" },
    ]);
    watcher.dispose();
  });

  it("同一条复制两次（文本未变）只投一次", async () => {
    const { watcher, links, setClipboard } = harness();
    watcher.setEnabled(true);
    setClipboard(LINK);
    await vi.advanceTimersByTimeAsync(50);
    setClipboard(LINK);
    await vi.advanceTimersByTimeAsync(200);
    expect(links).toHaveLength(1);
    watcher.dispose();
  });

  it("未识别（无链接）/ 超长文本不投递", async () => {
    const { watcher, links, setClipboard } = harness();
    watcher.setEnabled(true);
    setClipboard("只是普通文字，没有链接");
    await vi.advanceTimersByTimeAsync(100);
    setClipboard(`x${LINK}${"y".repeat(4000)}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(links).toHaveLength(0);
    watcher.dispose();
  });

  it("关闭后不再触发；重开再次认账当前内容", async () => {
    const { watcher, links, setClipboard } = harness();
    watcher.setEnabled(true);
    await vi.advanceTimersByTimeAsync(50);
    watcher.setEnabled(false);
    setClipboard(LINK);
    await vi.advanceTimersByTimeAsync(200);
    expect(links).toHaveLength(0);

    watcher.setEnabled(true); // 此刻剪贴板里已是 LINK：认账，不补投
    await vi.advanceTimersByTimeAsync(200);
    expect(links).toHaveLength(0);
    watcher.dispose();
  });

  it("启用等待认账期间快速关闭：定时器不残留", async () => {
    const { watcher, links, setClipboard } = harness();
    watcher.setEnabled(true);
    watcher.setEnabled(false); // seed 还未 resolve
    setClipboard(LINK);
    await vi.advanceTimersByTimeAsync(300);
    expect(links).toHaveLength(0);
    watcher.dispose();
  });

  it("dispose 后停止轮询", async () => {
    const { watcher, links, setClipboard } = harness();
    watcher.setEnabled(true);
    await vi.advanceTimersByTimeAsync(50);
    watcher.dispose();
    setClipboard(LINK);
    await vi.advanceTimersByTimeAsync(300);
    expect(links).toHaveLength(0);
  });
});

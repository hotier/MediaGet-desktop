/**
 * 剪贴板监听（electron/main/clipboard.ts）：
 * 开启前不轮询、开启瞬间认账已有内容、变化才识别、未识别/超长不投递；
 * checkNow（全局快捷键）与轮询共用同一道识别闸门，只是不受开关与「变化」约束。
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

  it("checkNow：未开启也投、同一条连按两次投两次，且不污染轮询的「已见过」", async () => {
    const { watcher, links, setClipboard } = harness();
    setClipboard(LINK);
    watcher.checkNow(); // 开关没开：快捷键按下去照样认
    await vi.advanceTimersByTimeAsync(0);
    expect(links).toHaveLength(1);
    watcher.checkNow(); // 同一条再按一次：显式意图，投第二次
    await vi.advanceTimersByTimeAsync(0);
    expect(links).toHaveLength(2);

    watcher.setEnabled(true); // 认账的正是刚 checkNow 读过的那一条 ⇒ 不补投
    await vi.advanceTimersByTimeAsync(300);
    expect(links).toHaveLength(2);
    watcher.dispose();
  });

  it("checkNow 走同一条识别闸门：普通文字与超长文本都不投", async () => {
    const { watcher, links, setClipboard } = harness();
    setClipboard("只是普通文字");
    watcher.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    setClipboard(`x${LINK}${"y".repeat(4000)}`);
    watcher.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(links).toHaveLength(0);
    watcher.dispose();
  });

  it("identify 抛异常不冒泡（快捷键调用方是主进程，没有 try/catch 兜着）", async () => {
    const links: IdentifyOutcome[] = [];
    const watcher = createClipboardWatcher({
      readText: () => LINK,
      identify: () => {
        throw new Error("内核炸了");
      },
      onLink: (l) => links.push(l),
      intervalMs: 50,
    });
    watcher.checkNow();
    await vi.advanceTimersByTimeAsync(200);
    expect(links).toHaveLength(0);
    watcher.dispose();
  });
});

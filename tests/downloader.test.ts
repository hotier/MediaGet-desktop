/**
 * 下载器核心行为测试（断点续传 / Range / Referer / 冲突命名 / 失败隔离 / SSRF 闸门）
 * 用注入 fetchImpl 完全离线。
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Downloader,
  isSafeRemoteUrl,
  resolveConflictPath,
  type PersistedQueueLike,
} from "../electron/main/downloader";
import type { DownloadTaskView } from "../types/ipc";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "mg-dl-test-"));
}

function makeDownloader(dir: string, fetchImpl: typeof fetch, maxConcurrent = 3) {
  const events: DownloadTaskView[] = [];
  const history: { groupTask: DownloadTaskView; files: string[] }[] = [];
  let persisted: PersistedQueueLike[] = [];
  const dl = new Downloader({
    getDownloadDir: () => dir,
    getMaxConcurrent: () => maxConcurrent,
    getRetryTimes: () => 2, // 与旧内置 MAX_ATTEMPTS=3 等价的总尝试数
    getKeepPartials: () => false,
    defaultUserAgent: "UA-TEST",
    fetchImpl,
    events: {
      progress: (t) => events.push(t),
      done: (t) => events.push(t),
      error: (t) => events.push(t),
      persist: (tasks) => {
        persisted = tasks;
      },
      history: (e) => history.push(e),
    },
  });
  return { dl, events, history, getPersisted: () => persisted };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等到谓词满足或超时 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await sleep(intervalMs);
  }
}

describe("isSafeRemoteUrl（SSRF 闸门）", () => {
  it("放行公网 http/https", () => {
    expect(isSafeRemoteUrl("https://v.douyin.com/abc/")).toBe(true);
    expect(isSafeRemoteUrl("http://cdn.example.com/a.mp4")).toBe(true);
  });
  it("拒绝私网/回环/元数据/非 http 协议", () => {
    expect(isSafeRemoteUrl("http://127.0.0.1/a")).toBe(false);
    expect(isSafeRemoteUrl("http://localhost/a")).toBe(false);
    expect(isSafeRemoteUrl("http://10.0.0.5/a")).toBe(false);
    expect(isSafeRemoteUrl("http://192.168.1.1/a")).toBe(false);
    expect(isSafeRemoteUrl("http://172.16.0.1/a")).toBe(false);
    expect(isSafeRemoteUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isSafeRemoteUrl("file:///C:/Windows/system32/config/sam")).toBe(false);
    expect(isSafeRemoteUrl("ftp://example.com/a")).toBe(false);
    expect(isSafeRemoteUrl("not-a-url")).toBe(false);
  });
  it("放行 172.15 与 172.32（非私网段不误伤）", () => {
    expect(isSafeRemoteUrl("http://172.15.0.1/a")).toBe(true);
    expect(isSafeRemoteUrl("http://172.32.0.1/a")).toBe(true);
  });
});

describe("resolveConflictPath（同名序号，只看最终文件）", () => {
  it("无冲突原样；有冲突加 (n)", () => {
    const dir = makeTempDir();
    expect(basename(resolveConflictPath(dir, "a.mp4"))).toBe("a.mp4");
    writeFileSync(join(dir, "a.mp4"), "x");
    expect(basename(resolveConflictPath(dir, "a.mp4"))).toBe("a (2).mp4");
    writeFileSync(join(dir, "a (2).mp4"), "x");
    expect(basename(resolveConflictPath(dir, "a.mp4"))).toBe("a (3).mp4");
    rmSync(dir, { recursive: true, force: true });
  });
});

function fakeResponse(body: Uint8Array, status = 200, headers: Record<string, string> = {}) {
  // TS 5.9 泛型 Uint8Array<ArrayBufferLike> 与 undici BodyInit 的窄签名冲突：值即 bytes，安全转
  return new Response(body as unknown as BodyInit, {
    status,
    headers: { "content-length": String(body.byteLength), ...headers },
  });
}

describe("Downloader 流式落盘", () => {
  it("下载完成：.part rename + 事件 + 历史", async () => {
    const dir = makeTempDir();
    const bytes = new TextEncoder().encode("hello-mediaget");
    let seenHeaders: Headers | undefined;
    const { dl, events, history } = makeDownloader(dir, async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      return fakeResponse(bytes);
    });

    const [taskId] = dl.enqueue(
      [{ url: "https://cdn.example.com/v.mp4", filename: "v.mp4", kind: "video", referer: "https://douyin.com/" }],
      "g1",
      { platform: "douyin", title: "测试视频", author: { name: "信号铺子", id: "9527", followerCount: 12000 } }
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"));

    const target = join(dir, "v.mp4");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("hello-mediaget");
    expect(existsSync(target + ".part")).toBe(false);
    // Referer/UA 组装
    expect(seenHeaders?.get("referer")).toBe("https://douyin.com/");
    expect(seenHeaders?.get("user-agent")).toBe("UA-TEST");
    // done 事件与历史
    expect(events.some((e) => e.taskId === taskId && e.status === "done")).toBe(true);
    expect(history[0]?.files[0]).toBe(target);
    expect(history[0]?.groupTask.platform).toBe("douyin");
    // 作者快照随任务视图外发，并原样进历史（历史页作者列的唯一数据源）
    expect(dl.list().find((t) => t.taskId === taskId)?.author?.name).toBe("信号铺子");
    expect(history[0]?.groupTask.author).toEqual({ name: "信号铺子", id: "9527", followerCount: 12000 });
    // 完成时刻只在 done 时写入（队列页「完成时间」列的数据源）
    expect(dl.list().find((t) => t.taskId === taskId)?.finishedAt).toBeTypeOf("number");
    rmSync(dir, { recursive: true, force: true });
  });

  it("断点续传：同身份 .part 存在带 Range，206 追加写", async () => {
    const dir = makeTempDir();
    // 预置 .part（前 6 字节已下）+ 身份 meta（URL 匹配才会续用）
    const part = join(dir, "resume.mp4.part");
    writeFileSync(part, "abcdef");
    writeFileSync(part + ".meta", "https://cdn.example.com/resume.mp4");
    let reqHeaders: Headers | undefined;
    const { dl } = makeDownloader(dir, async (_input, init) => {
      reqHeaders = new Headers(init?.headers);
      return new Response(new TextEncoder().encode("GHIJKL") as unknown as BodyInit, {
        status: 206,
        headers: { "content-range": "bytes 6-11/12", "content-length": "6" },
      });
    });

    const [taskId] = dl.enqueue(
      [{ url: "https://cdn.example.com/resume.mp4", filename: "resume.mp4", kind: "video" }],
      "g2"
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"));

    expect(reqHeaders?.get("range")).toBe("bytes=6-");
    expect(readFileSync(join(dir, "resume.mp4"), "utf8")).toBe("abcdefGHIJKL");
    expect(existsSync(part + ".meta")).toBe(false); // 完成后身份文件清理
    rmSync(dir, { recursive: true, force: true });
  });

  it("异 URL 遗留 .part → 清理重下（不混写损坏）", async () => {
    const dir = makeTempDir();
    const part = join(dir, "foreign.mp4.part");
    writeFileSync(part, "STALE-FROM-OTHER-VIDEO");
    writeFileSync(part + ".meta", "https://cdn.example.com/OTHER.mp4"); // 别的视频留下的
    let reqHeaders: Headers | undefined;
    const { dl } = makeDownloader(dir, async (_input, init) => {
      reqHeaders = new Headers(init?.headers);
      return fakeResponse(new TextEncoder().encode("FRESH"));
    });
    const [taskId] = dl.enqueue(
      [{ url: "https://cdn.example.com/foreign.mp4", filename: "foreign.mp4", kind: "video" }],
      "g2b"
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"));
    expect(reqHeaders?.get("range")).toBeNull(); // 无身份 → 不续传
    expect(readFileSync(join(dir, "foreign.mp4"), "utf8")).toBe("FRESH");
    expect(existsSync(part)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("上游不支持 Range（200）→ 整体重下", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "nr.mp4.part"), "OLDPREFIX");
    const { dl } = makeDownloader(dir, async () =>
      fakeResponse(new TextEncoder().encode("FULLBODY"))
    );
    const [taskId] = dl.enqueue(
      [{ url: "https://cdn.example.com/nr.mp4", filename: "nr.mp4", kind: "video" }],
      "g3"
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"));
    expect(readFileSync(join(dir, "nr.mp4"), "utf8")).toBe("FULLBODY");
    rmSync(dir, { recursive: true, force: true });
  });

  it("失败隔离：单任务 404 重试后 error，不影响同组其他任务", async () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(dir, async (input) => {
      const u = String(input);
      if (u.includes("bad")) return new Response("nope", { status: 404 });
      return fakeResponse(new TextEncoder().encode("ok"));
    });
    const [badId, goodId] = dl.enqueue(
      [
        { url: "https://cdn.example.com/bad.mp4", filename: "bad.mp4", kind: "video" },
        { url: "https://cdn.example.com/good.mp4", filename: "good.mp4", kind: "video" },
      ],
      "g4"
    );
    await waitUntil(
      () => {
        const l = dl.list();
        return (
          l.some((t) => t.taskId === goodId && t.status === "done") &&
          l.some((t) => t.taskId === badId && t.status === "error")
        );
      },
      8000
    );
    const l = dl.list();
    expect(l.find((t) => t.taskId === badId)?.error).toMatch(/404/);
    expect(existsSync(join(dir, "good.mp4"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("不安全 URL → 直接 error 态任务（不静默丢）", async () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(dir, async () => fakeResponse(new Uint8Array()));
    const [id] = dl.enqueue(
      [{ url: "http://169.254.169.254/meta", filename: "x.mp4", kind: "video" }],
      "g5"
    );
    const t = dl.list().find((x) => x.taskId === id);
    expect(t?.status).toBe("error");
    expect(t?.error).toMatch(/不安全/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pause→resume 保留 .part 并续传；snapshot/restore 队列完整", async () => {
    const dir = makeTempDir();
    // 第一次 fetch：推一块后挂起（可 abort）。关键：等到这块真的写进了
    // .part（内容信号）再 pause——abort 早于首块 read 时 error 会吞掉入队
    // chunk，测试竞态不依赖那个时序。
    const { dl } = makeDownloader(dir, async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("PART"));
          const bail = () => {
            try {
              controller.error(new Error("aborted"));
            } catch {
              /* 已关闭 */
            }
          };
          if (init?.signal?.aborted) bail();
          else init?.signal?.addEventListener("abort", bail, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });

    const [taskId] = dl.enqueue(
      [{ url: "https://cdn.example.com/slow.mp4", filename: "slow.mp4", kind: "video" }],
      "g6",
      { author: { name: "晚风合唱团", followerCount: 88 } }
    );
    // 验收信号：首块进 .part（write 即落 OS 缓冲，readFileSync 可见）
    await waitUntil(() => {
      try {
        return readFileSync(join(dir, "slow.mp4.part"), "utf8") === "PART";
      } catch {
        return false;
      }
    });
    dl.pause(taskId);
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "paused"));
    expect(readFileSync(join(dir, "slow.mp4.part"), "utf8")).toBe("PART");
    expect(existsSync(join(dir, "slow.mp4.part") + ".meta")).toBe(true);

    // 模拟重启：snapshot → 新实例 restore
    // paused 态重启后保持 paused（用户意图保留），须显式 resume 才续传
    const snap = dl.snapshot();
    expect(snap.some((s) => s.taskId === taskId)).toBe(true);
    // 作者快照要跟着落 queue.json，否则重启后历史页作者列凭空少一批
    expect(snap.find((s) => s.taskId === taskId)?.author?.name).toBe("晚风合唱团");
    const { dl: dl2 } = makeDownloader(dir, async (_i, init2) => {
      const h = new Headers(init2?.headers);
      expect(h.get("range")).toBe("bytes=4-");
      return new Response(new TextEncoder().encode("ONE2") as unknown as BodyInit, {
        status: 206,
        headers: { "content-length": "4" },
      });
    });
    dl2.restore(snap as unknown as PersistedQueueLike[]);
    const revived = dl2.list().find((t) => t.taskId === taskId);
    expect(revived?.status).toBe("paused"); // 恢复不越权自动开跑
    expect(revived?.author?.name).toBe("晚风合唱团");
    dl2.resume(taskId);
    await waitUntil(
      () => dl2.list().some((t) => t.taskId === taskId && t.status === "done"),
      5000
    );
    expect(readFileSync(join(dir, "slow.mp4"), "utf8")).toBe("PARTONE2");
    rmSync(dir, { recursive: true, force: true });
  });
});

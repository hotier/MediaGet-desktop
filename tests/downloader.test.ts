/**
 * 下载器核心行为测试（断点续传 / Range / Referer / 冲突命名 / 失败隔离 / SSRF 闸门）
 * 用注入 fetchImpl 完全离线。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

function makeDownloader(
  dir: string,
  fetchImpl: typeof fetch,
  maxConcurrent = 3,
  tuning?: { stallTimeoutMs?: number; retryBaseDelayMs?: number }
) {
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
    ...tuning,
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

/**
 * 正确性收口（2026-10-16）：这四条都是「用户会当成程序有 bug」的形态——
 * 半个文件标完成、磁盘写不进时整个应用消失、僵死连接永久占槽、下载期间覆盖别人的文件。
 * 全部离线：假 fetch + 把 .part 位置占成目录 + 显式 content-length 与实发字节数不一致。
 */
describe("Downloader 正确性收口", () => {
  it("上游提前 EOF（声明 12 字节只给 8）→ 不 rename、不标完成，报「不完整」且留断点", async () => {
    const dir = makeTempDir();
    // Response 必须每次新建：ReadableStream 是一次性消费品，重试复用同一个会拿到
    // "body should not be disturbed"，那就变成在测假 fetch 而不是测下载器。
    const { dl } = makeDownloader(
      dir,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("12345678"));
              c.close(); // 谎称 12 字节却提前收尾
            },
          }),
          { status: 200, headers: { "content-length": "12" } }
        ),
      3,
      { retryBaseDelayMs: 10 }
    );
    const [taskId] = dl.enqueue(
      [{ url: "https://cdn.example.com/short.mp4", filename: "short.mp4", kind: "video" }],
      "c1"
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "error"), 8000);
    const t = dl.list().find((x) => x.taskId === taskId);
    expect(t?.error).toMatch(/不完整|12/);
    expect(existsSync(join(dir, "short.mp4"))).toBe(false); // 半个文件不许冒充成品
    expect(existsSync(join(dir, "short.mp4.part"))).toBe(true); // 断点留着，重试接着下
    rmSync(dir, { recursive: true, force: true });
  });

  it("写流报错（.part 位置被目录占住）→ 错误进任务状态，不外泄成未捕获异常", async () => {
    const dir = makeTempDir();
    const partDir = join(dir, "broken.mp4.part");
    mkdirSync(partDir); // createWriteStream 在这个路径上必然异步 error
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const { dl } = makeDownloader(
        dir,
        async () => fakeResponse(new TextEncoder().encode("DATA")),
        3,
        { retryBaseDelayMs: 10 }
      );
      const [taskId] = dl.enqueue(
        [{ url: "https://cdn.example.com/broken.mp4", filename: "broken.mp4", kind: "video" }],
        "c2"
      );
      await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "error"), 8000);
      const t = dl.list().find((x) => x.taskId === taskId);
      expect(t?.error).toMatch(/写入|EPERM|EISDIR|目录/);
      expect(existsSync(join(dir, "broken.mp4"))).toBe(false);
      expect(uncaught).toEqual([]); // 主进程不该看见裸的 stream error
    } finally {
      process.off("uncaughtException", onUncaught);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("连接僵死（一块字节后再不推进）→ 空闲超时报错并释放执行槽", async () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(
      dir,
      async (_input, init) => {
        const url = String(_input);
        if (url.includes("stall")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode("HEAD")); // 首块之后永不推进
                const bail = () => {
                  try {
                    c.error(new Error("aborted"));
                  } catch {
                    /* 已关闭 */
                  }
                };
                if (init?.signal?.aborted) bail();
                else init?.signal?.addEventListener("abort", bail, { once: true });
              },
            }),
            { status: 200, headers: { "content-length": "1000" } }
          );
        }
        return fakeResponse(new TextEncoder().encode("AFTER"));
      },
      1, // 单槽：不释放就永远卡死
      { stallTimeoutMs: 150, retryBaseDelayMs: 10 }
    );
    const [stallId] = dl.enqueue(
      [{ url: "https://cdn.example.com/stall.mp4", filename: "stall.mp4", kind: "video" }],
      "c3a"
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === stallId && t.status === "error"), 8000);
    expect(dl.list().find((t) => t.taskId === stallId)?.error).toMatch(/超时|无数据/);

    const [nextId] = dl.enqueue(
      [{ url: "https://cdn.example.com/after.mp4", filename: "after.mp4", kind: "video" }],
      "c3b"
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === nextId && t.status === "done"), 5000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("下载期间目标被外部创建 → 落地时避让序号，不覆盖别人的文件", async () => {
    const dir = makeTempDir();
    const bytes = new TextEncoder().encode("MINE");
    const { dl } = makeDownloader(
      dir,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              // 外部程序在下载途中落了同名文件。放在 body 构造里而不是测试开头：
              // ReadableStream 于 fetchImpl 内构造，时机在 pickTargetPath 之后，
              // 这样测到的是「落地改名避让」，而不是入队时那套避让。
              if (!existsSync(join(dir, "exist.mp4"))) writeFileSync(join(dir, "exist.mp4"), "SOMEONE-ELSE");
              c.enqueue(bytes);
              c.close();
            },
          }),
          { status: 200, headers: { "content-length": String(bytes.byteLength) } }
        ),
      3,
      { retryBaseDelayMs: 10 }
    );
    const [taskId] = dl.enqueue(
      [{ url: "https://cdn.example.com/exist.mp4", filename: "exist.mp4", kind: "video" }],
      "c4"
    );
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"), 8000);
    expect(dl.list().find((t) => t.taskId === taskId)?.filename).toBe("exist (2).mp4");
    expect(readFileSync(join(dir, "exist.mp4"), "utf8")).toBe("SOMEONE-ELSE");
    expect(readFileSync(join(dir, "exist (2).mp4"), "utf8")).toBe("MINE");
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 队列卫生（契约 v4）。两件事一起验：清理只收终态且**不碰磁盘**，
 * 以及同批改判的恢复语义 —— canceled 不再复活（用户已经明确放弃的行，重启后回来只会再问一次），
 * paused/error 照旧回来等用户处置（它们带着可点的动作）。
 */
describe("Downloader 清理与恢复", () => {
  const seeded = (id: string, status: PersistedQueueLike["status"]): PersistedQueueLike => ({
    taskId: id,
    groupId: "g-h",
    url: `https://cdn.example.com/${id}.mp4`,
    filename: `${id}.mp4`,
    kind: "video",
    received: 10,
    total: 10,
    createdAt: 1,
    status,
  });

  /** ok 一次给完；bad 永远 404；hang 一块都不给，但听 abort（否则取消要等到空闲超时） */
  function triFetch(): typeof fetch {
    const bytes = new TextEncoder().encode("FULL");
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("bad")) return new Response(null, { status: 404 });
      if (url.includes("hang"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              const bail = (): void => {
                try {
                  c.error(new Error("aborted"));
                } catch {
                  /* 已关闭 */
                }
              };
              if (init?.signal?.aborted) bail();
              else init?.signal?.addEventListener("abort", bail, { once: true });
            },
          }),
          { status: 200, headers: { "content-length": "10" } }
        );
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": "4" },
      });
    }) as typeof fetch;
  }

  const one = (filename: string) => [
    { url: `https://cdn.example.com/${filename}`, filename, kind: "video" as const },
  ];

  it("清理带走终态、拒掉在途，removed 如实计数且文件不动", async () => {
    const dir = makeTempDir();
    // 单槽 + 超长空闲超时：hang 任务在整个断言期间稳定停在下载中/排队，不会自己变终态
    const { dl, getPersisted } = makeDownloader(dir, triFetch(), 1, {
      stallTimeoutMs: 100_000,
      retryBaseDelayMs: 10,
    });
    const [doneId] = dl.enqueue(one("ok.mp4"), "g1");
    await waitUntil(() => dl.list().some((t) => t.taskId === doneId && t.status === "done"), 8000);
    const [errId] = dl.enqueue(one("bad.mp4"), "g2");
    await waitUntil(() => dl.list().some((t) => t.taskId === errId && t.status === "error"), 8000);
    const [cancelId] = dl.enqueue(one("hang-a.mp4"), "g3");
    await waitUntil(() => dl.list().some((t) => t.taskId === cancelId && t.status === "downloading"), 8000);
    dl.cancel(cancelId);
    await waitUntil(() => dl.list().some((t) => t.taskId === cancelId && t.status === "canceled"), 8000);
    const [runId, waitId] = dl.enqueue(one("hang-b.mp4").concat(one("hang-c.mp4")), "g4");
    await waitUntil(() => dl.list().some((t) => t.taskId === runId && t.status === "downloading"), 8000);
    expect(dl.list().find((t) => t.taskId === waitId)?.status).toBe("queued");
    expect(dl.list()).toHaveLength(5);

    expect(dl.clear([doneId, errId, cancelId, runId, waitId])).toBe(3);
    expect(dl.list().map((t) => t.taskId).sort()).toEqual([runId, waitId].sort());
    // 落盘快照跟着变短：清完的行不能重启后又回来
    expect(getPersisted().map((t) => t.taskId)).not.toContain(doneId);
    expect(getPersisted().map((t) => t.taskId)).not.toContain(errId);
    // 「清理」是忘记，不是删文件
    expect(existsSync(join(dir, "ok.mp4"))).toBe(true);

    dl.cancel(runId);
    dl.cancel(waitId); // 单槽：不掐掉 runId，waitId 会被 promote 成新的在途任务
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("点名一颗不存在的 id 也算零（状态竞争下不谎报）", () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(dir, triFetch(), 1, { retryBaseDelayMs: 10 });
    expect(dl.clear(["nope"])).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("restore：done 与 canceled 不复活，paused/error 留在队列", () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(dir, triFetch(), 1, { retryBaseDelayMs: 10 });
    dl.restore([seeded("p1", "paused"), seeded("e1", "error"), seeded("x1", "canceled"), seeded("d1", "done")]);
    const back = dl.list().map((t) => t.taskId);
    expect(back).toEqual(["p1", "e1"]); // 顺序按 createdAt，这里同为 1 → 保持入参序
    expect(dl.list().map((t) => t.status)).toEqual(["paused", "error"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

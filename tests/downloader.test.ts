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
  tuning?: {
    stallTimeoutMs?: number;
    retryBaseDelayMs?: number;
    renewUrl?: (failedUrl: string, sourceUrl?: string) => Promise<string | null>;
  }
) {
  const events: DownloadTaskView[] = [];
  const history: { groupTask: DownloadTaskView; files: string[] }[] = [];
  let persisted: PersistedQueueLike[] = [];
  // 终态行落盘后从内存退休（v22），测试用这张表模拟 SQLite 的 upsert 台账：
  // 活行读 dl.list()，退休行读这里，两者合起来才是队列页看到的那份队列。
  const ledger = new Map<string, PersistedQueueLike>();
  const dl = new Downloader({
    getDownloadDir: () => dir,
    getMaxConcurrent: () => maxConcurrent,
    getRetryTimes: () => 2, // 与旧内置 MAX_ATTEMPTS=3 等价的总尝试数
    getKeepPartials: () => false,
    queue: {
      load: (taskId) => ledger.get(taskId),
      remove: (taskIds) => {
        let removed = 0;
        for (const id of taskIds) if (ledger.delete(id)) removed += 1;
        return removed;
      },
    },
    defaultUserAgent: "UA-TEST",
    fetchImpl,
    ...tuning,
    events: {
      progress: (t) => events.push(t),
      done: (t) => events.push(t),
      error: (t) => events.push(t),
      persist: (tasks) => {
        persisted = tasks;
        for (const task of tasks) ledger.set(task.taskId, task);
      },
      history: (e) => history.push(e),
    },
  });
  const memoryList = dl.list.bind(dl);
  // 测试里的 dl.list() 取队列页口径（库 ∪ 活行，活行优先），与 download:list 的 overlay 同义；
  // 真实内存列表经 memoryList() 取，用来钉「终态行确实退休了」
  dl.list = () => {
    const live = memoryList();
    const seen = new Set(live.map((t) => t.taskId));
    const retired = [...ledger.values()]
      .filter((t) => !seen.has(t.taskId))
      .map((t) => ({
        ...t,
        kind: t.kind as DownloadTaskView["kind"],
        speed: t.speed ?? 0,
        transferMs: t.transferMs ?? 0,
        transferBytes: t.transferBytes ?? 0,
      }));
    return [...live, ...retired];
  };
  return {
    dl,
    events,
    history,
    memoryList,
    ledger: () => [...ledger.values()],
    getPersisted: () => persisted,
  };
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
    const speedBeforePause = dl.list().find((t) => t.taskId === taskId)?.speed ?? 0;
    dl.pause(taskId);
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "paused"));
    expect(readFileSync(join(dir, "slow.mp4.part"), "utf8")).toBe("PART");
    expect(existsSync(join(dir, "slow.mp4.part") + ".meta")).toBe(true);
    // v17 暂停快照：pause 不清 speed —— 界面据它显示「暂停时的速度 / 剩余」，重启后也一样
    expect(dl.list().find((t) => t.taskId === taskId)?.speed).toBe(speedBeforePause);

    // 模拟重启：snapshot → 新实例 restore
    // paused 态重启后保持 paused（用户意图保留），须显式 resume 才续传
    const snap = dl.snapshot();
    expect(snap.some((s) => s.taskId === taskId)).toBe(true);
    // 作者快照要跟着落 queue.json，否则重启后历史页作者列凭空少一批
    expect(snap.find((s) => s.taskId === taskId)?.author?.name).toBe("晚风合唱团");
    expect(snap.find((s) => s.taskId === taskId)?.speed).toBe(speedBeforePause);
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
    expect(revived?.speed).toBe(speedBeforePause); // 暂停快照跨重启还在
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
  const seeded = (
    id: string,
    status: PersistedQueueLike["status"],
    extra: Partial<PersistedQueueLike> = {}
  ): PersistedQueueLike => ({
    taskId: id,
    groupId: "g-h",
    url: `https://cdn.example.com/${id}.mp4`,
    filename: `${id}.mp4`,
    kind: "video",
    received: 10,
    total: 10,
    createdAt: 1,
    status,
    ...extra,
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
    const { dl, ledger } = makeDownloader(dir, triFetch(), 1, {
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
    // 台账里也清掉了：清完的行不能重启后又回来
    expect(ledger().map((t) => t.taskId)).not.toContain(doneId);
    expect(ledger().map((t) => t.taskId)).not.toContain(errId);
    expect(ledger().map((t) => t.taskId)).not.toContain(cancelId);
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

  // v13 起队列是全量台账（业主指令 2026-10-17「保留所有进过队列的数据」）。
  // 这几条钉的是「终态行能不能被如实还原」——缺任一个字段，界面上就是一个会点空的按钮。
  it("restore：进过队列的行全部回来，终态只是台账不会自己开跑", () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(dir, triFetch(), 1, { retryBaseDelayMs: 10 });
    dl.restore([
      // v17 暂停快照：paused 行的 speed 是「暂停那一刻多快」，重启后照样生效
      seeded("p1", "paused", { speed: 1234 }),
      // 档里混进来的 speed 只在 paused 行被承认：非 paused 的实时速度不是可持久事实
      seeded("e1", "error", { error: "HTTP 403 Forbidden", speed: 999 }),
      seeded("x1", "canceled"),
      seeded("d1", "done", { filePath: join(dir, "d1(1).mp4"), finishedAt: 777, url: "" }),
      // 旧档（v13 之前）没有 filePath：这时才按「目录 + 文件名」兜一个
      seeded("d2", "done", { finishedAt: 888, url: "" }),
    ]);
    // 同为 createdAt=1 → 稳定排序保持入参序；pump 只挑 queued，所以五条都没开始动
    expect(dl.list().map((t) => t.taskId)).toEqual(["p1", "e1", "x1", "d1", "d2"]);
    expect(dl.list().map((t) => t.status)).toEqual(["paused", "error", "canceled", "done", "done"]);
    // 原因文本跟着档回来：旧实现无条件 error: undefined，重启后是一条「不知道为什么失败」的失败
    expect(dl.list().find((t) => t.taskId === "e1")?.error).toBe("HTTP 403 Forbidden");
    expect(dl.list().find((t) => t.taskId === "p1")?.speed).toBe(1234);
    expect(dl.list().find((t) => t.taskId === "e1")?.speed).toBe(0);
    const d1 = dl.list().find((t) => t.taskId === "d1");
    // 冲突避让后落的是 d1(1).mp4，按目录+名重算会指到一个从没落地的文件
    expect(d1?.filePath).toBe(join(dir, "d1(1).mp4"));
    expect(d1?.finishedAt).toBe(777);
    expect(dl.list().find((t) => t.taskId === "d2")?.filePath).toBe(join(dir, "d2.mp4"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshot：终态三件套落盘，done 行剥掉直链、还能续的状态留链", () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(dir, triFetch(), 1, { retryBaseDelayMs: 10 });
    dl.restore([
      seeded("p1", "paused", { speed: 2048 }),
      seeded("d1", "done", { filePath: join(dir, "d1.mp4"), finishedAt: 5 }),
      seeded("e1", "error", { error: "下载超时：30 秒没有收到新数据", speed: 512 }),
      seeded("x1", "canceled"),
    ]);
    const snap = dl.snapshot();
    // 隐私红线「队列不保留直链 URL」：队列从短命快照变成长期档之后，靠这句守住
    expect(snap.find((s) => s.taskId === "d1")?.url).toBe("");
    expect(snap.find((s) => s.taskId === "d1")?.filePath).toBe(join(dir, "d1.mp4"));
    expect(snap.find((s) => s.taskId === "d1")?.finishedAt).toBe(5);
    // v17 暂停快照：只有 paused 行落 speed，其余状态不把实时值写进长期档
    expect(snap.find((s) => s.taskId === "p1")?.speed).toBe(2048);
    expect(snap.find((s) => s.taskId === "e1")?.speed).toBeUndefined();
    expect(snap.find((s) => s.taskId === "d1")?.speed).toBeUndefined();
    // error / canceled 都还能 resume，链一剥就等于把这两个动作废了
    expect(snap.find((s) => s.taskId === "e1")?.url).toContain("cdn.example.com");
    expect(snap.find((s) => s.taskId === "e1")?.error).toBe("下载超时：30 秒没有收到新数据");
    expect(snap.find((s) => s.taskId === "x1")?.url).toContain("cdn.example.com");
    rmSync(dir, { recursive: true, force: true });
  });

  it("异常文本再长也只落 300 字符（写流错误会带本机路径，不灌进长期档）", () => {
    const dir = makeTempDir();
    const { dl } = makeDownloader(dir, triFetch(), 1, { retryBaseDelayMs: 10 });
    dl.restore([seeded("e1", "error", { error: "E".repeat(500) })]);
    const e1 = dl.snapshot().find((s) => s.taskId === "e1");
    expect(e1?.error).toHaveLength(300); // 与 PersistedQueueTaskSchema 的 STR.max(300) 同口径
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 直链到期（HTTP 403）的自愈（契约 v12）。业主的问题是「这类情况静默重试会不会好一点」——
 * 答案是：403 是唯一硬证据，所以反应式处理而不是提前预防。这四条钉住四条边界：
 * 认得出就换链跑完、认不出就照原样报错、一次为限不许循环、换链不许把断点清空。
 */
describe("Downloader 403 自动续链", () => {
  const OLD = "https://cdn.example.com/v.mp4?video_id=1&sign=S1&expires=100";
  const NEW = "https://cdn.example.com/v.mp4?video_id=1&sign=S2&expires=200";
  const SOURCE = "https://v.douyin.com/abc/";
  const dead = () => new Response(null, { status: 403 });

  it("换一条新链跑完：url 落地是新链，note 说明这一行刚自己动过", async () => {
    const dir = makeTempDir();
    const bytes = new TextEncoder().encode("FRESH-LINK");
    const seen: [string, string | undefined][] = [];
    const { dl, events } = makeDownloader(
      dir,
      async (input) => (String(input) === OLD ? dead() : fakeResponse(bytes)),
      3,
      {
        retryBaseDelayMs: 10,
        renewUrl: async (failedUrl, sourceUrl) => {
          seen.push([failedUrl, sourceUrl]);
          return NEW;
        },
      }
    );
    const [taskId] = dl.enqueue([{ url: OLD, filename: "v.mp4", kind: "video" }], "r1", { sourceUrl: SOURCE });
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"), 8000);

    // 交给续链的是「失败那条 + 这个作品的链接」，不是别的任务的链
    expect(seen).toEqual([[OLD, SOURCE]]);
    // done 台账按隐私红线剥掉直链，运行中的新链只能从完成事件上取
    expect(events.find((e) => e.taskId === taskId && e.status === "done")?.url).toBe(NEW);
    expect(readFileSync(join(dir, "v.mp4"), "utf8")).toBe("FRESH-LINK");
    expect(events.at(-1)?.note).toBe("直链已过期，已自动重新取链");
    rmSync(dir, { recursive: true, force: true });
  });

  it("认不出对象（返回 null）→ 不写 note，报错与原来一模一样", async () => {
    const dir = makeTempDir();
    const { dl, events } = makeDownloader(dir, async () => dead(), 3, {
      retryBaseDelayMs: 10,
      renewUrl: async () => null,
    });
    const [taskId] = dl.enqueue([{ url: OLD, filename: "v.mp4", kind: "video" }], "r2", { sourceUrl: SOURCE });
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "error"), 8000);
    expect(dl.list().find((t) => t.taskId === taskId)?.error).toBe("HTTP 403");
    expect(events.every((e) => e.note === undefined)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("一次为限：新链也 403 也不会再解析第二次（下架的作品不该被反复捶）", async () => {
    const dir = makeTempDir();
    let calls = 0;
    const { dl } = makeDownloader(dir, async () => dead(), 3, {
      retryBaseDelayMs: 10,
      renewUrl: async () => {
        calls++;
        return `${NEW}&attempt=${calls}`; // 每次都给一条不同的链，排除「返回同一条」的干扰
      },
    });
    const [taskId] = dl.enqueue([{ url: OLD, filename: "v.mp4", kind: "video" }], "r3", { sourceUrl: SOURCE });
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "error"), 8000);
    expect(calls).toBe(1);
    expect(dl.list().find((t) => t.taskId === taskId)?.error).toBe("HTTP 403");
    rmSync(dir, { recursive: true, force: true });
  });

  it("续链只换签名不换资源：.part 断点保留，从已收字节接着下", async () => {
    const dir = makeTempDir();
    // 上一轮留下的半成品 + 身份（meta 记的还是那条死链）
    writeFileSync(join(dir, "v.mp4.part"), "HEAD");
    writeFileSync(join(dir, "v.mp4.part.meta"), OLD);
    const tail = new TextEncoder().encode("TAIL");
    let range: string | null = null;
    const { dl } = makeDownloader(
      dir,
      async (input, init) => {
        const h = new Headers(init?.headers);
        if (String(input) === OLD) return dead();
        range = h.get("range");
        // 认下 Range 才给 206：内容 = 缺的那一段，总长跟着 start 相加
        return new Response(tail as unknown as BodyInit, {
          status: 206,
          headers: { "content-length": String(tail.byteLength), "content-range": `bytes 4-7/8` },
        });
      },
      3,
      {
        retryBaseDelayMs: 10,
        renewUrl: async () => NEW,
      }
    );
    const [taskId] = dl.enqueue([{ url: OLD, filename: "v.mp4", kind: "video" }], "r4", { sourceUrl: SOURCE });
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"), 8000);
    // 没有那次 meta 同步，这里会变成 `bytes=0-`：用户看到进度从 4 字节跳回 0
    expect(range).toBe("bytes=4-");
    expect(dl.list().find((t) => t.taskId === taskId)?.received).toBe(8);
    expect(readFileSync(join(dir, "v.mp4"), "utf8")).toBe("HEADTAIL");
    expect(existsSync(join(dir, "v.mp4.part.meta"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 「首次没下完，后续接着下」的两条保证（业主问题 2026-10-18）：
 * ① 直链没过期 → 靠 `.part` + `Range` 续（上面的 restore / pause 用例钉着）；
 * ② 直链过期了 → 403 续链拿新签名，`.part` 照旧接着写（`isSameResource` 判身份）。
 * 这里钉的是**第二类里最容易漏掉的两处**：重新解析后重新入队（新 URL 是新签名，不是新资源）、
 * 以及「续链失败之后按重试还能再换一次链」。
 */
describe("断点续传：跨签名 / 跨会话接着下", () => {
  const OLD = "https://cdn.example.com/dir/v.mp4?video_id=1&sign=S1&expires=100";
  const NEW = "https://cdn.example.com/dir/v.mp4?video_id=1&sign=S2&expires=200";
  /** 同名但确实是另一份资源（路径不同 = 别的清晰度/分 P） */
  const OTHER = "https://cdn.example.com/dir/other.mp4?video_id=1&sign=S9&expires=200";

  it("隔天重新解析：换签名的同一个文件沿用 .part，从已收字节续（不再从 0 重下）", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "v.mp4.part"), "HEAD");
    writeFileSync(join(dir, "v.mp4.part.meta"), OLD);
    const tail = new TextEncoder().encode("TAIL");
    let range: string | null = null;
    const { dl } = makeDownloader(dir, async (_input, init) => {
      range = new Headers(init?.headers).get("range");
      return new Response(tail as unknown as BodyInit, {
        status: 206,
        headers: { "content-length": String(tail.byteLength), "content-range": "bytes 4-7/8" },
      });
    });
    const [taskId] = dl.enqueue([{ url: NEW, filename: "v.mp4", kind: "video" }], "k1");
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"), 8000);
    // 旧实现按 URL 字符串比 meta：签名一变就判「异 URL」，把 HEAD 删掉从头下
    expect(range).toBe("bytes=4-");
    expect(readFileSync(join(dir, "v.mp4"), "utf8")).toBe("HEADTAIL");
    // 采样分子只覆盖「本任务真正收到的那 4 字节」：HEAD 是本任务之前就在盘上的
    const done = dl.list().find((t) => t.taskId === taskId);
    expect(done?.received).toBe(8);
    expect(done?.transferBytes).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("同名但换了资源（路径不同）→ 半成品不属于它，清掉从 0 下", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "v.mp4.part"), "HEAD");
    writeFileSync(join(dir, "v.mp4.part.meta"), OTHER);
    const full = new TextEncoder().encode("FULLBODY");
    let range: string | null = "未发出";
    const { dl } = makeDownloader(dir, async (_input, init) => {
      range = new Headers(init?.headers).get("range");
      return fakeResponse(full);
    });
    const [taskId] = dl.enqueue([{ url: NEW, filename: "v.mp4", kind: "video" }], "k2");
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"), 8000);
    expect(range).toBeNull();
    expect(readFileSync(join(dir, "v.mp4"), "utf8")).toBe("FULLBODY");
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 平均速度的分母是**实际传输时长**（契约 v18，业主追问 2026-10-18）。
   * 旧口径用 `finishedAt − createdAt`：暂停一小时再续，那个文件的速度就变成零头，
   * 而「暂停」根本不是「下得慢」。这里暂停 120ms 再续，钉住这段空档不进分母。
   */
  it("暂停一段再继续：transferMs 只算在传的时间，暂停的空档不进分母", async () => {
    const dir = makeTempDir();
    const enc = new TextEncoder();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { dl } = makeDownloader(dir, async (_input, init) => {
      const range = new Headers(init?.headers).get("range");
      if (range) {
        // 续传这一段延迟 25ms 才给最后一块：transferMs 必须记到这段时间
        const tail = new ReadableStream<Uint8Array>({
          async start(c) {
            await wait(25);
            c.enqueue(enc.encode("TAIL"));
            c.close();
          },
        });
        return new Response(tail, {
          status: 206,
          headers: { "content-length": "4", "content-range": "bytes 4-7/8" },
        });
      }
      // 首程只给第一块然后挂住，等用户按暂停
      const head = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("HEAD"));
        },
      });
      return new Response(head, { status: 200, headers: { "content-length": "8" } });
    });

    const [taskId] = dl.enqueue([{ url: NEW, filename: "v.mp4", kind: "video" }], "k4");
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.received === 4), 8000);
    expect(dl.pause(taskId)).toBe(true);
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "paused"), 8000);
    await wait(120); // 用户的「暂停一段时间」
    expect(dl.resume(taskId)).toBe(true);
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"), 8000);

    const t = dl.list().find((x) => x.taskId === taskId);
    expect(t?.received).toBe(8);
    expect(t?.transferBytes).toBe(8);
    expect(t?.transferMs).toBeGreaterThan(0);
    // 墙钟 − 传输时长 ≥ 暂停空档：那 120ms 一秒都不许算进平均速度的分母
    expect((t?.finishedAt ?? 0) - (t?.createdAt ?? 0)).toBeGreaterThanOrEqual((t?.transferMs ?? 0) + 100);
    expect(readFileSync(join(dir, "v.mp4"), "utf8")).toBe("HEADTAIL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("续链失败落了 error 之后，按重试还能再换一次链（不必重启应用）", async () => {
    const dir = makeTempDir();
    const bytes = new TextEncoder().encode("AFTER-RETRY");
    let calls = 0;
    const { dl } = makeDownloader(
      dir,
      async (input) => (String(input) === NEW ? fakeResponse(bytes) : new Response(null, { status: 403 })),
      3,
      {
        retryBaseDelayMs: 10,
        // 第一次认不出（平台抽风）→ 落在 error；第二次按重试才给它新链
        renewUrl: async () => {
          calls += 1;
          return calls === 1 ? null : NEW;
        },
      }
    );
    const [taskId] = dl.enqueue([{ url: OLD, filename: "v.mp4", kind: "video" }], "k3", {
      sourceUrl: "https://v.douyin.com/abc/",
    });
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "error"), 8000);
    expect(calls).toBe(1);

    expect(dl.resume(taskId)).toBe(true);
    await waitUntil(() => dl.list().some((t) => t.taskId === taskId && t.status === "done"), 8000);
    // `renewed` 不在 resume 里重开的话，这里恒为 1：同一行按多少次重试都只会在死链上打转
    expect(calls).toBe(2);
    expect(readFileSync(join(dir, "v.mp4"), "utf8")).toBe("AFTER-RETRY");
    rmSync(dir, { recursive: true, force: true });
  });
});

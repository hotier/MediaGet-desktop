/**
 * 音视频合流内核（预览 + 下载共用，2026-10-21）。
 *
 * 绝不真跑 ffmpeg：进程用注入的假启动器，只验证「参数拼对、失败清干净、同档只合一次、
 * 缓存复用不误伤」。真合流属 L5（实机点一次 B站预览 + 下载一条 dash 档）。
 */
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRACK_CACHE_TTL_MS,
  buildLocalMergeArgs,
  buildRemoteMergeArgs,
  createTrackMerger,
  trackCacheKey,
  type SpawnFn,
} from "../electron/main/media-merge";

const VIDEO = "https://upos-sz-mirrorcos.bilivideo.com/v/80.m4s?e=1&deadline=9";
const AUDIO = "https://upos-sz-mirrorcos.bilivideo.com/a/30280.m4s?e=1&deadline=9";
const REFERER = "https://www.bilibili.com/";

type Behavior = "ok" | "fail" | "never";

/** 假启动器：按行为在下一个 tick 写/不写产物并回调 close */
function fakeSpawn(behavior: Behavior): { spawnFn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawnFn = ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    const closeListeners: Array<(code: number | null) => void> = [];
    const errorListeners: Array<(err: Error) => void> = [];
    const child = {
      on(event: "close" | "error", cb: (arg: never) => void): void {
        if (event === "close") closeListeners.push(cb as (code: number | null) => void);
        else errorListeners.push(cb as (err: Error) => void);
      },
      kill(): void {
        /* 超时分支用；这里的用例都不会触发 */
      },
    };
    if (behavior === "ok") {
      const out = args[args.length - 1];
      setImmediate(() => {
        writeFileSync(out, "fake-mp4-bytes");
        for (const cb of closeListeners) cb(0);
      });
    } else if (behavior === "fail") {
      setImmediate(() => {
        for (const cb of closeListeners) cb(1);
      });
    }
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, calls };
}

describe("trackCacheKey（文件名里不许出现直链）", () => {
  it("稳定、32 位十六进制、不同链不同键", () => {
    const key = trackCacheKey(VIDEO, AUDIO);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(trackCacheKey(VIDEO, AUDIO)).toBe(key);
    // 同一视频换音频档 / 换视频档都必须换键，否则会拿到上一档的产物
    expect(trackCacheKey(VIDEO, `${AUDIO}&x=1`)).not.toBe(key);
    expect(trackCacheKey(`${VIDEO}&x=1`, AUDIO)).not.toBe(key);
    expect(key).not.toContain("upos");
    expect(key).not.toContain("m4s");
  });
});

describe("远程合流参数（预览：两输入各自带身份头，容器层复制）", () => {
  it("每个 -i 前都有 UA 与 Referer；不转码、faststart、输出路径在最后", () => {
    const out = join(tmpdir(), "mg-out.mp4");
    const args = buildRemoteMergeArgs(VIDEO, AUDIO, out, { userAgent: "UA/1", referer: REFERER });

    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args.filter((a) => a === "-user_agent")).toHaveLength(2);
    expect(args.filter((a) => a === "-headers")).toHaveLength(2);
    // ffmpeg 的输入选项只作用于紧随的那个 -i：顺序必须成对出现
    expect(args[args.indexOf("-i") - 2]).toBe("-headers");
    expect(args[args.indexOf("-headers") + 1]).toBe(`Referer: ${REFERER}\r\n`);
    expect(args).toContain("copy");
    // 连接挂起时不能一直等：每条输入都带 15s 无数据超时
    expect(args.filter((a) => a === "-rw_timeout")).toHaveLength(2);
    expect(args[args.indexOf("-rw_timeout") + 1]).toBe("15000000");
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
    expect(args.slice(-2)).toEqual(["mp4", out]);
    // 两条输入顺序不能反：-map 0:v:0 / 1:a:0 依赖它
    expect(args[args.indexOf("-i") + 1]).toBe(VIDEO);
    expect(args[args.indexOf("-i", args.indexOf("-i") + 1) + 1]).toBe(AUDIO);
  });

  it("没有 Referer 时不带 -headers（平台认不出的直链照样能合）", () => {
    const args = buildRemoteMergeArgs(VIDEO, AUDIO, join(tmpdir(), "o.mp4"), { userAgent: "UA/1" });
    expect(args).not.toContain("-headers");
    expect(args.filter((a) => a === "-user_agent")).toHaveLength(2);
  });
});

describe("本地合流参数（下载：两条 .part 已在盘上）", () => {
  it("输入是本地路径，不带任何网络身份头", () => {
    const args = buildLocalMergeArgs("/dl/a.mp4.part", "/dl/a.mp4.part.audio", "/dl/a.mp4.part.merged");
    expect(args).not.toContain("-user_agent");
    expect(args).not.toContain("-headers");
    expect(args[args.indexOf("-i") + 1]).toBe("/dl/a.mp4.part");
    expect(args[args.indexOf("-i", args.indexOf("-i") + 1) + 1]).toBe("/dl/a.mp4.part.audio");
    expect(args).toContain("copy");
    expect(args.slice(-2)).toEqual(["mp4", "/dl/a.mp4.part.merged"]);
  });
});

describe("createTrackMerger（缓存 / 失败清理 / 并发去重 / TTL）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mg-media-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (behavior: Behavior, ffmpeg: string | null = "/fake/ffmpeg.exe") => {
    const { spawnFn, calls } = fakeSpawn(behavior);
    const merger = createTrackMerger({
      getFfmpegPath: () => ffmpeg,
      cacheDir: () => dir,
      userAgent: "UA/1",
      refererFor: () => REFERER,
      spawnFn,
    });
    return { merger, calls };
  };

  it("ffmpeg 不可用 → 直接 null，连进程都不起（预览退回失败文案，不假装能播）", async () => {
    const { merger, calls } = make("ok", null);
    expect(await merger.ensureRemote(VIDEO, AUDIO, "bilibili")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("成功：产物按哈希命名，第二次点开命中缓存不再起进程", async () => {
    const { merger, calls } = make("ok");
    const first = await merger.ensureRemote(VIDEO, AUDIO, "bilibili");
    expect(first).toBe(join(dir, `${trackCacheKey(VIDEO, AUDIO)}.mp4`));
    expect(readdirSync(dir)).toEqual([`${trackCacheKey(VIDEO, AUDIO)}.mp4`]);
    expect(calls).toHaveLength(1);

    expect(await merger.ensureRemote(VIDEO, AUDIO, "bilibili")).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("远程合流失败：返回 null 且不留 .part 半成品（下次还能重试）", async () => {
    const { merger } = make("fail");
    expect(await merger.ensureRemote(VIDEO, AUDIO, "bilibili")).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("失败原因只留 ffmpeg 那句话，直链被洗成 <url>（隐私红线）", async () => {
    const reasons: string[] = [];
    const spawnFn = ((_command: string, args: readonly string[]) => {
      const closeListeners: Array<(code: number | null) => void> = [];
      const dataListeners: Array<(chunk: string) => void> = [];
      const child = {
        on(event: "close" | "error", cb: (arg: never) => void): void {
          if (event === "close") closeListeners.push(cb as (code: number | null) => void);
        },
        kill(): void {
          /* 不触发超时分支 */
        },
        stderr: {
          on(_event: "data", cb: (chunk: string) => void): void {
            dataListeners.push(cb);
          },
        },
      };
      setImmediate(() => {
        // ffmpeg 的报错原文里就带着输入 URL —— 正是要洗掉的那一段
        const input = args[args.indexOf("-i") + 1];
        for (const cb of dataListeners) cb(`Error opening input file ${input}: 403 Forbidden\n`);
        for (const cb of closeListeners) cb(1);
      });
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;
    const merger = createTrackMerger({
      getFfmpegPath: () => "/fake/ffmpeg.exe",
      cacheDir: () => dir,
      userAgent: "UA/1",
      spawnFn,
      onFailure: (reason) => reasons.push(reason),
    });

    expect(await merger.ensureRemote(VIDEO, AUDIO, "bilibili")).toBeNull();
    expect(reasons[0]).toContain("403 Forbidden");
    expect(reasons[0]).toContain("<url>");
    expect(reasons[0]).not.toContain("upos");
  });

  it("同一档并发点开只合一次（浏览器的重试/预载不该叠出多个 ffmpeg）", async () => {
    const { merger, calls } = make("ok");
    const [a, b] = await Promise.all([
      merger.ensureRemote(VIDEO, AUDIO, "bilibili"),
      merger.ensureRemote(VIDEO, AUDIO, "bilibili"),
    ]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("下载侧本地合流：成功产出目标文件，失败清掉半成品", async () => {
    const okMerger = make("ok").merger;
    const out = join(dir, "task.mp4.merged");
    expect(await okMerger.mergeLocal("/dl/v.part", "/dl/v.part.audio", out)).toBe(true);
    expect(readdirSync(dir)).toContain("task.mp4.merged");

    const badMerger = make("fail").merger;
    const badOut = join(dir, "bad.mp4.merged");
    expect(await badMerger.mergeLocal("/dl/v.part", "/dl/v.part.audio", badOut)).toBe(false);
    expect(readdirSync(dir)).not.toContain("bad.mp4.merged");
  });

  it("下载侧没有 ffmpeg → 本地合流如实失败（调用方报错，不落半截文件）", async () => {
    const { merger, calls } = make("ok", null);
    expect(await merger.mergeLocal("/dl/v.part", "/dl/v.part.audio", join(dir, "x.merged"))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("lookupCached / copyCached：预览合过的产物给下载直接复用", async () => {
    const { merger } = make("ok");
    expect(await merger.lookupCached(VIDEO, AUDIO)).toBeNull();
    expect(await merger.copyCached(VIDEO, AUDIO, join(dir, "copy.mp4"))).toBe(false);

    const cached = await merger.ensureRemote(VIDEO, AUDIO, "bilibili");
    expect(await merger.lookupCached(VIDEO, AUDIO)).toBe(cached);

    const dest = join(dir, "download.mp4");
    expect(await merger.copyCached(VIDEO, AUDIO, dest)).toBe(true);
    expect(readdirSync(dir)).toContain("download.mp4");
  });

  it("prune 只删过期的本模块产物，别的一概不碰", async () => {
    const { merger } = make("ok");
    const fresh = `${"c".repeat(32)}.mp4`;
    const stale = `${"a".repeat(32)}.mp4`;
    const stalePart = `${"b".repeat(32)}.mp4.part`;
    const foreign = "someone-else.tmp";
    for (const name of [fresh, stale, stalePart, foreign]) {
      writeFileSync(join(dir, name), "x");
    }
    const old = new Date(Date.now() - TRACK_CACHE_TTL_MS - 60_000);
    for (const name of [stale, stalePart, foreign]) utimesSync(join(dir, name), old, old);

    expect(await merger.prune(TRACK_CACHE_TTL_MS)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([fresh, foreign].sort());
  });

  it("缓存目录不存在时 prune 不抛（首启还没合过任何东西）", async () => {
    const merger = createTrackMerger({
      getFfmpegPath: () => null,
      cacheDir: () => join(dir, "not-created-yet"),
      userAgent: "UA/1",
    });
    await mkdir(dir, { recursive: true });
    expect(await merger.prune()).toBe(0);
  });
});

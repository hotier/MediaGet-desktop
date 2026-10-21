/**
 * 音视频合流内核（2026-10-21，预览与下载共用）。
 *
 * 产品规则（业主定调）：**DASH 双轨一律合流**。B站登录态 `playurl` 只回 DASH——视频轨与
 * 音频轨是两条独立分片，谁都不能单独当成「一个视频」交付：
 * - 预览：`<video>` 直接吃视频轨会退化成 300×150 的默认框、时长读不出来；
 * - 下载：只落视频轨就是无声视频，用户拿到的不是他要的那个文件。
 *
 * 两种用法共享同一套内核（进程执行、超时、失败清理、命名），但产物生命周期不同：
 * - `ensureRemote`：预览用，两条 URL 直接由 ffmpeg 拉流合并，产物进系统 temp 按哈希缓存；
 * - `mergeLocal`：下载用，两条轨已经作为 `.part` 落盘，只做本地并流，产物归下载器接管；
 * - `lookupCached`：下载命中所属预览产物时直接复制，省掉两轨下载与一次合流。
 *
 * 直链不进日志：失败一律返回 null / false，由调用方按既有语义报错。
 * 前置条件：远程两链已过 `shared/preview-link.ts` 的公网闸（本模块不做网络侧判断）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** 预览产物在 temp 里的保留时长：一次性的东西留一天够反复点开，又不至于越堆越多 */
export const TRACK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 一次合流的墙钟上限。远程要下完两条轨，慢网络也得给足；但用户点开预览是在等画面，
 * 三分钟以上的转圈等同于「坏了」——超时就杀进程、清半成品、回 502，让界面说失败。
 * 真正的连接僵死由 `-rw_timeout`（15s 无数据）先一步拦掉。
 */
const DEFAULT_MERGE_TIMEOUT_MS = 120_000;

/** ffmpeg 单次读写无数据的容忍时长（微秒）：连接挂起时 15s 就失败，而不是等到总超时 */
const REMOTE_IO_TIMEOUT_US = 15_000_000;

/** 进程启动器的最小切面（测试注入假实现，绝不真跑 ffmpeg） */
export type SpawnFn = (
  command: string,
  args: readonly string[]
) => {
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
  /** ffmpeg 的 stderr（可选：测试的假进程不提供）；只用于把失败原因洗成一句话 */
  stderr?: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
};

export interface TrackMergeDeps {
  /** 随包释放 / 用户自配的 ffmpeg；返回 null = 不可用（预览失败、下载如实报错） */
  getFfmpegPath: () => string | null;
  /** 远程合流的缓存目录（惰性求值：测试不必真建目录，也不必在 app ready 前取 temp） */
  cacheDir: () => string;
  userAgent: string;
  /** 平台 → 防盗链 Referer（与直连取流同一份口径） */
  refererFor?: (platform?: string) => string | undefined;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  /**
   * 合流失败时的一句话原因（已把直链洗成 `<url>`）：主进程据此记一条日志。
   * 不在这里直接依赖 logger —— 本模块在主进程与测试里都要能跑。
   */
  onFailure?: (reason: string) => void;
}

export interface TrackMerger {
  /** 预览：两条远程 URL → 可播文件的缓存路径；失败（无 ffmpeg / 非零 / 超时）返回 null */
  ensureRemote(videoUrl: string, audioUrl: string, platform?: string): Promise<string | null>;
  /** 下载：两条本地轨 → 目标路径；调用方负责后续改名与清理 */
  mergeLocal(videoPath: string, audioPath: string, outPath: string): Promise<boolean>;
  /** 下载：预览已经合过的那一对，直接拿缓存路径（没有则 null） */
  lookupCached(videoUrl: string, audioUrl: string): Promise<string | null>;
  /** 下载：把命中的预览产物复制到下载目标（跨盘也走 copyFile，比重新拉两轨快得多） */
  copyCached(videoUrl: string, audioUrl: string, outPath: string): Promise<boolean>;
  /** 清掉超过 maxAgeMs 的预览产物与半成品，返回删除条数 */
  prune(maxAgeMs?: number): Promise<number>;
}

/**
 * 缓存键：两条直链的哈希前 32 位。
 *
 * 用哈希而不是原串：文件名不能带签名参数（那是敏感段），也不能因为长度撞上路径上限。
 * 两条链任一变化（换档、签名刷新）就是一个新键——旧产物由 TTL 收走。
 */
export function trackCacheKey(videoUrl: string, audioUrl: string): string {
  return createHash("sha256").update(`${videoUrl}\n${audioUrl}`).digest("hex").slice(0, 32);
}

/**
 * 把 ffmpeg 失败原因里的直链洗掉。
 *
 * ffmpeg 的报错长这样：`Error opening input file https://upos-.../x.m4s?e=...: 403 Forbidden`。
 * ffmpeg 一次能把视频轨与音频轨两条签名链都吐出来，逐条留档只会把日志冲淡，而
 * 「403 / moov atom not found / Connection timed out」这几句话正是排查要看的东西
 * ——只洗 URL，其余原样保留。
 */
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "<url>");
}

/** 远程输入的公共选项：UA/Referer 与网络超时都是**输入选项**，只作用于紧随的那个 `-i` */
function remoteInputOpts(opts: { userAgent: string; referer?: string }): string[] {
  const out = ["-user_agent", opts.userAgent, "-rw_timeout", String(REMOTE_IO_TIMEOUT_US)];
  if (opts.referer) out.push("-headers", `Referer: ${opts.referer}\r\n`);
  return out;
}

/** 容器层复制不转码；`+faststart` 把 moov 挪到文件头，播放器不用等整段下完 */
const CONTAINER_ARGS = ["-c", "copy", "-movflags", "+faststart", "-f", "mp4"] as const;

/** 远程合流参数（预览）：视频在前、音频在后，`-map 0:v:0 / 1:a:0` 依赖这个次序 */
export function buildRemoteMergeArgs(
  videoUrl: string,
  audioUrl: string,
  outPath: string,
  opts: { userAgent: string; referer?: string }
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...remoteInputOpts(opts),
    "-i",
    videoUrl,
    ...remoteInputOpts(opts),
    "-i",
    audioUrl,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    ...CONTAINER_ARGS,
    outPath,
  ];
}

/** 本地合流参数（下载）：两条 `.part` 已在盘上，不带任何网络身份头 */
export function buildLocalMergeArgs(videoPath: string, audioPath: string, outPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    ...CONTAINER_ARGS,
    outPath,
  ];
}

/** 文件存在且非空才算命中（半成品/0 字节一律当没有） */
async function usableFileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : 0;
  } catch {
    return 0;
  }
}

interface ProcessResult {
  ok: boolean;
  timedOut: boolean;
  /** ffmpeg 的 stderr（尾部 4KB）；只用来提炼一句原因，不整段落日志 */
  stderr: string;
}

/** 把一次进程结果压成一句话：超时 / 最后一行 stderr / 没有输出 */
function describeFailure(result: ProcessResult): string {
  if (result.timedOut) return "ffmpeg 超时被杀（两条轨没能在时限内拉完）";
  const last = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return last ? scrubUrls(last).slice(0, 300) : "ffmpeg 退出码非零（无输出）";
}

function runProcess(spawnFn: SpawnFn, command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let child: ReturnType<SpawnFn> | undefined;
    let timedOut = false;
    const chunks: string[] = [];
    const collect = (): string => chunks.join("").slice(-4096);
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, timedOut, stderr: collect() });
    };
    // 定时器与 done 互相引用：done 只会在 timer 初始化之后被调到（spawn 与事件都在其后）
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* 已经退出：kill 失败无需处理 */
      }
      done(false);
    }, timeoutMs);

    try {
      child = spawnFn(command, args);
    } catch {
      done(false);
      return;
    }
    if (!child) {
      done(false);
      return;
    }
    child.stderr?.on("data", (chunk: unknown) => {
      if (chunks.length >= 64) return;
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

export function createTrackMerger(deps: TrackMergeDeps): TrackMerger {
  const spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnFn);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
  /** 同一档并发点开（浏览器会为重试/预载发多个请求）只跑一次 ffmpeg */
  const pending = new Map<string, Promise<string | null>>();

  const cachePath = (videoUrl: string, audioUrl: string): string =>
    join(deps.cacheDir(), `${trackCacheKey(videoUrl, audioUrl)}.mp4`);

  async function mergeRemote(videoUrl: string, audioUrl: string, platform?: string): Promise<string | null> {
    const ffmpeg = deps.getFfmpegPath();
    if (!ffmpeg) return null;
    const dir = deps.cacheDir();
    const out = cachePath(videoUrl, audioUrl);
    const part = `${out}.part`;
    try {
      await mkdir(dir, { recursive: true });
      await rm(part, { force: true });
      const args = buildRemoteMergeArgs(videoUrl, audioUrl, part, {
        userAgent: deps.userAgent,
        referer: deps.refererFor?.(platform),
      });
      const result = await runProcess(spawnFn, ffmpeg, args, timeoutMs);
      if (!result.ok || (await usableFileSize(part)) === 0) {
        deps.onFailure?.(`远程合流失败：${result.ok ? "产出为空" : describeFailure(result)}`);
        await rm(part, { force: true });
        return null;
      }
      // 先写 part 再改名：播放侧永远看不到写了一半的文件
      await rename(part, out);
      return out;
    } catch {
      await rm(part, { force: true }).catch(() => {});
      return null;
    }
  }

  return {
    async ensureRemote(videoUrl, audioUrl, platform) {
      const out = cachePath(videoUrl, audioUrl);
      if ((await usableFileSize(out)) > 0) return out;

      const key = trackCacheKey(videoUrl, audioUrl);
      const running = pending.get(key);
      if (running) return running;

      const task = mergeRemote(videoUrl, audioUrl, platform).finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },

    async mergeLocal(videoPath, audioPath, outPath) {
      const ffmpeg = deps.getFfmpegPath();
      if (!ffmpeg) return false;
      await rm(outPath, { force: true }).catch(() => {});
      const result = await runProcess(
        spawnFn,
        ffmpeg,
        buildLocalMergeArgs(videoPath, audioPath, outPath),
        timeoutMs
      );
      if (!result.ok || (await usableFileSize(outPath)) === 0) {
        deps.onFailure?.(`本地合流失败：${result.ok ? "产出为空" : describeFailure(result)}`);
        await rm(outPath, { force: true }).catch(() => {});
        return false;
      }
      return true;
    },

    async lookupCached(videoUrl, audioUrl) {
      const out = cachePath(videoUrl, audioUrl);
      return (await usableFileSize(out)) > 0 ? out : null;
    },

    async copyCached(videoUrl, audioUrl, outPath) {
      const cached = await this.lookupCached(videoUrl, audioUrl);
      if (!cached) return false;
      try {
        await copyFile(cached, outPath);
        return (await usableFileSize(outPath)) > 0;
      } catch {
        // 缓存可能正在被 TTL 清理或跨盘不可复制：如实失败，交回正常下载
        await rm(outPath, { force: true }).catch(() => {});
        return false;
      }
    },

    async prune(maxAgeMs = TRACK_CACHE_TTL_MS) {
      const dir = deps.cacheDir();
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return 0;
      }
      const now = Date.now();
      let removed = 0;
      for (const name of names) {
        // 只碰本模块自己的产物形状，别误删 temp 里别人的东西
        if (!/^[0-9a-f]{32}\.mp4(\.part)?$/.test(name)) continue;
        const path = join(dir, name);
        try {
          const s = await stat(path);
          if (now - s.mtimeMs <= maxAgeMs) continue;
          await rm(path, { force: true });
          removed += 1;
        } catch {
          /* 已被系统清理或正被别人用着：跳过 */
        }
      }
      return removed;
    },
  };
}

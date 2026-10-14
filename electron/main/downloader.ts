/**
 * 下载管理器（docs/ARCHITECTURE.md §4）
 *
 * - 并发上限（设置可调）、失败隔离、重试（指数退避 3 次）
 * - 落盘 `<目标>.part` → 完成 rename；`.part` 带身份 meta（`<part>.meta` 存 URL）：
 *   同 URL 断点续传复用原名；异 URL 遗留半成品清理后复用；活任务占位才序号避让
 * - 续传：`.part` 存在且 meta 匹配带 `Range: bytes=<size>-`；上游返回 200
 *   （不支持 Range）整体重下
 * - 防盗链：Referer/UA 来自任务入队时携带的字段（main/ipc 从解析结果与内核
 *   PLATFORM_INFO 域名映射组装），本模块不复制域名表
 * - 进度事件 ~200ms 节流（emitter 注入，vitest 可直接测，不依赖 electron）
 * - 队列快照节流持久化（重启恢复由 index.ts 调 restore）
 *
 * 依赖边界（§1）：core/downloader 不 import electron；IO 走 Node fetch + fs。
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, extname } from "node:path";
import type {
  AuthorSnapshot,
  DownloadItem,
  DownloadTaskView,
  DownloadStatus,
  PersistedQueueTask,
} from "../../types/ipc";

export type PersistedQueueLike = PersistedQueueTask;

export interface DownloaderEvents {
  /** 进度（已按 ~200ms 节流） */
  progress(task: DownloadTaskView): void;
  done(task: DownloadTaskView): void;
  error(task: DownloadTaskView): void;
  /** 需要持久化队列快照（节流由调用方或本模块 saveQueue 回调处理） */
  persist(tasks: PersistedQueueLike[]): void;
  /** 任务完成时写入历史 */
  history(entry: { groupTask: DownloadTaskView; files: string[] }): void;
}

export interface DownloaderOptions {
  getDownloadDir: () => string;
  /** 并发上限实时取值（设置页改完即生效） */
  getMaxConcurrent: () => number;
  /** 默认 UA（主进程出网统一带浏览器 UA，照抄内核 UA 治理，不私自加码） */
  defaultUserAgent: string;
  events: DownloaderEvents;
  fetchImpl?: typeof fetch;
}

interface InternalTask extends DownloadTaskView {
  referer?: string;
  headers?: Record<string, string>;
  signal?: AbortController;
  attempts: number;
  /** 最终落地路径（含同名冲突后的实际名） */
  filePath?: string;
}

const MAX_ATTEMPTS = 3;
const PROGRESS_THROTTLE_MS = 200;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * SSRF 面治理（§6.3）：只放行 http/https，拒私网/回环/链路本地/元数据地址。
 * 主机名字面 IP 才做网段判断（不做 DNS 解析——桌面威胁模型下用户自己受害，
 * 目标是「不让畸形链接打到内网」，不是对抗 DNS rebinding）。
 */
export function isSafeRemoteUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^224\.|^240\./.test(host)) return false;
  if (host === "::1" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) return false;
  if (host === "0:0:0:0:0:0:0:1" || host === "[::1]") return false;
  // 172.16-31 私网段
  const m = host.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return false;
  }
  return true;
}

/**
 * 同名冲突避让（纯函数版，供测试与降级使用）：只看最终文件是否已存在。
 * .part 的续传身份由 Downloader 内部处理（meta 匹配复用、异 URL 清理、活任务避让）。
 */
export function resolveConflictPath(dir: string, filename: string): string {
  let candidate = join(dir, filename);
  if (!existsSync(candidate)) return candidate;
  const ext = extname(filename);
  const stem = basename(filename, ext);
  for (let i = 2; i < 1000; i++) {
    candidate = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

/** 断点文件身份 meta：part + ".meta"，内容 = 当时下载的 URL */
function metaPathFor(part: string): string {
  return part + ".meta";
}

function readPartUrl(part: string): string | null {
  try {
    return readFileSync(metaPathFor(part), "utf8");
  } catch {
    return null;
  }
}

export class Downloader {
  private tasks = new Map<string, InternalTask>();
  /** 展示序：新在前 */
  private order: string[] = [];
  private running = 0;
  private seq = 0;
  /** 本实例写过的 part（URL 身份哈希，防跨任务串写） */
  private claimedTargets = new Set<string>();

  constructor(private opts: DownloaderOptions) {}

  list(): DownloadTaskView[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is InternalTask => !!t)
      .map(toView);
  }

  /** 入队：items 共用 groupId；返回 taskId 列表 */
  enqueue(
    items: DownloadItem[],
    groupId: string,
    meta?: { platform?: string; title?: string; sourceUrl?: string; author?: AuthorSnapshot }
  ): string[] {
    mkdirSync(this.opts.getDownloadDir(), { recursive: true });
    const ids: string[] = [];
    for (const item of items) {
      if (!isSafeRemoteUrl(item.url)) {
        // 不安全 URL 直接建一个 error 态任务，UI 可见、不静默丢
        const id = this.newId();
        const t: InternalTask = {
          taskId: id,
          groupId,
          url: item.url,
          filename: item.filename,
          kind: item.kind,
          status: "error",
          received: 0,
          total: 0,
          speed: 0,
          error: "不安全的下载地址（私网/非 http 协议被拒绝）",
          attempts: 0,
          createdAt: Date.now(),
          platform: meta?.platform,
          title: meta?.title,
          sourceUrl: meta?.sourceUrl,
          author: meta?.author,
        };
        this.tasks.set(id, t);
        this.order.unshift(id);
        this.opts.events.error(toView(t));
        ids.push(id);
        continue;
      }
      const id = this.newId();
      const target = this.pickTargetPath(sanitize(item.filename), item.url);
      const t: InternalTask = {
        taskId: id,
        groupId,
        url: item.url,
        filename: basename(target),
        kind: item.kind,
        status: "queued",
        received: 0,
        total: 0,
        speed: 0,
        attempts: 0,
        createdAt: Date.now(),
        platform: meta?.platform,
        title: meta?.title,
        sourceUrl: meta?.sourceUrl,
        author: meta?.author,
        referer: item.referer,
        headers: item.headers,
        filePath: target,
      };
      this.claimedTargets.add(target);
      this.tasks.set(id, t);
      this.order.unshift(id);
      ids.push(id);
    }
    this.persist();
    this.pump();
    return ids;
  }

  /**
   * 目标名分配：
   * - 最终文件存在 → 避让 (n)
   * - 本实例活任务（queued/downloading/paused/error）占同一目标 → 避让（防双写）
   * - 同名 .part：meta 与本 URL 一致 → 原名续传；不一致/无 meta → 清理后复用原名
   *   （遗留半成品对当前下载无价值，且最终文件不存在，名字归本次任务）
   */
  private pickTargetPath(filename: string, url: string): string {
    const dir = this.opts.getDownloadDir();
    const ext = extname(filename);
    const stem = basename(filename, ext);
    for (let i = 0; i < 1000; i++) {
      const name = i === 0 ? filename : `${stem} (${i})${ext}`;
      const candidate = join(dir, name);
      if (existsSync(candidate)) continue;
      if (this.isTargetClaimed(candidate)) continue;
      const part = candidate + ".part";
      if (existsSync(part)) {
        const partUrl = readPartUrl(part);
        if (partUrl !== url) {
          // 异 URL / 无身份的遗留半成品：清理复用
          this.removePartFiles(part);
        }
      }
      return candidate;
    }
    return join(dir, `${stem}-${Date.now()}${ext}`);
  }

  private isTargetClaimed(target: string): boolean {
    for (const t of this.tasks.values()) {
      if (
        (t.status === "queued" || t.status === "downloading" || t.status === "paused" || t.status === "error") &&
        this.targetPath(t) === target
      ) {
        return true;
      }
    }
    // 重启恢复前旧实例的占位不在内存：claimedTargets 只在进程内有效（可接受——
    // 同一目标两个活下载在 restore 语义里互斥于 status，恢复即重排）
    return false;
  }

  cancel(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === "done" || t.status === "error" || t.status === "canceled") return false;
    t.status = "canceled";
    if (t.signal) {
      // 流关闭后的 .part 清理由 runOne 的收尾统一做（Windows 句柄未关不能删）
      t.signal.abort();
    } else {
      this.dropPart(t); // 未开始：无句柄，直接清
    }
    this.opts.events.progress(toView(t));
    this.persist();
    return true;
  }

  pause(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "downloading") return false;
    t.status = "paused";
    t.signal?.abort(); // runOne 收尾 flush 后保留 .part，resume 从断点续
    this.opts.events.progress(toView(t));
    this.persist();
    return true;
  }

  resume(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t || (t.status !== "paused" && t.status !== "error" && t.status !== "canceled")) return false;
    t.status = "queued";
    t.error = undefined;
    t.attempts = 0;
    this.opts.events.progress(toView(t));
    this.persist();
    this.pump();
    return true;
  }

  /**
   * 重启恢复（P2 验收「重启后队列/历史完整」）：
   * - queued / downloading → queued（.part+meta 在则续传）
   * - paused / error / canceled → 保持原态，等用户手动 resume
   * - done → 跳过（snapshot 已过滤，双保险）
   */
  restore(saved: PersistedQueueLike[]): void {
    for (const s of saved) {
      if (s.status === "done") continue;
      const revived: DownloadStatus =
        s.status === "queued" || s.status === "downloading" ? "queued" : s.status;
      const t = {
        ...s,
        status: revived,
        speed: 0,
        attempts: 0,
        error: undefined,
      } as unknown as InternalTask;
      t.filePath = join(this.opts.getDownloadDir(), t.filename);
      this.claimedTargets.add(t.filePath);
      this.tasks.set(t.taskId, t);
      this.order.push(t.taskId);
    }
    // 展示序：新在前
    this.order.sort(
      (a, b) => (this.tasks.get(b)?.createdAt ?? 0) - (this.tasks.get(a)?.createdAt ?? 0)
    );
    this.pump();
  }

  /** 退出前把仍在跑的任务快照为可恢复 */
  snapshot(): PersistedQueueLike[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is InternalTask => !!t && t.status !== "done")
      .map((t) => ({
        taskId: t.taskId,
        groupId: t.groupId,
        url: t.url,
        filename: t.filename,
        referer: t.referer,
        headers: t.headers,
        kind: t.kind,
        received: t.received,
        total: t.total,
        createdAt: t.createdAt,
        platform: t.platform,
        title: t.title,
        sourceUrl: t.sourceUrl,
        author: t.author,
        status: t.status as DownloadStatus,
      }));
  }

  // ————— 内部 —————

  private newId(): string {
    return `dl-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
  }

  private targetPath(t: InternalTask): string {
    return t.filePath ?? join(this.opts.getDownloadDir(), t.filename);
  }

  private partPath(t: InternalTask): string {
    return this.targetPath(t) + ".part";
  }

  private removePartFiles(part: string): void {
    try {
      rmSync(part, { force: true });
    } catch {
      /* 占用失败不影响状态机 */
    }
    try {
      rmSync(metaPathFor(part), { force: true });
    } catch {
      /* 同上 */
    }
  }

  /** 删除 .part（取消场景）；孤儿 .part 下次异 URL 入队会被清理 */
  private dropPart(t: InternalTask): void {
    this.removePartFiles(this.partPath(t));
  }

  private pump(): void {
    const max = Math.max(1, this.opts.getMaxConcurrent());
    if (this.running >= max) return;
    // 执行按 FIFO（order 为展示序：新在前，故从后往前找最早入队的 queued）
    let next: InternalTask | undefined;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const t = this.tasks.get(this.order[i]);
      if (t && t.status === "queued") {
        next = t;
        break;
      }
    }
    if (!next) return;
    this.running++;
    void this.runOne(next).finally(() => {
      this.running--;
      this.pump();
    });
    // 还有空槽继续放下一个
    if (this.running < max) this.pump();
  }

  private persist(): void {
    this.opts.events.persist(this.snapshot());
  }

  /** 优雅收尾流：flush 已缓冲字节（暂停/取消都要保证 .part 内容准确） */
  private static closeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const fin = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      stream.end(fin);
      stream.once("close", fin);
      stream.once("error", fin);
    });
  }

  private async runOne(t: InternalTask): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    t.status = "downloading";
    t.error = undefined;
    t.signal = new AbortController();
    // pause/cancel 在事件循环的其他回调里改 t.status；经闭包读取跳出
    // TS 的赋值收窄（直线流分析看不到跨回调突变）
    const st = (): DownloadStatus => t.status;
    this.opts.events.progress(toView(t));

    const part = this.partPath(t);
    let start = 0;
    if (existsSync(part)) {
      if (readPartUrl(part) === t.url) {
        try {
          start = statSync(part).size;
        } catch {
          start = 0;
        }
      } else {
        this.removePartFiles(part); // 兜底：入队后又被外部改动过身份
      }
    }
    t.received = start;
    try {
      writeFileSync(metaPathFor(part), t.url, "utf8"); // 身份随行
    } catch {
      /* meta 写失败只影响下次续传判定 */
    }

    const headers: Record<string, string> = {
      "User-Agent": t.headers?.["User-Agent"] ?? this.opts.defaultUserAgent,
      Accept: "*/*",
      ...t.headers,
    };
    if (t.referer) headers["Referer"] = t.referer;
    if (start > 0) headers["Range"] = `bytes=${start}-`;

    let lastEmit = 0;
    let stream: ReturnType<typeof createWriteStream> | null = null;
    try {
      const resp = await fetchImpl(t.url, { headers, signal: t.signal.signal, redirect: "follow" });
      if (!resp.ok && resp.status !== 206) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const supportsRange = resp.status === 206;
      if (start > 0 && !supportsRange) {
        // 上游不支持 Range：整体重下（截断重开）
        start = 0;
        t.received = 0;
      }
      const contentLength = Number(resp.headers.get("content-length") ?? 0);
      t.total = supportsRange ? start + contentLength : contentLength || t.total;

      stream = createWriteStream(part, supportsRange && start > 0 ? { flags: "a" } : { flags: "w" });
      const activeStream = stream;
      if (!resp.body) throw new Error("响应无 body");
      const reader = resp.body.getReader();
      let prevBytes = t.received;
      let prevTime = Date.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const live = st();
        if (live === "canceled" || live === "paused") {
          await Downloader.closeStream(activeStream); // flush 已收字节
          stream = null;
          if (live === "canceled") this.removePartFiles(part);
          return;
        }
        // 背压：write 返回 false 时等 drain，避免大文件灌满内存
        if (!activeStream.write(value)) {
          await new Promise<void>((res) => activeStream.once("drain", () => res()));
        }
        t.received += value.byteLength;
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
          const dt = (now - prevTime) / 1000;
          if (dt > 0) t.speed = Math.round((t.received - prevBytes) / dt);
          prevBytes = t.received;
          prevTime = now;
          lastEmit = now;
          this.opts.events.progress(toView(t));
        }
      }
      await Downloader.closeStream(activeStream);
      stream = null;

      renameSync(part, this.targetPath(t));
      try {
        rmSync(metaPathFor(part), { force: true }); // 身份使命完成
      } catch {
        /* ignore */
      }
      t.status = "done";
      t.speed = 0;
      t.finishedAt = Date.now();
      this.opts.events.progress(toView(t));
      this.opts.events.done(toView(t));
      this.opts.events.history({
        groupTask: { ...toView(t), filePath: this.targetPath(t) },
        files: [this.targetPath(t)],
      });
      this.persist();
    } catch (e) {
      const live = st();
      if (stream) {
        // 中断（pause/cancel/网络错）都先 flush：.part 内容始终等于「已确认收到的字节」
        if (live === "paused" || live === "canceled") {
          await Downloader.closeStream(stream);
        } else {
          stream.destroy();
        }
        stream = null;
      }
      if (live === "canceled") {
        this.removePartFiles(part);
        return;
      }
      if (live === "paused") {
        // flush 之后补发：UI 收到 paused 进度事件时 .part 已就绪可续传
        this.opts.events.progress(toView(t));
        return;
      }
      t.attempts++;
      if (t.attempts < MAX_ATTEMPTS) {
        // 指数退避重试
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (t.attempts - 1));
        const live2 = st();
        if (live2 === "canceled") {
          this.removePartFiles(part);
          return;
        }
        if (live2 === "paused") return;
        return this.runOne(t);
      }
      t.status = "error";
      t.error = e instanceof Error ? e.message : String(e);
      this.opts.events.error(toView(t));
      this.persist();
    }
  }
}

export function toView(t: InternalTask): DownloadTaskView {
  const v: DownloadTaskView = {
    taskId: t.taskId,
    groupId: t.groupId,
    url: t.url,
    filename: t.filename,
    kind: t.kind,
    status: t.status as DownloadStatus,
    received: t.received,
    total: t.total,
    speed: t.speed,
    error: t.error,
    platform: t.platform,
    title: t.title,
    createdAt: t.createdAt,
  };
  if (t.sourceUrl) v.sourceUrl = t.sourceUrl;
  if (t.author) v.author = t.author;
  if (t.finishedAt) v.finishedAt = t.finishedAt;
  if (t.status === "done" && t.filePath) v.filePath = t.filePath;
  return v;
}

function sanitize(name: string): string {
  // 与内核 utils/filename.ts 同规则的文件名净化在 ipc 层做；这里只兜底路径分隔符
  return basename(name).replace(/[\\/:*?"<>|]/g, "_") || "download";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

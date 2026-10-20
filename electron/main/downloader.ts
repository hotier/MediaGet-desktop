/**
 * 下载管理器（docs/ARCHITECTURE.md §4）
 *
 * - 并发上限（设置可调）、失败隔离、重试（指数退避 3 次）
 * - 落盘 `<目标>.part` → 完成 rename；`.part` 带身份 meta（`<part>.meta` 存 URL）：
 *   同 URL 断点续传复用原名；异 URL 遗留半成品清理后复用；活任务占位才序号避让
 * - 续传：`.part` 存在且 meta 与本次是**同一份资源**（`isSameResource`，换签名/换节点都不算换资源）
 *   就带 `Range: bytes=<size>-`；上游返回 200（不支持 Range）才整体重下。两条入口共用这条判据：
 *   队列里 resume/restore，以及「重新解析后重新入队」——后者拿到的是新签名链，不能当成新资源
 * - 防盗链：Referer/UA 来自任务入队时携带的字段（main/ipc 从解析结果与内核
 *   PLATFORM_INFO 域名映射组装），本模块不复制域名表
 * - 进度事件 ~200ms 节流（emitter 注入，vitest 可直接测，不依赖 electron）
 * - 队列快照节流持久化（重启恢复由 index.ts 调 restore）
 * - 完整性闸门：上游声明过 content-length 却没收满 = 提前 EOF，保留 `.part` 报失败，
 *   绝不把半截文件改名成「完成」的成品
 * - 无进展看门狗（默认 30s）：僵死连接中止并重试，不会一直占着执行槽；
 *   写流 'error' 当场接住（磁盘满/EPERM 报任务失败），不外泄成未捕获异常
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
// 续传身份与续链身份必须是同一把尺（pathname + 非时效参数）：`.part` 能不能接着写、
// 403 之后哪条新链属于这一份资源，两处各写一套比较规则就会得出互相矛盾的答案
import { isSameResource } from "../../shared/link-identity";
import { resolveKey } from "../../shared/platforms";

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
  /** 失败自动重试次数实时取值（0–3） */
  getRetryTimes: () => number;
  /** 取消任务是否保留 .part 断点 */
  getKeepPartials: () => boolean;
  /**
   * SQLite 队列档（可选）：终态行落盘后会从内存退休，重试时按 taskId 取回；
   * 清理由下载器判定「哪些能删」后统一交给它删库。不传则保持纯内存语义（单测）。
   */
  queue?: {
    load(taskId: string): PersistedQueueTask | undefined;
    remove(taskIds: string[]): number;
  };
  /** 默认 UA（主进程出网统一带浏览器 UA，照抄内核 UA 治理，不私自加码） */
  defaultUserAgent: string;
  /**
   * 无进展看门狗：连续多少毫秒收不到一个新字节就判定连接僵死（默认 30s）。
   * 做成参数而不是常量，是为了让离线测试不必真的等 30 秒。
   */
  stallTimeoutMs?: number;
  /** 重试退避基数（默认 1s；同上，测试要能压缩时间） */
  retryBaseDelayMs?: number;
  /**
   * 直链过期（HTTP 403）时重新取一条链：给**同一个资源**换新签名，认不出对象就不续（返回 null，
   * 照原样进重试与报错）。合并与判据在 `electron/main/link-renew.ts`、`shared/link-identity.ts`。
   */
  renewUrl?: (failedUrl: string, sourceUrl?: string) => Promise<string | null>;
  events: DownloaderEvents;
  fetchImpl?: typeof fetch;
}

interface InternalTask extends DownloadTaskView {
  referer?: string;
  headers?: Record<string, string>;
  signal?: AbortController;
  attempts: number;
  /** 本任务已经为 403 续过一次链（一次为限：续完还 403 就不是时效问题） */
  renewed?: boolean;
  /** 续链成功那一句给用户的说明，只活在本进程内存里（队列快照不带它） */
  note?: string;
  /** 最终落地路径（含同名冲突后的实际名） */
  filePath?: string;
}

const PROGRESS_THROTTLE_MS = 200;
const RETRY_BASE_DELAY_MS = 1000;
/**
 * 无进展看门狗默认值。30s 的依据：CDN 直链的抖动通常几秒内恢复，超过 30s 不推进
 * 基本是连接僵死——而僵死的 fetch 会一直占着执行槽（旧实现只有 pause/cancel 能中止），
 * 用户视角就是「队列卡死，只能重启应用」。
 */
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

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

/**
 * 「占位中」状态：目标路径归它、随时可能继续往里写字节。
 * 同名冲突避让与缓存清理避让共用这一把尺 —— done/canceled 已定局，不再占位。
 */
function isClaimingStatus(status: DownloadStatus): boolean {
  return status === "queued" || status === "downloading" || status === "paused" || status === "error";
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

  /**
   * 内存里的活行（排队 / 下载中 / 暂停）。`download:list` 用它覆盖 SQLite 同 id 行：
   * 终态行落盘后即退休，库里那份才是台账；活行的进度只在内存里刷新。
   */
  listLive(): DownloadTaskView[] {
    return this.list().filter(
      (t) => t.status === "queued" || t.status === "downloading" || t.status === "paused"
    );
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
          transferMs: 0,
          transferBytes: 0,
          error: "不安全的下载地址（私网/非 http 协议被拒绝）",
          attempts: 0,
          createdAt: Date.now(),
          platform: meta?.platform ? resolveKey(meta.platform) : undefined,
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
        // 平均速度的两个采样计数器从 0 起：接着别人的 .part 写时，分子（transferBytes）
        // 只会长在本任务真正收到的字节上，不会把半成品的旧字节算成「这么快下完的」
        transferMs: 0,
        transferBytes: 0,
        attempts: 0,
        createdAt: Date.now(),
        platform: meta?.platform ? resolveKey(meta.platform) : undefined,
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
   * - 同名 .part：meta 与本次**同一份资源** → 原名续传；认不出 / 无 meta → 清理后复用原名
   *   （遗留半成品对别的资源没有价值，且最终文件不存在，名字归本次任务）
   *
   * 「同一份资源」按 `isSameResource`（pathname + 非时效参数）判，不按 URL 字符串：
   * 403 续链、隔天重新解析都会把签名换掉，字符串比较会把每次换签都当成「异资源」，
   * 于是真正的续传永远轮不到 —— 症状是「重新下载又从 0% 开始」。
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
        const reusable = partUrl === url || (partUrl !== null && isSameResource(partUrl, url));
        if (!reusable) this.removePartFiles(part);
      }
      return candidate;
    }
    return join(dir, `${stem}-${Date.now()}${ext}`);
  }

  private isTargetClaimed(target: string): boolean {
    for (const t of this.tasks.values()) {
      if (isClaimingStatus(t.status) && this.targetPath(t) === target) {
        return true;
      }
    }
    // 重启恢复前旧实例的占位不在内存：claimedTargets 只在进程内有效（可接受——
    // 同一目标两个活下载在 restore 语义里互斥于 status，恢复即重排）
    return false;
  }

  /**
   * 活任务占用的断点文件（`.part` 及其 `.meta`）。
   * 存在的理由：设置页「清理缓存」只挑没人认领的半成品，判据必须与 isTargetClaimed
   * 同源，否则清一次缓存就把进行中的下载打断、把续传身份抹掉。
   */
  livePartPaths(): string[] {
    const out: string[] = [];
    for (const t of this.tasks.values()) {
      if (!isClaimingStatus(t.status)) continue;
      out.push(this.partPath(t));
    }
    return out;
  }

  cancel(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === "done" || t.status === "error" || t.status === "canceled") return false;
    t.status = "canceled";
    if (t.signal) {
      // 流关闭后的 .part 清理由 runOne 的收尾统一做（Windows 句柄未关不能删）
      t.signal.abort();
    } else if (!this.opts.getKeepPartials()) {
      this.dropPart(t); // 未开始：无句柄，直接清（保留断点策略开启时不动）
    }
    this.opts.events.progress(toView(t));
    this.persist();
    this.retire(taskId);
    return true;
  }

  pause(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== "downloading") return false;
    t.status = "paused";
    // speed 故意不清：它是**暂停那一刻的快照**（业主指令 2026-10-18），界面据它显示暂停行的
    // 「速度」与「剩余」——两个值都冻结在暂停时，重启后靠队列档里的同一个键带回来（契约 v17）。
    t.signal?.abort(); // runOne 收尾 flush 后保留 .part，resume 从断点续
    this.opts.events.progress(toView(t));
    this.persist();
    return true;
  }

  resume(taskId: string): boolean {
    let t = this.tasks.get(taskId);
    if (!t) {
      // 终态行落盘后已退休：重试/继续要先把档取回内存。
      // paused 行本来就在内存（loadRecoverable 带回来），这里主要是 error/canceled。
      const saved = this.opts.queue?.load(taskId);
      if (!saved || !saved.url) return false;
      if (saved.status !== "paused" && saved.status !== "error" && saved.status !== "canceled") return false;
      t = this.revive(saved);
    }
    if (t.status !== "paused" && t.status !== "error" && t.status !== "canceled") return false;
    t.status = "queued";
    t.error = undefined;
    // 暂停快照的寿命到「继续」为止：重新连上游的那几秒报一个过期速度就是在说谎
    t.speed = 0;
    // 续链额度跟着重开：上一次已经换过一条链，不代表用户这次按下「继续/重试」时手上还是那条。
    // 不重开的话，「续链失败 → 一行 error」之后按重试只会在同一条死链上打转，必须重启应用才有救。
    t.renewed = undefined;
    t.attempts = 0;
    this.opts.events.progress(toView(t));
    this.persist();
    this.pump();
    return true;
  }

  /**
   * 把点名的任务移出行列（队列页「清理」与逐行移除共用一条通道）。
   * 只删终态行：queued/downloading 要用户先取消，不做「点一下就掐断在途字节」的暗箱；
   * 不碰磁盘 —— done 的产物在落地目录，error/canceled 的 .part 归 keepPartials 策略管。
   * 终态行可能早已退休、只剩库里那一行，所以「能不能删」按内存状态判，删除动作交给库。
   */
  clear(taskIds: string[]): number {
    const removable: string[] = [];
    for (const id of taskIds) {
      const t = this.tasks.get(id);
      if (t && (t.status === "queued" || t.status === "downloading")) continue;
      removable.push(id);
    }
    for (const id of removable) {
      this.tasks.delete(id);
      const at = this.order.indexOf(id);
      if (at >= 0) this.order.splice(at, 1);
    }
    // 返回值说「真正删掉几行」：退休行只在库里，按内存计数会少报
    return this.opts.queue ? this.opts.queue.remove(removable) : removable.length;
  }

  /** 终态行落盘后退出内存：队列页从 SQLite 翻页读它，内存只留还要动的活 */
  private retire(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t || t.status === "queued" || t.status === "downloading" || t.status === "paused") return;
    this.tasks.delete(taskId);
    const at = this.order.indexOf(taskId);
    if (at >= 0) this.order.splice(at, 1);
  }

  /** 把库里一条可重试的终态行取回内存（resume 专用）；落盘路径与 filePath 兜底同 restore */
  private revive(saved: PersistedQueueLike): InternalTask {
    const t = {
      ...saved,
      // 保留库内状态（error/canceled/paused）：resume 的资格判断在调用方，这里改成 queued
      // 会让那次判断永远失败
      speed: 0,
      transferMs: Math.max(0, Math.round(saved.transferMs ?? 0)),
      transferBytes: Math.max(0, Math.round(saved.transferBytes ?? 0)),
      attempts: 0,
      error: undefined,
      renewed: undefined,
      platform: saved.platform ? resolveKey(saved.platform) : undefined,
    } as InternalTask;
    if (!t.filePath) t.filePath = join(this.opts.getDownloadDir(), t.filename);
    // 与 restore 同一条占位纪律：复活的行也是活下载，别让新入队抢走同一个落点
    this.claimedTargets.add(t.filePath);
    this.tasks.set(t.taskId, t);
    this.order.push(t.taskId);
    this.order.sort(
      (a, b) => (this.tasks.get(b)?.createdAt ?? 0) - (this.tasks.get(a)?.createdAt ?? 0)
    );
    return t;
  }

  /**
   * 重启恢复：只接 `queueRepository.loadRecoverable()` 交回的未完成行
   * （queued / downloading / paused）。done / error / canceled 留在 SQLite 里由队列页翻页，
   * 不再进内存 —— 队列从此没有条数上限，内存只装还要动的那几条。
   * - downloading → queued（.part+meta 在则续传）；paused 保留暂停快照
   * - 旧版迁移可能拿不到直链（当时的隐私策略剥掉了 url）：这类行无法续传，
   *   落成一条带原因的 error 台账，而不是一启动就对着空 URL 发请求
   * - `pump()` 只挑 queued，所以暂停行回来不会被自动开跑
   *
   * 翻案记录（别照旧注释改回去）：v4 定过「done 跳过（落地目录才是真源）」与「canceled 不该
   * 每次启动回来占位」，业主 2026-10-17 明确推翻，原话「保留所有进过队列的数据」。
   * v22 起「保留」的实现从「全部塞回内存」改成「全部留在 SQLite」，队列页照样翻得到。
   */
  restore(saved: PersistedQueueLike[]): void {
    const unrecoverable: string[] = [];
    for (const s of saved) {
      const revived: DownloadStatus = s.status === "downloading" ? "queued" : s.status;
      const needsUrl = revived === "queued" || revived === "paused";
      const missingUrl = needsUrl && !s.url;
      if (missingUrl) unrecoverable.push(s.taskId);
      const t = {
        ...s,
        status: missingUrl ? "error" : revived,
        error: missingUrl ? "升级前的队列记录缺少下载地址，无法续传；请重新解析下载" : s.error,
        // 只有 paused 行的 speed 是档内的暂停快照（业主指令 2026-10-18）；其余状态不承认这个数：
        // 下载中恢复成 queued 后还没采到新样本，拿旧值当实时速度就是假象
        speed: revived === "paused" ? Math.max(0, Math.round(s.speed ?? 0)) : 0,
        // v18：平均速度的两个采样计数器随档回来 —— 暂停/失败行下次续完仍算得出平均速度。
        // 旧档没这两个键 → 0，该行完成时只能显示「—」，不拿墙钟时间凑一个数
        transferMs: Math.max(0, Math.round(s.transferMs ?? 0)),
        transferBytes: Math.max(0, Math.round(s.transferBytes ?? 0)),
        attempts: 0,
        renewed: undefined,
      } as unknown as InternalTask;
      // filePath 以档内为准：同名冲突时落的是 `xxx(1).mp4`，按「目录 + 文件名」重算会指向
      // 一个从没落地的名字，「打开所在文件夹」跳到不存在的路径。缺这个键（v13 之前的旧档）才重算。
      if (!t.filePath) t.filePath = join(this.opts.getDownloadDir(), t.filename);
      this.claimedTargets.add(t.filePath);
      this.tasks.set(t.taskId, t);
      this.order.push(t.taskId);
    }
    // 展示序：新在前
    this.order.sort(
      (a, b) => (this.tasks.get(b)?.createdAt ?? 0) - (this.tasks.get(a)?.createdAt ?? 0)
    );
    // downloading→queued 与「缺直链→error」都要落盘；否则下次启动还会把它们当可恢复行捞出来
    if (saved.length > 0) this.persist();
    for (const id of unrecoverable) this.retire(id);
    this.pump();
  }

  /**
   * 内存里的活行快照（v22：终态行落盘即退休，台账的完整形态在 SQLite 里）。
   *
   * 直链只在「还能续或还能重试」的状态上落盘：done 行剥成空串。理由是隐私红线「队列不保留
   * 直链 URL」——旧实现靠"完成行不落盘"顺带满足了它，现在完成行要留，就得单独把链摘掉；
   * 而到期直链对一条已完成记录本来也没有用途。
   */
  snapshot(): PersistedQueueLike[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is InternalTask => !!t)
      .map((t) => ({
        taskId: t.taskId,
        groupId: t.groupId,
        url: t.status === "done" ? "" : t.url,
        filename: t.filename,
        referer: t.referer,
        headers: t.headers,
        kind: t.kind,
        received: t.received,
        total: t.total,
        // 传输时长与对应字节：跨会话累积，暂停多久都不进分母（契约 v18）
        transferMs: Math.round(t.transferMs),
        transferBytes: Math.round(t.transferBytes),
        createdAt: t.createdAt,
        platform: t.platform,
        title: t.title,
        sourceUrl: t.sourceUrl,
        author: t.author,
        status: t.status as DownloadStatus,
        filePath: t.filePath,
        // 异常文本可能带路径且长度不可控（写流错误尤甚），契约上限 300，落盘前就地截
        error: t.error ? t.error.slice(0, 300) : undefined,
        finishedAt: t.finishedAt,
        // 暂停快照（契约 v17）：只给 paused 行落这个键，它答的是「暂停那一刻多快」，
        // 不是「这一行现在多快」——其余状态即使有值也没有意义，别把噪声写进长期档
        speed: t.status === "paused" ? Math.max(0, Math.round(t.speed)) : undefined,
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

  /**
   * 落地改名。Windows 的 renameSync 带 REPLACE_EXISTING：下载期间目标若被外部创建
   * （用户另存、别的程序写同名），直接改名会静默覆盖别人的文件 → 先探一次，占着就换
   * 序号名，与入队时的避让共用 resolveConflictPath 这一套规则。
   */
  private landFile(part: string, t: InternalTask): void {
    const target = this.targetPath(t);
    if (existsSync(target)) {
      const alt = resolveConflictPath(this.opts.getDownloadDir(), basename(target));
      t.filePath = alt;
      t.filename = basename(alt);
    }
    renameSync(part, this.targetPath(t));
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
      const partUrl = readPartUrl(part);
      // 与 pickTargetPath 同一把尺（isSameResource）：换签名不换资源 → 接着写；
      // 认不出（没 meta / 换了清晰度或分 P）才清掉重下。入队后又被外部改动身份也走这条。
      const reusable = partUrl === t.url || (partUrl !== null && isSameResource(partUrl, t.url));
      if (reusable) {
        try {
          start = statSync(part).size;
        } catch {
          start = 0;
        }
      } else {
        this.removePartFiles(part);
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
    /** 上游状态码：403 是「链过期」的唯一硬证据，catch 里靠它决定要不要续链 */
    let httpStatus = 0;
    let stream: ReturnType<typeof createWriteStream> | null = null;
    /** 写流错误（磁盘满 / EPERM / 路径被占）——必须自己接住，见下面的 once("error") */
    let streamErr: Error | null = null;
    const stallTimeoutMs = this.opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const retryBaseDelayMs = this.opts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    const stallError = () =>
      new Error(`下载超时：${Math.max(1, Math.round(stallTimeoutMs / 1000))} 秒没有收到新数据`);
    /**
     * 无进展看门狗：每收到一块就重新计时，超时即 abort。
     * 僵死的连接不该一直占着执行槽（旧实现只有用户 pause/cancel 能中止，
     * 上游半死不活时队列会永久卡住，用户唯一的出路是重启应用）。
     * `stalled` 用来把「看门狗中止」与「用户中止」分开——后者不该报错。
     */
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        t.signal?.abort();
      }, stallTimeoutMs);
    };
    const clearStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
    };
    try {
      armStall();
      const resp = await fetchImpl(t.url, { headers, signal: t.signal.signal, redirect: "follow" });
      if (!resp.ok && resp.status !== 206) {
        httpStatus = resp.status;
        throw new Error(`HTTP ${resp.status}`);
      }
      const supportsRange = resp.status === 206;
      if (start > 0 && !supportsRange) {
        // 上游不支持 Range：整体重下（截断重开）。采样计数也得一起归零，
        // 否则平均速度的分子保留了已丢弃的那部分字节、分母也带着上一程的时长
        start = 0;
        t.received = 0;
        t.transferMs = 0;
        t.transferBytes = 0;
      }
      const contentLength = Number(resp.headers.get("content-length") ?? 0);
      t.total = supportsRange ? start + contentLength : contentLength || t.total;

      stream = createWriteStream(part, supportsRange && start > 0 ? { flags: "a" } : { flags: "w" });
      const activeStream = stream;
      // 写流的 'error' 必须当场挂监听：Node 对无人监听的 error 事件抛未捕获异常，
      // 磁盘满 / 杀软占用 / 路径被占 时整个主进程消失。closeStream 只在收尾挂，太晚。
      // 顺带立刻 abort，别让后续字节白读白丢。
      const streamDied = new Promise<void>((res) => {
        activeStream.once("error", (e) => {
          streamErr = e instanceof Error ? e : new Error(String(e));
          t.signal?.abort();
          res();
        });
      });
      if (!resp.body) throw new Error("响应无 body");
      const reader = resp.body.getReader();
      let prevBytes = t.received;
      let prevTime = Date.now();
      for (;;) {
        const readAt = performance.now();
        const { done, value } = await reader.read();
        // 实际传输时长（契约 v18）：只累计「等一块字节」的时间。暂停/排队/重试退避都在
        // 循环之外，天然不计入 —— 完成行的平均速度用它做分母，暂停一小时也不会被稀释
        if (value && value.byteLength > 0) t.transferMs += performance.now() - readAt;
        if (streamErr) throw streamErr;
        if (stalled) throw stallError();
        if (done) break;
        const live = st();
        if (live === "canceled" || live === "paused") {
          clearStall();
          await Downloader.closeStream(activeStream); // flush 已收字节
          stream = null;
          if (live === "canceled" && !this.opts.getKeepPartials()) this.removePartFiles(part);
          return;
        }
        // 背压：write 返回 false 时等 drain，避免大文件灌满内存；
        // 流已死就永远等不到 drain，用 streamDied 兜住这个 await。
        if (!activeStream.write(value)) {
          await Promise.race([
            new Promise<void>((res) => activeStream.once("drain", () => res())),
            streamDied,
          ]);
        }
        // 写入失败的那些字节不算已收：received 必须等于 .part 的真实长度，
        // 否则续传时 Range 起点会跳过一段没落盘的数据。
        if (streamErr) throw streamErr;
        t.received += value.byteLength;
        // 分子只算「真落盘的那部分」：与 transferMs 同一段区间，两个计数器必须成对增长
        t.transferBytes += value.byteLength;
        armStall();
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
      clearStall();
      await Downloader.closeStream(activeStream);
      stream = null;
      // flush 期间才浮出来的写错误（缓冲推到磁盘才发现写不进去）
      if (streamErr) throw streamErr;
      // 完整性闸门：上游声明过总长却没收满，就是提前 EOF。
      // 半截文件改名成正式文件名并标「完成」是最坏结局——用户以为下好了，打开才发现播不了。
      if (t.total > 0 && t.received < t.total) {
        throw new Error(`传输不完整（${t.received}/${t.total} 字节），已保留断点`);
      }
      this.landFile(part, t);
      try {
        rmSync(metaPathFor(part), { force: true }); // 身份使命完成
      } catch {
        /* ignore */
      }
      t.status = "done";
      // 完成行的速度由界面按「transferBytes ÷ transferMs」算平均（业主指令 2026-10-18），
      // 这里清掉最后一个瞬时采样值，免得它被误读成「完成时还在跑」
      t.speed = 0;
      t.finishedAt = Date.now();
      this.opts.events.progress(toView(t));
      this.opts.events.done(toView(t));
      this.opts.events.history({
        groupTask: { ...toView(t), filePath: this.targetPath(t) },
        files: [this.targetPath(t)],
      });
      this.persist();
      this.retire(t.taskId);
    } catch (e) {
      clearStall();
      const live = st();
      // 归因优先于表面异常：看门狗与写流错误都表现为 AbortError / 静默丢字节，
      // "This operation was aborted" 对用户没有信息量，要说清是谁按下的中止。
      const cause = streamErr ?? (stalled ? stallError() : e);
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
        if (!this.opts.getKeepPartials()) this.removePartFiles(part);
        return;
      }
      if (live === "paused") {
        // flush 之后补发：UI 收到 paused 进度事件时 .part 已就绪可续传
        this.opts.events.progress(toView(t));
        return;
      }
      // —— 直链过期（403）自动续链：一次为限，认不出对象就照原样报错 ——
      // 放在重试计数之前：续链不是「又失败一次」，而是把这一条任务换成能用的链再来一遍。
      // 用户视角应当是「等一下就好了」，而不是队列里多一条 403 让他自己重新解析。
      if (httpStatus === 403 && !t.renewed && t.sourceUrl && this.opts.renewUrl) {
        t.renewed = true; // 先立牌：续链本身失败也不能再来一轮，否则会打平台打到手
        const next = await this.opts.renewUrl(t.url, t.sourceUrl).catch((e) => {
          console.warn(`[download] 续链失败: ${t.filename} - ${e?.message ?? String(e)}`);
          return null;
        });
        if (!next) {
          console.warn(`[download] 续链无结果: ${t.filename}, sourceUrl=${t.sourceUrl}`);
        }
        const live3 = st();
        if (next && next !== t.url && live3 !== "canceled" && live3 !== "paused") {
          t.url = next;
          // `.part.meta` 记的是「这一份资源的身份」，续链换的只是签名不是资源；不同步这一行
          // 就掉进下面那条「异 URL → 清掉半成品重下」，用户会看到进度从 0 开始跳回去。
          try {
            writeFileSync(metaPathFor(part), next, "utf8");
          } catch {
            /* meta 写失败只影响下次续传判定 */
          }
          t.note = "直链已过期，已自动重新取链";
          this.opts.events.progress(toView(t));
          this.persist();
          return this.runOne(t);
        } else if (next && next === t.url) {
          console.warn(`[download] 续链返回同一条URL: ${t.filename}`);
        }
      }
      t.attempts++;
      const maxAttempts = Math.min(4, Math.max(1, this.opts.getRetryTimes() + 1));
      if (t.attempts < maxAttempts) {
        // 指数退避重试
        await sleep(retryBaseDelayMs * 2 ** (t.attempts - 1));
        const live2 = st();
        if (live2 === "canceled") {
          if (!this.opts.getKeepPartials()) this.removePartFiles(part);
          return;
        }
        if (live2 === "paused") return;
        return this.runOne(t);
      }
      // 重试耗尽才落地成 error。完整性/超时/写流都保留 .part：
      // 磁盘满、连接僵死都是会过去的状况，续传比重下一遍对用户诚实得多。
      t.status = "error";
      t.error = cause instanceof Error ? cause.message : String(cause);
      this.opts.events.error(toView(t));
      this.persist();
      // 终态已落盘：内存退休，重试时 resume 会按 taskId 从库里取回
      this.retire(t.taskId);
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
    // 毫秒取整：契约要整数；this 是平均速度的分母，亚毫秒精度对结果没有意义
    transferMs: Math.round(t.transferMs),
    transferBytes: Math.round(t.transferBytes),
    error: t.error,
    platform: t.platform,
    title: t.title,
    createdAt: t.createdAt,
  };
  if (t.sourceUrl) v.sourceUrl = t.sourceUrl;
  if (t.note) v.note = t.note;
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

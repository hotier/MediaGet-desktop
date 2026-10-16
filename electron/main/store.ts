/**
 * userData 配置/历史读写（docs/ARCHITECTURE.md §2：JSON 文件 + 原子写；
 * 不用 SQLite 除非历史量大）。
 *
 * 落盘布局（%APPDATA%/MediaGet 或 Electron userData）：
 *   config.json   —— 应用设置 AppSettings + 内核配置键（Cookie 等，§5）
 *   history.json  —— HistoryEntry[]（只存平台/标题/时间/落地路径，**不存直链**）
 *   queue.json    —— 下载队列持久化（重启恢复，P2 验收「重启后队列/历史完整」）
 *   stats.json    —— StatsSnapshot 生命周期计数器（只有计数/字节/时长，无 url 无文件名）
 *
 * 原子写：写临时文件 → fsync → rename，避免断电/崩溃留下半个 JSON。
 * 凭据红线（§6.2）：config.json 含用户 Cookie，仅存本机 userData；
 * 导出接口（exportRedacted）默认剔除 Cookie 类键。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type HistoryEntry,
  type PersistedQueueTask,
  type StatsSnapshot,
} from "../../types/ipc";
import { resolveKey } from "../../shared/platforms";

/**
 * 历史窗口。5000 是给统计页的「逐文件粒度」用的：作者榜、单文件大小分布、
 * 类型字节占比只能从明细行算，计数器档给不了这些。代价是整档重写变贵——
 * 本机按真实形状（含中文标题、图集 7 张、作者快照）实测：500 条 299 KB / 写 5.7 ms，
 * 5000 条 3.0 MB / 整档写 25.5 ms、冷读+parse 19.3 ms。所以合并窗口
 * （`HISTORY_WRITE_DEBOUNCE_MS`）与「读盘走内存缓存」这两条必须一起成立。
 * 导出是为了截断用例能跟着这条线走，而不是把 5000 抄进测试。
 */
export const HISTORY_MAX = 5000;

/**
 * 落盘队列条数上限。快照里只剩待办（done 不进快照、canceled 不再恢复），
 * 正常用量远到不了这条线；到了就说明用户不清理，那就丢最旧的，
 * 而不是让 queue.json 无界增长（每次节流写盘都是整档重写）。
 */
const QUEUE_MAX = 200;

/** 历史落盘合并窗口：批量下载连环完成时，一秒内几十次追加只重写一次整档 */
const HISTORY_WRITE_DEBOUNCE_MS = 1000;

/** 计数档合并窗口：整档很小（几 KB），但收尾风暴同样不该钉几十次写 */
const STATS_WRITE_DEBOUNCE_MS = 1000;

export type { PersistedQueueTask };

export interface StoreShape {
  settings: AppSettings;
  /** 内核配置键（DOUYIN_COOKIE 等） */
  kernel: Record<string, string>;
  history: HistoryEntry[];
  queue: PersistedQueueTask[];
}

export class JsonStore {
  private dirtyTimer: NodeJS.Timeout | null = null;
  /** 待落盘的队列快照（节流窗口内最后一次写赢） */
  private pendingQueue: PersistedQueueTask[] | null = null;
  private configCache: Pick<StoreShape, "settings" | "kernel"> | null = null;
  /** 历史在内存里的当前表（新在前）；null = 还没从盘上读过来 */
  private historyCache: HistoryEntry[] | null = null;
  /** `historyCache` 对应的盘上身份（`${size}:${mtimeMs}`，null = 档不存在） */
  private historyStampOnDisk: string | null = null;
  /** 已进内存、尚未落盘的追加（新在前） */
  private historyPending: HistoryEntry[] = [];
  private historyTimer: NodeJS.Timeout | null = null;
  /** 计数档的内存对象（stats.ts 的 recorder 持有同一引用，这里只负责读盘与落盘） */
  private statsCache: StatsSnapshot | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  /**
   * @param onError 落盘失败的去处（默认 console.error；主进程注入文件日志）。
   * 历史写失败必须留痕 —— 合并窗口意味着失败不会在用户眼前重现第二次。
   */
  constructor(
    private dir: string,
    private onError: (message: string) => void = (message: string): void => console.error(message)
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: "config" | "history" | "queue" | "stats"): string {
    return join(this.dir, `${name}.json`);
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      if (!existsSync(file)) return fallback;
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      // 文件损坏按空处理（不让坏档阻断启动）；备份保留供人工恢复
      try {
        const bak = file + ".corrupt-" + Date.now();
        renameSync(file, bak);
      } catch {
        /* 备份失败也继续 */
      }
      return fallback;
    }
  }

  /** 原子写：tmp → fsync → rename */
  private writeJson(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  }

  // —— settings + kernel（同一个 config.json）——

  /** 内存缓存读：core-adapter/config 的 `read` 回调在每次解析都会调用，避免热路径反复读盘 */
  loadConfig(force = false): Pick<StoreShape, "settings" | "kernel"> {
    if (this.configCache && !force) return this.configCache;
    const raw = this.readJson<Partial<StoreShape>>(this.path("config"), {});
    this.configCache = {
      settings: {
        ...DEFAULT_SETTINGS,
        ...(raw.settings ?? {}),
        // 深拷 cookies：避免 settings 缺省时与 DEFAULT_SETTINGS 的共享引用被写穿（污染模块级常量）
        cookies: { ...(raw.settings?.cookies ?? {}) },
        // 同一条理由，且值本身是对象：逐键拷，不给 DEFAULT_SETTINGS 留可改的内层引用
        platformSwitches: Object.fromEntries(
          Object.entries(raw.settings?.platformSwitches ?? {}).map(([k, v]) => [k, { ...v }])
        ),
      },
      kernel: raw.kernel ?? {},
    };
    return this.configCache;
  }

  saveConfig(config: { settings: AppSettings; kernel: Record<string, string> }): void {
    // 写穿缓存：config.json 只有本类读写，无需再读盘
    this.configCache = config;
    this.writeJson(this.path("config"), config);
  }

  /** 内核配置单项读取（core-adapter/config 的 `read` 回调接这里） */
  getKernelValue(key: string): string | undefined {
    return this.loadConfig().kernel[key];
  }

  /** 导出配置（脱敏：剔除 Cookie/Key 类凭据，§6.2） */
  exportRedacted(secrets: readonly string[]): Record<string, unknown> {
    const { settings, kernel } = this.loadConfig();
    const redactedKernel: Record<string, string> = {};
    for (const [k, v] of Object.entries(kernel)) {
      redactedKernel[k] = secrets.includes(k) ? "<REDACTED>" : v;
    }
    return { settings: { ...settings, cookies: {} }, kernel: redactedKernel };
  }

  // —— history ——

  /**
   * 读历史（内存缓存 + 文件身份校验）。
   *
   * 追加即全量重写的话，500 条档位的单次写本机实测 4.4 ms（读 177 KB + parse +
   * stringify + fsync + rename），批量下载连环落盘就是在主进程上一颗一颗钉；
   * 而 `history:list` 每次调用都重读整档同样没必要。所以这里像 config 一样
   * 常驻内存，只在一个 `statSync` 的尺度上确认「盘上还是我认得的那份」——
   * 被外部改档（用户手编辑 / 别的实例）时以盘为准，不能拿着旧缓存装没看见。
   */
  loadHistory(): HistoryEntry[] {
    const stamp = this.historyStamp();
    if (this.historyCache && this.historyStampOnDisk === stamp) return this.historyCache;
    const onDisk = this.readJson<HistoryEntry[]>(this.path("history"), []);
    // 读侧归一（P2）：写入口归一只管得住今后，盘上的 xhs/ppxia 存量要在这里变回契约键，
    // 否则历史页按 `redbook` 筛选永远筛不出老记录。幂等，所以不必重写文件。
    const migrated = onDisk.map((e) => (e.platform ? { ...e, platform: resolveKey(e.platform) } : e));
    // 还没落盘的追加接回最前面（新在前），外部改档不能把它们吃掉
    this.historyCache = [...this.historyPending, ...migrated].slice(0, HISTORY_MAX);
    this.historyStampOnDisk = stamp;
    return this.historyCache;
  }

  /**
   * 追加一条：只动内存，落盘交给合并窗口。
   * 返回的是新表（新在前）；退出前 `flush()` 会把最后一次写补上。
   */
  appendHistory(entry: HistoryEntry): HistoryEntry[] {
    // 别名归一（xhs → redbook）在唯一的写入口做：历史页与统计页因此不可能看到同一个平台的两个名字
    const normalized: HistoryEntry = entry.platform
      ? { ...entry, platform: resolveKey(entry.platform) }
      : entry;
    const list = this.loadHistory();
    const next = [normalized, ...list].slice(0, HISTORY_MAX);
    this.historyCache = next;
    this.historyPending = [normalized, ...this.historyPending].slice(0, HISTORY_MAX);
    this.scheduleHistoryWrite();
    return next;
  }

  /** 清空历史：用户动作，立即落盘（不等合并窗口） */
  clearHistory(): HistoryEntry[] {
    this.historyCache = [];
    this.historyPending = [];
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    this.writeHistoryNow();
    return [];
  }

  /** 合并窗口：窗口内无论追加多少条，只重写一次整档 */
  private scheduleHistoryWrite(): void {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.writeHistoryNow();
    }, HISTORY_WRITE_DEBOUNCE_MS);
    if (typeof this.historyTimer.unref === "function") this.historyTimer.unref();
  }

  private writeHistoryNow(): void {
    try {
      this.writeJson(this.path("history"), this.historyCache ?? []);
      this.historyPending = [];
      this.historyStampOnDisk = this.historyStamp(); // 我们自己写的这份，缓存与盘重新对齐
    } catch (e) {
      this.onError(`history.json 落盘失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private historyStamp(): string | null {
    try {
      const st = statSync(this.path("history"));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null; // 档还不存在
    }
  }

  // —— stats（生命周期计数器：读只在启动发生一次，写走节流）——

  /** 盘上的计数档；不存在 / 损坏 → null（由 stats.ts 决定从零起算） */
  loadStats(): StatsSnapshot | null {
    if (this.statsCache) return this.statsCache;
    this.statsCache = this.readJson<StatsSnapshot | null>(this.path("stats"), null);
    return this.statsCache;
  }

  /**
   * 节流落盘。与队列不同，这里不另存 pending —— recorder 交回的就是它手上那份
   * 最新对象，定时器到点直接写整份即可。
   */
  saveStatsThrottled(stats: StatsSnapshot): void {
    this.statsCache = stats;
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.writeStatsNow();
    }, STATS_WRITE_DEBOUNCE_MS);
    if (typeof this.statsTimer.unref === "function") this.statsTimer.unref();
  }

  private writeStatsNow(): void {
    if (!this.statsCache) return;
    try {
      this.writeJson(this.path("stats"), this.statsCache);
    } catch (e) {
      // 计数写失败是静默倒退：不留痕就没人知道统计页少了这一段
      this.onError(`stats.json 落盘失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // —— queue（下载队列恢复用；写走节流，进度高频不逐条落盘）——

  loadQueue(): PersistedQueueTask[] {
    return this.readJson<PersistedQueueTask[]>(this.path("queue"), []);
  }

  saveQueue(tasks: PersistedQueueTask[]): void {
    // 快照已是展示序（新在前），截断即丢最旧的，不再排序
    this.writeJson(this.path("queue"), tasks.slice(0, QUEUE_MAX));
  }

  /**
   * 节流落盘：窗口内只写一次，但**写的是最后一次快照**。
   *
   * 为什么必须留 pending（曾经的真实缺陷）：早先的实现是
   * `if (this.dirtyTimer) return;` 直接丢弃窗口内的后续调用 —— 于是落盘的是
   * 窗口**开始**时的快照，而进度事件高频发生在窗口**结束**前，重启后队列显示的
   * 是 2 秒前的旧进度。更糟的是 `flush()` 只清定时器不落盘，退出路径上
   * before-quit 的最终快照会被前一个待触发定时器一起丢掉，
   * 直接违反 P2 验收「重启后队列/历史完整」。
   */
  saveQueueThrottled(tasks: PersistedQueueTask[]): void {
    this.pendingQueue = tasks;
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      this.flushQueue();
    }, 2000);
    if (typeof this.dirtyTimer.unref === "function") this.dirtyTimer.unref();
  }

  /** 立即落盘待写快照（幂等：无 pending 则什么都不做） */
  private flushQueue(): void {
    const pending = this.pendingQueue;
    this.pendingQueue = null;
    if (!pending) return;
    try {
      this.saveQueue(pending);
    } catch {
      /* 队列快照写失败不影响下载本身 */
    }
  }

  /**
   * 退出前调用：取消定时器并**同步**落盘最后快照，避免丢最后一次写入。
   * 队列、历史、计数三档都是节流写 —— 退出路径上不补就等于丢。
   */
  flush(): void {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
    this.flushQueue();
    if (this.historyTimer) {
      clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    if (this.historyPending.length > 0) this.writeHistoryNow();
    if (this.statsTimer) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
    }
    this.writeStatsNow();
  }
}

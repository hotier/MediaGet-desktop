/**
 * userData 配置/历史读写（docs/ARCHITECTURE.md §2：JSON 文件 + 原子写；
 * 不用 SQLite 除非历史量大）。
 *
 * 落盘布局（%APPDATA%/MediaGet 或 Electron userData）：
 *   config.json   —— 应用设置 AppSettings + 内核配置键（Cookie 等，§5）
 *   history.json  —— HistoryEntry[]（解析历史：平台/标题/时间/落地路径，**不存直链**；
 *                    files 为空 = 只解析没下载）
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
import { basename, dirname, join } from "node:path";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type HistoryEntry,
  type PersistedQueueTask,
  type StatsSnapshot,
} from "../../types/ipc";
import { resolveKey } from "../../shared/platforms";
import { normalizeAuthorSnapshot } from "../../shared/author";
import { normalizeHistoryKeys } from "../../shared/history";

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
 * 落盘队列条数上限。v13 起进过队列的行全部留档（done 也写，重启后照样回来），
 * 正常用量远到不了这条线；到了就说明用户不清理，那就丢最旧的，
 * 而不是让 queue.json 无界增长（每次节流写盘都是整档重写）。
 */
const QUEUE_MAX = 200;

/** 状态档的固定顺序：摘要按它排，两次落盘的日志才可直接比对（跟着插入序走会漂） */
const QUEUE_STATUS_ORDER = ["queued", "downloading", "paused", "done", "error", "canceled"] as const;

/**
 * 队列快照 → 一行摘要（`5 项（downloading 1 · done 3 · error 1）`）。
 *
 * 只带条数与状态分布两维：隐私红线（§6）不让直链进日志，而排查「谁把 queue.json 写空了」
 * 要的恰好也是这两维 —— 一行记录消失必然改变条数或某个状态的计数。进度字节不进摘要，
 * 所以 2 秒一次的进度落盘不会刷屏（`saveQueue` 那边按摘要变化决定是否留痕）。
 */
export function queueDigest(tasks: readonly PersistedQueueTask[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const parts = QUEUE_STATUS_ORDER.filter((s) => counts.has(s)).map((s) => `${s} ${counts.get(s)}`);
  return `${tasks.length} 项${parts.length === 0 ? "" : `（${parts.join(" · ")}）`}`;
}

/** 历史落盘合并窗口：批量下载连环完成时，一秒内几十次追加只重写一次整档 */
const HISTORY_WRITE_DEBOUNCE_MS = 1000;
/** 计数档合并窗口：整档很小（几 KB），但收尾风暴同样不该钉几十次写 */
const STATS_WRITE_DEBOUNCE_MS = 1000;

/** 异常 → 一行文本：落盘失败的原因要进日志，不能只留 `[object Object]` */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type { PersistedQueueTask };export interface StoreShape {
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
  /** 上一次队列落盘的摘要；只有它变了才留痕（进度每 2 秒写一次，不该刷屏） */
  private lastQueueDigest = "";

  /**
   * @param onError 落盘/读盘失败的去处（默认 console.error；主进程注入文件日志）。
   * 历史与队列写失败必须留痕 —— 合并窗口意味着失败不会在用户眼前重现第二次。
   * @param onInfo 关键落盘动作的留痕（默认 console.info；主进程注入 `logger.info`）。
   * 队列是这里唯一的主动留痕方：档内一行凭空没了，症状是「重启后任务不见了」，
   * 而没有任何一行日志能回答「什么时候写的、写了什么形状」。
   */
  constructor(
    private dir: string,
    private onError: (message: string) => void = (message: string): void => console.error(message),
    private onInfo: (message: string) => void = (message: string): void => console.info(message)
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: "config" | "history" | "queue" | "stats"): string {
    return join(this.dir, `${name}.json`);
  }

  private readJson<T>(file: string, fallback: T): T {
    const name = basename(file);
    try {
      if (!existsSync(file)) return fallback;
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch (e) {
      // 文件损坏按空处理（不让坏档阻断启动）；备份保留供人工恢复
      const bak = file + ".corrupt-" + Date.now();
      let kept = "";
      try {
        renameSync(file, bak);
        kept = `，原档留在 ${basename(bak)}`;
      } catch {
        kept = "，备份也失败（原档已不可读）";
      }
      // 这条必须留痕：按空处理的症状是「历史记录/队列凭空没了」，而盘上一个字节都没少 ——
      // 静默吞掉就等于把一次数据事故变成用户口中的「应用自己把档清了」
      this.onError(`[store] ${name} 读取失败，按空处理：${errText(e)}${kept}`);
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
        // filenameExtra 同理：缺省时若沿用 DEFAULT_SETTINGS 的对象引用，settings:set 的写回会污染常量
        filenameExtra: { ...DEFAULT_SETTINGS.filenameExtra, ...(raw.settings?.filenameExtra ?? {}) },
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
    // 读侧归一（P2）：写入口归一只管得住今后，盘上的 xhs 存量要在这里变回契约键，
    // 否则历史页按 `redbook` 筛选永远筛不出老记录。幂等，所以不必重写文件。
    // author 同一条口径：`toText` 之前落过数字 uid（bilibili 的 mid），一个脏字段就足以让
    // 整次 history:list 出参校验失败 —— 症状不是「这行少个作者」而是整页空态。
    // 作品键同理：旧行的键算自原始链接（尾部斜杠/分享参数会各成一行），读侧补算成归一后的键。
    const migrated = onDisk.map((e) => {
      const keyed = e.platform ? { ...e, platform: resolveKey(e.platform) } : e;
      return keyed.author ? { ...keyed, author: normalizeAuthorSnapshot(keyed.author) } : keyed;
    });
    // 还没落盘的追加接回最前面（新在前），外部改档不能把它们吃掉。
    // 键归一连同 pending 一起跑：刚解析的同作品行与盘上旧键行也要当场合成一行。
    this.historyCache = normalizeHistoryKeys([...this.historyPending, ...migrated]).slice(
      0,
      HISTORY_MAX
    );
    this.historyStampOnDisk = stamp;
    return this.historyCache;
  }

  /**
   * 追加一条：只动内存，落盘交给合并窗口。
   * 返回的是新表（新在前）；退出前 `flush()` 会把最后一次写补上。
   */
  appendHistory(entry: HistoryEntry): HistoryEntry[] {
    return this.pushHistory(entry, false);
  }

  /**
   * 追加或刷新同 id 的那一条（解析行用）。
   *
   * 一条链接会被解析很多次（[重试]、直链过期后的「重新解析并下载」、隔天再贴一遍），
   * 每次成功都插一行就成了重复解析的堆。id 是可复算的作品键（`shared/history.ts`），
   * 所以「同 id 先摘掉再前置」就等于：这个作品在历史里只有一条解析记录，且时间在最新。
   */
  upsertHistory(entry: HistoryEntry): HistoryEntry[] {
    return this.pushHistory(entry, true);
  }

  private pushHistory(entry: HistoryEntry, replaceSameId: boolean): HistoryEntry[] {
    // 别名归一（xhs → redbook）在唯一的写入口做：历史页与统计页因此不可能看到同一个平台的两个名字
    const normalized: HistoryEntry = entry.platform
      ? { ...entry, platform: resolveKey(entry.platform) }
      : entry;
    const drop = (e: HistoryEntry): boolean => replaceSameId && e.id === normalized.id;
    const next = [normalized, ...this.loadHistory().filter((e) => !drop(e))].slice(0, HISTORY_MAX);
    this.historyCache = next;
    this.historyPending = [normalized, ...this.historyPending.filter((e) => !drop(e))].slice(
      0,
      HISTORY_MAX
    );
    this.scheduleHistoryWrite();
    return next;
  }

  /**
   * 删除选中记录（history:remove）。传入的是**行键**集合 —— UI 一行可能聚了图集的
   * 多条条目（同 groupId），故删除口径是「条目 id 命中 **或** 其 groupId 命中」都删，
   * 保证选一行删掉整组、不留下半截图集。返回删除后的剩余列表，UI 直接拿去刷新，
   * 省一次回读（也不给「删完刚好空表」留特判：空数组就是空态）。
   * 整表清空也走这条（界面上是「表头全选 → 移除记录」，v9 起没有独立的 clear 方法）。
   * 用户动作，立即落盘。必须先走 loadHistory 把合并窗口里
   * 待写的追加折进缓存再筛，再经 writeHistoryNow 清掉 pending —— 绕过缓存直接写盘，
   * 节流定时器到点会拿旧缓存把删掉的行复活。
   */
  removeHistory(keys: string[]): HistoryEntry[] {
    const drop = new Set(keys);
    const hit = (e: HistoryEntry): boolean =>
      drop.has(e.id) || (e.groupId != null && drop.has(e.groupId));
    const keep = this.loadHistory().filter((e) => !hit(e));
    this.historyCache = keep;
    this.writeHistoryNow();
    return keep;
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
      this.onError(`[store] history.json 落盘失败：${errText(e)}`);
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
      this.onError(`[store] stats.json 落盘失败：${errText(e)}`);
    }
  }

  // —— queue（下载队列恢复用；写走节流，进度高频不逐条落盘）——

  loadQueue(): PersistedQueueTask[] {
    const raw = this.readJson<unknown>(this.path("queue"), []);
    if (!Array.isArray(raw)) {
      // 盘上那份算外部输入（手工编辑过、半截写、老版本形状都算）。异形只当没队列，
      // 但必须留痕：把非数组交给 `downloader.restore` 是启动级崩溃，而崩之前一行日志都没有
      this.onError(`[store] queue.json 不是数组（${typeof raw}），按空队列处理`);
      this.lastQueueDigest = "";
      return [];
    }
    const tasks = raw as PersistedQueueTask[];
    // 盘上现值作摘要基线：形状没变的第一次落盘不必再报一行
    this.lastQueueDigest = queueDigest(tasks);
    return tasks;
  }

  saveQueue(tasks: PersistedQueueTask[]): void {
    // 快照已是展示序（新在前），截断即丢最旧的，不再排序
    const keep = tasks.slice(0, QUEUE_MAX);
    this.writeJson(this.path("queue"), keep);
    const digest = queueDigest(keep);
    if (digest !== this.lastQueueDigest) {
      this.lastQueueDigest = digest;
      this.onInfo(`[store] 队列落盘 ${digest}`);
    }
    if (keep.length < tasks.length) {
      this.onError(`[store] 队列超过 ${QUEUE_MAX} 条上限，丢弃最旧的 ${tasks.length - keep.length} 条`);
    }
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
    } catch (e) {
      // 写失败不影响下载本身，但必须留痕：节流窗口意味着这事不会在用户眼前重演第二次，
      // 而它丢的是「重启后那条还没下完的任务」——静默就等于 P2 验收失败却没人知道
      this.onError(`[store] 队列落盘失败：${errText(e)}`);
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

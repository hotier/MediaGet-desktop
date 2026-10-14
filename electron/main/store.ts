/**
 * userData 配置/历史读写（docs/ARCHITECTURE.md §2：JSON 文件 + 原子写；
 * 不用 SQLite 除非历史量大）。
 *
 * 落盘布局（%APPDATA%/即刻解析 或 Electron userData）：
 *   config.json   —— 应用设置 AppSettings + 内核配置键（Cookie 等，§5）
 *   history.json  —— HistoryEntry[]（只存平台/标题/时间/落地路径，**不存直链**）
 *   queue.json    —— 下载队列持久化（重启恢复，P2 验收「重启后队列/历史完整」）
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
} from "../../types/ipc";

const HISTORY_MAX = 500;

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
  private configCache: Pick<StoreShape, "settings" | "kernel"> | null = null;

  constructor(private dir: string) {
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: "config" | "history" | "queue"): string {
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

  loadHistory(): HistoryEntry[] {
    return this.readJson<HistoryEntry[]>(this.path("history"), []);
  }

  appendHistory(entry: HistoryEntry): HistoryEntry[] {
    const list = [entry, ...this.loadHistory()].slice(0, HISTORY_MAX);
    this.writeJson(this.path("history"), list);
    return list;
  }

  clearHistory(): HistoryEntry[] {
    this.writeJson(this.path("history"), []);
    return [];
  }

  // —— queue（下载队列恢复用；写走节流，进度高频不逐条落盘）——

  loadQueue(): PersistedQueueTask[] {
    return this.readJson<PersistedQueueTask[]>(this.path("queue"), []);
  }

  saveQueue(tasks: PersistedQueueTask[]): void {
    this.writeJson(this.path("queue"), tasks);
  }

  saveQueueThrottled(tasks: PersistedQueueTask[]): void {
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      try {
        this.saveQueue(tasks);
      } catch {
        /* 队列快照写失败不影响下载本身 */
      }
    }, 2000);
    if (typeof this.dirtyTimer.unref === "function") this.dirtyTimer.unref();
  }

  flush(): void {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
  }
}

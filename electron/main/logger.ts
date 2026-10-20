/**
 * 文件日志（设置→通用→日志）：`<userData>/logs/app.log`，按大小轮转 + 按天保留。
 *
 * 为什么自己写而不引三方（electron-log 等）：需要的只有「级别门槛 + 轮转 + 超期删除」
 * 三件事，引库会把日志目录约定、 transports 配置再叠一层，而这里的落点必须完全可控 ——
 * 日志与本机数据库同处 userData，同样受隐私红线约束：**不落 Cookie 值、不落媒体直链**，
 * 调用方只投「哪一处降级/失败」这一句话。
 *
 * 级别门槛每次写都重新取（deps.getLevel 是回调）：设置页改完即生效，不需要重启。
 * 保留天数只在启动时扫一次（pruneExpired），因为「运行中删掉刚写的行」没有意义。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { LogSeverity, LogLevel } from "../../types/ipc";

/** 单档上限 2 MB；轮转留 5 份 ⇒ 日志目录最坏 ~12 MB，够回看数周问题 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ROTATIONS = 5;
/** 单行长度上限（渲染层转发的异常文本不可信，长堆栈截断而不是撑爆行结构） */
const MAX_LINE_CHARS = 2000;

/** 日志目录里归本模块管辖的文件名（轮转档位全在这里，别的路径一概不碰） */
const MANAGED_RE = /^app(\.\d+)?\.log$/;

const RANK: Record<LogSeverity, number> = { error: 0, warn: 1, info: 2 };

export interface LoggerDeps {
  logDir: () => string;
  getLevel: () => LogLevel;
  getRetentionDays: () => number;
  /** dev 同步镜像到控制台（打包版没有终端，写 console 等于丢进黑洞） */
  mirrorConsole?: boolean;
}

export interface AppLogger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  /** 按级别写（app:log 转发用） */
  write(level: LogSeverity, message: string): void;
  dir(): string;
  /** 托管文件的当前总占用（清理前汇报、设置页显示都取这里） */
  sizeBytes(): number;
  /** 删除全部轮转档与当前档，返回释放字节数（下次写入自动重建） */
  clear(): number;
  /** 启动时按保留天数清掉超期档，返回释放字节数 */
  pruneExpired(): number;
}

export function createLogger(deps: LoggerDeps): AppLogger {
  const dir = () => deps.logDir();

  /** 一行之内不许出现换行：多行消息会把「一行一条」的日志结构打成不可解析 */
  const sanitize = (message: string): string =>
    message.replace(/[\r\n]+/g, " | ").slice(0, MAX_LINE_CHARS);

  const managedFiles = (): string[] => {
    try {
      return readdirSync(dir()).filter((f) => MANAGED_RE.test(f));
    } catch {
      return [];
    }
  };

  const sizeOf = (name: string): number => {
    try {
      return statSync(join(dir(), name)).size;
    } catch {
      return 0;
    }
  };

  const sizeBytes = (): number =>
    managedFiles().reduce((sum, name) => sum + sizeOf(name), 0);

  /** app.5 → 删、4 → 5 …… 1 → 2、app.log → app.1（腾出的正是当前档的位） */
  function rotate(): void {
    const at = (i: number) => join(dir(), i === 0 ? "app.log" : `app.${i}.log`);
    try {
      if (existsSync(at(MAX_ROTATIONS))) unlinkSync(at(MAX_ROTATIONS));
      for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
        if (existsSync(at(i))) renameSync(at(i), at(i + 1));
      }
      renameSync(at(0), at(1));
    } catch {
      /* 轮转失败（占用/权限）就继续往当前档追加，不能因日志挡住主流程 */
    }
  }

  function write(level: LogSeverity, message: string): void {
    const gate = deps.getLevel();
    if (gate === "off") return;
    if (RANK[level] > RANK[gate]) return;
    const text = sanitize(message);
    if (deps.mirrorConsole) console[level](`[${level}] ${text}`);
    try {
      mkdirSync(dir(), { recursive: true });
      const line = `${new Date().toISOString()} [${level}] ${text}\n`;
      if (sizeOf("app.log") + Buffer.byteLength(line) > MAX_LOG_BYTES) rotate();
      appendFileSync(join(dir(), "app.log"), line, "utf8");
    } catch {
      /* 磁盘写失败静默：日志是旁路，任何情况下都不能让解析/下载跟着崩 */
    }
  }

  function removeManaged(cutoffMs?: number): number {
    let freed = 0;
    for (const name of managedFiles()) {
      const path = join(dir(), name);
      try {
        if (cutoffMs !== undefined && statSync(path).mtimeMs >= cutoffMs) continue;
        freed += sizeOf(name);
        unlinkSync(path);
      } catch {
        /* 单个文件删不掉（句柄占用）跳过，其余照清 */
      }
    }
    return freed;
  }

  return {
    error: (message) => write("error", message),
    warn: (message) => write("warn", message),
    info: (message) => write("info", message),
    write,
    dir,
    sizeBytes,
    clear: () => removeManaged(),
    pruneExpired: () =>
      removeManaged(Date.now() - deps.getRetentionDays() * 86_400_000),
  };
}

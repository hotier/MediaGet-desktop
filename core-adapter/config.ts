/**
 * 配置注入件（core-adapter/config）—— 两级求值（docs/ARCHITECTURE.md §5）。
 *
 * ```
 * 读某项 = 注入的本机配置（userData/mediaget.sqlite 的 kernel_config，设置页可见可编辑）
 *        ?? process.env.<KEY>（仅 dev 便利，prod 不依赖）
 *        ?? 代码内默认值
 * ```
 *
 * 依赖边界（§1）：core-adapter 不得 import electron。故本模块只定义
 * 「取值器」契约，读库由 electron/main 的 settingsRepository 注入 `read` 回调。
 *
 * 键位沿用 mediaGet 命名（DOUYIN_COOKIE / XHS_COOKIE / IG_COOKIE /
 * BILIBILI_COOKIE / YOUTUBE_PIPED_HOSTS / TWITTER_FIXER_SERVICES …），
 * 语义变化：线上是部署级秘密，桌面是用户自配（设置页明确标注风险自负）。
 */

export interface ConfigSourceOptions {
  /** 从本机配置读一项（kernel_config 表）；返回 undefined 表示未配置 */
  read: (key: string) => string | undefined;
  /** 是否允许回落 process.env（dev 便利；prod 传 false） */
  allowEnv: boolean;
  /** 代码内默认值表 */
  defaults?: Record<string, string>;
}

export interface ConfigSource {
  /** 两级求值取字符串 */
  get(key: string): string | undefined;
  /** 取布尔（"1"/"true"/"on" 视为真） */
  getBool(key: string): boolean | undefined;
  /** 取整数 */
  getInt(key: string): number | undefined;
  /** 取字符串列表（逗号分隔） */
  getList(key: string): string[];
  /** 来源诊断：值 + 命中级别，供设置页/日志展示 */
  inspect(key: string): { value?: string; level: "config" | "env" | "default" | "none" };
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function createConfigSource(options: ConfigSourceOptions): ConfigSource {
  const { read, allowEnv, defaults = {} } = options;

  const fromConfig = (key: string): string | undefined => {
    const v = read(key);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const fromEnv = (key: string): string | undefined => {
    if (!allowEnv || typeof process === "undefined" || !process.env) return undefined;
    const v = process.env[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };

  const resolve = (key: string): { value?: string; level: "config" | "env" | "default" | "none" } => {
    const c = fromConfig(key);
    if (c !== undefined) return { value: c, level: "config" };
    const e = fromEnv(key);
    if (e !== undefined) return { value: e, level: "env" };
    const d = defaults[key];
    if (typeof d === "string" && d.trim() !== "") return { value: d.trim(), level: "default" };
    return { level: "none" };
  };

  return {
    get: (key) => resolve(key).value,
    getBool: (key) => {
      const v = resolve(key).value;
      return v === undefined ? undefined : TRUTHY.has(v.toLowerCase());
    },
    getInt: (key) => {
      const v = resolve(key).value;
      if (v === undefined) return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    },
    getList: (key) => {
      const v = resolve(key).value;
      if (!v) return [];
      return v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    },
    inspect: resolve,
  };
}

/** 桌面端读取的内核配置键（Cookie 类 + 上游候选类），供设置页渲染 */
export const KERNEL_CONFIG_KEYS = [
  "DOUYIN_COOKIE",
  "BILIBILI_COOKIE",
  "BILIBILI_USER_AGENT",
  "XHS_COOKIE",
  "IG_COOKIE",
  "IG_TIMEOUT_MS",
  // 内核 1.0.0 新增：只服务快手作者主页资料（简介 / 获赞 / 粉丝数），视频解析本身不需要
  "KUAISHOU_COOKIE",
  "YOUTUBE_PIPED_HOSTS",
  "YOUTUBE_INVIDIOUS_HOSTS",
  "YOUTUBE_API_KEY",
  "TWITTER_FIXER_SERVICES",
  "YTDLP_BIN",
  "FFMPEG_BIN",
] as const;

export type KernelConfigKey = (typeof KERNEL_CONFIG_KEYS)[number];

/** Cookie 类键（导出配置时须剔除，ARCHITECTURE §6.2） */
export { SECRET_CONFIG_KEYS, isSecretKey } from "../shared/secret-keys";

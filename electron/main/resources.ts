/**
 * yt-dlp / ffmpeg 资源定位 + SHA-256 完整性校验
 * （docs/ARCHITECTURE.md §2 resources.ts, §7）
 *
 * - dev：MG_BIN_DIR 环境变量指定本地目录
 * - prod 首启：从打包 extraResources（`process.resourcesPath/bin`）校验 SHA-256
 *   后释放到 `userData/bin/`
 * - 支持用户自备路径覆盖（设置 kernel.YTDLP_BIN / FFMPEG_BIN 指向本地文件）
 *
 * 完整性链路（P0-2 打通，端到端闭合）：
 *   `scripts/fetch-binaries.cjs` 下载 → 比对 pin 的 size/sha256 → 写
 *   `<binDir>/manifest.json` → 随 extraResources 打包 → 本模块 `readManifest()`
 *   读出后作为 `expectedHashes` 注入 `createResources` → `locate()` 在释放前后
 *   强校验，不匹配即拒绝使用（返回 null，该平台回落线上通道）。
 *   CI 用 `fetch-binaries.cjs --verify-only` 在打包前断言清单在位且自洽，
 *   使「清单缺失」在构建期暴露，而不是拖到用户机器上降级。
 *
 * 校验强度分档（诚实标注，不假装有防护）：
 * - 有 manifest → 强校验，哈希不符一律不用；
 * - 无 manifest（dev 用户自备、旧包）→ 只定位不校验，并在日志明示降级。
 *   降级不是隐形的：`describe()` 把每个二进制的实际强度报给设置页。
 *
 * 性能约定：sha256 是同步 CPU 操作，ffmpeg 79 MB ≈ 107 ms。`locate()` 在每次
 * 解析前都会被内核配置读取路径调到，故这里按 `路径 + size + mtimeMs` 记忆化
 * 校验结果 —— 同一份文件只算一次；文件被替换（size/mtime 变）自动失效重算。
 * 不做记忆化会让主进程在首次解析时同步卡住上百毫秒。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type BinName = "yt-dlp" | "ffmpeg";

export interface ResourcesDeps {
  /** userData 根目录 */
  userDataDir: string;
  /** extraResources 落点（prod：process.resourcesPath/bin；dev：MG_BIN_DIR 或 null） */
  packagedDir: string | null;
  /** 用户自备路径（kernel 配置 YTDLP_BIN / FFMPEG_BIN） */
  readKernelConfig: (key: string) => string | undefined;
  /**
   * 期望 SHA-256 清单（发布时由 CI 生成随包 manifest.json；缺省只告警不阻断）。
   * Partial：清单可以只含其中一个二进制（例如只随包 yt-dlp），缺的那个退回降级。
   */
  expectedHashes?: Partial<Record<BinName, string>>;
  /**
   * 哈希实现（默认 sha256File）。仅作为测试接缝：让「同一文件只算一次」这条
   * 性能约定可以被确定性地断言，而不是靠计时猜测。
   */
  hashFile?: (path: string) => string;
}

export interface ResolvedBin {
  name: BinName;
  path: string;
  /** 来源：user=用户自备 / extracted=首启释放 / packaged=直接使用（dev） */
  origin: "user" | "extracted" | "packaged";
}

/** 单个二进制的可汇报状态（设置页 / 日志用，如实反映校验强度） */
export interface BinStatus {
  name: BinName;
  available: boolean;
  origin?: ResolvedBin["origin"];
  path?: string;
  /**
   * 完整性结论：
   * - verified   有基线且哈希匹配
   * - degraded   无基线（未随包清单 / 用户自备），只定位不校验
   * - rejected   有基线但哈希不符或读取失败，已拒绝使用
   * - missing    三处都没有
   */
  integrity: "verified" | "degraded" | "rejected" | "missing";
  /** 期望哈希（有基线时） */
  expected?: string;
}

const FILENAMES: Record<BinName, string> = {
  "yt-dlp": process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  ffmpeg: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
};

const KERNEL_KEYS: Record<BinName, string> = {
  "yt-dlp": "YTDLP_BIN",
  ffmpeg: "FFMPEG_BIN",
};

export const BIN_NAMES: readonly BinName[] = ["yt-dlp", "ffmpeg"] as const;

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createResources(deps: ResourcesDeps) {
  const binDir = join(deps.userDataDir, "bin");
  const hashFile = deps.hashFile ?? sha256File;

  /**
   * 校验结果记忆化：key = `${name}\u0000${path}\u0000${size}\u0000${mtimeMs}`。
   * 只缓存「是否通过」这一个布尔，不缓存文件内容（内存友好）。
   */
  const verifyCache = new Map<string, boolean>();

  function cacheKey(name: BinName, path: string): string | null {
    try {
      const st = statSync(path);
      // 目录不是二进制（existsSync 对目录同样返回 true，必须显式挡掉）
      if (!st.isFile()) return null;
      return `${name}\u0000${path}\u0000${st.size}\u0000${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** 解析二进制路径：用户自备 > userData/bin（已释放）> packaged（首启校验后释放） */
  function locate(name: BinName): ResolvedBin | null {
    const userPath = deps.readKernelConfig(KERNEL_KEYS[name]);
    if (userPath && isUsableFile(userPath)) {
      // 用户自备：按设计不校验哈希（我们不知道他放的哪个构建），但仍拒绝目录/不可读路径
      return { name, path: userPath, origin: "user" };
    }

    const local = join(binDir, FILENAMES[name]);
    if (isUsableFile(local)) {
      return verify(local, name) ? { name, path: local, origin: "extracted" } : null;
    }

    if (deps.packagedDir) {
      const src = join(deps.packagedDir, FILENAMES[name]);
      if (isUsableFile(src)) {
        if (!verify(src, name)) return null;
        mkdirSync(binDir, { recursive: true });
        try {
          copyFileSync(src, local);
          return { name, path: local, origin: "extracted" };
        } catch {
          // 释放失败直接用 packaged（asar.unpacked 场景可读）
          return { name, path: src, origin: "packaged" };
        }
      }
    }
    return null;
  }

  /** 存在且是普通文件（挡掉目录、断链） */
  function isUsableFile(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  }

  function verify(path: string, name: BinName): boolean {
    const expected = deps.expectedHashes?.[name];
    if (!expected) {
      // 无清单 = 无完整性基线（dev 自备二进制 / 旧包）。降级但留痕，
      // 不要静默假装校验过。
      console.warn(`[resources] ${name} 无 SHA-256 基线，跳过完整性校验（降级）`);
      return true;
    }
    const key = cacheKey(name, path);
    if (key) {
      const hit = verifyCache.get(key);
      if (hit !== undefined) return hit;
    }
    let ok: boolean;
    try {
      const actual = hashFile(path);
      ok = actual === expected;
      if (!ok) {
        console.warn(
          `[resources] ${name} SHA-256 不匹配，拒绝使用: ${actual} ≠ ${expected}`
        );
      }
    } catch (e) {
      console.warn(
        `[resources] ${name} 哈希计算失败，拒绝使用: ${e instanceof Error ? e.message : String(e)}`
      );
      ok = false;
    }
    if (key) verifyCache.set(key, ok);
    return ok;
  }

  /**
   * 逐个二进制的实际状态（设置页 / 诊断日志用）。
   * 这是「降级可见」的落点：调用方据此把 integrity 如实展示给用户，
   * 而不是让「无基线」悄悄发生。
   */
  function describe(): BinStatus[] {
    return BIN_NAMES.map((name) => {
      const expected = deps.expectedHashes?.[name];
      const hit = locate(name);
      if (!hit) {
        // locate 返回 null 有两种可能：压根没有，或有基线但被拒
        const rejected = !!expected && hasAnyCandidate(name);
        return {
          name,
          available: false,
          integrity: rejected ? "rejected" : "missing",
          ...(expected ? { expected } : {}),
        };
      }
      return {
        name,
        available: true,
        origin: hit.origin,
        path: hit.path,
        integrity: expected ? "verified" : "degraded",
        ...(expected ? { expected } : {}),
      };
    });
  }

  /** 三处候选位置里是否至少存在一个普通文件（区分 missing 与 rejected） */
  function hasAnyCandidate(name: BinName): boolean {
    const userPath = deps.readKernelConfig(KERNEL_KEYS[name]);
    if (userPath && isUsableFile(userPath)) return true;
    if (isUsableFile(join(binDir, FILENAMES[name]))) return true;
    if (deps.packagedDir && isUsableFile(join(deps.packagedDir, FILENAMES[name]))) return true;
    return false;
  }

  return {
    locate,
    describe,
    binDir,
    /** 本次是否带完整性基线（设置页/日志据此如实汇报校验强度） */
    verified: Object.keys(deps.expectedHashes ?? {}).length > 0,
  };
}

/**
 * 读二进制 SHA-256 清单（由 `scripts/fetch-binaries.cjs` 在下载校验通过后写入
 * `<dir>/manifest.json`，随 extraResources 一起打包）。
 *
 * 返回 null 表示「无清单」——dev 下用户自备二进制、或旧包未带清单。调用方据此
 * 决定是否启用严格校验：有清单就强校验，没有就退回「只定位不校验」。
 *
 * 清单内容形如 `{ "yt-dlp": "<sha256>", "ffmpeg": "<sha256>" }`，只信任其中
 * 64 位十六进制字符串的条目，其余（手改、截断、注入）一律丢弃。
 */
export function readManifest(dir: string | null): Partial<Record<BinName, string>> | null {
  if (!dir) return null;
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Partial<Record<BinName, string>> = {};
    for (const name of BIN_NAMES) {
      const v = raw?.[name];
      if (typeof v === "string" && /^[0-9a-f]{64}$/i.test(v)) out[name] = v.toLowerCase();
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    console.warn(
      `[resources] manifest.json 解析失败（按无清单处理）: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

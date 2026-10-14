/**
 * yt-dlp / ffmpeg 资源定位（docs/ARCHITECTURE.md §2 resources.ts, §7）
 *
 * - dev：MG_BIN_DIR 环境变量指定本地目录
 * - prod 首启：从打包 extraResources（`process.resourcesPath/bin`）校验 SHA-256
 *   后释放到 `userData/bin/`
 * - 支持用户自备路径覆盖（设置 kernel.YTDLP_BIN / FFMPEG_BIN 指向本地文件）
 *
 * P3 才随包分发二进制；P1/P2 阶段本模块只提供定位与哈希校验骨架，
 * 文件缺失时返回 null（TikTok 等依赖 yt-dlp 的平台自然走线上回落）。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type BinName = "yt-dlp" | "ffmpeg";

export interface ResourcesDeps {
  /** userData 根目录 */
  userDataDir: string;
  /** extraResources 落点（prod：process.resourcesPath/bin；dev：MG_BIN_DIR 或 null） */
  packagedDir: string | null;
  /** 用户自备路径（kernel 配置 YTDLP_BIN / FFMPEG_BIN） */
  readKernelConfig: (key: string) => string | undefined;
  /** 期望 SHA-256 清单（发布时由 CI 生成随包 manifest.json；缺省只告警不阻断） */
  expectedHashes?: Record<BinName, string>;
}

export interface ResolvedBin {
  name: BinName;
  path: string;
  /** 来源：user=用户自备 / extracted=首启释放 / packaged=直接使用（dev） */
  origin: "user" | "extracted" | "packaged";
}

const FILENAMES: Record<BinName, string> = {
  "yt-dlp": process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  ffmpeg: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
};

const KERNEL_KEYS: Record<BinName, string> = {
  "yt-dlp": "YTDLP_BIN",
  ffmpeg: "FFMPEG_BIN",
};

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createResources(deps: ResourcesDeps) {
  const binDir = join(deps.userDataDir, "bin");

  /** 解析二进制路径：用户自备 > userData/bin（已释放）> packaged（首启校验后释放） */
  function locate(name: BinName): ResolvedBin | null {
    const userPath = deps.readKernelConfig(KERNEL_KEYS[name]);
    if (userPath && existsSync(userPath)) {
      return { name, path: userPath, origin: "user" };
    }

    const local = join(binDir, FILENAMES[name]);
    if (existsSync(local)) {
      return verify(local, name) ? { name, path: local, origin: "extracted" } : null;
    }

    if (deps.packagedDir) {
      const src = join(deps.packagedDir, FILENAMES[name]);
      if (existsSync(src)) {
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

  function verify(path: string, name: BinName): boolean {
    const expected = deps.expectedHashes?.[name];
    if (!expected) return true; // 无 manifest（P1/P2 阶段）只告警不阻断
    try {
      const actual = sha256File(path);
      if (actual !== expected) {
        console.warn(`[resources] ${name} SHA-256 不匹配: ${actual} ≠ ${expected}`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 写 SHA-256 manifest（CI/发布工具用；本仓 resources/bin 不入库） */
  function writeManifest(dir: string): void {
    const manifest: Partial<Record<BinName, string>> = {};
    for (const name of ["yt-dlp", "ffmpeg"] as BinName[]) {
      const p = join(dir, FILENAMES[name]);
      if (existsSync(p)) manifest[name] = sha256File(p);
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  return { locate, writeManifest, binDir };
}

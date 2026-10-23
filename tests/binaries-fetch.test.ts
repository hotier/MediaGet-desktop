/**
 * fetch-binaries.cjs 的退出码边界（P2-11）。
 *
 * 这几条语义只有真子进程可观测，写反的后果不对称：`--soft` 变严 = 没网就改不了 UI；
 * 严格档变软 = 缺 ffmpeg 的包照样出门。把脚本复制进临时树后它的 ROOT 跟着 __dirname 走，
 * pins 指向 127.0.0.1:1（必拒端口），全程离线、秒回。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/fetch-binaries.cjs", import.meta.url));
const directories: string[] = [];

function tree(pins: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mediaget-binaries-"));
  directories.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "resources"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts", "fetch-binaries.cjs"));
  writeFileSync(join(dir, "resources", "binaries.json"), JSON.stringify(pins), "utf8");
  return dir;
}

function offlinePins(overrides: Record<string, unknown> = {}): unknown {
  return {
    binaries: {
      "yt-dlp": {
        version: "0.0.0",
        file: "yt-dlp.exe",
        url: "http://127.0.0.1:1/yt-dlp.exe",
        sha256: "a".repeat(64),
        size: 1,
        ...overrides,
      },
    },
  };
}

function run(dir: string, args: string[]) {
  // Node 的 fetch 在 NODE_USE_ENV_PROXY=1 时会读环境代理；测试进程可能带着它，清掉免得请求绕路
  const env = { ...process.env };
  for (const key of [
    "NODE_USE_ENV_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [join(dir, "scripts", "fetch-binaries.cjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("下载失败时的退出码", () => {
  it("--soft：下载失败照样 0，manifest 如实记为空并播报未就绪", () => {
    const dir = tree(offlinePins());
    const r = run(dir, ["--soft"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("软失败");
    expect(r.stderr).toContain("随包二进制未就绪");
    const manifest = readFileSync(join(dir, "resources", "bin", "manifest.json"), "utf8");
    expect(JSON.parse(manifest)).toEqual({});
  });

  it("不带 --soft（CI 路径）：同一失败必须非零退出", () => {
    const dir = tree(offlinePins());
    const r = run(dir, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("失败");
  });

  it("--soft 不救 pins 残缺：binaries.json 缺字段仍非零退出", () => {
    const dir = tree(offlinePins({ sha256: undefined }));
    const r = run(dir, ["--soft"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("缺字段");
  });

  it("--soft 不救漂移源：releases/latest/download 仍非零退出", () => {
    const dir = tree(offlinePins({ url: "https://github.com/x/y/releases/latest/download/tool.exe" }));
    const r = run(dir, ["--soft"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("latest/download");
  });
});

describe("--verify-only 的清单守门", () => {
  function hashedPins(content: Buffer) {
    return offlinePins({
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.length,
      url: "https://example.invalid/yt-dlp.exe",
    });
  }

  it("--require-all：二进制缺失即非零退出", () => {
    const dir = tree(offlinePins({ url: "https://example.invalid/yt-dlp.exe" }));
    const r = run(dir, ["--verify-only", "--require-all"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("不存在");
    expect(r.stderr).toContain("manifest.json 缺失");
  });

  it("文件在位但 manifest 缺失仍非零退出（拒绝静默降级为只定位不校验）", () => {
    const content = Buffer.from("fake-exe-payload");
    const dir = tree(hashedPins(content));
    mkdirSync(join(dir, "resources", "bin"), { recursive: true });
    writeFileSync(join(dir, "resources", "bin", "yt-dlp.exe"), content);
    const r = run(dir, ["--verify-only"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("manifest.json 缺失");
  });

  it("文件与 manifest 自洽时通过", () => {
    const content = Buffer.from("fake-exe-payload");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const dir = tree(hashedPins(content));
    mkdirSync(join(dir, "resources", "bin"), { recursive: true });
    writeFileSync(join(dir, "resources", "bin", "yt-dlp.exe"), content);
    writeFileSync(join(dir, "resources", "bin", "manifest.json"), JSON.stringify({ "yt-dlp": sha256 }), "utf8");
    const r = run(dir, ["--verify-only", "--require-all"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("校验通过");
  });
});

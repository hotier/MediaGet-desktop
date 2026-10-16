/**
 * 二进制新版本观察（`--check-updates`）单测。
 *
 * 为什么值得单测：这条命令的输出直接决定「要不要动 resources/binaries.json 的 pin」，
 * 而它算出的 SHA-256 一旦错写，构建期校验会红或在用户机器上拒收正常文件。
 * 更关键的是它必须诚实：限流没查成时不能报「全部为最新」——那会让人以为下载链路是健康的。
 *
 * 判定逻辑全部走注入的假 fetch 件（外网不该进测试）；唯一跑真子进程的是 `--soft`
 * 退出码那组，它要验的对象就是进程退出码本身，地址固定指向本机死端口，不碰外网。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs, parseReleaseUrl, checkUpdates } = require("../scripts/fetch-binaries.cjs") as {
  parseArgs: (argv: string[]) => Record<string, unknown>;
  parseReleaseUrl: (url: string) => { owner: string; repo: string; tag: string; asset: string } | null;
  checkUpdates: (
    pins: [string, Record<string, string>][],
    log: (m: string) => void,
    note: (m: string) => void,
    deps?: {
      fetchLatest?: (owner: string, repo: string) => Promise<unknown>;
      fetchAsset?: (url: string) => Promise<Buffer>;
    }
  ) => Promise<{
    patch: Record<string, { version: string; url: string; file: string; sha256: string; size: number }>;
    behind: number;
    unresolved: number;
  }>;
};

const PIN = {
  version: "2026.08.19",
  url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe",
  file: "yt-dlp.exe",
  sha256: "a".repeat(64),
};

/** 收集器：既要断言结论，也要断言「人看到的那句话」有没有误导 */
function harness() {
  const lines: string[] = [];
  const notes: string[] = [];
  return {
    log: (m: string) => lines.push(m),
    note: (m: string) => notes.push(m),
    lines,
    notes,
  };
}

const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from("fake-pe-payload")]); // "MZ" 开头

describe("pin.url 反解", () => {
  it("固定 tag 直链拆出 owner/repo/tag/asset", () => {
    expect(parseReleaseUrl(PIN.url)).toEqual({
      owner: "yt-dlp",
      repo: "yt-dlp",
      tag: "2026.08.19",
      asset: "yt-dlp.exe",
    });
  });

  it("资产名允许带斜杠以外的路径字符（ffmpeg 的发布名与落地名不同）", () => {
    const parsed = parseReleaseUrl(
      "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64"
    );
    expect(parsed?.asset).toBe("ffmpeg-win32-x64");
    expect(parsed?.tag).toBe("b6.1.1");
  });

  it("非 GitHub Release 直链返回 null（观察不了就别硬猜）", () => {
    expect(parseReleaseUrl("https://example.com/tool.tar.gz")).toBeNull();
  });
});

describe("checkUpdates 判定", () => {
  it("上游 tag 与 pin 相同 → 最新，无补丁、无未决", async () => {
    const h = harness();
    const r = await checkUpdates([["yt-dlp", PIN]], h.log, h.note, {
      fetchLatest: async () => ({ tag_name: PIN.version, assets: [] }),
    });
    expect(r).toEqual({ patch: {}, behind: 0, unresolved: 0 });
    expect(h.lines.join("\n")).toContain("已是上游最新正式版");
  });

  it("有新版本 → 给出可直接粘贴的字段，SHA-256 与新资产字节自洽", async () => {
    const h = harness();
    const newUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.09/yt-dlp.exe";
    const r = await checkUpdates([["yt-dlp", PIN]], h.log, h.note, {
      fetchLatest: async () => ({
        tag_name: "2026.10.09",
        assets: [{ name: "yt-dlp.exe", browser_download_url: newUrl }],
      }),
      fetchAsset: async () => EXE,
    });
    const expectSha = createHash("sha256").update(EXE).digest("hex");
    expect(r.patch["yt-dlp"]).toEqual({
      version: "2026.10.09",
      url: newUrl,
      file: "yt-dlp.exe", // 落地名沿用 pin.file，不是上游资产名
      sha256: expectSha,
      size: EXE.length,
    });
    expect(r.behind).toBe(1);
    expect(r.unresolved).toBe(0);
  });

  it("限流（soft）记为未决，绝不报成「一切正常」", async () => {
    const h = harness();
    const soft = Object.assign(new Error("GitHub API 限流（HTTP 403）"), { soft: true });
    const r = await checkUpdates([["yt-dlp", PIN]], h.log, h.note, {
      fetchLatest: async () => {
        throw soft;
      },
    });
    expect(r).toEqual({ patch: {}, behind: 0, unresolved: 1 });
    expect(h.notes.join("\n")).toContain("本轮未能确认");
  });

  it("上游硬失败才抛（网络断了要知道，别静默）", async () => {
    const h = harness();
    await expect(
      checkUpdates([["yt-dlp", PIN]], h.log, h.note, {
        fetchLatest: async () => {
          throw new Error("GitHub API 失败：HTTP 500");
        },
      })
    ).rejects.toThrow(/查上游失败/);
  });

  it("新版里资产改名 → 未决并提示人工核对，不产补丁", async () => {
    const h = harness();
    const r = await checkUpdates([["yt-dlp", PIN]], h.log, h.note, {
      fetchLatest: async () => ({ tag_name: "2026.10.09", assets: [{ name: "yt-dlp", browser_download_url: "x" }] }),
      fetchAsset: async () => EXE,
    });
    expect(r.patch).toEqual({});
    expect(r.unresolved).toBe(1);
    expect(h.notes.join("\n")).toContain("没有资产");
  });

  it("新资产是 HTML 错误页 → 抛错（200 + 错误页是最阴的投毒形态）", async () => {
    const h = harness();
    await expect(
      checkUpdates([["yt-dlp", PIN]], h.log, h.note, {
        fetchLatest: async () => ({
          tag_name: "2026.10.09",
          assets: [{ name: "yt-dlp.exe", browser_download_url: "https://github.com/x" }],
        }),
        fetchAsset: async () => Buffer.from("<!DOCTYPE html><html>404</html>"),
      })
    ).rejects.toThrow(/HTML/);
  });

  it("pin.url 形态不认识 → 记未决而不是崩", async () => {
    const h = harness();
    const r = await checkUpdates([["tool", { ...PIN, url: "https://ftp.example.com/tool.exe" }]], h.log, h.note);
    expect(r.unresolved).toBe(1);
    expect(h.notes.join("\n")).toContain("不是 GitHub Release 直链");
  });
});

describe("--check-updates 参数", () => {
  it("解析 --check-updates / --json", () => {
    expect(parseArgs(["--check-updates", "--json"])).toMatchObject({ checkUpdates: true, json: true });
    expect(parseArgs([])).toMatchObject({ checkUpdates: false, json: false });
  });

  it("解析 --soft（默认关）", () => {
    expect(parseArgs(["--soft"])).toMatchObject({ soft: true });
    expect(parseArgs([])).toMatchObject({ soft: false });
  });
});

/**
 * dev 前置 vs CI 严格的那条分界，只有退出码可观测，所以只能真起进程验。
 * 写反的后果不对称：dev 变严 = 没网就改不了 UI；CI 变软 = 缺 ffmpeg 的包照样出门。
 * url 指向 127.0.0.1:1（端口必拒）：离线、秒回、不需要假件。
 */
describe("--soft 退出码边界", () => {
  const SCRIPT = fileURLToPath(new URL("../scripts/fetch-binaries.cjs", import.meta.url));

  function offlineTree() {
    const dir = mkdtempSync(join(tmpdir(), "mediaget-bin-soft-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "resources"), { recursive: true });
    copyFileSync(SCRIPT, join(dir, "scripts", "fetch-binaries.cjs"));
    const pin = {
      version: "0.0.0",
      file: "yt-dlp.exe",
      url: "http://127.0.0.1:1/yt-dlp.exe",
      sha256: "a".repeat(64),
      size: 1,
    };
    writeFileSync(join(dir, "resources", "binaries.json"), JSON.stringify({ binaries: { "yt-dlp": pin } }), "utf8");
    return dir;
  }

  it("--soft：下载失败照样 0，并如实播报未就绪", () => {
    const dir = offlineTree();
    try {
      const r = spawnSync(process.execPath, [join(dir, "scripts", "fetch-binaries.cjs"), "--soft"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("软失败");
      // 未就绪走 note()（stderr）：与 --check-updates 的告警同一条通道
      expect(r.stderr).toContain("随包二进制未就绪");
      const manifest = JSON.parse(readFileSync(join(dir, "resources", "bin", "manifest.json"), "utf8"));
      expect(manifest).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不带 --soft（CI 路径）：同一失败必须非零退出", () => {
    const dir = offlineTree();
    try {
      const r = spawnSync(process.execPath, [join(dir, "scripts", "fetch-binaries.cjs")], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("失败");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

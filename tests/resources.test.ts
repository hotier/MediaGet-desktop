/**
 * 资源定位与完整性校验测试（P0-2 manifest 链路）。
 *
 * 覆盖三档行为，全程不下载任何东西（用 tmpdir 造假二进制）：
 *  - 有 manifest + 哈希匹配 → 正常定位，verified=true；
 *  - 有 manifest + 哈希不符 → 拒绝使用（locate 返回 null），并打印拒绝日志；
 *  - 无 manifest → 降级放行，verified=false，并打印降级日志（不假装校验过）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createResources, readManifest, sha256File } from "../electron/main/resources";

/** 真实现（测试接缝里复算哈希用） */
const createHashReal = createHash;

let root: string;
let userDataDir: string;
let packagedDir: string;

/** 造一个假二进制（内容任意，哈希由 sha256File 现算，不硬编码） */
function fakeBin(dir: string, name: "yt-dlp" | "ffmpeg", content = "FAKE-BINARY"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, process.platform === "win32" ? `${name}.exe` : name);
  writeFileSync(file, content);
  return file;
}

/**
 * 写 manifest。值故意放宽到 unknown：有一条用例专门投喂「非字符串 / 截断 hex /
 * 未知键」来验证 readManifest 的丢弃逻辑，签名收窄成 Record<string,string>
 * 会让那条用例无法表达它要测的输入（编译期就挡住，测不到运行期防线）。
 */
function writeManifest(dir: string, hashes: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(hashes, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mg-res-"));
  userDataDir = join(root, "userData");
  packagedDir = join(root, "packaged");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("readManifest（清单解析，只信任 64 位 hex）", () => {
  it("null 目录 / 文件不存在 → null", () => {
    expect(readManifest(null)).toBeNull();
    expect(readManifest(packagedDir)).toBeNull();
  });

  it("合法清单原样读出（含大写归一为小写）", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    writeManifest(packagedDir, { "yt-dlp": a, ffmpeg: b });
    expect(readManifest(packagedDir)).toEqual({ "yt-dlp": a, ffmpeg: b.toLowerCase() });
  });

  it("只信任 64 位 hex：截断 / 非字符串 / 注入键一律丢弃", () => {
    writeManifest(packagedDir, {
      "yt-dlp": "deadbeef",
      ffmpeg: 12345,
      evil: "c".repeat(64),
    });
    expect(readManifest(packagedDir)).toBeNull();
  });

  it("坏 JSON → null 且不抛（打印降级日志）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(packagedDir, { recursive: true });
    writeFileSync(join(packagedDir, "manifest.json"), "{ not json");
    expect(readManifest(packagedDir)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("createResources().locate（用户自备 > 已释放 > 随包）", () => {
  it("用户自备路径存在即优先，且不校验哈希", () => {
    const custom = fakeBin(join(root, "custom"), "yt-dlp");
    const r = createResources({
      userDataDir,
      packagedDir: null,
      readKernelConfig: (k) => (k === "YTDLP_BIN" ? custom : undefined),
    });
    const hit = r.locate("yt-dlp");
    expect(hit).toEqual({ name: "yt-dlp", path: custom, origin: "user" });
  });

  it("随包 + 哈希匹配 → 释放到 userData/bin（origin=extracted），verified=true", () => {
    const src = fakeBin(packagedDir, "yt-dlp", "GOOD");
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
      expectedHashes: { "yt-dlp": sha256File(src) },
    });
    expect(r.verified).toBe(true);
    const hit = r.locate("yt-dlp");
    expect(hit?.origin).toBe("extracted");
    expect(hit?.path).toBe(join(userDataDir, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"));
    expect(sha256File(hit!.path)).toBe(sha256File(src));
  });

  it("随包 + 哈希不符 → 拒绝使用（返回 null）并留痕", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeBin(packagedDir, "ffmpeg", "TAMPERED");
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
      expectedHashes: { ffmpeg: "0".repeat(64) },
    });
    expect(r.locate("ffmpeg")).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("不匹配，拒绝使用"))).toBe(true);
  });

  it("无 manifest → 降级放行 + 明确日志，verified=false（不假装有防护）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeBin(packagedDir, "ffmpeg", "ANY");
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
    });
    expect(r.verified).toBe(false);
    expect(r.locate("ffmpeg")?.origin).toBe("extracted");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("无 SHA-256 基线"))).toBe(true);
  });

  it("三处都没有 → null", () => {
    const r = createResources({
      userDataDir,
      packagedDir: null,
      readKernelConfig: () => undefined,
    });
    expect(r.locate("yt-dlp")).toBeNull();
  });
});

describe("createResources().describe（降级可见性：不让「无基线」静默发生）", () => {
  it("有基线 + 匹配 → verified，且带 origin/path/expected", () => {
    const src = fakeBin(packagedDir, "yt-dlp", "GOOD");
    const hash = sha256File(src);
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
      expectedHashes: { "yt-dlp": hash },
    });
    const st = r.describe().find((s) => s.name === "yt-dlp")!;
    expect(st).toMatchObject({ available: true, integrity: "verified", expected: hash });
    expect(st.origin).toBe("extracted");
  });

  it("无基线 → degraded（而非 verified），如实汇报校验强度", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeBin(packagedDir, "yt-dlp", "GOOD");
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
    });
    const st = r.describe().find((s) => s.name === "yt-dlp")!;
    expect(st.integrity).toBe("degraded");
    expect(st.available).toBe(true);
  });

  it("有基线但哈希不符 → rejected（与 missing 区分：文件在，只是不可信）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeBin(packagedDir, "ffmpeg", "TAMPERED");
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
      expectedHashes: { ffmpeg: "0".repeat(64) },
    });
    const st = r.describe().find((s) => s.name === "ffmpeg")!;
    expect(st).toMatchObject({ available: false, integrity: "rejected" });
  });

  it("三处都没有 → missing", () => {
    const r = createResources({
      userDataDir,
      packagedDir: null,
      readKernelConfig: () => undefined,
    });
    expect(r.describe().every((s) => s.integrity === "missing" && !s.available)).toBe(true);
  });

  it("两个二进制各自独立汇报（部分随包是合法形态）", () => {
    const src = fakeBin(packagedDir, "yt-dlp", "ONLY-YTDLP");
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
      expectedHashes: { "yt-dlp": sha256File(src) },
    });
    const byName = Object.fromEntries(r.describe().map((s) => [s.name, s.integrity]));
    expect(byName["yt-dlp"]).toBe("verified");
    expect(byName.ffmpeg).toBe("missing");
  });
});

describe("createResources().locate 健壮性（防「目录当二进制」与热路径重复哈希）", () => {
  it("同名路径是目录 → 不算命中（existsSync 对目录同样为 true）", () => {
    mkdirSync(join(packagedDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"), {
      recursive: true,
    });
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
    });
    expect(r.locate("yt-dlp")).toBeNull();
  });

  it("用户自备路径指向目录 → 忽略，继续找随包", () => {
    const userDir = join(root, "user-provided-dir");
    mkdirSync(userDir, { recursive: true });
    fakeBin(packagedDir, "yt-dlp", "PKG");
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: (k) => (k === "YTDLP_BIN" ? userDir : undefined),
    });
    expect(r.locate("yt-dlp")?.origin).toBe("extracted");
  });

  it("同一文件重复 locate 不重复哈希（ffmpeg 79MB 同步哈希不能每调用一次做一遍）", () => {
    const src = fakeBin(packagedDir, "ffmpeg", "BIG");
    let hashes = 0;
    const r = createResources({
      userDataDir,
      packagedDir,
      readKernelConfig: () => undefined,
      expectedHashes: { ffmpeg: sha256File(src) },
      hashFile: (p) => {
        hashes++;
        return createHashReal("sha256").update(readFileSync(p)).digest("hex");
      },
    });

    expect(r.locate("ffmpeg")).not.toBeNull();
    const afterFirst = hashes; // 首次：校验随包源文件（1 次），释放到 userData
    expect(afterFirst).toBeGreaterThan(0);

    // 后续每次走的是已释放副本（不同路径），首次校验后即命中缓存
    for (let i = 0; i < 5; i++) expect(r.locate("ffmpeg")).not.toBeNull();
    const afterSix = hashes;

    // 再多调 5 次，哈希次数必须不再增长 —— 这才是「热路径不重算」的判据
    for (let i = 0; i < 5; i++) expect(r.locate("ffmpeg")).not.toBeNull();
    expect(hashes).toBe(afterSix);

    // 且总量是「每路径一次」量级，而不是「每调用一次」
    expect(afterSix).toBeLessThanOrEqual(2);
  });
});

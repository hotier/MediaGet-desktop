#!/usr/bin/env node
/**
 * 下载并强校验随包二进制（yt-dlp / ffmpeg）——CI 与本地开发共用。
 *
 * 为什么要有这个脚本（而不是 CI 里两行 curl）：
 *  1. 固定 tag：`releases/latest/download/...` 会随上游发布漂移，昨天过的构建今天换内容；
 *     本脚本只认 resources/binaries.json 里写死的 tag。
 *  2. 强校验：`curl -sL -o` 不带 --fail 时，404 的 HTML 错误页会被原样写成 .exe
 *     （静默投毒，构建成功但产物是垃圾）。这里下载后比对 SHA-256 与 size，不符即失败退出。
 *  3. 单一真源：下载/校验/写 manifest 一套逻辑，CI 与本地跑的是同一份代码。
 *  4. `--verify-only`：打包前的守门人。manifest 是运行时完整性校验的**唯一基线**，
 *     它缺失时应用会静默降级为「只定位不校验」。把这一步放在 CI 的打包前，
 *     让「清单缺失」在构建期就红，而不是拖到用户机器上无声降级。
 *
 * 用法：
 *   node scripts/fetch-binaries.cjs              # 缺哪个下哪个，已存在且校验通过则跳过
 *   node scripts/fetch-binaries.cjs --force      # 强制重下
 *   node scripts/fetch-binaries.cjs --out DIR    # 指定输出目录（默认 resources/bin）
 *   node scripts/fetch-binaries.cjs --verify-only # 只校验 + 断言 manifest 在位，不下载
 *   node scripts/fetch-binaries.cjs --require-all # 要求 binaries.json 的每一项都在位（发布构建用）
 */
"use strict";

const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const PINS_FILE = join(ROOT, "resources", "binaries.json");

/** 下载超时：GitHub Release 资产偶发挂起，不设上限会让 CI 卡到 job timeout */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  const out = {
    force: false,
    verifyOnly: false,
    requireAll: false,
    outDir: join(ROOT, "resources", "bin"),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--verify-only") out.verifyOnly = true;
    else if (argv[i] === "--require-all") out.requireAll = true;
    else if (argv[i] === "--out") out.outDir = argv[++i];
  }
  return out;
}

function loadPins() {
  const raw = JSON.parse(readFileSync(PINS_FILE, "utf8"));
  const entries = Object.entries(raw.binaries || {});
  if (entries.length === 0) throw new Error(`${PINS_FILE} 里没有 binaries 条目`);
  for (const [name, pin] of entries) {
    if (!pin.url || !pin.file || !pin.sha256 || !pin.version) {
      throw new Error(`binaries.json 的 ${name} 缺字段（url/file/sha256/version 必填）`);
    }
    if (!/^[0-9a-f]{64}$/.test(pin.sha256)) {
      throw new Error(`binaries.json 的 ${name}.sha256 不是 64 位小写十六进制`);
    }
    // latest/download 是漂移源，明确禁掉（见文件头第 1 条）
    if (/\/releases\/latest\/download\//.test(pin.url)) {
      throw new Error(
        `binaries.json 的 ${name}.url 用了 releases/latest/download（会漂移）：${pin.url}\n` +
          `  请改成固定 tag 的直链，并同步更新 sha256/size。`
      );
    }
  }
  return entries;
}

/** 校验一个已存在的文件是否与 pin 一致 */
function verifyExisting(pin, dest) {
  const size = statSync(dest).size;
  if (pin.size && size !== pin.size) {
    return { ok: false, reason: `字节数不符：期望 ${pin.size}，实际 ${size}` };
  }
  const hash = sha256File(dest);
  if (hash !== pin.sha256) {
    return { ok: false, reason: `SHA-256 不符：期望 ${pin.sha256}，实际 ${hash}` };
  }
  return { ok: true, size, sha256: hash };
}

/** 下载到 <file>.part，校验通过才 rename —— 中断/投毒不会留下半个"可用"文件 */
async function download(pin, dest, log) {
  const part = `${dest}.part`;
  if (existsSync(part)) unlinkSync(part);

  const resp = await fetch(pin.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`下载 ${pin.file} 失败：HTTP ${resp.status} ${resp.statusText}（${pin.url}）`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  // 404 错误页的兜底：即便上游返回 200 却给了 HTML，体积也会与 pin 严重不符，
  // 但这里先做一道便宜的魔数检查，让「HTML 被写成 .exe」这类投毒当场可见。
  if (buf.length >= 2 && buf[0] === 0x3c && buf[1] === 0x21) {
    // "<!" —— HTML 文档开头（"<!DOCTYPE"）
    throw new Error(
      `${pin.file} 下载到的内容是 HTML（前两字节 0x3c 0x21），不是可执行文件：${pin.url}`
    );
  }
  writeFileSync(part, buf);
  log(`  已下载 ${pin.file}：${buf.length} 字节`);

  const actualSize = statSync(part).size;
  if (pin.size && actualSize !== pin.size) {
    unlinkSync(part);
    throw new Error(
      `${pin.file} 字节数不符：期望 ${pin.size}，实际 ${actualSize}（上游资产可能已变更）`
    );
  }

  const actualHash = sha256File(part);
  if (actualHash !== pin.sha256) {
    unlinkSync(part);
    throw new Error(
      `${pin.file} SHA-256 不符：\n  期望 ${pin.sha256}\n  实际 ${actualHash}\n` +
        `  上游 ${pin.version} 的资产已变或下载被篡改。确认无误后更新 resources/binaries.json。`
    );
  }

  renameSync(part, dest);
  return { size: actualSize, sha256: actualHash };
}

function writeManifest(outDir, manifest, log) {
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`[fetch-binaries] manifest → ${manifestPath}`);
  for (const [k, v] of Object.entries(manifest)) log(`  ${k} = ${v}`);
  return manifestPath;
}

/**
 * 只校验模式（CI 打包前的守门人）：
 * 断言每个 pin 对应的文件在位、size/sha256 匹配，并断言 manifest.json 存在且与 pins 自洽。
 * 任一条不满足即非零退出。
 */
function verifyOnly(pins, outDir, requireAll, log) {
  const manifestPath = join(outDir, "manifest.json");
  const problems = [];
  const present = {};

  for (const [name, pin] of pins) {
    const dest = join(outDir, pin.file);
    log(`[fetch-binaries] 校验 ${name} @ ${pin.version}`);
    if (!existsSync(dest)) {
      const msg = `${pin.file} 不存在（${dest}）`;
      if (requireAll) problems.push(msg);
      else log(`  跳过：${msg}`);
      continue;
    }
    const r = verifyExisting(pin, dest);
    if (!r.ok) {
      problems.push(`${pin.file} 校验失败：${r.reason}`);
      continue;
    }
    present[name] = r.sha256;
    log(`  通过 ${r.sha256.slice(0, 16)}…`);
  }

  if (!existsSync(manifestPath)) {
    problems.push(
      `manifest.json 缺失（${manifestPath}）—— 运行时将静默降级为「只定位不校验」`
    );
  } else {
    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      problems.push(`manifest.json 不是合法 JSON：${e.message}`);
      raw = null;
    }
    if (raw) {
      for (const [name, hash] of Object.entries(present)) {
        if (raw[name] !== hash) {
          problems.push(
            `manifest.json 的 ${name} 与当前二进制不一致（manifest=${raw[name]} 实际=${hash}）`
          );
        }
      }
      for (const name of Object.keys(raw)) {
        if (!(name in present) && requireAll) {
          problems.push(`manifest.json 声明了 ${name}，但对应二进制不在位`);
        }
      }
    }
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`[fetch-binaries] ✗ ${p}\n`);
    throw new Error(`二进制/清单校验未通过（${problems.length} 项）`);
  }
  log(`[fetch-binaries] 校验通过：${Object.keys(present).length} 个二进制 + manifest 自洽`);
}

async function main() {
  const { force, outDir, verifyOnly: only, requireAll } = parseArgs(process.argv.slice(2));
  const log = (m) => process.stdout.write(`${m}\n`);

  const pins = loadPins();
  mkdirSync(outDir, { recursive: true });
  log(`[fetch-binaries] 目标目录：${outDir}`);

  if (only) {
    verifyOnly(pins, outDir, requireAll, log);
    return;
  }

  const manifest = {};
  let downloaded = 0;

  for (const [name, pin] of pins) {
    const dest = join(outDir, pin.file);
    log(`[fetch-binaries] ${name} @ ${pin.version}`);

    if (!force && existsSync(dest)) {
      const r = verifyExisting(pin, dest);
      if (r.ok) {
        log(`  已存在且校验通过，跳过`);
        manifest[name] = r.sha256;
        continue;
      }
      log(`  已存在但校验不过（${r.reason}），重新下载`);
    }

    const { sha256 } = await download(pin, dest, log);
    manifest[name] = sha256;
    downloaded++;
    log(`  校验通过 ${sha256.slice(0, 16)}…`);
  }

  // manifest 与二进制同目录：extraResources 会把整个 resources/bin 拷进包内，
  // 首启 resources.ts 读它做校验（与 binaries.json 同源，不手抄哈希）。
  writeManifest(outDir, manifest, log);
  log(`[fetch-binaries] 完成：新下载 ${downloaded} 个`);
}

main().catch((e) => {
  process.stderr.write(`[fetch-binaries] 失败：${e.message}\n`);
  process.exit(1);
});

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
 *  5. `--check-updates`：只读观察上游新版本，**不写任何文件**。固定 pin 是安全要求，
 *     但也意味着「yt-dlp 落后两个月」没人提醒 —— 而 yt-dlp 的版本就是下载链路的寿命。
 *     这一步把唯一麻烦的人工环节（下载新资产再算 SHA-256）也代做了，产出可直接粘贴的
 *     JSON 片段；写回 binaries.json 仍由人完成，校验性质不变。
 *  6. `--soft`：开发生命周期用（`pnpm dev` 前置）。缺件是「功能未就绪」而不是「仓库坏了」：
 *     下载失败只播报、不非零退出，让没网/限流的人照样能改 UI。
 *     容错放在脚本里而不是 shell 的 `|| true`，是因为 Windows 下 cmd.exe 的 GBK 控制台
 *     会把兜底文案弄成乱码，而 manifest 的部分清单本就是受支持的状态（resources.ts）。
 *     CI 不传 `--soft`，严格非零语义不变。
 *
 * 用法：
 *   node scripts/fetch-binaries.cjs              # 缺哪个下哪个，已存在且校验通过则跳过
 *   node scripts/fetch-binaries.cjs --force      # 强制重下
 *   node scripts/fetch-binaries.cjs --out DIR    # 指定输出目录（默认 resources/bin）
 *   node scripts/fetch-binaries.cjs --verify-only # 只校验 + 断言 manifest 在位，不下载
 *   node scripts/fetch-binaries.cjs --require-all # 要求 binaries.json 的每一项都在位（发布构建用）
 *   node scripts/fetch-binaries.cjs --check-updates [--json]
 *       # 比对上游 latest release；--json 时建议片段走 stdout、过程日志走 stderr
 *       # 注意走 GitHub API，本机上 Node fetch 不读系统代理，需要
 *       # HTTP(S)_PROXY + NODE_USE_ENV_PROXY=1（CI 内直连可用）
 *   node scripts/fetch-binaries.cjs --soft
 *       # 同上「缺哪个下哪个」，但下载失败不非零退出（dev 前置用）
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
    checkUpdates: false,
    json: false,
    soft: false,
    outDir: join(ROOT, "resources", "bin"),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--verify-only") out.verifyOnly = true;
    else if (argv[i] === "--require-all") out.requireAll = true;
    else if (argv[i] === "--check-updates") out.checkUpdates = true;
    else if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--soft") out.soft = true;
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

/** 从固定 pin 的直链反解 owner/repo/tag/asset：观察上游只靠这条 URL，不引入第二份配置 */
function parseReleaseUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(url);
  if (!m) return null;
  return { owner: m[1], repo: m[2], tag: m[3], asset: m[4] };
}

/** releases/latest 只返回正式版：上游 rc/prerelease 不算「该升级」（yt-dlp 的 rc 常带破坏性改动） */
async function fetchLatestRelease(owner, repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
    redirect: "follow",
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub API 无 UA 直接 403
      "User-Agent": "mediaget-desktop-fetch-binaries",
      // 匿名额度 60 次/小时按出口 IP 计（本机共享代理实测已被打满）；CI 里带上
      // 自带的 GITHUB_TOKEN 升到 5000/小时，观察任务才不会空转。
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(60 * 1000),
  });
  if (resp.status === 403 || resp.status === 429) {
    const err = new Error(`GitHub API 限流（HTTP ${resp.status}）`);
    err.soft = true; // 限流是可恢复的常态，不该把观察任务判红——但也不能报「一切正常」
    throw err;
  }
  if (!resp.ok) throw new Error(`GitHub API 失败：HTTP ${resp.status} ${resp.statusText}`);
  return resp.json();
}

/** 取新资产字节流（不写盘）：只用来算 SHA-256/size */
async function fetchAssetBytes(url) {
  const resp = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}（${url}）`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * 只读观察：比对 pin 与上游最新正式版，有新版则下载新资产算 SHA-256/size。
 * 绝不写 binaries.json —— 写回由人完成，固定校验的性质才保持不变。
 * `deps` 是给测试留的注入口（网络件不该逼测试真出网）。
 */
async function checkUpdates(pins, log, note, deps = {}) {
  const getLatest = deps.fetchLatest || fetchLatestRelease;
  const getBytes = deps.fetchAsset || fetchAssetBytes;
  const patch = {};
  let behind = 0;
  let unresolved = 0; // 限流/URL 形态导致「这一项本轮没查成」

  for (const [name, pin] of pins) {
    const from = parseReleaseUrl(pin.url);
    if (!from) {
      note(`${name}：pin.url 不是 GitHub Release 直链，无法观察，跳过`);
      unresolved++;
      continue;
    }

    let release;
    try {
      release = await getLatest(from.owner, from.repo);
    } catch (e) {
      if (e.soft) {
        note(`${name}：${e.message}，本轮未能确认`);
        unresolved++;
        continue;
      }
      throw new Error(`${name}：查上游失败 —— ${e.message}`);
    }

    if (release.tag_name === from.tag) {
      log(`${name}：已是上游最新正式版 ${pin.version}`);
      continue;
    }

    behind++;
    const asset = (release.assets || []).find((a) => a.name === from.asset);
    if (!asset) {
      note(`${name}：上游 ${release.tag_name} 里没有资产「${from.asset}」，可能改名或换发布方，需人工核对`);
      unresolved++;
      continue;
    }

    log(`${name}：pin ${pin.version} → 上游最新 ${release.tag_name}，下载新资产以计算 SHA-256…`);
    let buf;
    try {
      buf = await getBytes(asset.browser_download_url);
    } catch (e) {
      throw new Error(`${name}：新资产取回失败 —— ${e.message}`);
    }
    if (buf.length >= 2 && buf[0] === 0x3c && buf[1] === 0x21) {
      throw new Error(`${name}：新资产内容是 HTML（0x3c 0x21），不是可执行文件`);
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    patch[name] = {
      version: release.tag_name,
      url: asset.browser_download_url,
      file: pin.file,
      sha256,
      size: buf.length,
    };
    log(`  ${release.tag_name}：${buf.length} 字节，sha256=${sha256}`);
  }

  return { patch, behind, unresolved };
}

async function main() {
  const {
    force,
    outDir,
    verifyOnly: only,
    requireAll,
    checkUpdates: watch,
    json,
    soft,
  } = parseArgs(process.argv.slice(2));
  // --json 模式：机器读的结果走 stdout，人读的日志一律改走 stderr，便于 `> patch.json` 直取
  const log = (m) => process[json ? "stderr" : "stdout"].write(`${m}\n`);
  const note = (m) => process.stderr.write(`[fetch-binaries] ! ${m}\n`);

  const pins = loadPins();

  if (watch) {
    const { patch, behind, unresolved } = await checkUpdates(pins, log, note);
    if (json) process.stdout.write(`${JSON.stringify(patch, null, 2)}\n`);
    if (unresolved > 0) {
      // 没查成 ≠ 没问题：给观察任务一个能区分的退出码，别让「限流空转」显示成绿
      log(`[fetch-binaries] 本轮有 ${unresolved} 项未能确认（落后 ${behind} 项），结论不完整`);
      process.exitCode = 3;
    } else if (behind === 0) {
      log("[fetch-binaries] 全部二进制均为上游最新正式版");
    } else {
      log(`[fetch-binaries] ${behind} 项有新版本，见上方 SHA-256 与建议片段`);
    }
    return;
  }
  mkdirSync(outDir, { recursive: true });
  log(`[fetch-binaries] 目标目录：${outDir}`);

  if (only) {
    verifyOnly(pins, outDir, requireAll, log);
    return;
  }

  const manifest = {};
  let downloaded = 0;
  const missing = [];

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

    try {
      const { sha256 } = await download(pin, dest, log);
      manifest[name] = sha256;
      downloaded++;
      log(`  校验通过 ${sha256.slice(0, 16)}…`);
    } catch (e) {
      if (!soft) throw e;
      // 不写这个键：部分清单是 resources.ts 支持的状态，缺的那个平台运行时如实降级
      missing.push(name);
      log(`  软失败（继续）：${e.message}`);
    }
  }

  // manifest 与二进制同目录：extraResources 会把整个 resources/bin 拷进包内，
  // 首启 resources.ts 读它做校验（与 binaries.json 同源，不手抄哈希）。
  writeManifest(outDir, manifest, log);
  log(`[fetch-binaries] 完成：新下载 ${downloaded} 个`);

  if (missing.length > 0) {
    note(
      `随包二进制未就绪：${missing.join("、")}。相关链路会如实降级（不静默失败），联网后跑 \`pnpm fetch:binaries\` 补齐（下次 \`pnpm dev\` 也会自动补）。`
    );
  }
}

// 直接跑才执行；被 require（测试）时只导出纯件，避免测试进程真的去下载 79MB 资产
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[fetch-binaries] 失败：${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parseReleaseUrl, checkUpdates, sha256File };

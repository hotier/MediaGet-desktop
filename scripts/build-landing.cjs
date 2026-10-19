#!/usr/bin/env node
/**
 * 产出 landing/version.json（落地页的版本信息数据源）。
 *
 * landing 站是 Astro 工程：src/pages/index.astro 在构建时直接 import 这份
 * JSON 渲染版本号、日期与下载链接，所以本脚本不再注入 HTML 占位符——
 * 数据（version.json）与展示（index.astro）分离，漏更数据会体现在
 * source 字段上而不是静默过期。
 *
 * 为什么由脚本产出而不是手改：
 *  1. 版本号只有一个真源（package.json / GitHub Release），手改就会出现「页面写 0.9.0、
 *     装的是 1.0.0」这种最难发现的错。
 *  2. 体积与发布日期是发布动作的产物，人工维护必然落后；默认只读本地（离线可跑，只有版本号），
 *     `--online` 时向 GitHub 要真实资产与发布日期，失败则回退本地值并播报——宁可页面上
 *     少一行「发布于」，也不要一行编出来的日期。
 *  3. 仓库内的 version.json 是最近一次 `--online` 的快照：没执行本脚本时 astro build 也能
 *     拿到合法数据（不会白屏），代价是它落后于最新 Release，所以发布后要重跑一次。
 *
 * 用法：
 *  node scripts/build-landing.cjs            # 离线：版本取 package.json，日期留空，资产留空
 *  node scripts/build-landing.cjs --online   # 追加拉取 GitHub latest release 的资产与日期
 *  node scripts/build-landing.cjs --strict   # 与 --online 搭配：拉取失败时非零退出（CI 由 CI=true 自动获得）
 *
 * 同时把 renderer/public/logos 的 SVG 镜像到 landing/public/logos：品牌图标只有一个真源
 * （注册表 + 应用资源目录），落地页拿到的那份是生成物，已进 .gitignore。
 *
 * landing 的 `pnpm --filter mediaget-landing build` 已把本脚本串在 astro build 之前。
 *
 * 注意：Node 的全局 fetch 不读 Windows 系统代理，本机 --online 需要
 * HTTP_PROXY/HTTPS_PROXY + NODE_USE_ENV_PROXY=1；CI 内直连即可。
 */
/* global AbortController, setTimeout, clearTimeout */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const VERSION_FILE = path.join(ROOT, "landing", "version.json");
const LOGO_SRC = path.join(ROOT, "renderer", "public", "logos");
const LOGO_DEST = path.join(ROOT, "landing", "public", "logos");
const REPO_SLUG = "hotier/mediaGet-desktop";

const online = process.argv.includes("--online");
// CI 里拉不到 Release 就是红：GitHub Actions 自带 CI=true，同一条命令在本机回退并播报、
// 在 CI 终止构建——落地页发一个「版本号对、下载按钮指向网页」的页面比不发布更坏。
const strict = process.argv.includes("--strict") || process.env.CI === "true";

function log(message) {
  console.log(`[landing] ${message}`);
}

function fail(message) {
  console.error(`[landing] ${message}`);
  process.exit(1);
}

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return String(pkg.version || "").replace(/^v/, "");
}

/**
 * 品牌图标镜像：整目录复制，不做筛选。
 * tests/platform-registry.test.ts 已经保证 renderer 那侧「登记的都有、有的都登记」，
 * 所以源目录干净；这里再挑一次只是把同一个判断写第二遍。
 */
function syncLogos() {
  if (!fs.existsSync(LOGO_SRC)) fail(`图标源目录不存在：${path.relative(ROOT, LOGO_SRC)}`);
  const files = fs.readdirSync(LOGO_SRC).filter((name) => name.endsWith(".svg"));
  if (files.length === 0) fail("renderer/public/logos 里一个 SVG 都没有");
  fs.rmSync(LOGO_DEST, { recursive: true, force: true });
  fs.mkdirSync(LOGO_DEST, { recursive: true });
  files.forEach((name) => fs.copyFileSync(path.join(LOGO_SRC, name), path.join(LOGO_DEST, name)));
  log(`已镜像 ${files.length} 枚品牌图标 → landing/public/logos`);
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function assetKind(name) {
  /* 只认安装包：blockmap 与 latest.yml 的名字同样带 -Setup-，
     不按扩展名收口的话，0.2MB 的差量校验文件会抢在真正的 exe 之前命中（GitHub 不保证 assets 顺序）。 */
  if (!/\.exe$/i.test(String(name || ""))) return null;
  if (/-Setup-/.test(name)) return "setup";
  if (/-Portable-/.test(name)) return "portable";
  return null;
}

async function fetchLatestRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mediaget-landing-build",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO_SLUG}/releases/latest`,
      { headers, signal: controller.signal }
    );
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function fromRelease(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const picked = {};
  assets.forEach((asset) => {
    const kind = assetKind(asset.name);
    if (!kind || picked[kind]) return;
    picked[kind] = { name: asset.name, size: formatSize(asset.size), url: asset.browser_download_url };
  });

  return {
    version: String(release.tag_name || "").replace(/^v/, "") || null,
    date: String(release.published_at || "").slice(0, 10) || null,
    assets: picked,
    source: "github",
  };
}

/* 离线兜底：发布日期只有 Release 那一个来源，本地拿不到就留空，让页面省略「发布于」。
   原先这里填 HEAD 的提交日，界面却写成「发布于 …」——最后一次 commit 的日子不是发布日。 */
function fromLocal() {
  return {
    version: readPackageVersion(),
    date: null,
    assets: {},
    source: "local",
  };
}

async function main() {
  syncLogos();

  let info = fromLocal();
  if (online) {
    try {
      const release = await fetchLatestRelease();
      const remote = fromRelease(release);
      info = {
        version: remote.version || info.version,
        date: remote.date || info.date,
        assets: remote.assets,
        source: "github",
      };
      log(`已获取 GitHub latest release：v${info.version}（${info.date}）`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (strict) fail(`--online 拉取失败（--strict）：${message}`);
      log(`--online 拉取失败，回退本地值：${message}`);
    }
  }

  if (!info.version) fail("取不到版本号（package.json 也没有 version？）");

  const setup = info.assets.setup || {};
  const portable = info.assets.portable || {};

  fs.writeFileSync(
    VERSION_FILE,
    `${JSON.stringify(
      {
        version: info.version,
        date: info.date,
        source: info.source,
        repo: REPO_SLUG,
        assets: [setup, portable].filter((asset) => asset && asset.name),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  log(`已写入 ${path.relative(ROOT, VERSION_FILE)}（source=${info.source}）`);
}

main().catch(fail);

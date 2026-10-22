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
 * 同时把 renderer/public 的两份资产镜像过来（落地页拿到的是生成物，已进 .gitignore）：
 *   logos/ → landing/public/logos  平台图标，真源 = 注册表 + 应用资源目录
 *   brand/ → landing/public/brand  应用字标与页签图标，真源 = brand/ 母版 + scripts/make-icons.cjs
 *
 * 还把仓库根的 CHANGELOG.md 解析成 landing/changelog.json（同样是生成物、已进 .gitignore），
 * 供 changelog 页在构建时 import：更新日志只有一个真源，抄第二份必然过期。
 * 解析是按本仓 pnpm release 的产出格式写的窄规则（## [版本](compare) (日期) / ### 小节 / * 列表项），
 * 格式变了会在这里报「解析出 0 个版本」，不会静默发一个空页。
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
const CHANGELOG_SRC = path.join(ROOT, "CHANGELOG.md");
const CHANGELOG_FILE = path.join(ROOT, "landing", "changelog.json");
const LOGO_SRC = path.join(ROOT, "renderer", "public", "logos");
const LOGO_DEST = path.join(ROOT, "landing", "public", "logos");
const BRAND_SRC = path.join(ROOT, "renderer", "public", "brand");
const BRAND_DEST = path.join(ROOT, "landing", "public", "brand");
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
 * 品牌资产镜像：整目录复制，不做筛选。
 * tests/platform-registry.test.ts 已经保证 renderer 那侧「登记的都有、有的都登记」，
 * 所以源目录干净；这里再挑一次只是把同一个判断写第二遍。
 * 字标与 favicon 同理：`renderer/public/brand` 是唯一真源（更上游是 brand/ 母版 + make-icons.cjs），
 * 落地页拿到的那份是生成物，已进 .gitignore。
 */
function syncDir(src, dest) {
  if (!fs.existsSync(src)) fail(`资产源目录不存在：${path.relative(ROOT, src)}`);
  const files = fs.readdirSync(src);
  if (files.length === 0) fail(`${path.relative(ROOT, src)} 是空的（先跑 node scripts/make-icons.cjs）`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  files.forEach((name) => fs.copyFileSync(path.join(src, name), path.join(dest, name)));
  log(`已镜像 ${files.length} 个资产 → ${path.relative(ROOT, dest)}`);
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

/**
 * 小节标题 → 常规提交类型与 emoji（2026-10-22 业主定调：更新日志条目规范为
 * `✨ feat(scope): 摘要` 这种形式）。
 *
 * 真源是 .release-it.json 里 conventional-changelog 插件的 types 表：
 * 每个进 CHANGELOG 的 type 在那里声明了中文小节名（feat→新增、fix→修复、
 * perf→性能、revert→回退），这里是那张表的反向映射——改一边就要同步另一边。
 * emoji 取 gitmoji 口径：✨ 新功能 / 🐛 修复 / ⚡ 性能 / ⏪ 回退。
 * 认不出的标题（types 表加了新 type 却没同步这里）：type/emoji 留空并播报，
 * 页面退回旧渲染（只有 scope 加粗），不会静默丢信息。
 */
const SECTION_TYPES = {
  新增: { type: "feat", emoji: "✨" },
  修复: { type: "fix", emoji: "🐛" },
  性能: { type: "perf", emoji: "⚡" },
  回退: { type: "revert", emoji: "⏪" },
};

/**
 * 解析 CHANGELOG.md（conventional-changelog 的产出格式）为结构化数据。
 *
 * 只认三样东西，其余跳过并播报：
 *   - `## 版本 (日期)` 或 `## [版本](compare-url) (日期)` —— 首个版本没有 compare 链接，
 *     第二个版本起 conventional-changelog 会自动包上方括号形式，两种都要接住；
 *   - `### 小节标题`（新增 / 修复 / …）；
 *   - `* **scope:** 摘要 ([hash](commit-url))` —— scope 与尾部的 commit 链接都可缺省。
 * 每个小节按 SECTION_TYPES 反向映射出 type 与 emoji，随 sections 一起进
 * changelog.json——页面据此渲染「✨ feat(scope): 摘要」。
 * `# 更新日志` 大标题与开头那段给维护者的说明（「本文件由 pnpm release …」）不是用户文案，
 * 从首个 `## ` 起截断丢掉。文本不在这里转 HTML：changelog 页用 Astro 渲染，插值自动转义。
 */
function parseChangelog(md) {
  const fromFirstRelease = md.search(/^## /m);
  if (fromFirstRelease === -1) fail("CHANGELOG.md 里没有 `## ` 版本段——格式变了？");

  const releases = [];
  for (const block of md.slice(fromFirstRelease).split(/^## /m)) {
    const lines = block.replace(/\r/g, "").split("\n");
    const headLine = (lines.shift() || "").trim();
    if (!headLine) continue;

    let rest = headLine;
    let compareUrl = null;
    let version = "";
    const bracketed = rest.match(/^\[([^\]]+)\]\(([^)]+)\)\s*/);
    if (bracketed) {
      version = bracketed[1].trim();
      compareUrl = bracketed[2];
      rest = rest.slice(bracketed[0].length);
    } else {
      version = (rest.match(/^\S+/) || [""])[0];
      rest = rest.slice(version.length).trim();
    }
    if (!version) {
      log(`changelog：版本段标题读不出版本号，已跳过：${headLine.slice(0, 60)}`);
      continue;
    }
    const dated = rest.match(/^\(([^)]*)\)$/);
    if (!dated) log(`changelog：v${version} 缺日期（写 (YYYY-MM-DD) 才能显示「发布于」）`);

    const release = {
      version,
      date: dated ? dated[1].trim() : null,
      compareUrl,
      intro: [],
      sections: [],
    };
    let section = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("### ")) {
        const title = line.slice(4).trim();
        const meta = SECTION_TYPES[title];
        if (!meta) {
          log(`changelog：v${version} 的小节「${title}」不在 SECTION_TYPES 里（.release-it.json 加了新 type？），条目退回无 type 渲染`);
        }
        section = { title, type: meta ? meta.type : null, emoji: meta ? meta.emoji : null, items: [] };
        release.sections.push(section);
      } else if (line.startsWith("* ")) {
        if (!section) {
          log(`changelog：v${version} 有列表项落在小节之外，已跳过`);
          continue;
        }
        section.items.push(parseChangeItem(line.slice(2)));
      } else if (!section) {
        release.intro.push(line);
      } else {
        log(`changelog：v${version} 小节内的非列表行，已跳过：${line.slice(0, 40)}`);
      }
    }
    releases.push(release);
  }
  return releases;
}

/** 单条变更：`**scope:** 摘要 ([hash](commit-url))`，scope 与 commit 链接都可缺省 */
function parseChangeItem(text) {
  const item = { scope: null, text: text.trim(), hash: null, url: null };
  const scoped = item.text.match(/^\*\*(.+?):\*\*\s*/);
  if (scoped) {
    item.scope = scoped[1];
    item.text = item.text.slice(scoped[0].length).trim();
  }
  const linked = item.text.match(/\s*\(\[([0-9a-f]+)\]\(([^)\s]+)\)\)\s*$/);
  if (linked) {
    item.hash = linked[1];
    item.url = linked[2];
    item.text = item.text.slice(0, linked.index).trimEnd();
  }
  return item;
}

function syncChangelog() {
  if (!fs.existsSync(CHANGELOG_SRC)) fail("仓库根没有 CHANGELOG.md：changelog 页没有数据源");
  const releases = parseChangelog(fs.readFileSync(CHANGELOG_SRC, "utf8"));
  if (releases.length === 0) fail("CHANGELOG.md 解析出 0 个版本——产出格式变了，同步规则要跟着改");
  fs.writeFileSync(CHANGELOG_FILE, `${JSON.stringify({ source: "CHANGELOG.md", releases }, null, 2)}\n`, "utf8");
  log(`已解析 CHANGELOG.md → ${path.relative(ROOT, CHANGELOG_FILE)}（${releases.length} 个版本）`);
}

async function main() {
  syncDir(LOGO_SRC, LOGO_DEST);
  syncDir(BRAND_SRC, BRAND_DEST);
  syncChangelog();

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

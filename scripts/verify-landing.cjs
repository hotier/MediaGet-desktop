#!/usr/bin/env node
/**
 * 落地页产物自检（离线、不碰网络、不跑构建）。
 *
 * 为什么单独成一个脚本：CI 的 PR 检查与落地页部署两条链路都要这道门，抄两段 bash
 * 迟早只有一段跟着页面结构更新。这里钉的都是「构建成功但线上是坏的」那一类：
 *   1. 八页都在产物里 —— build.format="directory"（URL 不带 .html，业主 2026-10-22 定）：
 *      七页各在自己的目录（changelog/index.html …），404 是唯一保留 .html 的文件
 *      （GitHub Pages 按根下这个文件名接管未命中路径）。谁改回 file 平铺或漏掉 404，
 *      第一道检查就红；
 *   2. 每页资源引用已改成文档相对且按页算层级（根页 `./_astro/`、目录页 `../_astro/`）
 *      —— 残留 `/_astro/` 时双击打开与 Pages 子路径至少有一个打不开，而 astro build
 *      一声不响；
 *   3. 页面里每个 `src/href="./x"` / `../x` 都按「该页所在目录」解析后真的落在 dist 里
 *      —— 页脚改一个文件名、平台图标漏镜像，都是构建绿、点开 404；
 *   4. 首页平台卡数量与页内那句「支持 N 个平台」一致 —— 卡片由注册表生成，
 *      数字由同一处推出，谁把平台名/数量抄回页面，这里当天红；
 *   5. 更新日志页里有 CHANGELOG.md 最新那个版本号 —— 页面内容由构建脚本从
 *      仓库根 CHANGELOG.md 解析生成，这条钉住「解析 → JSON → 页面」整条同步链，
 *      链上任何一环静默失效都会在这里当天红。
 *   6. 入库的 landing/version.json 快照与同一提交里的 package.json 同版 ——
 *      跟随发版靠 release-it 的 after:bump 钩子（重跑本数据源并 git add 进发版
 *      commit）；绕过 pnpm release 手改版本号时，快照会永远漂移，这里当天红。
 *
 * 用法：pnpm landing:build && node scripts/verify-landing.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DIST = path.join(__dirname, "..", "landing", "dist");
// 产物是 build.format="directory"（URL 不带 .html，业主 2026-10-22 定）：
// 七页各在自己的目录（guide/download/changelog/terms/privacy/dmca，首页在根），
// 404 是唯一保留 .html 的文件（GitHub Pages 按根下这个文件名接管未命中路径）。
const PAGES = [
  { file: "index.html", dir: "" },
  { file: "guide/index.html", dir: "guide" },
  { file: "download/index.html", dir: "download" },
  { file: "changelog/index.html", dir: "changelog" },
  { file: "terms/index.html", dir: "terms" },
  { file: "privacy/index.html", dir: "privacy" },
  { file: "dmca/index.html", dir: "dmca" },
  { file: "404.html", dir: "" },
];

function fail(message) {
  console.error(`[verify-landing] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(DIST)) fail("landing/dist 不存在：先跑 pnpm landing:build");

for (const { file } of PAGES) {
  if (!fs.existsSync(path.join(DIST, file))) {
    fail(`缺少产物 ${file}：build.format="directory" 时五页各在自己目录、404 在产物根`);
  }
}

let refCount = 0;
for (const { file, dir } of PAGES) {
  const html = fs.readFileSync(path.join(DIST, file), "utf8");
  /* 本页所在目录 = 引用解析的基准；浏览器就是这么算的 */
  const base = path.join(DIST, dir);

  if (html.includes('"/_astro/')) {
    fail(`${file}: 仍有站点根绝对路径的资源引用，relative-output 改写没生效`);
  }
  const expectedPrefix = dir ? '"../_astro/' : '"./_astro/';
  if (!html.includes(expectedPrefix)) {
    fail(`${file}: 没有 ${expectedPrefix.replace('"', "")} 引用——按目录层级算前缀的改写失效了`);
  }

  /* 只查相对引用（./ 与 ../）；外链（https:）、协议相对（//）、纯锚点（#faq）不归这里管 */
  const refs = new Set(
    [...html.matchAll(/(?:src|href)="(\.{1,2}\/[^"#?]+)/g)].map((match) => match[1]),
  );
  for (const ref of refs) {
    if (!fs.existsSync(path.resolve(base, ref))) {
      fail(`${file}: 引用了 ${ref}，按本页目录解析后产物里没有这个文件`);
    }
    refCount += 1;
  }
}

const home = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const cards = (home.match(/class="platform"/g) || []).length;
if (cards === 0) fail('首页一张平台卡都没有（class="platform"）');
if (!home.includes(`支持 ${cards} 个平台`)) {
  fail(`首页有 ${cards} 张平台卡，页内却没有「支持 ${cards} 个平台」——两处都该由注册表推出`);
}

/* 同步链守卫：CHANGELOG.md 最新版本号必须出现在 changelog 页里。
   注意比较的是「v + 版本号」：页面把版本渲染成 v0.1.0 的形式，光查裸版本号
   会被 commit 链接里的哈希之类误命中。 */
const changelogSource = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
const latestVersion = (changelogSource.match(/^## (?:\[)?([^\]\s(]+)/m) || [])[1];
const changelogHtml = fs.readFileSync(path.join(DIST, "changelog/index.html"), "utf8");
if (!latestVersion) fail("CHANGELOG.md 里读不出版本号（首个 ## 段的格式变了）");
if (!changelogHtml.includes(`v${latestVersion}`)) {
  fail(`changelog/ 里没有最新版本 v${latestVersion}——build-landing 的解析或页面渲染有一环失效`);
}

/* 快照同步守卫：比的是「同一提交里的两份真值」。工作区那份 version.json 每次
   landing:build 都会被重写成 package.json 的值，拿它比 package.json 恒等、没有意义；
   只有 HEAD 的两份 blob 能暴露「发版 commit 没带上刷新后的快照」这种漂移
   （跟随发版的正路是 .release-it.json 的 after:bump 钩子）。 */
function committed(file) {
  try {
    return execFileSync("git", ["show", `HEAD:${file}`], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}
const committedSnapshot = committed("landing/version.json");
const committedPkg = committed("package.json");
if (committedSnapshot === null || committedPkg === null) {
  fail("读不到 HEAD 里的 landing/version.json 或 package.json：快照守卫没得比");
} else {
  const snapshotVersion = (JSON.parse(committedSnapshot).version || "").replace(/^v/, "");
  const pkgVersion = (JSON.parse(committedPkg).version || "").replace(/^v/, "");
  if (snapshotVersion !== pkgVersion) {
    fail(
      `入库快照漂移：HEAD 里 landing/version.json 是 ${snapshotVersion || "（空）"}，package.json 是 ${pkgVersion}。` +
        "走 pnpm release 发版（after:bump 会重跑数据源并把快照带进发版 commit）；" +
        "手改过版本号的，补跑 node scripts/build-landing.cjs 后把 landing/version.json 一起提交",
    );
  }
}

console.log(
  `[verify-landing] OK：${PAGES.length} 页齐备、${cards} 张平台卡、${refCount} 个本地引用全部在位、资源引用全部文档相对、更新日志与 CHANGELOG 同步、版本快照与 package.json 同版`,
);

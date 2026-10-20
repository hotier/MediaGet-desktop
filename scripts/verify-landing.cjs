#!/usr/bin/env node
/**
 * 落地页产物自检（离线、不碰网络、不跑构建）。
 *
 * 为什么单独成一个脚本：CI 的 PR 检查与落地页部署两条链路都要这道门，抄两段 bash
 * 迟早只有一段跟着页面结构更新。这里钉的都是「构建成功但线上是坏的」那一类：
 *   1. 四页都在产物根 —— build.format="file" 的形态一旦被改回目录格式，
 *      `./_astro/` 会指向 dist/terms/_astro，样式与脚本全 404；
 *   2. 每页资源引用已改成文档相对（`./_astro/`）——残留 `/_astro/` 时双击打开与
 *      Pages 子路径至少有一个打不开，而 astro build 一声不响；
 *   3. 页面里每个 `src/href="./x"` 都真的落在 dist 里 —— 页脚改一个文件名、
 *      平台图标漏镜像，都是构建绿、点开 404；
 *   4. 首页平台卡数量与页内那句「支持 N 个平台」一致 —— 卡片由注册表生成，
 *      数字由同一处推出，谁把平台名/数量抄回页面，这里当天红。
 *
 * 用法：pnpm landing:build && node scripts/verify-landing.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "landing", "dist");
const PAGES = ["index.html", "terms.html", "privacy.html", "notice.html"];

function fail(message) {
  console.error(`[verify-landing] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(DIST)) fail("landing/dist 不存在：先跑 pnpm landing:build");

for (const name of PAGES) {
  if (!fs.existsSync(path.join(DIST, name))) {
    fail(`缺少产物 ${name}：build.format="file" 时四页都应平铺在 dist 根`);
  }
}

let refCount = 0;
for (const name of PAGES) {
  const html = fs.readFileSync(path.join(DIST, name), "utf8");

  if (html.includes('"/_astro/')) {
    fail(`${name}: 仍有站点根绝对路径的资源引用，relative-output 改写没生效`);
  }
  if (!html.includes('"./_astro/')) {
    fail(`${name}: 没有 ./_astro/ 引用，构建形态变了`);
  }

  /* 只查文档相对引用；外链（https:）与纯锚点（#faq）不归这里管 */
  const refs = new Set(
    [...html.matchAll(/(?:src|href)="\.\/([^"#?]+)/g)].map((match) => match[1]),
  );
  for (const ref of refs) {
    if (!fs.existsSync(path.join(DIST, ref))) {
      fail(`${name}: 引用了 ./${ref}，产物里没有这个文件`);
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

console.log(
  `[verify-landing] OK：${PAGES.length} 页齐备、${cards} 张平台卡、${refCount} 个本地引用全部在位、资源引用全部文档相对`,
);

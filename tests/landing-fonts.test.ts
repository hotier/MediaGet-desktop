/**
 * 落地页字体产物路径守卫。
 *
 * 为什么需要它：2026-10-20 换首屏字体时发现，`@font-face` 里的 `url("./fonts/x.woff2")`
 * 在 dev 下是对的、构建产物里是错的 —— Astro 把 global.css 抽成 `dist/_astro/*.css`，
 * `./fonts/` 于是指向 `dist/_astro/fonts/`，而字体躺在 `dist/fonts/`（public 原样拷的）。
 * Vite 对这种「public 目录 + 相对路径」只警告一句 “remain unchanged to be resolved at
 * runtime”，构建照样绿；线上首屏静默回落到系统宋体，而两台机子上的系统宋体长得很像，
 * 所以这个错能一直躺着——「静默降级」正是这类 bug 的杀伤力所在。
 *
 * 这里钉两件事，都不跑构建、不碰网络：
 *   1. 每条 `url()` 以「产物 CSS 的落点」为基准解析后，必须落在 dist 之下
 *      —— 否则双击 dist/index.html 与 Pages 子路径至少有一个打不开；
 *   2. 解析出来的那份在 public/ 里真的存在（= 构建时确实会被拷到那个位置）。
 *
 * 正文已全走系统字体栈（2026-10-22 业主定调），字体的 webfont 只剩首屏京华老宋体一份；
 * 曾经的思源子集覆盖对账（源码汉字 ↔ .chars.txt）随子集一起删除。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STYLE_DIR = join(ROOT, "landing/src/styles");
const DIST_DIR = join(ROOT, "landing/dist");
const PUBLIC_DIR = join(ROOT, "landing/public");
/** Astro 抽出来的样式落点：浏览器解析相对 url 的基准就是这一层 */
const OUTPUT_CSS_DIR = join(DIST_DIR, "_astro");

const CSS_FILES = readdirSync(STYLE_DIR).filter((name) => name.endsWith(".css"));

interface LocalUrl {
  css: string;
  url: string;
}

/** 取出所有本地资源引用；data: 与外链（logo 那类同源图片以外的东西）不归这里管 */
function localUrls(): LocalUrl[] {
  const found: LocalUrl[] = [];
  for (const name of CSS_FILES) {
    const css = readFileSync(join(STYLE_DIR, name), "utf8");
    for (const match of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
      const url = match[2].trim();
      if (/^(?:data:|https?:|\/\/)/.test(url)) continue;
      found.push({ css: name, url });
    }
  }
  return found;
}

describe("落地页字体产物路径", () => {
  const urls = localUrls();

  it("样式里确实有本地字体引用（守卫没空转）", () => {
    expect(urls.length).toBeGreaterThan(0);
  });

  it("每条 url() 都解析在 dist 之内", () => {
    for (const { css, url } of urls) {
      const target = resolve(OUTPUT_CSS_DIR, url);
      const inside = relative(DIST_DIR, target);
      expect(
        inside.startsWith("..") || inside.startsWith("/"),
        `${css}: url("${url}") 按 dist/_astro/ 解析到了 ${target}，跑到 dist 外面去了`,
      ).toBe(false);
    }
  });

  it("解析出来的文件在 public/ 里存在（构建会把它拷到那个位置）", () => {
    for (const { css, url } of urls) {
      const target = resolve(OUTPUT_CSS_DIR, url);
      const source = join(PUBLIC_DIR, relative(DIST_DIR, target));
      expect(
        existsSync(source),
        `${css}: url("${url}") 对应的源文件不存在（找的是 ${relative(ROOT, source)}）。` +
          "字体走 public/ 时要按「产物 CSS 在 dist/_astro/」这一层算相对路径，写成 ../fonts/ 才对",
      ).toBe(true);
    }
  });
});

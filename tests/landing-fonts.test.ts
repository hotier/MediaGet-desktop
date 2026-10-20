/**
 * 落地页字体子集 ↔ 产物路径 / 覆盖范围的守卫。
 *
 * 为什么需要它：2026-10-20 换首屏字体时发现，`@font-face` 里的 `url("./fonts/x.woff2")`
 * 在 dev 下是对的、构建产物里是错的 —— Astro 把 global.css 抽成 `dist/_astro/*.css`，
 * `./fonts/` 于是指向 `dist/_astro/fonts/`，而字体躺在 `dist/fonts/`（public 原样拷的）。
 * Vite 对这种「public 目录 + 相对路径」只警告一句 “remain unchanged to be resolved at
 * runtime”，构建照样绿；线上首屏静默回落到系统宋体，而两台机子上的系统宋体长得很像，
 * 所以这个错能一直躺着——「静默降级」正是这类 bug 的杀伤力所在。
 *
 * 这里钉三件事，都不跑构建、不碰网络：
 *   1. 每条 `url()` 以「产物 CSS 的落点」为基准解析后，必须落在 dist 之下
 *      —— 否则双击 dist/index.html 与 Pages 子路径至少有一个打不开；
 *   2. 解析出来的那份在 public/ 里真的存在（= 构建时确实会被拷到那个位置）；
 *   3. 源码里出现的每个汉字都在思源子集的覆盖清单里。子集是按文案裁的，改文案而忘了重裁
 *      不会报错、不会漏白，只是新字悄悄换成系统雅黑——比缺字更难发现，所以在这里变红叉。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STYLE_DIR = join(ROOT, "landing/src/styles");
const SRC_DIR = join(ROOT, "landing/src");
const DIST_DIR = join(ROOT, "landing/dist");
const PUBLIC_DIR = join(ROOT, "landing/public");
/** Astro 抽出来的样式落点：浏览器解析相对 url 的基准就是这一层 */
const OUTPUT_CSS_DIR = join(DIST_DIR, "_astro");
/** 思源黑体子集实际覆盖的字符（由裁子集那一步一并产出，与 woff2 同目录）。
 *  首页与文档页各一份：条款用字与宣传语几乎不重叠，合并会让只读首页的人多下载几十 KB。 */
const BODY_CHARSET = join(PUBLIC_DIR, "fonts/noto-sans-sc-body.chars.txt");
const DOC_CHARSET = join(PUBLIC_DIR, "fonts/noto-sans-sc-doc.chars.txt");

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

describe("落地页字体子集", () => {
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

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
const SOURCE_EXT = new Set([".astro", ".ts", ".js"]);

/**
 * 注释里的汉字不算文案：本轮子集只有几百个字，把注释算进来会让清单虚胖，
 * 而注释永远不会被渲染。只剥注释，不碰字符串与模板文本。
 */
function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/**
 * 文档页是「另一套用字」的那几页：layouts/ 只被它们用，三篇页面本身也在此列。
 * components/ 是两边共用的小件（字标等），所以它同时计入两套子集——漏一处就会出现
 * 「首页好看、文档页那三个字长得不一样」这种最难发现的降级。
 */
const DOC_PAGE = /^pages\/(terms|privacy|notice)\.astro$/;
const SHARED_DIR = "components/";
const isDocSource = (rel: string) => rel.startsWith("layouts/") || DOC_PAGE.test(rel);
const overlaps = (rel: string) => rel.startsWith(SHARED_DIR);

/** 扫描 landing/src 下所有源码的可见汉字 → 首次出现的文件（报错时指着它说话） */
function sourceCjk(): { rel: string; chars: Map<string, string> }[] {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => SOURCE_EXT.has(extname(name)))
    .map((name) => ({ rel: name.split(/[\\/]/).join("/"), abs: join(SRC_DIR, name) }));
  return files.map(({ rel, abs }) => {
    const chars = new Map<string, string>();
    for (const char of stripComments(readFileSync(abs, "utf8"))) {
      if (CJK.test(char) && !chars.has(char)) chars.set(char, `landing/src/${rel}`);
    }
    return { rel, chars };
  });
}

/** 两套子集各自负责哪些文件；断言分开跑，某一边漏字就只红那一条 */
const SUBSETS = [
  {
    key: "首页（body）",
    charset: BODY_CHARSET,
    owns: (rel: string) => overlaps(rel) || !isDocSource(rel),
  },
  {
    key: "文档页（doc）",
    charset: DOC_CHARSET,
    owns: (rel: string) => overlaps(rel) || isDocSource(rel),
  },
];

describe("思源黑体子集覆盖", () => {
  const sources = sourceCjk();

  it("两套子集的清单都在（守卫没空转）", () => {
    for (const subset of SUBSETS) {
      expect(existsSync(subset.charset), `${subset.key} 的用字清单不存在`).toBe(true);
      expect(readFileSync(subset.charset, "utf8").length, `${subset.key} 的清单是空的`).toBeGreaterThan(
        0,
      );
    }
  });

  for (const subset of SUBSETS) {
    it(`${subset.key}：源码里出现的每个汉字都在覆盖清单里`, () => {
      const covered = new Set(readFileSync(subset.charset, "utf8"));
      const missing = sources
        .filter(({ rel }) => subset.owns(rel))
        .flatMap(({ chars }) => [...chars])
        .filter(([char]) => !covered.has(char));
      expect(
        missing.map(([char, file]) => `${char} · ${file}`),
        "落地页新增了汉字而对应那份思源子集没重裁。照 fonts/OFL-NotoSans.txt 里记的来源重做子集，" +
          "并同步同目录的 .chars.txt——不重裁不会报错，只会让新字静默换成系统雅黑",
      ).toEqual([]);
    });
  }
});

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { defineConfig } from "astro/config";

/* global URL */

/**
 * 把产物里的资源引用改成「相对当前文档」，且**按页面所在目录算层级**。
 *
 * 为什么需要这一步：Astro 只认站点根绝对路径（`/_astro/xxx.css`），配置里没有
 * relativeLinks 这类开关（本仓 astro@7.4.1 全包搜不到这个键，写了也只是静默不生效）。
 * 根绝对路径的产物因此有三个打不开的场合——双击 dist/index.html（解析到磁盘根）、
 * 部署到 Pages 项目子路径（解析到域名根）、以及放进任意一层目录里托管。
 *
 * 产物形态是 build.format = "directory"（业主 2026-10-22 点名：URL 不带 .html）：
 * 首页与 404 在产物根（index.html / 404.html），其余四页在各自目录里
 * （changelog/index.html …）。所以前缀不能一刀切 `./`——changelog/ 下的页面写
 * `./_astro/` 会指到 dist/changelog/_astro/，样式全 404（旧注释预言过的坑）。
 * 层级从文件相对 dist 的深度算：根页 `./`，一层目录 `../`。页面里的站内链接
 * 同理走 src/lib/rel.ts，两边共用「深度 → 前缀」这一条规则。
 *
 * 逐份 HTML 改写而不是只改 index.html：五份内页 + 一份 404，漏一页就是那一页裸奔
 * （构建是绿的，点开是没样式的）。
 *
 * 只动 `"/_astro/`：外链（github.com）、data: URI 与正文锚点一律不碰。
 * 一处都没改到就抛错——那说明 Astro 改了输出形态，静默放行等于把降级悄悄丢掉。
 */
function relativeOutput() {
  return {
    name: "relative-output",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        const pages = readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter((name) => name.endsWith(".html"))
          .map((name) => new URL(name.split(/[\\/]/).join("/"), dir));
        if (pages.length === 0) throw new Error("relative-output：产物里一份 HTML 都没有");

        let rewritten = 0;
        for (const page of pages) {
          // dist 根 = 0 层 → "./"；changelog/index.html = 1 层 → "../"
          const depth = page.pathname.slice(dir.pathname.length).split("/").filter(Boolean).length - 1;
          const prefix = depth === 0 ? "./" : "../".repeat(depth);
          const html = readFileSync(page, "utf8");
          const next = html.split('"/_astro/').join(`"${prefix}_astro/`);
          if (next === html) continue;
          writeFileSync(page, next, "utf8");
          rewritten += 1;
        }
        if (rewritten === 0) {
          throw new Error('relative-output：产物里找不到 "/_astro/" 引用，改写规则已失效');
        }
        logger.info(`产物资源引用已改为文档相对路径（${rewritten} / ${pages.length} 份 HTML）`);
      },
    },
  };
}

// 静态输出。产物在 dist/，与主仓 dist-renderer / dist-electron 互不相干。
// build.format = "directory"（业主 2026-10-22 定：路径不带 .html）：
// 首页落在 /，更新日志落在 /changelog/ …… 站内链接写成 `./changelog/` 这种目录式
// （前缀一律经 src/lib/rel.ts 按页算，页面里不手写 ../）。
// 404 是唯一保留 .html 扩展名的产物（GitHub Pages 按文件名接管未命中路径），
// 且必须留在产物根——Pages 只认根下那份。
// 一个如实的边界：不带扩展名的 URL 与「双击 dist/index.html 预览」在原理上不可
// 兼得——file:// 没有服务器补 index.html，点向 /changelog/ 会被当成本地目录列表。
// 首页自身与其资源照常能开；上线形态（Pages）没有这个问题。
// 端口避开主仓 dev server 的 5433。
export default defineConfig({
  build: { format: "directory" },
  server: { port: 5174 },
  devToolbar: { enabled: false },
  // Pages 项目站地址：只喂 canonical / og:url 这类「我是谁」的绝对链接，不参与资源路径
  // （产物资源引用已改为文档相对）。换宿主时改这一行就够，页面里不写死域名。
  site: "https://hotier.github.io/mediaGet-desktop/",
  integrations: [relativeOutput()],
});

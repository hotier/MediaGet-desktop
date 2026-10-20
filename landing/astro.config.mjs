import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { defineConfig } from "astro/config";

/* global URL */

/**
 * 把产物里的资源引用改成「相对当前文档」。
 *
 * 为什么需要这一步：Astro 只认站点根绝对路径（`/_astro/xxx.css`），配置里没有
 * relativeLinks 这类开关（本仓 astro@5.18.2 全包搜不到这个键，写了也只是静不生效）。
 * 根绝对路径的产物因此有三个打不开的场合——双击 dist/index.html（解析到磁盘根）、
 * 部署到 Pages 项目子路径（解析到域名根）、以及放进任意一层目录里托管。
 *
 * 前提是 build.format = "file"：每页都平铺在 dist 根（terms.html / privacy.html …），
 * 所以 `./_astro/` 对每一页都指向 dist/_astro/。目录格式（terms/index.html）下这条改写
 * 会把资源指到 dist/terms/_astro/，那种组合要么改成按层级算前缀，要么别用目录格式——
 * 别把 format 改回去却留着这里的 `./`。
 *
 * 逐份 HTML 改写而不是只改 index.html：文档页有三份，只改首页等于让那三页在
 * 双击打开与子路径部署两种场合下裸奔（构建是绿的，线上是没样式的）。
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
          const html = readFileSync(page, "utf8");
          const next = html.split('"/_astro/').join('"./_astro/');
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
// build.format = "file"：四页（index / terms / privacy / notice）都平铺在产物根，
// 页面之间的链接于是可以写成 `./terms.html` —— 双击打开与 Pages 子路径都能跳。
// 端口避开主仓 dev server 的 5433。
export default defineConfig({
  build: { format: "file" },
  server: { port: 5174 },
  devToolbar: { enabled: false },
  // Pages 项目站地址：只喂 canonical / og:url 这类「我是谁」的绝对链接，不参与资源路径
  // （产物资源引用已改为文档相对）。换宿主时改这一行就够，页面里不写死域名。
  site: "https://hotier.github.io/mediaGet-desktop/",
  integrations: [relativeOutput()],
});

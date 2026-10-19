import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "astro/config";

/* global URL */

/**
 * 把产物里的资源引用改成「相对当前文档」。
 *
 * 为什么需要这一步：Astro 只认站点根绝对路径（`/_astro/xxx.css`），配置里没有
 * relativeLinks 这类开关（本仓 astro@5.18.2 全包搜不到这个键，写了也只是静不生效）。
 * 根绝对路径的产物因此有三个打不开的场合——双击 dist/index.html（解析到磁盘根）、
 * 部署到 Pages 项目子路径（解析到域名根）、以及放进任意一层目录里托管。
 * 落地页只有一个 index.html 且它就躺在产物根，改写前缀是等价的：改完这份产物
 * 在上述三种场合都能原样打开，不必为托管位置回来动配置。
 *
 * 只动 `"/_astro/`：外链（github.com）、data: URI 与正文锚点一律不碰。
 * 一处都没改到就抛错——那说明 Astro 改了输出形态，静默放行等于把降级悄悄丢掉。
 */
function relativeOutput() {
  return {
    name: "relative-output",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        const target = new URL("index.html", dir);
        const html = readFileSync(target, "utf8");
        const rewritten = html.split('"/_astro/').join('"./_astro/');
        if (rewritten === html) {
          throw new Error('relative-output：产物里找不到 "/_astro/" 引用，改写规则已失效');
        }
        writeFileSync(target, rewritten, "utf8");
        logger.info("产物资源引用已改为文档相对路径");
      },
    },
  };
}

// 静态输出（默认）。产物在 dist/，与主仓 dist-renderer / dist-electron 互不相干。
// 端口避开主仓 dev server 的 5433。
export default defineConfig({
  server: { port: 5174 },
  devToolbar: { enabled: false },
  // Pages 项目站地址：只喂 canonical / og:url 这类「我是谁」的绝对链接，不参与资源路径
  // （产物资源引用已改为文档相对）。换宿主时改这一行就够，页面里不写死域名。
  site: "https://hotier.github.io/mediaGet-desktop/",
  integrations: [relativeOutput()],
});

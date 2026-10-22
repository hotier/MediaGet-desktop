/**
 * 页面深度 → 站点根的相对前缀。
 *
 * 产物是 build.format="directory"（URL 不带 .html：/changelog/ 而非 /changelog.html），
 * 页面所在的目录层级不再统一，站内链接与资源引用都得按页算前缀：
 *   /            → "./"      （index.html 与 404.html 都在产物根）
 *   /changelog/  → "../"
 * 只许从这里算，页面里不许手写 ../ —— 挪一层目录就得全量改链接，正是这套
 * 落地页一直避开的「第二份真源」。
 *
 * dirSlug(slug)：**站内页面链接**用这半 —— 拼成不带尾斜杠的目录式地址
 * （../changelog 而非 ../changelog/）。Pages 对无斜杠目录路径 301 补斜杠，
 * 最终地址不变；业主 2026-10-22 点名要这种形态（与 dev 服务器 /changelog 的
 * 直观地址一致）。资源引用（_astro、brand、字体）仍走 pageRel —— 它们必须
 * 一次命中真实文件，不能指望 301。
 */
export function pageRel(pathname: string): string {
  // 404.html 在根：带 .html 的末段是文件不是目录，不计深度
  const segs = pathname.split("/").filter((s) => s && !s.endsWith(".html"));
  return segs.length === 0 ? "./" : "../".repeat(segs.length);
}

/**
 * 站内页面链接：前缀 + 无斜杠目录式地址（Pages 301 补斜杠到规范形态）。
 * slug 为空串时表示「回首页」——回根目录要落到文件（./index.html）而不是
 * 目录本身（./ 或 ../）：file:// 下目录链接会落到本地目录列表（见 astro.config
 * 的边界注释），Pages 上 ./ 也会让地址栏比 / 差一层。锚点同理由调用方带 index.html。
 */
export function dirSlug(prefix: string, slug: string): string {
  if (!slug) return prefix === "./" ? "./index.html" : `${prefix}index.html`;
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return `${base}/${slug}`;
}

/**
 * 预览取流的链规则（业主定调 2026-10-18：预览走「放开 CSP + 主进程代理取流」）。
 *
 * 结果卡的「预览」要把直链交给 `<video>` / `<audio>` 解码，而这两条都过不去：
 * ① 渲染层的 CSP 只放行 `'self'`，媒体外链直接被策略拦死；
 * ② 就算放行，防盗链要求的那对 `Referer` + 桌面 UA 只有主进程能带（浏览器标签里的
 *    媒体元素改不了请求头）。所以链交给一个自定义 scheme，由主进程换上防盗链头再去取。
 *
 * 链里带的是**编码后的上游直链**，它跟直链本身一样敏感：只在内存里过一遍，绝不写日志、
 * 不进历史与队列（隐私红线同 `link-identity.ts`）。零依赖、纯算术，主进程与单测共用同一份判据。
 */

import { isPublicHttpUrl } from "./net-guard";

/** 自定义 scheme 名：CSP、协议注册、编解码三处都取这一枚常量 */
export const PREVIEW_SCHEME = "mgpreview";

/** 占位宿主：scheme 声明为 standard 后必须有 host，真源信息全在查询串里 */
const PREVIEW_HOST = "media";

/**
 * 旧内核（parse-core 0.1.2）的站内图片代理路由前缀：那版把图片/头像改写成
 * `/api/image?url=<编码直链>`（web 宿主路由，桌面没有）。读侧见 `decodeLegacyProxiedImage`。
 */
const LEGACY_PROXY_PREFIX = "/api/image?url=";

export interface PreviewTarget {
  /** 主进程真正要去取的上游直链 */
  url: string;
  /** 平台键，用来查防盗链 Referer；缺省（或认不出）就不带 Referer，只补 UA */
  platform?: string;
  /**
   * 第二条直链：B站登录态的 dash 主链是 **video-only 分片**（`.m4s`），`<video>` 单独放不出
   * 画面与时长，必须由主进程用随包 ffmpeg 与音频轨合流后才能预览。这条存在即表示「要合流」。
   */
  audioUrl?: string;
}

/**
 * 上游地址是不是 DASH 视频分片（B站 `.m4s`）。
 *
 * 只看 pathname 的扩展名：`baseUrl` 后面永远挂着一串签名查询串，拿整串做 `endsWith` 永远 false。
 * 这不是安全判据（安全闸在 `isPublicHttpUrl`），只用来决定「要不要带音频轨去合流」。
 */
export function isDashSegment(target: string): boolean {
  try {
    return /\.m4s$/i.test(new URL(target).pathname);
  } catch {
    return /\.m4s$/i.test(target.split(/[?#]/)[0]);
  }
}

/**
 * 直链 → 预览代理链；上游地址过不了安全闸就返回 `null`（UI 据此不进代理，不假装能预览）。
 *
 * 查询串用 `URLSearchParams` 编码：直链自带 `?a=1&b=2`，手工拼接会在第一个 `&` 处断链，
 * 断出来的那半截正好是最敏感签名段——所以这条链只许由本函数产出。
 */
export function buildPreviewLink(target: string, platform?: string, audio?: string): string | null {
  if (!isPublicHttpUrl(target)) return null;
  const u = new URL(`${PREVIEW_SCHEME}://${PREVIEW_HOST}/`);
  u.searchParams.set("u", target);
  const key = platform?.trim();
  if (key) u.searchParams.set("p", key);
  // 第二条直链（B站 dash 音频轨）同样过闸：认不准就退回「只取视频」，绝不把代理
  // 扩成第二条任意地址通道。与主链相同也不重复带（durl 单文件本身就含音轨）。
  if (audio && audio !== target && isPublicHttpUrl(audio)) u.searchParams.set("a", audio);
  return u.href;
}

/**
 * 图片该写进 `src` 的那条链：**照媒体一样走代理**；代理建不出来时，只有 `data:` 内联图原样
 * 放行，其余返回 `null`（调用方画占位，别把必坏或指向内网的地址写进 src）。
 *
 * 「图片反正 CSP 放行 https:，直接吃原链就行」这条推断 2026-10-18 被实测推翻：微博图床
 * `*.sinaimg.cn` 对**空 Referer**也回 403（`no-referrer` 与本机来源 Referer 同样被拒，只有
 * `Referer: https://weibo.com/` 是 200）。而 `<img>` 改不了请求头——于是结果卡的头像、主视觉、
 * 缩略条、图集弹窗整片空白，症状长得像「内核没返回 avatar/images」。防盗链那对头只有主进程带得上，
 * 所以图片与音视频共用这条代理链；回落只服务 `data:` 内联图。
 *
 * 2026-10-18 事故（parse-core 0.1.2，四个症状：头像/图片不显示、评论数没有、图集识别成视频）：
 * 旧内核把微博/小红书/B站的图片与头像改写成 web 宿主的**站内相对路由**
 * `/api/image?url=<编码直链>`，桌面根本没有这条路由，而「回落原链」分支把这个相对地址
 * 原样写进了 `<img src>` —— 一张注定 404 的图，界面上演的是「图裂了」而不是任何报错。
 * 内核 1.0.0 起已移除该模式（1.1.0 零残留），桌面侧在这里钉死：相对路由、私网字面量与
 * 其它 scheme 一律 `null`；盘上存量（那段时间写进 history/queue 的作者头像）则读侧解出来复活。
 */
export function buildImageSrc(target: string, platform?: string): string | null {
  const direct = decodeLegacyProxiedImage(target) ?? target;
  const proxied = buildPreviewLink(direct, platform);
  if (proxied) return proxied;
  // 回落只剩 `data:` 内联图（不发起网络请求，dev mock 的头像封面都是它）。
  // 公网 http(s) 直链在上一步必然建得出代理链；走到这里还过不了闸的地址（私网、.local、
  // .invalid、带 userinfo）绝不能原样写进 src——那正是「借 <img> 让渲染层访问内网」的形状。
  if (direct.startsWith("data:")) return direct;
  return null;
}

/**
 * 旧内核（parse-core 0.1.2）的站内图片代理路由 → 上游直链；不是该形状返回 `null`。
 *
 * 读侧归一：盘上存量不许被静默改写，但要把
 * 存量解释成当前认得的形态——否则 0.1.2 期间解析过的每一行，头像都永远是一张裂图。
 * 形状以上游 0.1.2 `weiboCore.js` 的 `proxifyImage3` 为准（`decodeProxiedUrl` 同款前缀）。
 */
function decodeLegacyProxiedImage(target: string): string | null {
  if (!target.startsWith(LEGACY_PROXY_PREFIX)) return null;
  try {
    const url = decodeURIComponent(target.slice(LEGACY_PROXY_PREFIX.length));
    // 只复活「本来就能建代理链」的真直链：裹着回环/私网地址的存量同样不救——
    // 那类链只配经主进程，而主进程那道闸（isPublicHttpUrl）在这里已经替它判过了
    return isPublicHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * 代理链 → 上游直链（主进程侧唯一的解链口）。
 *
 * 解码后**再走一次安全闸**：链是渲染层送上来的，写日志、被篡改、被别的窗口拼一条都可能导致
 * 它指向回环或内网；闸只有一处判据，两侧各跑一遍才算数。认不出就返回 `null`，处理器据此回 400。
 */
export function readPreviewTarget(link: string): PreviewTarget | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== `${PREVIEW_SCHEME}:`) return null;
  const url = u.searchParams.get("u");
  if (!url || !isPublicHttpUrl(url)) return null;
  const platform = u.searchParams.get("p");
  // 音频轨同一道闸：伪造一条指向回环的 `a=` 不该让取流侧多跳一次内网，
  // 但也不该因此废掉整条链——丢掉它，视频仍按原样取（B站 dash 会退化，不是安全问题）
  const audio = u.searchParams.get("a");
  const audioUrl = audio && audio !== url && isPublicHttpUrl(audio) ? audio : undefined;
  const base: PreviewTarget = platform ? { url, platform } : { url };
  return audioUrl ? { ...base, audioUrl } : base;
}

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
 * 上游地址的安全闸：只放行「公网 http(s) 资源」。
 *
 * 这条链的查询串来自渲染进程，而渲染进程是不可信输入源——代理取流若不加闸，就等于给
 * 渲染层开了一条「让主进程替我访问任意地址」的路（内网探测、回环服务、云主机元数据接口）。
 * 判据从严：认不准就不认，正常媒体 CDN 都是公网域名，不存在误杀顾虑。
 */
function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return !isBlockedHost(u.hostname);
}

/** 直连解析不出公网身份的地址段：回环、私网、链路本地、CGNAT、组播/保留、元数据接口 */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0xff000000], // 0/8「本网络」，含 0.0.0.0
  [0x0a000000, 0xff000000], // 10/8
  [0x64400000, 0xffc00000], // 100.64/10 CGNAT
  [0x7f000000, 0xff000000], // 127/8 回环
  [0xa9fe0000, 0xffff0000], // 169.254/16 链路本地，含 169.254.169.254 元数据
  [0xac100000, 0xfff00000], // 172.16/12
  [0xc0000000, 0xffffff00], // 192.0.0/24 IETF 协议分配
  [0xc0000200, 0xffffff00], // 192.0.2/24 TEST-NET-1
  [0xc0a80000, 0xffff0000], // 192.168/16
  [0xc2120000, 0xfffe0000], // 198.18/15 基准测试
  [0xe0000000, 0xf0000000], // 224/4 组播
  [0xf0000000, 0xf0000000], // 240/4 保留，含 255.255.255.255
];

function ipv4ToLong(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function blockedV4Long(n: number): boolean {
  return BLOCKED_V4.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

function blockedV4(host: string): boolean {
  const n = ipv4ToLong(host);
  if (n === null) return false; // 不是 IP 字面量 → 是域名，交给名字规则
  return blockedV4Long(n);
}

/**
 * IPv6 展成 8 个数值段：`::` 压缩补零，末段点分 v4 折进后两段。
 *
 * 必须展开而不是拿字符串比前缀——WHATWG 把 `::ffff:127.0.0.1` 规范化成 `::ffff:7f00:1`，
 * 而 `::ffff:0:127.0.0.1`、`0:0:0:0:0:ffff:7f00:1` 又是另外几种写法，字面匹配总有一种漏掉。
 * 展不出来就返回 `null`，调用侧按不放行收（判据宁可错杀）。
 */
function expandV6(ip: string): number[] | null {
  let body = ip;
  let tail: string[] = [];
  if (body.includes(".")) {
    const v4 = body.slice(body.lastIndexOf(":") + 1);
    const n = ipv4ToLong(v4);
    if (n === null) return null;
    body = body.slice(0, body.lastIndexOf(":"));
    tail = [((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16)];
  }
  let groups: string[];
  const compress = body.indexOf("::");
  if (compress >= 0) {
    if (compress !== body.lastIndexOf("::")) return null; // 两个 `::` 不合法
    const head = body.slice(0, compress) ? body.slice(0, compress).split(":") : [];
    const rest = body.slice(compress + 2) ? body.slice(compress + 2).split(":") : [];
    const zeros = 8 - tail.length - head.length - rest.length;
    if (zeros < 1) return null;
    groups = [...head, ...new Array<string>(zeros).fill("0"), ...rest];
  } else {
    groups = body.split(":");
  }
  groups = [...groups, ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function blockedV6(bracketed: string): boolean {
  let ip = bracketed.slice(1, -1).toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone); // 区域 id 只是本机网卡寻址，剥掉再看地址段
  const g = expandV6(ip);
  if (!g) return true;
  const zeros = (from: number, to: number) => g.slice(from, to).every((n) => n === 0);
  if (zeros(0, 8)) return true; // :: 未指定
  if (zeros(0, 7) && g[7] === 1) return true; // ::1 回环
  // ::ffff:a.b.c.d 与其十六进制写法（WHATWG 会压成 `::ffff:7f00:1`）：后两段就是那 32 位
  if (zeros(0, 5) && g[5] === 0xffff) return blockedV4Long(((g[6] << 16) | g[7]) >>> 0);
  const head = g[0];
  if (head >= 0xfc00 && head <= 0xfdff) return true; // fc00::/7 唯一本地
  if (head >= 0xfe80 && head <= 0xfebf) return true; // fe80::/10 链路本地
  if (head >= 0xff00) return true; // ff00::/8 组播与保留
  return false;
}

function isBlockedHost(hostname: string): boolean {
  // 拿到这里的主机名已被 `new URL` 规范化：`2130706433`、`0x7f.1`、`127.1` 都成 `127.0.0.1`，
  // IPv6 一律压缩小写并加方括号。所以只需认规范形，不必防着各种花样的私网写法。
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  if (host.startsWith("[")) return blockedV6(host);
  // `new URL` 把 IPv6 放进方括号；不带括号的多段冒号写法不是合法主机名
  if (host.includes(":")) return true;
  if (blockedV4(host)) return true;
  // 非点分的单段名走不了公网（且正是 `http://metadata/` 这类内网别名的形状）
  if (!host.includes(".")) return true;
  return (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".invalid") ||
    host.endsWith(".example")
  );
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
 * 图片该写进 `src` 的那条链：**照媒体一样走代理**；代理建不出来时，只有「浏览器自己
 * 也能安全发」的地址才原样回落，其余返回 `null`（调用方画占位，别把必坏的地址写进 src）。
 *
 * 「图片反正 CSP 放行 https:，直接吃原链就行」这条推断 2026-10-18 被实测推翻：微博图床
 * `*.sinaimg.cn` 对**空 Referer**也回 403（`no-referrer` 与本机来源 Referer 同样被拒，只有
 * `Referer: https://weibo.com/` 是 200）。而 `<img>` 改不了请求头——于是结果卡的头像、主视觉、
 * 缩略条、图集弹窗整片空白，症状长得像「内核没返回 avatar/images」。防盗链那对头只有主进程带得上，
 * 所以图片与音视频共用这条代理链；回落只服务「图床不吃 Referer 少一跳」与 `data:` 内联图。
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
  // 回落放行的只有两类：data: 内联图（不发起网络请求，dev mock 的头像封面都是它），
  // 与绝对 http(s) 直链（浏览器自己发请求，图床不吃 Referer 时少一跳）。
  if (direct.startsWith("data:")) return direct;
  try {
    const u = new URL(direct);
    if (u.protocol === "http:" || u.protocol === "https:") return direct;
  } catch {
    /* 相对地址或坏 URL：落到 null */
  }
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

/**
 * 公网地址闸门（单一真源）：预览代理、图片回落与下载器共用同一份判据。
 *
 * 为什么必须只有一份：这类判据的漏洞从来不是「写错一个网段」，而是「两份实现里只有一份被修」。
 * 2026-10-23 审查实测下载器那份对 `[::ffff:127.0.0.1]`、`[fd00::1]`、`100.64/10` 全部放行——
 * 根因是拿字符串前缀判断带方括号的 IPv6，而预览侧这份早已按八段展开处理。合并后新增网段
 * 只需改这里，两层不会漂移。
 */

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
  [0xc6120000, 0xfffe0000], // 198.18/15 基准测试
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
 * 上游地址的安全闸：只放行「公网 http(s) 资源」。
 *
 * 调用面横跨预览代理与下载器，查询串可能来自渲染进程（不可信输入源）；判据从严：
 * 认不准就不认，正常媒体 CDN 都是公网域名，不存在误杀顾虑。带 userinfo 的地址一律拒——
 * 合法媒体链没有它，而它是「把凭据塞进 URL」的常见形状。
 */
export function isPublicHttpUrl(raw: string): boolean {
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

/**
 * fetch 跟随重定向后的复检：闸门只校验了发起时的 URL，公网地址 302 到内网仍会打过去。
 * `resp.url` 为空（注入的测试 fetch 或非 HTTP 实现）时跳过，不制造假阳性。
 */
export function isPublicFinalUrl(url: string | undefined): boolean {
  return !url || isPublicHttpUrl(url);
}

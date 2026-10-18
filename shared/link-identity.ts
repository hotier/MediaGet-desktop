/**
 * 直链的身份规则（业主指令 2026-10-17：下载遇 403 就自动重新取链，别让用户以为软件坏了）。
 *
 * 「重新取链」的难点不在再解析一次，而在**新结果里哪一条才是这一份资源**：一次解析会同时
 * 给出主视频、音频、图集若干张、多 P 各档清晰度，而重解析回来的是一整份新列表。认错了对象
 * 就是把 P2 的链接到 P1 的任务上——文件照样下完、内容却是另一段，这种错界面上看不出来。
 *
 * 所以这里的判据是「**路径 + 全部非时效参数**」：路径带的就是这份资源本身，非时效参数把它
 * 钉到具体那一档（`video_id` / `ratio` / `quality` / `fnval`…），而签名与到期时刻每次都换、
 * 不参与身份。零依赖、纯算术，主进程与单测共用同一份判据。
 *
 * **host 不参与身份**（2026-10-18 实测修正）：host 是 CDN 节点，不是资源。B 站一次解析里
 * 两条清晰度就分别落在 `cn-sh-cc-01-08.bilivideo.com` 与 `cn-sh-cc-01-15.bilivideo.com`，
 * 节点还会随每次 playurl 重选——把 host 写进判据，等于要求「平台必须发同一个节点」，那条
 * 资源一换节点就永远续不上链（线上表现正是「续链无结果」+ 一路 403）。
 * 资源身份落在 pathname（`/upgcxcode/…/<avid>-1-<qn>.mp4` 这类串里已经钉住作品与清晰度）。
 */
import type { ParseData } from "../types/ipc";

/**
 * 时效/签名/路由类查询键：这些是「这一次请求临时算出来的」，重解析必然变，不能当身份。
 * 各家叫法都收进来（`x-expires` / `deadline` / `sign` / `lk3s` / `se`…），B 站那一串
 * （`upsig` 签名 / `uparams` 被签的参数名 / `trid` 请求轨迹 / `nbs` / `cdnid` 节点号 / `og` 源站组）
 * 是 2026-10-18 实测出来的：连续两次解析同一作品，只有 `deadline` / `trid` / `uparams` / `upsig` 变值，
 * 而前三个不在名单里时续链永远认不出（线上日志「续链无结果」的根因）。
 *
 * 名单只收签名、到期与路由，**不收设备/用户标识**（`uid` / `mid` / `buvid` / `chid`）：那些在
 * 两边取值相同，留在身份参数里只会让判据更严。判据的方向是固定的——宁可认不出（返回 null、
 * 照原样报错），也不能把别的清晰度或别的分 P 当成这一份。
 *
 * 单字母 `e` 也在名单里：B 站 playurl 直链的到期时刻就叫 `e=<秒级时间戳>`（与 `deadline`
 * 毫秒版并存），实测两条链的 `e` 会随签名一起变。名字很短，但路径已经把资源钉死了，
 * 让它参与身份只会让续链失效。
 */
const VOLATILE_KEY =
  /^(x-)?(e|expires?|expiry|deadline|sign|signature|token|ts|time|timestamp|rnd|rand|nonce|lip|lk3s|sc|se|l|s|m|bs|trid|upsig|uparams|nbs|cdnid|og)$/i;

interface LinkShape {
  /** CDN 节点。**不参与身份**，只用来判断「这条链跟失败那条其实是同一个节点、同一串参数」 */
  host: string;
  /** 仅 pathname：资源本身（host 是 CDN 节点，见文件头） */
  path: string;
  /** 全部查询参数（含时效项），用来判断「新链跟旧链其实是同一条」 */
  all: Map<string, string>;
  /** 去掉时效项之后的身份参数 */
  stable: Map<string, string>;
}

function shapeOf(url: string): LinkShape | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const all = new Map<string, string>();
  u.searchParams.forEach((v, k) => all.set(k, v));
  const stable = new Map<string, string>();
  for (const [k, v] of all) if (!VOLATILE_KEY.test(k)) stable.set(k, v);
  return { host: u.host, path: u.pathname, all, stable };
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * 从重解析得到的候选里挑出「失败这条的新一份链接」。
 *
 * 判据（全部满足才认）：① 路径（pathname，host 不参与）相同；② 非时效参数集合全等；
 * ③ 新链与旧链不是同一条（**同一个节点**上整串参数都一样 = 平台没换签，这次 403 与时效无关，
 * 让它照原样报错，别把重试变成死循环；换了节点即使参数相同也算新链 —— 那个节点正是刚才
 * 403 的那一处，换一处是有意义的尝试）。认不出就返回 `null` —— **宁可不续链，也不能续错**：
 * 接错的那条会把别的清晰度或别的分 P 当成这一份下完。
 */
export function pickRenewedUrl(failedUrl: string, candidates: readonly string[]): string | null {
  const want = shapeOf(failedUrl);
  if (!want) return null;
  for (const c of candidates) {
    if (c === failedUrl) continue;
    const s = shapeOf(c);
    if (!s || s.path !== want.path) continue;
    if (!sameMap(s.stable, want.stable)) continue;
    if (s.host === want.host && sameMap(s.all, want.all)) continue; // 同节点、签名都没变，续了也还是同一个 403
    return c;
  }
  return null;
}

/**
 * 两条链是不是**同一份资源**（断点续传的身份判据）。
 *
 * 与 `pickRenewedUrl` 共用同一套判据（pathname + 非时效参数全等，host 与签名不参与），
 * 区别只在于这里**不要求「必须有东西变了」**：盘上的 `.part` 记的是上一条签名链，
 * 重新解析拿回的是新签名链 —— 资源没换就该接着写，而不是把半成品删掉从 0 开始。
 *
 * 用来回答「这个 `.part` 还能不能续」这件事的只有这一处，别在调用侧再抄一份比较规则。
 */
export function isSameResource(a: string, b: string): boolean {
  const sa = shapeOf(a);
  const sb = shapeOf(b);
  if (!sa || !sb) return false;
  return sa.path === sb.path && sameMap(sa.stable, sb.stable);
}

/**
 * 一份解析结果里所有「可下载的媒体直链」，顺序与结果卡的排布一致
 * （主媒体 → 音频 → 图集 → 多 P 各项 → 各清晰度档）。
 *
 * 只在内存里过一遍：这些是直链，按隐私红线绝不写日志、不进历史与队列。
 */
export function collectMediaUrls(data: ParseData | undefined): string[] {
  if (!data) return [];
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v && !out.includes(v)) out.push(v);
  };
  push(data.url);
  push(data.audioUrl);
  for (const img of data.images ?? []) push(img);
  for (const q of data.qualities ?? []) push(q.url);
  for (const v of data.videos ?? []) {
    push(v.url);
    for (const q of v.qualities ?? []) push(q.url);
  }
  return out;
}

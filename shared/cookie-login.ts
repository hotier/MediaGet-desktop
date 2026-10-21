/**
 * 设置页「打开登录页 → 登录后自动抓 Cookie」的规则表与纯函数（2026-10-19 业主指令）。
 *
 * 为什么放 shared/：主进程拿它开窗、收 cookie、拼 Cookie 头；渲染层拿它判断
 * 「这一行有没有自动获取」并显示按钮——两边各写一份键名，就是下一个漂移点
 * （与平台清单同一条纪律：一处声明，两侧 import）。这里只有键名、域名与判据，
 * **没有任何 Cookie 值**；值只在主进程内存里过一遍，不进渲染层、不落日志。
 *
 * 为什么必须有 `markers`：自动抓取最坏的结局不是抓不到，而是**抓到半份**——
 * 匿名访客的 cookie（`ttwid`、`did` 一类）先出现，界面据此标成「已配置」，
 * 解析却必然失败。所以判据只认「登录动作发生后才会有」的键，认不准就不抓。
 */

/** 支持自动获取的键（= `AppSettings.cookies` 的键名，也是内核读的环境变量名） */
export const COOKIE_LOGIN_KEYS = [
  "BILIBILI_COOKIE",
  "XHS_COOKIE",
  "DOUYIN_COOKIE",
  "KUAISHOU_COOKIE",
] as const;

export type CookieLoginKey = (typeof COOKIE_LOGIN_KEYS)[number];

export interface CookieLoginTarget {
  /** 登录页：必须是 https 且落在下面某个域内（导航闸门与它同一份判据） */
  url: string;
  /** 收哪些域的 cookie：cookie 的 domain 去前导点后，等于该域或以 `.该域` 结尾 */
  domains: readonly string[];
  /** 登录后才出现、且出现就一直在的键（任一出现即抓）；见文件头「半份 Cookie」那段 */
  markers: readonly string[];
  /**
   * 「游客也会写」的键：只看名字必然误判，必须看**值的变化**。
   *
   * 小红书 `web_session` 就是这样：匿名打开页面时前端脚本会先注册一个游客会话，
   * 名字在、值不同，登录成功才把它换成正式会话（2026-10-21 业主实测「没登录却显示
   * 已获取」，13 条 cookie 里 web_session 就是游客那一份）。MediaCrawler 的登录态矩阵
   * 对 XHS 的主判据同样是「web_session 变更检测」，而不是「存在即登录」。
   */
  volatileMarkers?: readonly string[];
}

/**
 * 登录页选择（业主建议 2026-10-21）：能直达登录页的平台**直接开登录页**，不先落首页——
 * 省掉「自己在推荐流里找登录入口」这一跳，也让窗口一打开就停在那件要做的事上。
 * 两个前提都没变，所以判据不用跟着改：
 * - 登录域是目标域的子域（`passport.bilibili.com` / `passport.kuaishou.com` /
 *   `www.xiaohongshu.com/login`），`isAllowedNavigation` 与 `filterCookies` 都按
 *   host 后缀认，登录成功跳回主站也在域内；
 * - 登录动作写下的会话 cookie 域仍是 `.bilibili.com` / `.kuaishou.com` / `.xiaohongshu.com`。
 *
 * 2026-10-21 查证：小红书**有**同站登录页（`/login`，200 且直接渲染登录表单）；
 * 抖音**没有** `passport.douyin.com`（域名不存在），官方登录页是 `https://sso.douyin.com/`
 * （标题「登录抖音短视频」，页内自带扫码），而主站 `/passport/web/get_qrcode/` 直接回
 * 「非法应用 error_code 22」——说明二维码只能由平台页面自己出，主进程复刻不了。
 * 所以抖音也走登录页：窗口里就是那张二维码，与我们自己画一张是同一个动作，少一套签名维护。
 */
export const COOKIE_LOGIN_TARGETS: Record<CookieLoginKey, CookieLoginTarget> = {
  BILIBILI_COOKIE: {
    url: "https://passport.bilibili.com/login",
    domains: ["bilibili.com"],
    markers: ["SESSDATA"],
  },
  XHS_COOKIE: {
    // 同站登录页：素访即出扫码/手机号表单，登录后回 explore，全程不出域
    url: "https://www.xiaohongshu.com/login",
    domains: ["xiaohongshu.com"],
    /** 没有任何「游客不写」的可靠键：登录判据只能读 `web_session` 的值变化 */
    markers: [],
    volatileMarkers: ["web_session"],
  },
  DOUYIN_COOKIE: {
    // 官方 SSO 登录页：一打开就是扫码二维码（首页那条要再点一次「登录」）
    url: "https://sso.douyin.com/",
    domains: ["douyin.com"],
    markers: ["sessionid", "sessionid_ss", "sid_guard"],
  },
  KUAISHOU_COOKIE: {
    // 这两枚是登录动作之后的会话/账号标记；`did` 是设备号（匿名也有），所以不作判据
    url: "https://passport.kuaishou.com/",
    domains: ["kuaishou.com"],
    markers: ["kuaishou.web.cp.api_st", "userId"],
  },
};

/**
 * Cookie 头上限。没有这条，一次抓取可能把几十条埋点 cookie 全塞进 config.json，
 * 而内核真正要的那几枚反而可能被平台的 header 上限截掉。
 */
export const MAX_COOKIE_HEADER = 16_000;

export function isCookieLoginKey(raw: string): raw is CookieLoginKey {
  return (COOKIE_LOGIN_KEYS as readonly string[]).includes(raw);
}

export interface RawCookie {
  name: string;
  value: string;
  /** 浏览器/Electron 给的域，通常带前导点（`.xiaohongshu.com`） */
  domain?: string;
}

function hostMatches(host: string, domains: readonly string[]): boolean {
  const h = host.replace(/^\./, "").toLowerCase();
  if (!h) return false;
  return domains.some((d) => {
    const base = d.toLowerCase();
    return h === base || h.endsWith(`.${base}`);
  });
}

/** 只留目标域的 cookie（同名多条时保留先出现的，与浏览器语义接近） */
export function filterCookies(cookies: readonly RawCookie[], domains: readonly string[]): RawCookie[] {
  return cookies.filter((c) => Boolean(c.domain) && hostMatches(c.domain as string, domains));
}

/** 登录态判据：任一 marker 出现即算已登录（只用于「游客不会写」的键） */
export function hasLoginMarker(names: Iterable<string>, markers: readonly string[]): boolean {
  const set = new Set(names);
  return markers.some((m) => set.has(m));
}

/**
 * 「游客也会写」的键：值相对基线变了才算登录。
 *
 * 两侧都必须有值才比较——基线没取到（页面还在写游客会话）时**宁可晚一拍也不误报**，
 * 这正是这个函数存在的理由：`web_session` 只要名字在就算登录，会把每一个匿名访客
 * 标成「已配置」，而那份 cookie 拿去解析必然失败，比没配更难排查。
 */
export function volatileMarkerChanged(
  cookies: readonly RawCookie[],
  names: readonly string[],
  baseline: ReadonlyMap<string, string>
): boolean {
  if (names.length === 0) return false;
  const current = new Map<string, string>();
  for (const c of cookies) {
    // 同名多条以第一条为准，且空值不算「有值」（游客会话在未写定时就是空串）
    if (c.value && !current.has(c.name)) current.set(c.name, c.value);
  }
  return names.some((n) => {
    const now = current.get(n);
    const before = baseline.get(n);
    return now !== undefined && before !== undefined && now !== before;
  });
}

/**
 * cookies → `Cookie` 头字符串。
 *
 * 三条例行：① 同名只留一条（不同路径/域会重复出现）；② markers 排最前，超长时先保命；
 * ③ 放不下的单条**整条跳过**，绝不截半条——半截 value 送上去比没有更坏（签名类 cookie
 * 半截会被平台当成「配置了但无效」，与过期同形）。
 */
export function buildCookieHeader(
  cookies: readonly RawCookie[],
  markers: readonly string[] = [],
  maxLen: number = MAX_COOKIE_HEADER
): string {
  const seen = new Set<string>();
  const uniq: RawCookie[] = [];
  for (const c of cookies) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    uniq.push(c);
  }
  const rank = (c: RawCookie): number => (markers.includes(c.name) ? 0 : 1);
  uniq.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const parts: string[] = [];
  let len = 0;
  for (const c of uniq) {
    const piece = `${c.name}=${c.value}`;
    const grow = parts.length > 0 ? piece.length + 2 : piece.length;
    if (len + grow > maxLen) continue;
    parts.push(piece);
    len += grow;
  }
  return parts.join("; ");
}

/**
 * 导航闸门：登录窗口只许留在目标平台域内。
 *
 * 登录完成后页面里常有「第三方授权 / 帮助中心」这类外链，点进去就把用户的登录态窗口
 * 带到了别的站点上；判据按 host 后缀而不是字符串包含——`https://evil.com/?x=xxx.com`
 * 这种形状必须被拒。
 */
export function isAllowedNavigation(rawUrl: string, domains: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return hostMatches(u.hostname, domains);
}

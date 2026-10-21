/**
 * 平台注册表：本项目「有哪些平台、提不提供、谁能解」的唯一真源。
 *
 * 为什么这张表在本仓而不是内核里（2026-10-16 业主定调）：
 * `@mediaget/parse-core` 只是解析引擎之一（后面还有 yt-dlp 直连与更多兜底引擎），
 * 引擎决定「能不能解」，注册表决定「供不供」。若以内核 PLATFORM_INFO 为真源，
 * 换引擎、关平台都得等上游发版，产品边界就不归我们管了。
 *
 * 三条纪律（都有测试守着，见 tests/platform-registry.test.ts）：
 * 1. 渲染层与主进程 import 同一个模块 —— 名字/图标只有一份，不再各写一张表；
 * 2. `domains` 与内核 PLATFORM_INFO 逐键对齐（现阶段识别仍走内核，这张表是将来接管的底稿），
 *    漂移 = 红叉，而不是静默两套识别；
 * 3. `engines` 的能力位只写**当前可验证**的事实，不写愿望。
 *
 * 零依赖：不 import zod / electron / react，两个进程都能直接吃。
 */

export type EngineId = "parseCore" | "ytdlp" | "amagi" | "mock";

/**
 * 引擎对某平台的覆盖状态：
 * - ready：本仓可直接路由到该引擎解这平台；
 * - declared：引擎自报能解，但注册表还没把它当独立通道（2026-10-21 yt-dlp 引擎接入后
 *   曾埋在 parse-core 里的那条 tiktok 通路已升 ready，此位暂无在用者，留给未来的间接通道）；
 * - unknown：未验证，注册表照收但默认不开。
 */
export type EngineCoverage = "ready" | "declared" | "unknown";

export interface PlatformDef {
  /** 契约键：写进历史/统计事件、跨 IPC 传输用的唯一标识 */
  key: string;
  /** 界面显示名（全站只用这一个，不再出现裸 key） */
  name: string;
  nameEn: string;
  /** renderer/public/logos 下的品牌 SVG 文件名 */
  iconFile: string;
  domains: string[];
  shortDomains: string[];
  /** 是否支持「平台 + ID」直接解析（内核 supportsIdParse 的同名镜像） */
  supportsIdParse: boolean;
  /** 历史/上游用过的别名 → 归一到 key（盘上旧数据认得出的唯一办法） */
  legacyKeys: string[];
  /**
   * 这个平台的 Cookie 存在 `settings.cookies` 的哪个键（2026-10-21 随 YouTube 接入引入）。
   *
   * 为什么放在注册表：键名不是任意推导出来的——`redbook` → `XHS_COOKIE`、
   * `instagram` → `IG_COOKIE`，按契约键大写拼只拼得对一半。引擎侧（yt-dlp）只需要
   * 「平台 → 值」，界面侧只需要「平台 → 输入框文案」，两边各自推导一次就会漂。
   * 没有这一项 = 这平台不支持配 Cookie。
   */
  cookieKey?: string;
  engines: Partial<Record<EngineId, EngineCoverage>>;
  /**
   * 选路顺序覆盖（2026-10-21 注册制铺垫）：缺省 = 引擎注册表的全局声明顺序。
   * 某平台该先用谁，是产品事实，归这张表；引擎怎么解，是能力事实，归引擎自己。
   * 只列在场引擎；没出现在表里的引擎按原相对顺序垫底。
   */
  enginePriority?: EngineId[];
  /**
   * 用户没选过主引擎时，这个平台先试谁（2026-10-21 随 YouTube 接入 yt-dlp 引入）。
   *
   * 为什么不能只靠 `enginePriority`：真正的排序由「用户主引擎」提到首位，而主引擎缺省
   * 一律是 mediaget（`DEFAULT_PRIMARY_ENGINE`）。所以一个平台的默认首选若与全局默认不同，
   * 只能在这里单独声明，否则 `enginePriority` 会被那个缺省值盖掉。
   *
   * 目前只有 YouTube：内核那条要 `YOUTUBE_API_KEY`（没有 key 就退到公共 Invidious/Piped
   * 实例），而 yt-dlp 无 key 即可解，先试它少一次「主引擎失败再回退」的等待与提示。
   */
  defaultPrimaryEngine?: SwitchableEngineId;
  /** 用户没动过开关时是否提供这平台：有 ready 引擎即默认开，只有 unknown 的默认关 */
  enabledByDefault: boolean;
}

/** 用户开关的持久化形状（缺省 = 跟随 enabledByDefault） */
export interface PlatformSwitch {
  enabled: boolean;
}

/** 引擎开关的持久化形状（缺省 = 开；关掉 = 选路与体检都不再包含它） */
export interface EngineSwitch {
  enabled: boolean;
}

interface Seed {
  key: string;
  name: string;
  nameEn: string;
  iconFile: string;
  domains: string[];
  shortDomains?: string[];
  supportsIdParse?: boolean;
  legacyKeys?: string[];
  /** Cookie 在 settings.cookies 里的键名（缺省 = 这平台不支持配 Cookie） */
  cookieKey?: string;
  /** 除 parseCore 外的引擎覆盖；parseCore 一律 ready（内核有 parser，由测试对账） */
  engines?: Partial<Record<EngineId, EngineCoverage>>;
  /** 选路顺序覆盖（缺省 = 引擎注册表全局顺序） */
  enginePriority?: EngineId[];
  /** 缺省主引擎覆盖（缺省 = DEFAULT_PRIMARY_ENGINE） */
  defaultPrimaryEngine?: SwitchableEngineId;
}

function platform(seed: Seed): PlatformDef {
  const engines: PlatformDef["engines"] = { parseCore: "ready", ...seed.engines };
  const hasReady = Object.values(engines).some((c) => c === "ready");
  return {
    key: seed.key,
    name: seed.name,
    nameEn: seed.nameEn,
    iconFile: seed.iconFile,
    domains: seed.domains,
    shortDomains: seed.shortDomains ?? [],
    supportsIdParse: seed.supportsIdParse ?? false,
    legacyKeys: seed.legacyKeys ?? [],
    cookieKey: seed.cookieKey,
    engines,
    enginePriority: seed.enginePriority,
    defaultPrimaryEngine: seed.defaultPrimaryEngine,
    enabledByDefault: hasReady,
  };
}

export const PLATFORMS: readonly PlatformDef[] = [
  platform({
    key: "douyin",
    name: "抖音",
    nameEn: "Douyin",
    iconFile: "douyin.svg",
    // snssdk.com（App 分享直链）、wtturl.cn（老版短链）：内核补齐过，两处行为才一致
    domains: ["douyin.com", "iesdouyin.com", "snssdk.com", "wtturl.cn"],
    shortDomains: ["v.douyin.com"],
    supportsIdParse: true,
    cookieKey: "DOUYIN_COOKIE",
    engines: { amagi: "ready" },
  }),
  platform({
    key: "kuaishou",
    name: "快手",
    nameEn: "Kuaishou",
    iconFile: "kuaishou.svg",
    domains: ["kuaishou.com", "kuaishoup.com"],
    shortDomains: ["v.kuaishou.com"],
    cookieKey: "KUAISHOU_COOKIE",
    engines: { amagi: "ready" },
  }),
  platform({
    key: "redbook",
    name: "小红书",
    nameEn: "Xiaohongshu",
    iconFile: "xiaohongshu.svg",
    domains: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
    shortDomains: ["xhslink.com", "xhslink.cn"],
    // 上游 web 的路由目录名；旧数据与本仓图标表都可能是它，不能当陌生键丢掉
    legacyKeys: ["xhs"],
    cookieKey: "XHS_COOKIE",
    engines: { amagi: "ready" },
  }),
  platform({
    key: "xigua",
    name: "西瓜视频",
    nameEn: "Xigua",
    iconFile: "xigua.svg",
    domains: ["ixigua.com"],
    shortDomains: ["v.ixigua.com"],
    supportsIdParse: true,
  }),
  platform({
    key: "zuiyou",
    name: "最右",
    nameEn: "Zuiyou",
    iconFile: "zuiyou.svg",
    domains: ["izuiyou.com", "xiaochuankeji.com", "xiaochuankeji.cn"],
    shortDomains: ["share.xiaochuankeji.cn"],
  }),
  platform({
    key: "bilibili",
    name: "哔哩哔哩",
    nameEn: "Bilibili",
    iconFile: "bilibili.svg",
    domains: ["bilibili.com", "b23.tv"],
    shortDomains: ["b23.tv"],
    cookieKey: "BILIBILI_COOKIE",
    engines: { amagi: "ready" },
  }),
  platform({
    key: "weibo",
    name: "微博",
    nameEn: "Weibo",
    iconFile: "sinaweibo.svg",
    domains: ["weibo.com", "weibo.cn", "m.weibo.com"],
    supportsIdParse: true,
  }),
  platform({
    key: "acfun",
    name: "AcFun",
    nameEn: "Acfun",
    iconFile: "acfun.svg",
    domains: ["acfun.cn"],
    supportsIdParse: true,
  }),
  platform({
    key: "twitter",
    name: "Twitter/X",
    nameEn: "Twitter",
    iconFile: "x.svg",
    domains: ["twitter.com", "x.com", "t.co"],
    shortDomains: ["t.co"],
    supportsIdParse: true,
  }),
  platform({
    key: "tiktok",
    name: "TikTok",
    nameEn: "Tiktok",
    iconFile: "tiktok.svg",
    domains: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    shortDomains: ["vm.tiktok.com", "vt.tiktok.com"],
    // 2026-10-21 yt-dlp 独立引擎（ytdlp-nodejs）接入：原生 dlp 通道由它接管，declared 升 ready
    engines: { ytdlp: "ready" },
  }),
  platform({
    key: "instagram",
    name: "Instagram",
    nameEn: "Instagram",
    iconFile: "instagram.svg",
    domains: ["instagram.com"],
    shortDomains: ["instagr.am"],
    cookieKey: "IG_COOKIE",
  }),
  platform({
    key: "youtube",
    name: "YouTube",
    nameEn: "Youtube",
    iconFile: "youtube.svg",
    domains: ["youtube.com", "youtube-nocookie.com"],
    shortDomains: ["youtu.be"],
    // 2026-10-21 yt-dlp 接管主解析：内核那条依赖 YOUTUBE_API_KEY（缺 key 退公共实例），
    // 随包 yt-dlp 无 key 即可解，所以默认先试它；内核对 youtube 仍 ready，作回退。
    // Cookie 走 yt-dlp 的 `cookies` 入参（`YtDlpOptions` 没有这一项，是 `InfoOptions`），
    // 这条登录态只对 yt-dlp 那一档有效——内核那条不读它。
    cookieKey: "YOUTUBE_COOKIE",
    engines: { ytdlp: "ready" },
    defaultPrimaryEngine: "ytdlp",
  }),
  // 内核 PLATFORM_INFO 没有这一条：engine.ts 用正则特判 music.douyin.com 产出该键（防 .douyin.com 后缀误判成抖音）。
  // parser 与图标都在，缺的只是登记 —— 不登记就显示成裸键、也进不了平台榜。
  platform({
    key: "qsmusic",
    name: "汽水音乐",
    nameEn: "Qishui Music",
    iconFile: "qsmusic.svg",
    domains: ["music.douyin.com", "qishui.douyin.com"],
  }),
];

const BY_ANY_KEY = new Map<string, PlatformDef>();
for (const p of PLATFORMS) {
  BY_ANY_KEY.set(p.key, p);
  for (const legacy of p.legacyKeys) BY_ANY_KEY.set(legacy, p);
}

/** 归一：契约键或历史别名 → PlatformDef；未登记返回 null（策略见 resolveKey 的调用方） */
export function platformDef(raw: string | null | undefined): PlatformDef | null {
  if (!raw) return null;
  return BY_ANY_KEY.get(raw.toLowerCase()) ?? null;
}

/** 归一到契约键；未登记原样回吐（盘上旧数据不能被注册表改写） */
export function resolveKey(raw: string): string {
  return platformDef(raw)?.key ?? raw;
}

/** 显示名：未登记键原样回吐，绝不解构出 undefined 让界面空一块 */
export function displayName(raw: string | null | undefined): string {
  if (!raw) return "";
  return platformDef(raw)?.name ?? raw;
}

export function iconFileOf(raw: string): string | null {
  return platformDef(raw)?.iconFile ?? null;
}

/** 该平台 Cookie 在 `settings.cookies` 里的键名；未登记或这平台不支持配 Cookie 返回 null */
export function cookieKeyOf(raw: string): string | null {
  return platformDef(raw)?.cookieKey ?? null;
}

export function isRegistered(raw: string): boolean {
  return platformDef(raw) !== null;
}

/** 由内核键集派生不重复；别名与契约键冲突 = 注册表写错，测试拦 */
export function canonicalKeys(): string[] {
  return PLATFORMS.map((p) => p.key);
}

/**
 * 生效开关：用户改过用用户的，没改过用平台默认。
 * 主进程解析路由与渲染层 UI 都调这一个函数，两边不可能判出不一致。
 */
export function isEnabled(key: string, switches: Record<string, PlatformSwitch>): boolean {
  const override = switches[key] ?? switches[resolveKey(key)];
  return override?.enabled ?? platformDef(key)?.enabledByDefault ?? false;
}

export const ENGINE_IDS: readonly EngineId[] = ["parseCore", "ytdlp", "amagi", "mock"];

export function engineCoverage(key: string, engine: EngineId): EngineCoverage | null {
  return platformDef(key)?.engines[engine] ?? null;
}

// ————————————————————————————————————————————————
// 引擎开关（2026-10-21）：引擎这一层的「供不供」，与平台开关同一套语义
// ————————————————————————————————————————————————

/**
 * 引擎元数据：界面上的引擎名与一行说明只有这一份。
 * `label` 同时是体检「通道」列显示的引擎名——引擎 runner 的 `label` 从这里取，
 * 两处各写一份就是漂移（tests/platform-registry.test.ts 的对账口径）。
 */
export interface EngineInfo {
  id: SwitchableEngineId;
  /** 面向用户的引擎名（如 mediaget / amagi / yt-dlp） */
  label: string;
  /** 设置页「引擎开关」那一行的说明 */
  desc: string;
  /** 选路角色：主引擎先试，回退引擎在主引擎失败后接力 */
  role: "primary" | "fallback";
}

/**
 * 可被用户开关的引擎（声明顺序 = 引擎注册表的全局登记顺序，界面对齐这个顺序）。
 * `mock` 不在其中：它是「没有引擎能解」时的演示兜底，不是一个可供给的通道。
 */
export const SWITCHABLE_ENGINE_IDS = ["parseCore", "amagi", "ytdlp"] as const;

export type SwitchableEngineId = (typeof SWITCHABLE_ENGINE_IDS)[number];

export const ENGINE_INFO: Record<SwitchableEngineId, EngineInfo> = {
  parseCore: {
    id: "parseCore",
    label: "mediaget",
    desc: "本地解析内核：主引擎，先由它解析",
    role: "primary",
  },
  amagi: {
    id: "amagi",
    label: "amagi",
    desc: "站点直连引擎：主引擎失败后接力，配 Cookie 更稳",
    role: "fallback",
  },
  ytdlp: {
    id: "ytdlp",
    label: "yt-dlp",
    desc: "yt-dlp 引擎：随包二进制，覆盖国际站点",
    role: "fallback",
  },
};

/**
 * 生效的引擎开关：缺省一律开（用户只在关掉时才落显式 false）。
 * 主进程选路/体检与渲染层 UI 都调这一个函数——只在界面隐藏引擎 = 假开关。
 */
export function isEngineEnabled(engine: string, switches: Record<string, EngineSwitch>): boolean {
  return switches[engine]?.enabled ?? true;
}

// ————————————————————————————————————————————————
// 平台主引擎（2026-10-21）：每个平台先试哪个引擎，用户可改
// ————————————————————————————————————————————————

/**
 * 没有用户覆盖、平台也没单独声明时的主引擎 = mediaget（parse-core）。
 * 「默认都是 mediaget」是产品口径：主引擎是本地内核，其它引擎按回退顺序垫后；
 * 例外只在注册表的 `defaultPrimaryEngine`（今天只有 YouTube，见那里的说明）。
 */
export const DEFAULT_PRIMARY_ENGINE: SwitchableEngineId = "parseCore";

/**
 * 某平台生效的主引擎：用户选过用用户的，否则平台默认（`defaultPrimaryEngine`），
 * 再否则 `DEFAULT_PRIMARY_ENGINE`。
 * 主进程选路与渲染层下拉都调它，两边不可能判出不一致。
 * 选的引擎今天不在场（被引擎开关关掉 / 无二进制）时由调用方退回默认顺序——
 * 这里只答「用户想要谁」，不替引擎回答「我今天能不能跑」。
 */
export function primaryEngineOf(
  platform: string,
  overrides: Record<string, SwitchableEngineId>
): SwitchableEngineId {
  const key = resolveKey(platform);
  return overrides[key] ?? platformDef(key)?.defaultPrimaryEngine ?? DEFAULT_PRIMARY_ENGINE;
}

/** 字符串 → 可切换引擎 id；认不出返回 null（盘上旧值/手改值不该把选路带偏） */
export function asSwitchableEngine(raw: string | null | undefined): SwitchableEngineId | null {
  if (!raw) return null;
  return (SWITCHABLE_ENGINE_IDS as readonly string[]).includes(raw)
    ? (raw as SwitchableEngineId)
    : null;
}

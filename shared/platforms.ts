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

export type EngineId = "parseCore" | "ytdlp" | "onlineApi" | "mock";

/**
 * 引擎对某平台的覆盖状态：
 * - ready：本仓可直接路由到该引擎解这平台；
 * - declared：引擎自报能解，但今天只能经另一个引擎间接生效（yt-dlp 埋在 parse-core 里只服务 tiktok）；
 * - unknown：未验证，注册表照收但默认不开。
 */
export type EngineCoverage = "ready" | "declared" | "unknown";

export interface PlatformDef {
  /** 契约键：写进 history.json / stats.json、跨 IPC 传输用的唯一标识 */
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
  engines: Partial<Record<EngineId, EngineCoverage>>;
  /** 用户没动过开关时是否提供这平台：有 ready 引擎即默认开，只有 unknown 的默认关 */
  enabledByDefault: boolean;
}

/** 用户开关的持久化形状（缺省 = 跟随 enabledByDefault） */
export interface PlatformSwitch {
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
  /** 除 parseCore 外的引擎覆盖；parseCore 一律 ready（内核有 parser，由测试对账） */
  engines?: Partial<Record<EngineId, EngineCoverage>>;
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
    engines,
    enabledByDefault: hasReady,
  };
}

/** 线上 API（get.hotier.cc.cd）覆盖 = 内核路由表白名单 = PLATFORM_INFO 的键集；汽水音乐不在其中 */
const ONLINE = { onlineApi: "ready" } as const;
const ONLINE_UNKNOWN = { onlineApi: "unknown" } as const;

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
    engines: ONLINE,
  }),
  platform({
    key: "kuaishou",
    name: "快手",
    nameEn: "Kuaishou",
    iconFile: "kuaishou.svg",
    domains: ["kuaishou.com", "kuaishoup.com"],
    shortDomains: ["v.kuaishou.com"],
    engines: ONLINE,
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
    engines: ONLINE,
  }),
  platform({
    key: "pipixia",
    name: "皮皮虾",
    nameEn: "Pipixia",
    iconFile: "pipixia.svg",
    domains: ["pipix.com"],
    supportsIdParse: true,
    legacyKeys: ["ppxia"],
    engines: ONLINE,
  }),
  platform({
    key: "xigua",
    name: "西瓜视频",
    nameEn: "Xigua",
    iconFile: "xigua.svg",
    domains: ["ixigua.com"],
    shortDomains: ["v.ixigua.com"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "zuiyou",
    name: "最右",
    nameEn: "Zuiyou",
    iconFile: "zuiyou.svg",
    domains: ["izuiyou.com", "xiaochuankeji.com", "xiaochuankeji.cn"],
    shortDomains: ["share.xiaochuankeji.cn"],
    engines: ONLINE,
  }),
  platform({
    key: "pipigx",
    name: "皮皮搞笑",
    nameEn: "Pipigaoxiao",
    iconFile: "pipigx.svg",
    domains: ["pipigx.com"],
    shortDomains: ["h5.pipigx.com"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "huya",
    name: "虎牙直播",
    nameEn: "Huya",
    iconFile: "huya.svg",
    domains: ["huya.com"],
    shortDomains: ["v.huya.com"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "bilibili",
    name: "哔哩哔哩",
    nameEn: "Bilibili",
    iconFile: "bilibili.svg",
    domains: ["bilibili.com", "b23.tv"],
    shortDomains: ["b23.tv"],
    engines: ONLINE,
  }),
  platform({
    key: "weibo",
    name: "微博",
    nameEn: "Weibo",
    iconFile: "sinaweibo.svg",
    domains: ["weibo.com", "weibo.cn", "m.weibo.com"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "quanminkge",
    name: "全民K歌",
    nameEn: "Quanminkge",
    iconFile: "quanminkge.svg",
    domains: ["kg.qq.com", "quanmin.kg.qq.com"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "sixroom",
    name: "六间房",
    nameEn: "Sixroom",
    iconFile: "sixroom.svg",
    domains: ["6.cn"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "xinpianchang",
    name: "新片场",
    nameEn: "Xinpianchang",
    iconFile: "xinpianchang.svg",
    domains: ["xinpianchang.com"],
    engines: ONLINE,
  }),
  platform({
    key: "haokan",
    name: "好看视频",
    nameEn: "Haokan",
    iconFile: "haokan.svg",
    domains: ["haokan.baidu.com", "haokan.hao123.com"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "acfun",
    name: "AcFun",
    nameEn: "Acfun",
    iconFile: "acfun.svg",
    domains: ["acfun.cn"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "twitter",
    name: "Twitter/X",
    nameEn: "Twitter",
    iconFile: "x.svg",
    domains: ["twitter.com", "x.com", "t.co"],
    shortDomains: ["t.co"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  platform({
    key: "tiktok",
    name: "TikTok",
    nameEn: "Tiktok",
    iconFile: "tiktok.svg",
    domains: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    shortDomains: ["vm.tiktok.com", "vt.tiktok.com"],
    engines: { ...ONLINE, ytdlp: "declared" },
  }),
  platform({
    key: "instagram",
    name: "Instagram",
    nameEn: "Instagram",
    iconFile: "instagram.svg",
    domains: ["instagram.com"],
    shortDomains: ["instagr.am"],
    engines: ONLINE,
  }),
  platform({
    key: "youtube",
    name: "YouTube",
    nameEn: "Youtube",
    iconFile: "youtube.svg",
    domains: ["youtube.com", "youtube-nocookie.com"],
    shortDomains: ["youtu.be"],
    engines: ONLINE,
  }),
  platform({
    key: "qqmusic",
    name: "QQ音乐",
    nameEn: "QQ Music",
    iconFile: "qqmusic.svg",
    domains: ["y.qq.com"],
    supportsIdParse: true,
    engines: ONLINE,
  }),
  // 内核 PLATFORM_INFO 没有这一条：engine.ts 用正则特判 music.douyin.com 产出该键（防 .douyin.com 后缀误判成抖音）。
  // parser 与图标都在，缺的只是登记 —— 不登记就显示成裸键、也进不了平台榜。
  platform({
    key: "qsmusic",
    name: "汽水音乐",
    nameEn: "Qishui Music",
    iconFile: "qsmusic.svg",
    domains: ["music.douyin.com", "qishui.douyin.com"],
    engines: ONLINE_UNKNOWN,
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

export const ENGINE_IDS: readonly EngineId[] = ["parseCore", "ytdlp", "onlineApi", "mock"];

export function engineCoverage(key: string, engine: EngineId): EngineCoverage | null {
  return platformDef(key)?.engines[engine] ?? null;
}

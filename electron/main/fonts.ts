/**
 * 本机已安装字体枚举（设置→外观→界面字体 的数据源）。
 *
 * 真源 = font-list：它在 win32 会 shell 出去跑 PowerShell/VBS 解析字体表，单次约 3–4s 且有子进程
 * 副作用，所以进程内做一次性缓存（成功缓存、失败不缓存以便下次重开选择器时重试）。
 * disableQuoting 让返回的是干净 family 名（无 " 包裹），可直接进 CSS font-family。
 */
import { getFonts } from "font-list";

let cache: Promise<string[]> | null = null;

/**
 * 中文中文字体族名单（小写匹配、按前缀判定）——业主指令 2026-10-15：字体族
 * 「中文字体靠前、英文字体靠后」的分类依据。
 * 为什么需要名单而不是看字形：Windows 上最常见的中文系统字体登记的是英文名
 * （实测本机注册表：DengXian=等线、另有 SimSun/Microsoft YaHei…），名字里没有
 * 一个中文字符；只看 name 是否含 CJK 会把主力中文字体错分到英文组。
 * 名单覆盖：中文系统字体（英文名 + 中文字面两路）/ 华文、汉仪等 foundry
 * 拼音或中文字面 / 东亚字体与思源系开源中文字体。未命中名单但含 CJK 字面的
 * 仍归中文组（见 isChineseFamily）。
 */
const CHINESE_FONT_PREFIXES = [
  // 中文系统字体（微软/汉仪等登记的英文名）
  "dengxian", "simsun", "simhei", "simkai", "simfang", "simyou", "simli",
  "nsim", "kaiti", "heiti", "fangsong", "yuanti", "xaobo", "liang", "hupo",
  "microsoft yahei", "microsoft jhengyu",
  "hanyi", "fangzheng", "fzht", "fzkai", "fzshu", "fzsong",
  // 东亚/繁体系统自带
  "ms jhenghao", "pmingliu", "mingliu", "dfkai", "dfsong",
  "yu gothic", "meiryo", "malgun", "batang", "gulim", "dotum",
  // 华文系（STSong/STKaiti/…）与思源系开源中文
  "stsong", "stkaiti", "stxihei", "stzhongs", "stliberation", "stmiddle",
  "source han", "sarasa",
  "noto sans cjk", "noto serif cjk", "noto sans sc", "noto sans tc",
  "noto sans hk", "noto sans jp", "noto sans kr",
] as const;

/** 是否 CJK 字面（中日韩统一表意文字 / 假名 / 兼容表意） */
function hasCjk(name: string): boolean {
  return /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ]/.test(name);
}

export function isChineseFamily(name: string): boolean {
  const n = name.trim().toLowerCase();
  return hasCjk(n) || CHINESE_FONT_PREFIXES.some((p) => n.startsWith(p));
}

function normalize(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = item.replace(/^"|"$/g, "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return orderFamilies(out);
}

/** 分组排序（导出给单测）：中文靠前、英文靠后，组内 locale 序 */
export function orderFamilies(names: string[]): string[] {
  const cmp = (a: string, b: string) =>
    a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  const cn = names.filter(isChineseFamily).sort(cmp);
  const en = names.filter((f) => !isChineseFamily(f)).sort(cmp);
  return [...cn, ...en];
}

export function listInstalledFonts(): Promise<string[]> {
  if (cache) return cache;
  cache = getFonts({ disableQuoting: true })
    .then((f) => normalize(f))
    .catch(() => {
      cache = null; // 失败不留坏缓存：下次调用重试探针
      return [] as string[];
    });
  return cache;
}

/** 仅 dev/测试用：清掉缓存，强制下次重新枚举 */
export function resetFontCache(): void {
  cache = null;
}

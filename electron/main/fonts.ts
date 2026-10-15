/**
 * 本机已安装字体枚举（设置→外观→界面字体 的数据源）。
 *
 * 真源 = font-list：它在 win32 会 shell 出去跑 PowerShell/VBS 解析字体表，单次约 3–4s 且有子进程
 * 副作用，所以进程内做一次性缓存（成功缓存、失败不缓存以便下次重开选择器时重试）。
 * disableQuoting 让返回的是干净 family 名（无 " 包裹），可直接进 CSS font-family。
 */
import { getFonts } from "font-list";

let cache: Promise<string[]> | null = null;

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
  return out.sort((a, b) =>
    a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  );
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

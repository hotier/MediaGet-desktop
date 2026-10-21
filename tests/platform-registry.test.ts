/**
 * 平台注册表纪律（shared/platforms.ts 的四把锁）。
 *
 * 为什么要测试而不是靠 review：这张表是「有哪些平台」的唯一真源，它的错不会编译失败，
 * 只会让用户在界面上看到裸键、看不到品牌图标、或某个平台永远下不动——
 * 2026-10-16 那批缺陷（小红书/皮皮虾无图标、qsmusic 显示成裸键）就是这么漏掉的。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_INFO, localParserKeys } from "@mediaget/parse-core";
import { describe, expect, it } from "vitest";
import {
  ENGINE_IDS,
  ENGINE_INFO,
  PLATFORMS,
  SWITCHABLE_ENGINE_IDS,
  asSwitchableEngine,
  canonicalKeys,
  cookieKeyOf,
  displayName,
  engineCoverage,
  iconFileOf,
  isEnabled,
  isRegistered,
  platformDef,
  primaryEngineOf,
  resolveKey,
} from "../shared/platforms";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOGO_DIR = join(ROOT, "renderer", "public", "logos");

describe("注册表结构", () => {
  it("契约键唯一", () => {
    const keys = canonicalKeys();
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("别名不与任何契约键或别的别名相撞（撞了归一就会指错平台）", () => {
    const keys = new Set(canonicalKeys());
    const seen = new Map<string, string>();
    for (const p of PLATFORMS) {
      for (const alias of p.legacyKeys) {
        expect(keys.has(alias), `别名 ${alias} 与契约键撞车`).toBe(false);
        expect(seen.has(alias), `别名 ${alias} 被 ${seen.get(alias)} 和 ${p.key} 同时声明`).toBe(false);
        seen.set(alias, p.key);
      }
    }
  });

  it("每个平台的图标文件真实存在于 renderer/public/logos", () => {
    for (const p of PLATFORMS) {
      expect(existsSync(join(LOGO_DIR, p.iconFile)), `${p.key} 的图标 ${p.iconFile} 不存在`).toBe(true);
    }
  });

  it("logo 目录没有孤儿文件（删平台要连图一起删，否则下次加回来会撞名）", () => {
    const declared = new Set(PLATFORMS.map((p) => p.iconFile));
    const orphans = readdirSync(LOGO_DIR).filter((f) => f.endsWith(".svg") && !declared.has(f));
    expect(orphans, `未登记的图标：${orphans.join(", ")}`).toEqual([]);
  });

  it("引擎位只用已登记的 EngineId", () => {
    for (const p of PLATFORMS) {
      for (const engine of Object.keys(p.engines)) {
        expect(ENGINE_IDS, `${p.key} 写了未知引擎 ${engine}`).toContain(engine as (typeof ENGINE_IDS)[number]);
      }
    }
  });

  it("主引擎解析：缺键 = mediaget，别名键先归一再查，认不出的值不左右选路", () => {
    expect(primaryEngineOf("douyin", {})).toBe("parseCore");
    expect(primaryEngineOf("xhs", { redbook: "amagi" })).toBe("amagi");
    // 未登记键不还原成别的平台
    expect(primaryEngineOf("weibo", { tiktok: "ytdlp" })).toBe("parseCore");
    expect(asSwitchableEngine("ytdlp")).toBe("ytdlp");
    expect(asSwitchableEngine("mock")).toBeNull();
    expect(asSwitchableEngine("nope")).toBeNull();
  });

  it("引擎开关元数据完整：可切换引擎都是已登记 id、各有 ENGINE_INFO，且不含 mock 兜底", () => {
    expect(SWITCHABLE_ENGINE_IDS).not.toContain("mock");
    for (const id of SWITCHABLE_ENGINE_IDS) {
      expect(ENGINE_IDS).toContain(id);
      const info = ENGINE_INFO[id];
      expect(info.id, `${id} 的 ENGINE_INFO.id 写错`).toBe(id);
      expect(info.label.length, `${id} 没有引擎名`).toBeGreaterThan(0);
      expect(info.desc.length, `${id} 没有一行说明`).toBeGreaterThan(0);
    }
    // 声明顺序 = 引擎注册表的全局登记顺序：体检按它对账「先试谁」
    expect(SWITCHABLE_ENGINE_IDS).toEqual(["parseCore", "amagi", "ytdlp"]);
  });

  it("enabledByDefault 与 ready 引擎一致：没有 ready 引擎就不该默认开", () => {
    for (const p of PLATFORMS) {
      const hasReady = Object.values(p.engines).some((c) => c === "ready");
      expect(p.enabledByDefault, `${p.key} 默认值与引擎覆盖不符`).toBe(hasReady);
    }
  });
});

describe("注册表 ↔ 内核引擎对账（漂移=当天红叉）", () => {
  const kernelKeys = Object.keys(PLATFORM_INFO);

  it("内核认识的键注册表都必须认识（否则界面上是裸键）", () => {
    for (const key of kernelKeys) {
      expect(isRegistered(key), `${key} 未登记`).toBe(true);
    }
  });

  it("逐键对齐 name / nameEn / domains / shortDomains / supportsIdParse", () => {
    for (const [key, info] of Object.entries(PLATFORM_INFO)) {
      const def = platformDef(key);
      expect(def, `${key} 未登记`).not.toBeNull();
      expect(def?.name, `${key} 显示名`).toBe(info.name);
      expect(def?.nameEn, `${key} 英文名`).toBe(info.nameEn);
      expect(def?.domains, `${key} domains`).toEqual(info.domains);
      expect(def?.shortDomains ?? [], `${key} shortDomains`).toEqual(info.shortDomains ?? []);
      expect(def?.supportsIdParse, `${key} supportsIdParse`).toBe(info.supportsIdParse === true);
    }
  });

  it("注册表比内核多出来的键必须有本地 parser（qsmusic 这类「内核漏登记」才允许收）", () => {
    const parsers = new Set(localParserKeys());
    for (const key of canonicalKeys()) {
      if (kernelKeys.includes(key)) continue;
      expect(parsers.has(key), `${key} 既不在内核 PLATFORM_INFO，也没有本地 parser`).toBe(true);
    }
  });

  it("parseCore=ready 的键都在内核 localParserKeys 里（不许声明解不了的引擎）", () => {
    const parsers = new Set(localParserKeys());
    for (const p of PLATFORMS) {
      if (p.engines.parseCore === "ready") expect(parsers.has(p.key), `${p.key} 号称本地可解`).toBe(true);
    }
  });

  it("内核有本地 parser 的平台，注册表都登记到了", () => {
    for (const key of localParserKeys()) {
      expect(isRegistered(key), `内核能解 ${key}，注册表却没登记`).toBe(true);
    }
  });
});

describe("键归一与显示", () => {
  it("历史别名归一到契约键", () => {
    expect(resolveKey("xhs")).toBe("redbook");
  });

  it("未登记键原样回吐：盘上旧数据不能被注册表改写", () => {
    expect(resolveKey("someFuturePlatform")).toBe("someFuturePlatform");
    expect(displayName("someFuturePlatform")).toBe("someFuturePlatform");
    expect(iconFileOf("someFuturePlatform")).toBeNull();
  });

  it("空值解构不出 undefined", () => {
    expect(resolveKey("")).toBe("");
    expect(displayName("")).toBe("");
    expect(displayName(null)).toBe("");
    expect(platformDef(undefined)).toBeNull();
  });

  it("引擎覆盖查询：登记的平台返回其声明，未登记返回 null", () => {
    // 2026-10-21 yt-dlp 独立引擎（ytdlp-nodejs）接入：tiktok 的原生 dlp 通路由它接管
    expect(engineCoverage("tiktok", "ytdlp")).toBe("ready");
    // 同日 YouTube 也接到 yt-dlp（内核那条要 API Key，随包二进制无 key 可解）
    expect(engineCoverage("youtube", "ytdlp")).toBe("ready");
    expect(engineCoverage("douyin", "ytdlp")).toBeNull();
    expect(engineCoverage("nope", "parseCore")).toBeNull();
  });

  it("平台 → Cookie 键：注册表是唯一真源（有两家的键拼不出来）", () => {
    expect(cookieKeyOf("youtube")).toBe("YOUTUBE_COOKIE");
    // 按契约键大写拼会拼成 REDBOOK_COOKIE / INSTAGRAM_COOKIE，这两条正是它必须进注册表的理由
    expect(cookieKeyOf("redbook")).toBe("XHS_COOKIE");
    expect(cookieKeyOf("instagram")).toBe("IG_COOKIE");
    // 别名先归一再查
    expect(cookieKeyOf("xhs")).toBe("XHS_COOKIE");
    // 没配 Cookie 的平台返回 null，调用方据此不传
    expect(cookieKeyOf("twitter")).toBeNull();
    expect(cookieKeyOf("nope")).toBeNull();
  });

  it("默认主引擎：YouTube 先试 yt-dlp，其余仍一律 mediaget", () => {
    expect(primaryEngineOf("youtube", {})).toBe("ytdlp");
    expect(primaryEngineOf("douyin", {})).toBe("parseCore");
    // 用户选过就听用户的，平台默认不再生效
    expect(primaryEngineOf("youtube", { youtube: "parseCore" })).toBe("parseCore");
  });
});

describe("开关语义（主进程路由与渲染层 UI 共用这一个函数）", () => {
  it("没改过 → 跟随 enabledByDefault；未登记的平台等于不提供", () => {
    expect(isEnabled("douyin", {})).toBe(true);
    // 汽水音乐有本地 parser（内核 parserRegistry 里有，PLATFORM_INFO 漏登记），所以默认开
    expect(isEnabled("qsmusic", {})).toBe(true);
    expect(isEnabled("nope", {})).toBe(false);
  });

  it("改过 → 用户说了算，默认开也能关、默认关也能开", () => {
    expect(isEnabled("douyin", { douyin: { enabled: false } })).toBe(false);
    expect(isEnabled("nope", { nope: { enabled: true } })).toBe(true);
  });

  it("别名查询与契约键同解（旧数据里可能存的是 xhs）", () => {
    const off = { redbook: { enabled: false } };
    expect(isEnabled("xhs", off)).toBe(false);
    expect(isEnabled("redbook", off)).toBe(false);
  });

  /**
   * 开关的界面纪律（2026-10-16 P3）：它是「落盘即生效」类，不是草稿字段。
   * 挂进 SCALAR_SECTION 会同时坏两样——脏计数虚报「N 项未保存」，「放弃」还把已经生效的开关撤回。
   */
  it("设置页只经 store 读写开关，不进草稿/脏计数", () => {
    const page = readFileSync(join(ROOT, "renderer", "src", "pages", "SettingsPage.tsx"), "utf8");
    const scalar = page.slice(page.indexOf("const SCALAR_SECTION"), page.indexOf("const SCALAR_FIELDS"));
    expect(scalar).not.toContain("platformSwitches");
    expect(scalar).not.toContain("engineSwitches");
    expect(scalar).not.toContain("platformEngines");
    expect(scalar).not.toContain("engineFallback");
    expect(page).toContain("usePlatformStore");
    expect(page).toContain("useEngineStore");
    // 预览用的假桥也必须过闸门，否则界面里关掉的平台/引擎在预览下照样能解（2026-10-16 实测踩过）
    const mock = readFileSync(join(ROOT, "renderer", "src", "dev", "mock-bridge.ts"), "utf8");
    expect(mock).toContain("isEnabled(");
    expect(mock).toContain("isEngineEnabled(");
  });
});

describe("单一真源纪律", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist-electron" || e === "dist-renderer" || e === ".qoder-credits") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.s?[jt]sx?$/.test(p)) out.push(p);
    }
    return out;
  }

  it("平台显示名只写在 shared/platforms.ts 一处", () => {
    const names = PLATFORMS.map((p) => p.name).filter((n) => /[一-龥]/.test(n));
    const scanned = [
      ...walk(join(ROOT, "electron")),
      ...walk(join(ROOT, "renderer", "src")),
      ...walk(join(ROOT, "types")),
      ...walk(join(ROOT, "core-adapter")),
    ];
    for (const file of scanned) {
      const src = readFileSync(file, "utf8");
      // 只认字符串字面量：注释里提一句「快手兜底」不是第二份真源，`"快手"` 才是
      const hit = names.filter((n) => src.includes(`"${n}"`) || src.includes(`'${n}'`));
      expect(hit, `${relative(ROOT, file)} 里又写了一份平台名：${hit.join(", ")}`).toEqual([]);
    }
  });

  it("renderer 不再自带平台表（图标/名称一律取自注册表）", () => {
    const rendererFiles = walk(join(ROOT, "renderer", "src"));
    for (const file of rendererFiles) {
      const src = readFileSync(file, "utf8");
      expect(src, `${relative(ROOT, file)} 直接吃内核 PLATFORM_INFO`).not.toMatch(/PLATFORM_INFO/);
      expect(src, `${relative(ROOT, file)} 手抄了图标名`).not.toMatch(/iconFile:\s*["'][^"']+\.svg["']/);
    }
  });
});

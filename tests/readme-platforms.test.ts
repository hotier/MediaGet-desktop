/**
 * README「平台支持」表 ↔ 代码真源的对账守卫。
 *
 * 为什么需要它：README 是唯一一份**手抄**平台清单的地方（其余全是 import 注册表），
 * 而手抄的第二真源必然过期——这份 README 此前就写着「43 个测试文件」（实际 40）、
 * 「CONTRACT_VERSION = 15」（实际 19）。平台表比那些数字更要紧：漏一家等于对外少承诺
 * 一个平台，Cookie 档位写错等于让用户配了个「不配也能用」的 Cookie，或者反过来
 * 让用户以为不用配。所以这里把三处真源钉死：
 *   - 平台清单 = `shared/platforms.ts` 的 `PLATFORMS`（名字即界面显示名）
 *   - Cookie 档位 = `renderer/src/pages/SettingsPage.tsx` 的 `COOKIE_ROWS`（note 首词定档）
 *   - 「应用内登录获取」列 = `shared/cookie-login.ts` 的 `COOKIE_LOGIN_KEYS`
 *
 * 「作品数据」「作者信息」两列没有可对账的真源——平台能力由内核各平台解析器逐一决定，
 * 本仓消费的是已打包的工件，读不出能力矩阵。所以这两列只钉一件事：**必须写实**
 * （不许留 — / TODO / 空），能力描述本身以 `@mediaget/parse-core` 的 README §4 为准。
 *
 * 为什么不把 COOKIE_ROWS 挪进 shared：它是**界面文案**（每行的 note 是给人看的一句话），
 * 挪出去只会让设置页与这段文案分居两处；测试按源码扫描取它，与 `toast-sonner` /
 * `table-row-height` 那几支守卫同一手法。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLATFORMS, displayName } from "../shared/platforms";
import { COOKIE_LOGIN_KEYS } from "../shared/cookie-login";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const README = readFileSync(`${ROOT}README.md`, "utf8");
const SETTINGS = readFileSync(`${ROOT}renderer/src/pages/SettingsPage.tsx`, "utf8");

const NO_NEED = "不需要";

interface CookieRow {
  key: string;
  platform: string;
  note: string;
}

/** 从设置页源码里取 COOKIE_ROWS（键名 / 平台键 / 文案），不做语义解析 */
function readCookieRows(): CookieRow[] {
  const block = SETTINGS.match(/const COOKIE_ROWS[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("SettingsPage.tsx 里找不到 COOKIE_ROWS：表结构变了，请同步本守卫");
  return [...block[1].matchAll(/key:\s*"([A-Z0-9_]+)"\s*,\s*platform:\s*"([\w-]+)"\s*,\s*note:\s*"([^"]*)"/g)].map(
    (m) => ({ key: m[1], platform: m[2], note: m[3] })
  );
}

const COOKIE_ROWS = readCookieRows();

/** note 的第一个词就是档位：`强烈建议…` / `可选…`。两档之外出现新文案 = 本守卫要重新表态 */
function cookieLevel(note: string): "强烈建议" | "可选" | null {
  if (note.startsWith("强烈建议")) return "强烈建议";
  if (note.startsWith("可选")) return "可选";
  return null;
}

/** 期望的「用哪一档 Cookie」：不在 COOKIE_ROWS 里 = 不需要 */
function expectedLevel(platformName: string): string {
  const key = PLATFORMS.find((p) => p.name === platformName)?.key;
  const row = COOKIE_ROWS.find((r) => r.platform === key);
  if (!row) return NO_NEED;
  const level = cookieLevel(row.note);
  if (!level) throw new Error(`${row.key} 的 note 没有档位前缀（强烈建议 / 可选）：${row.note}`);
  return level;
}

/**
 * 取 README「## 平台支持」一节的表格数据行。
 * 列按**表头名**定位，不按下标——那张表是给人看的，调整列顺序（比如把「作品数据」插到 Cookie 前面）
 * 不该让守卫报错，但列名被改掉必须报错（否则守卫会静默读空字符串而永远绿）。
 */
function readmeTable(): Array<{ name: string; works: string; author: string; cookie: string }> {
  const section = README.split(/^## /m).find((part) => part.startsWith("平台支持"));
  if (!section) throw new Error("README 缺少「## 平台支持」一节");
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows.find((cells) => cells[0] === "平台");
  if (!header) throw new Error("README 平台支持表找不到表头行");
  const at = (title: string) => {
    const index = header.indexOf(title);
    if (index < 0) throw new Error(`README 平台支持表缺列「${title}」，本守卫需要按列名定位`);
    return index;
  };
  const [WORKS, AUTHOR, COOKIE] = [at("作品数据"), at("作者信息"), at("Cookie")];
  return rows
    .filter((cells) => !/^-+$/.test(cells[0]) && cells[0] !== "平台")
    .map((cells) => ({
      name: cells[0],
      works: cells[WORKS],
      author: cells[AUTHOR],
      cookie: cells[COOKIE].replaceAll("**", ""),
    }));
}

const TABLE = readmeTable();

describe("README 平台支持表：与注册表/Cookie 规则对账", () => {
  it("表格里的平台集合与注册表逐个对齐（不重不漏、名字用显示名）", () => {
    expect(TABLE.map((r) => r.name).sort()).toEqual(PLATFORMS.map((p) => p.name).sort());
  });

  it("平台名必须是注册表的显示名，不能是裸键或别名", () => {
    for (const row of TABLE) {
      expect(row.name, `README 里出现了非显示名「${row.name}」`).toBe(displayName(row.name));
    }
  });

  it("Cookie 档位与 COOKIE_ROWS 一致（不在表里 = 不需要）", () => {
    for (const row of TABLE) {
      expect(row.cookie, `${row.name} 的 Cookie 档位与 COOKIE_ROWS 不符`).toBe(expectedLevel(row.name));
    }
  });

  it("「登录获取」那句点名的平台 = COOKIE_LOGIN_KEYS（多一家少一家都红）", () => {
    // 表里不再有「应用内登录获取」列，这件事只剩正文一句话在说，于是它成了新的手抄点：
    // 新增一家可自动登录的平台却忘了改这句，用户就会以为只能手动粘贴
    const sentence = README.split("\n").find((line) => line.includes("登录获取"));
    if (!sentence) throw new Error("README 里找不到提到「登录获取」的那一行");
    const mentioned = PLATFORMS.map((p) => p.name).filter((name) => sentence.includes(name));
    const expected = COOKIE_ROWS.filter((row) => (COOKIE_LOGIN_KEYS as readonly string[]).includes(row.key))
      .map((row) => displayName(row.platform))
      .filter((name): name is string => Boolean(name));
    expect(mentioned.sort()).toEqual(expected.sort());
  });

  it("COOKIE_ROWS 里的平台键都登记在注册表里（防拼错 key）", () => {
    for (const row of COOKIE_ROWS) {
      expect(displayName(row.platform), `COOKIE_ROWS 的平台键「${row.platform}」未登记`).not.toBe(row.platform);
    }
  });

  it("「作品数据」「作者信息」两列必须逐行写实（不接受空、破折号或稍后补）", () => {
    // 这两列没有代码真源可对账（平台能力由内核解析器逐一决定），所以只钉「必须写过」：
    // 加平台时这两列最容易留下 — 或 TODO，而它们恰恰是用户唯一想知道的东西
    for (const row of TABLE) {
      for (const [title, cell] of [
        ["作品数据", row.works],
        ["作者信息", row.author],
      ] as const) {
        expect(cell.replaceAll("**", "").trim(), `${row.name} 的「${title}」列是空的`).not.toMatch(/^(—|-|\?|todo|待补)$/i);
      }
    }
  });

  it("正文里出现的「N 个平台」都等于注册表长度", () => {
    const nums = [...README.matchAll(/(\d+)\s*个平台/g)].map((m) => Number(m[1]));
    expect(nums.length).toBeGreaterThan(0);
    expect([...new Set(nums)]).toEqual([PLATFORMS.length]);
  });
});

/**
 * 表格行高纪律（业主指令 2026-10-17「历史页上方表格的标题行高度太高，应该和内容行高度一致」）。
 *
 * 三条各自管一半：
 *  1. `th` 与 `td` 共用同一套纵向内边距。原先 th 是 `h-9`（rem 定值，不随「界面字号」伸缩）、
 *     td 是 `py-2` + 1.5 倍行高（随字号伸缩），两批行只在默认 13px 档偶然等高（36 vs 35.5），
 *     字号一调就重新错开 —— 所以钉的是「同一套公式」，不是「都等于某个像素值」。
 *  2. 工具栏与表格之间不垫 Card 的默认 `gap-4`。实测业主窗口截图：表头那条带 52px、内容行 35px，
 *     其中 16px 是 `Card` 的 flex 间隙落在工具栏底线与表头之间 —— 表头本身没变高，但它看上去高。
 *
 * 手法同 tests/empty-state.test.ts：这两条要钉的是源码结构，渲染冒烟给的信息量不比断言多。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const TABLE = src("renderer/src/components/ui/table.tsx");

/** 取 `function Name(` 那段的 className 字符串（cn 的第一个实参） */
function classOf(name: string): string {
  const at = TABLE.indexOf(`function ${name}(`);
  expect(at, `找不到组件 ${name}`).toBeGreaterThan(-1);
  const m = /cn\(\s*"([^"]+)"/.exec(TABLE.slice(at));
  if (!m) throw new Error(`${name} 的 className 不是 cn("字面量", …) 形状`);
  return m[1];
}

const HEAD = classOf("TableHead");
const CELL = classOf("TableCell");

describe("表头与内容行同高", () => {
  it("th 与 td 用同一套纵向内边距", () => {
    for (const box of [HEAD, CELL]) {
      expect(box).toMatch(/\bpy-2\b/);
      expect(box).toMatch(/\bpx-3\b/);
    }
  });

  it("th 不再拿定高顶开（h-9 不随界面字号伸缩）", () => {
    expect(HEAD).not.toMatch(/\bh-\S/);
    expect(CELL).not.toMatch(/\bh-\S/);
  });

  it("页面侧不给表头单独特化高度", () => {
    for (const page of [
      "renderer/src/pages/HistoryPage.tsx",
      "renderer/src/pages/DownloadsPage.tsx",
      "renderer/src/pages/SettingsPage.tsx",
    ]) {
      expect(src(page), `${page} 给 TableHead 传了 h-*`).not.toMatch(/<TableHead[^>]*className="[^"]*\bh-\S/);
    }
  });
});

describe("工具栏与表格之间不垫间隙", () => {
  /** 两张「工具栏 + 表格」的卡都要显式关掉 Card 自带的 gap-4 */
  for (const page of ["DownloadsPage", "HistoryPage"]) {
    it(`${page} 的列表卡 gap-0`, () => {
      const s = src(`renderer/src/pages/${page}.tsx`);
      const cards = [...s.matchAll(/<Card className="([^"]*)"/g)].map((m) => m[1]);
      expect(cards.length, `${page} 找不到带 className 的 Card`).toBeGreaterThan(0);
      expect(cards.some((c) => /\bgap-0\b/.test(c) && /\bpy-0\b/.test(c)), `${page} 的列表卡没写 gap-0`).toBe(true);
    });
  }

  it("队列页 CardContent 不给表头留顶部内边距", () => {
    const s = src("renderer/src/pages/DownloadsPage.tsx");
    expect(s).toMatch(/<CardContent className="pb-1"/);
    expect(s).not.toMatch(/<CardContent className="py-1"/);
  });
});

/**
 * 浮层「文件」行同一条纪律的另一半（业主指令 2026-10-17 两条）：那枚 28px 的图标按钮把这一行
 * 顶到 45px 而其余字段是 36.5px —— 撤掉图标、把动作挂到路径本身之后，行内不再有比正文行更高的东西。
 * 折叠（只显示第一个、其余「其余 N 个 ▾」）钉在这里的同一条：它防的是「N 个文件把卡片顶成一片滚动区」。
 */
describe("浮层「文件」行不吃图标按钮、默认只摊开一个", () => {
  const HISTORY = src("renderer/src/pages/HistoryPage.tsx");

  it("动作挂在路径上，行内不再出现图标按钮那套", () => {
    expect(HISTORY).toMatch(/showInFolder\(dirOf\(f\)\)/);
    expect(HISTORY).not.toMatch(/aria-label="打开位置"/);
    expect(HISTORY).not.toMatch(/size="icon-sm"/);
  });

  it("默认只列第一个文件，其余走折叠", () => {
    expect(HISTORY).toMatch(/filesOpen \? row\.files : row\.files\.slice\(0, 1\)/);
    expect(HISTORY).toMatch(/其余 \$\{row\.files\.length - 1\} 个/);
  });
});

/**
 * 「队列页右键『查看作品信息』→ 历史页定位那一行」这条链的回归守卫（业主 2026-10-23）。
 *
 * 要钉的是**事故形状**，不是样式：这条链路此前每一段代码都在，却永远定位不到——
 * 队列页传的是自己的 `groupId`（主进程入队时兜底生成的 `g-<base36 时间戳>`），
 * 而历史行的键是 `workKeyOf(sourceUrl)` 算出的 `w-<16 hex>`。两套命名空间，
 * `[data-group="g-…"]` 必然落空，类型系统一句都不会报。所以这里只断言「键的出处」，
 * 把「换回 groupId」这条路堵死。
 *
 * 同批还有两条业主点名的行为：定位后**自动展开**作品信息卡片、以及**短暂闪烁**
 * （keyframes 在 styles.css，这里只认类名与 token 挂上了没有）。
 * 手法与 `tests/history-detail.test.ts` 一致：源码结构断言，不开 jsdom（本仓不留 DOM 冒烟依赖）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 本机签出来是 CRLF，判据针对结构不针对行尾，读入时先归一（同 history-detail.test.ts） */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const DOWNLOADS = read("../renderer/src/pages/DownloadsPage.tsx");
const HISTORY = read("../renderer/src/pages/HistoryPage.tsx");
const APP = read("../renderer/src/App.tsx");
const CSS = read("../renderer/src/styles.css");

/** 历史页那段定位 effect：从「还没处理过这次意图」那条早退起到 effect 的依赖数组 */
const FOCUS_EFFECT = (() => {
  const at = HISTORY.indexOf("if (handledFocus.current === focus.seq) return;");
  expect(at, "找不到历史页的定位 effect（handledFocus 守卫）").toBeGreaterThan(-1);
  const end = HISTORY.indexOf("}, [focus, rows,", at);
  expect(end, "定位 effect 的依赖数组形状变了，守卫要跟着改").toBeGreaterThan(at);
  return HISTORY.slice(at, end);
})();

describe("队列 → 历史定位（键必须来自作品键）", () => {
  it("队列页用 workKeyOf(sourceUrl) 算定位键", () => {
    expect(DOWNLOADS).toMatch(/const key = workKeyOf\(t\.sourceUrl\);/);
  });

  it("不许退回队列自己的 groupId（那是 g-<时间戳>，与历史行的 w-<hash> 不同源）", () => {
    expect(DOWNLOADS).not.toMatch(/onNav\("history",\s*t\.groupId\)/);
    // 没有可定位的链接时明说一句，别跳过去停在列表顶部装成「点了」
    expect(DOWNLOADS).toContain("这条记录没有可定位的原始链接");
  });

  it("App 传下去的定位意图带 seq（连点同一作品也要重放一次）", () => {
    expect(APP).toMatch(/setHistoryFocus\(\{ key: workKey, seq: historyFocusSeq\.current \}\)/);
    // 手动切页清掉一次性意图：否则下次从侧栏进历史页会重放旧的滚动与闪烁
    expect(APP).toMatch(/const goPage = useCallback\([\s\S]{0,160}setHistoryFocus\(null\)/);
  });
});

describe("定位到达后的三件事", () => {
  it("自动展开作品信息卡片（直接置位，不走 toggle）", () => {
    expect(FOCUS_EFFECT).toContain("setDetailRow(row);");
    expect(FOCUS_EFFECT).toContain("setDetailShown(true);");
    expect(FOCUS_EFFECT).not.toContain("openDetail(");
  });

  it("短暂高亮闪烁：行上挂 animate-row-flash，keyframes 用层 2 的主色派生", () => {
    expect(FOCUS_EFFECT).toContain("setFlashKey(row.key);");
    expect(HISTORY).toContain("animate-row-flash");
    expect(CSS).toContain("--animate-row-flash:");
    expect(CSS).toMatch(/@keyframes row-flash[\s\S]{0,200}color-mix\(in oklab, var\(--color-primary\)/);
  });

  it("高亮只有底色、没有边框（业主 2026-10-23「高亮显示是没有边框的」）", () => {
    // 闪烁那一档的 class 串里不许再挂 outline —— 选中态早在 10-17 就撤了描边，两种状态同一口径
    const flashClass = /flashKey === r\.key && "([^"]*)"/.exec(HISTORY);
    expect(flashClass, "找不到闪烁那一档的 class 串").not.toBeNull();
    expect(flashClass![1]).not.toContain("outline");
  });

  it("闪烁时长两处同源：场景里的 FLASH_MS 与 CSS 的动画时长都必须是 2.4s", () => {
    // 一个是熄灭定时器、一个是动画本身；只改一处会截断动画或留下已结束的动画声明
    expect(HISTORY).toContain("const FLASH_MS = 2400;");
    expect(FOCUS_EFFECT).toContain("FLASH_MS");
    expect(CSS).toContain("--animate-row-flash: row-flash 800ms ease-in-out 3;");
  });

  it("目标不在当前页时先清筛选、再拉一页，都落空才提示（不留「点了没反应」）", () => {
    expect(FOCUS_EFFECT).toContain("clearFilters();");
    expect(FOCUS_EFFECT).toContain("loadMore();");
    expect(FOCUS_EFFECT).toContain("历史记录里没有这个作品");
  });
});

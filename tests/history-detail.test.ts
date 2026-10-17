/**
 * 历史页两处浮层的纪律守卫（业主指令 2026-10-17，四条 + 同批补的两枚对话框几何根因）。
 *
 * 手法取源码结构断言而不是渲染冒烟（同 tests/empty-state.test.ts、tests/toast-sonner.test.ts）：
 * 这两处要钉的都是「某个元素不许再长回来」与「每一处 truncate 必须挂在 TruncatedTooltip 里」，
 * 而它们只有在作者带 url / 带简介的具体 fixture 下才可见，渲染冒烟给出的信息量不比断言多。
 * tooltip 弹出本身依赖真鼠标事件与 Radix 的延时计时，本机预览页在后台标签里被节流
 * （`document.hidden` 为真），所以在这里钉结构，弹出观感交回真窗口。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  fileURLToPath(new URL("../renderer/src/pages/HistoryPage.tsx", import.meta.url)),
  "utf8"
);

/**
 * 取 `function Name(` 起到函数收尾那枚顶格 `}` 为止。
 * 只认 `\n}\n`：解构参数那行 `}: {` 的 `}` 也顶格，认 `\n}` 会在第一个属性后就截断。
 */
function fn(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  expect(at, `找不到组件 ${name}`).toBeGreaterThan(-1);
  const end = SRC.indexOf("\n}\n", at);
  expect(end, `${name} 之后收不到函数结尾`).toBeGreaterThan(at);
  return SRC.slice(at, end);
}

const AUTHOR_CARD = fn("AuthorCard");
const WORK_DETAIL = fn("WorkDetail");

/** 作者卡片那层 Dialog：从 Root 的 open 态到标题行结束（DialogContent 的属性都在这一段里） */
const AUTHOR_DIALOG = (() => {
  const at = SRC.indexOf("open={authorShown}");
  expect(at, "找不到作者卡片那层 Dialog").toBeGreaterThan(-1);
  const end = SRC.indexOf("作者卡片</DialogTitle>", at);
  expect(end).toBeGreaterThan(at);
  return SRC.slice(at, end);
})();

describe("作者卡片（业主指令 2026-10-17 四项精简）", () => {
  it("「解析那一刻抓到的作者信息，之后不会自动更新」这句说明已删，且不在卡片里回潮", () => {
    expect(SRC).not.toContain("解析那一刻抓到的作者信息");
    expect(AUTHOR_CARD).not.toContain("不会自动更新");
    // 快照语义仍在文件头注释与文档里（机制口径归文档，界面不常驻说明书）
    expect(SRC).toContain("解析那一刻的快照");
  });

  it("底部不再重复作品标题（信息浮层里已经有「标题」那一行）", () => {
    expect(AUTHOR_CARD).not.toContain("作品：");
    expect(AUTHOR_CARD).not.toContain("row.title");
  });

  it("「在浏览器中打开主页」按钮已撤，作者名本身就是那条外链", () => {
    expect(AUTHOR_CARD).not.toContain("在浏览器中打开主页");
    expect(AUTHOR_CARD).toMatch(/<a\b[^>]*href=\{a\.url\}[^>]*target="_blank"[^>]*rel="noreferrer"/);
    // 没有主页的作者退回纯文本，不渲染一个点了没反应的假链接
    expect(AUTHOR_CARD).toContain('<span className="block truncate font-semibold text-sm">');
  });

  it("删掉 DialogDescription 后显式声明 aria-describedby={undefined}（否则 Radix 控制台告警）", () => {
    expect(AUTHOR_DIALOG).not.toContain("<DialogDescription>");
    expect(AUTHOR_DIALOG).toContain("aria-describedby={undefined}");
  });

  it("每一处 truncate 都挂在 TruncatedTooltip 里（全仓基准：截断必有 tooltip）", () => {
    const truncated = AUTHOR_CARD.match(/className="[^"]*\btruncate\b[^"]*"/g) ?? [];
    const tips = AUTHOR_CARD.match(/<TruncatedTooltip/g) ?? [];
    expect(truncated.length, `truncate ${truncated.length} 处 / tooltip ${tips.length} 处，对不上`).toBe(
      tips.length
    );
    expect(truncated.length).toBeGreaterThanOrEqual(4);
  });
});

describe("作品信息浮层（业主指令 2026-10-17：标题同行单行 + 截断预览）", () => {
  it("标题值单行截断，全文交给 tooltip", () => {
    expect(WORK_DETAIL).toMatch(/label="标题"[\s\S]{0,200}<TruncatedTooltip[\s\S]{0,160}block min-w-0 truncate/);
  });

  it("不许把标题原文直接塞进 Field（长标题会换成两三行，把下面的字段推下去）", () => {
    // 形如 <Field label="标题">{row.title}</Field>（值没经过截断元素）就是回归
    expect(WORK_DETAIL).not.toMatch(/label="标题"[\s\S]{0,80}>\s*\{row\.title\}\s*</);
  });
});

describe("对话框组件层的几何纪律（业主指令 2026-10-17 两条，同一枚 DialogContent）", () => {
  /**
   * 两条都钉在共享件而不是用法处，因为它们是「少了就整层失效」的那种前提：
   * ① 截断要成立先得有可截断的盒——`grid` 不写 `grid-cols` 时隐式列是 `auto`，下限 = 内容的 max-content，
   *    卡里任何一行 `truncate`（nowrap）都把整列撑到全文宽（临时灌 60 字简介实测：列 896 / 框 365，省略号根本不出现）。
   * ② 居中参照系是功能区而不是视口（`left` 加半个侧栏宽），**宽度必须跟着换算**——`w-full` 的 100% 仍是视口宽，
   *    只挪 `left` 会让 `max-w-3xl` 在 820（窗口 minWidth）算出左缘 130（压侧栏）、右缘 898（出屏）。
   */
  const DIALOG = readFileSync(
    fileURLToPath(new URL("../renderer/src/components/ui/dialog.tsx", import.meta.url)),
    "utf8"
  );
  const at = DIALOG.indexOf("function DialogContent(");
  expect(at).toBeGreaterThan(-1);
  // 切到下一个函数为止（不按 `\n}` 找结尾：ui/ 那批 vendored 件在工作区是 CRLF，按换行符匹配会落空）
  const BODY = DIALOG.slice(at, DIALOG.indexOf("function DialogHeader", at));
  const CLASS = /"([^"]*fixed top-1\/2[^"]*)"/.exec(BODY);
  if (!CLASS) throw new Error("DialogContent 的定位串形状变了，守卫要跟着改");

  it("单列写成 minmax(0,1fr)，不给 auto 列留 max-content 下限", () => {
    expect(CLASS[1]).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("left 按功能区中心算，宽度同步让开侧栏（w-full / left-1/2 都不许回潮）", () => {
    expect(CLASS[1]).toContain("left-[calc(50%_+_var(--w-side)/2)]");
    expect(CLASS[1]).toContain("w-[calc(100%_-_var(--w-side)_-_2rem)]");
    expect(CLASS[1]).not.toMatch(/\b(w-full|left-1\/2)\b/);
  });
});

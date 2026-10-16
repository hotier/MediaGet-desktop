/**
 * 浮空 toast（sonner）迁移守卫（业主指令 2026-10-15：用 shadcn 的 sonner，原先用 toast 的组件全部改用）。
 *
 * 为什么是源码结构断言而不是渲染冒烟：sonner 在 render 期深用浏览器 API
 * （getComputedStyle 等），node 环境要把它桩到失真——补到能跑的那堆桩已经不比被测逻辑简单，
 * 冒烟价值低于噪声。主题订阅这条真逻辑在 tests/theme.test.ts 里有单测，这里只钉「迁移事实」：
 * 三处旧自绘不许回潮 + 样式注入的唯一来源。手法与 tests/style-discipline.test.ts 一致。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** 注释里可以写「不用 next-themes 而用 subscribeTheme」这类对比说明，断言只看代码本体 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 原先各自自绘 toast（useState + setTimeout + 内容流里的 <Alert>）的三处消费方 */
const CONSUMERS = [
  "renderer/src/pages/HomePage.tsx",
  "renderer/src/pages/HistoryPage.tsx",
  "renderer/src/components/Update.tsx",
];

describe("toast 已统一到 sonner", () => {
  it.each(CONSUMERS)("%s 从 sonner 取 toast", (rel) => {
    expect(src(rel)).toMatch(/from\s+"sonner"/);
  });

  it.each(CONSUMERS)("%s 不留自绘 toast 的 setToast 残留", (rel) => {
    expect(src(rel), `${rel} 还有 setToast 残留`).not.toMatch(/setToast/);
  });

  it("App 挂载 <Toaster />：不挂上则所有 toast() 调用静默无声", () => {
    const app = src("renderer/src/App.tsx");
    expect(app).toMatch(/from\s+"\.\/components\/ui\/sonner"/);
    expect(app).toMatch(/<Toaster\s*\/>/);
  });
});

describe("Toaster 基座的接线", () => {
  const toaster = src("renderer/src/components/ui/sonner.tsx");

  it("明暗走本仓订阅出口（theme.ts），不引 next-themes", () => {
    const code = stripComments(toaster);
    expect(code).toMatch(/from\s+"~\/lib\/theme"/);
    expect(code).toMatch("getResolvedTheme");
    expect(code).toMatch("subscribeTheme");
    expect(code).not.toMatch(/next-themes/);
  });

  it("取色接层 2 Token：--normal-* 指到本仓语义色，不吃 sonner 的 gray 阶梯", () => {
    expect(toaster).toMatch(/"--normal-bg":\s*"var\(--surface\)"/);
    expect(toaster).toMatch(/"--normal-text":\s*"var\(--text\)"/);
    expect(toaster).toMatch(/"--normal-border":\s*"var\(--line\)"/);
  });

  it("位置 top-right：底部是作品信息 Sheet 的地盘，提示不叠上去", () => {
    expect(toaster).toMatch(/position="top-right"/);
  });
});

describe("浮空样式的唯一来源（回归守卫）", () => {
  it("styles.css 不 @import sonner 样式 —— sonner 的 JS 在 import 时已自注入同一份", () => {
    // 踩过一次：显式 @import 让产物 CSS 多背 14 kB 完全重复的样式。
    // CSP style-src 带 'unsafe-inline'，运行时注入合法可行。
    expect(src("renderer/src/styles.css")).not.toMatch(/@import\s+["']sonner/);
  });
});

describe("宽度按内容动态走（业主指令 2026-10-15）", () => {
  const toaster = src("renderer/src/components/ui/sonner.tsx");

  it("单条 toast 宽度改 fit-content，容器 --width 不动", () => {
    // sonner 把 `width: var(--width)` 写死在 [data-sonner-toast] 上；
    // toastOptions.style 落的是单条 <li> 的内联样式，覆盖它才不会连累容器。
    expect(toaster).toMatch(/toastOptions=\{\{/);
    expect(toaster).toMatch(/width:\s*"fit-content"/);
    // 容器变量仍是设计口径 320 —— 直接改它会压塌 toaster（子元素全是 absolute）
    expect(toaster).toMatch(/"--width":\s*"20rem"/);
  });

  it("长短两端都有界：max-width 封顶 + min-width 兜底", () => {
    // 只写 fit-content 的话，长文案不换行会顶破 320，极短文案会缩成一小坨
    expect(toaster).toMatch(/maxWidth:\s*"var\(--width\)"/);
    expect(toaster).toMatch(/minWidth:\s*"10rem"/);
  });

  it("字号跟界面字号走：键名必须是驼峰 fontSize，不能写 font-size", () => {
    // 踩过一次：写成 `"font-size"` 会被 React 当未知属性丢弃（控制台 "Unsupported style
    // property font-size"），设置页把 --fs-content 从 13px 调到 17px，toast 始终 13px。
    // 且这条只能落内联 —— sonner 自带 `font-size: 13px` 写死在元素选择器上。
    expect(toaster).toMatch(/fontSize:\s*"var\(--fs-content\)"/);
    expect(toaster).not.toMatch(/"font-size"\s*:/);
  });
});

describe("每条 toast 都是「图标 + 提示」（业主指令 2026-10-15）", () => {
  it("四档图标都接了 lucide 且取层 2 语义色", () => {
    const code = stripComments(src("renderer/src/components/ui/sonner.tsx"));
    for (const [tone, cls] of [
      ["success", "text-ok"],
      ["info", "text-info"],
      ["warning", "text-warn"],
      ["error", "text-err"],
    ] as const) {
      expect(code, `icons.${tone} 缺失或没接语义色`).toMatch(
        new RegExp(`${tone}:\\s*<\\w+ className="[^"]*${cls}`),
      );
    }
  });

  it("消费方不出现不带档位的裸 toast() —— 裸调用不落 type，sonner 就不给图标", () => {
    // sonner 渲染 data-icon 的条件是「有 toastType」；toast() 的 type 是 undefined，
    // 于是四档里唯独它没有图标。按「一律图标 + 提示」的口径禁止回潮。
    for (const rel of CONSUMERS) {
      const code = stripComments(src(rel));
      const bare = code.match(/(?<![.\w])toast\s*\(/g) ?? [];
      expect(bare, `${rel} 有 ${bare.length} 处裸 toast()，应改用带档位的调用`).toHaveLength(0);
    }
  });
});

describe("播报文案的信息密度（业主指令 2026-10-15）", () => {
  it("「发现新版本」的 toast 不带当前版本号", () => {
    // 提示的主角是「有了什么新东西」；当前版本在对话框/设置页都在，toast 里它是噪声。
    // 只钉 toast 文案那行 —— 下载弹窗的 DialogDescription 带「（当前 v…）」是有意的，别误伤。
    // find 吃 stripComments 后的源码：文件头注释也写着「发现新版本」，不排除注释会先命中它
    const line = stripComments(src("renderer/src/components/Update.tsx"))
      .split("\n")
      .find((l) => l.includes("发现新版本"));
    expect(line, "available 的 toast 文案找不到了").toBeTruthy();
    expect(line).not.toMatch(/当前 ?v/);
    expect(line).not.toMatch(/currentVersion/);
  });
});

describe("进出轴与密度（业主指令 2026-10-15：从右进、退右；框内上下空白太大）", () => {
  const css = src("renderer/src/styles.css");

  it("padding 压缩：四周 16px → 上下 10px 左右 12px", () => {
    expect(css).toMatch(/\[data-sonner-toast\]\[data-styled="true"\]\s*\{\s*padding:\s*10px 12px/);
  });

  it("进场起点在右外侧：首帧（未 mounted）从 translateX(110%) 滑入", () => {
    // sonner 的 mounted 是 effect 里翻的（首帧真实绘制 → transition 才触发），
    // 所以「起点」写在 :not([data-mounted]) 上而不是动画关键帧里
    expect(css).toMatch(/:not\(\[data-mounted="true"\]\)\s*\{[\s\S]{0,80}?--y:\s*translateX\(110%\)/);
  });

  it("落位归零只给 front：非 front 的垂直堆叠（lift+scale）不得被水平化", () => {
    // 落位规则若漏掉 [data-front="true"]，堆叠中的 toast 会被一起拽到 translateX(0)，
    // 右上角「叠成一摞」变成「排成一横排」—— 这条是当年最容易改错的一处
    const landed = css.match(/\[data-mounted="true"\]\[data-front="true"\]\s*\{/)?.[0];
    expect(landed, "落位规则缺 data-front 限定或选择器变了").toBeTruthy();
    expect(css).toMatch(/\[data-mounted="true"\]\[data-front="true"\][^{]*\{\s*--y:\s*translateX\(0\)/);
  });

  it("退场三条形态一并向右：选择器不分 front，也不碰 swipe-out", () => {
    // 按行取选择器：块与块之间隔着 } 与注释，跨块的 [^{]* 会停在第一条规则上误抓
    const selectors = css
      .split("\n")
      .filter((l) => l.includes("[data-sonner-toaster]") && l.includes("data-removed"));
    expect(selectors, "找不到退场规则").toHaveLength(1);
    expect(selectors[0]).toMatch(/data-swipe-out="false"/);
    expect(selectors[0]).toMatch(/\[data-sonner-toast\](?!.*data-front)/); // 不分 front：三条形态一并接管
    expect(css).toMatch(/data-removed="true"\]\[data-swipe-out="false"\]\s*\{\s*--y:\s*translateX\(110%\)/);
  });

  it("跟手甩出：--y 的垂直分量置零，横移交给 --swipe-amount 分量", () => {
    expect(css).toMatch(/\[data-swipe-out="true"\]\s*\{\s*--y:\s*translateX\(0\)/);
  });
});

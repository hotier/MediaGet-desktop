/**
 * 导航与设置面字形漂移闸。
 *
 * 动效字形的快照随文件冻结（动效关键帧长在字形里，经官方 shadcn registry 逐枚拉入仓），
 * 界面其余部分仍用 lucide-react —— 同一枚图标有两个上游来源。本文件把两边各自渲染成静态
 * SVG，抽出线段 / 弧块 / 圆形与矩形整块做多重集比对：哪边换掉一枚字形、或改了笔路，
 * 先红在这里。设置面（侧栏设置钮 + 设置页一级分类）同样比对；
 * `SETTINGS_GLYPHS.categories` 的键即 SettingsPage CATEGORIES 的 id。
 *
 * 登记过的两类形态差异不算漂移（几何不变，只为动画服务）：
 * - 元素拆分：同一笔被拆成多个元素 —— 下载箭头的 polyline+line vs 规范化 path、
 *   历史的指针被拆成两段 line（各绕 (12,12) 转）；
 * - 浮点噪声：快照里 `5.999` 与 lucide-react 规范化后的 `6` —— 数值一律定点到
 *   两位小数再比（亚像素差异，任何渲染尺寸下不可见）。
 *
 * 第三类是**已知冻结**：设置面三枚（settings 直齿 / sliders-horizontal 导轨
 * y=4·12·20 / cpu 8 针 + 6×6 内芯）停在旧版 lucide 画法，与 lucide-react 现版
 * 不同形。这是登记状态而非漂移——逐枚断言「仍不同形 + 图元数 + 画法指纹」，
 * 上游哪天追平或再变都会红，回来重新登记。
 *
 * 第四类是**vendored 重绘**：九枚字形本体都经官方 shadcn registry 拉平入仓
 * （`pnpm dlx shadcn add @lucide-animated/<name>` → `components/ui/*.tsx`）。
 * 其中外观 palette 的轮廓是为描边画线动画反向重绘的——四枚圆点与 lucide-react
 * 逐点一致但轮廓不同形，动画另依赖 dasharray 70（断言在「设置面字形」describe 内）。
 *
 * 上一版（morphicons 时期）逐节点比对 lucide 数据包与 lucide-react 的内部 `__iconData`，
 * 深路径 import 只许活在测试里；这一版改用两边的公开组件渲染产物，深路径读法退场。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { BadgePercent, ChartLine, Cpu, Download, History, House, Palette, Settings, SlidersHorizontal } from "lucide-react";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS, SETTINGS_GLYPHS, type NavKey } from "../renderer/src/lib/nav-icons";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 每个导航键在 lucide-react 里的对照字形（换字形先改这里） */
const REF: Record<NavKey, (props: { size?: number }) => ReactNode> = {
  home: House,
  downloads: Download,
  history: History,
  stats: ChartLine,
};

const markup = (Icon: (props: { size?: number }) => ReactNode): string =>
  renderToStaticMarkup(createElement(Icon, { size: 16 }));

interface El {
  tag: string;
  attrs: Record<string, string>;
}

const attrsOf = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};

/** 只抽画几何的元素；`g`/`svg` 是壳，其余图元出现即报错（新图元要显式登记） */
function elementsOf(html: string): El[] {
  return [...html.matchAll(/<(path|polyline|polygon|line|circle|ellipse|rect)\b([^>]*)>/g)].map((m) => ({
    tag: m[1],
    attrs: attrsOf(m[2]),
  }));
}

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** 一条线段，端点排序后成规范串（无序比对用） */
const seg = (x1: number, y1: number, x2: number, y2: number): string => {
  const a = `${r2(x1)},${r2(y1)}`;
  const b = `${r2(x2)},${r2(y2)}`;
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
};

/** 弧 / 曲线的参数个数（几何不解析，退化为「命令 + 定点参数串」整块比对） */
const CURVE_ARITY: Record<string, number> = { a: 7, c: 6, q: 4, s: 4, t: 2 };

const NUM = /[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g;

function segmentsOf(el: El): string[] {
  if (el.tag === "line") {
    return [seg(Number(el.attrs.x1), Number(el.attrs.y1), Number(el.attrs.x2), Number(el.attrs.y2))];
  }
  if (el.tag === "polyline") {
    const v = (el.attrs.points ?? "").match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    const out: string[] = [];
    for (let i = 0; i + 3 < v.length; i += 2) out.push(seg(v[i], v[i + 1], v[i + 2], v[i + 3]));
    return out;
  }
  if (el.tag === "circle") {
    // 圆整块不拆弧：两侧 lucide 都用 <circle> 画圆，整块比对足够且不引入解析歧义
    return [`CIR(${r2(Number(el.attrs.cx))},${r2(Number(el.attrs.cy))},${r2(Number(el.attrs.r))})`];
  }
  if (el.tag === "rect") {
    // 一律带 rx（缺省 0）整块比对：圆角是曲线，拆成四条边只有在 rx=0 时才等价，不做条件分叉
    const n = (k: string): string => r2(Number(el.attrs[k] ?? 0));
    return [`RECT(${n("x")},${n("y")},${n("width")},${n("height")},rx=${n("rx")})`];
  }
  if (el.tag !== "path") throw new Error(`图元 <${el.tag}> 还没登记到几何抽取器`);

  const t = el.attrs.d.match(NUM) ?? [];
  const out: string[] = [];
  let x = 0;
  let y = 0;
  let i = 0;
  let cmd = "";
  const read = (): number => Number(t[i++]);
  while (i < t.length) {
    if (/[a-zA-Z]/.test(t[i])) cmd = t[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": {
        x = rel ? x + read() : read();
        y = rel ? y + read() : read();
        cmd = rel ? "l" : "L"; // M 之后的续参数是隐式 lineto
        break;
      }
      case "L": {
        const nx = rel ? x + read() : read();
        const ny = rel ? y + read() : read();
        out.push(seg(x, y, nx, ny));
        x = nx;
        y = ny;
        break;
      }
      case "H": {
        const nx = rel ? x + read() : read();
        out.push(seg(x, y, nx, y));
        x = nx;
        break;
      }
      case "V": {
        const ny = rel ? y + read() : read();
        out.push(seg(x, y, x, ny));
        y = ny;
        break;
      }
      case "Z":
        break;
      default: {
        const arity = CURVE_ARITY[cmd.toLowerCase()];
        if (!arity) throw new Error(`路径命令 ${cmd} 还没登记到几何抽取器`);
        const params = Array.from({ length: arity }, read);
        out.push(`${cmd.toUpperCase()}(${params.map(r2).join(",")})`);
        x = rel ? x + params[arity - 2] : params[arity - 2];
        y = rel ? y + params[arity - 1] : params[arity - 1];
        break;
      }
    }
  }
  return out;
}

const geometry = (Icon: (props: { size?: number }) => ReactNode): string[] =>
  elementsOf(markup(Icon)).flatMap(segmentsOf).sort();

describe("导航字形：入仓快照必须与 lucide-react 同形", () => {
  it("对照表键集合与注册表一致", () => {
    expect(Object.keys(REF).sort()).toEqual(NAV_ITEMS.map((i) => i.key).sort());
  });

  it("⌃1–4 的映射顺序 = 注册表顺序", () => {
    expect(NAV_ITEMS.map((i) => i.key)).toEqual(["home", "downloads", "history", "stats"]);
  });

  it.each(NAV_ITEMS)("$key（$label）两侧渲染几何逐段一致", (item) => {
    const ref = geometry(REF[item.key]);
    expect(ref.length).toBeGreaterThan(0);
    expect(geometry(item.Icon)).toEqual(ref);
  });

  it("svg 外壳契约：currentColor 描边 / 无填充 / 24 视窗 / size 生效", () => {
    const svg = markup(NAV_ITEMS[0].Icon).match(/<svg([^>]*)>/)?.[1] ?? "";
    expect(attrsOf(svg)).toMatchObject({
      fill: "none",
      stroke: "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      viewBox: "0 0 24 24",
      width: "16",
      height: "16",
    });
  });

  it("className 落在外壳 div 上（styles.css 的 `.anim-icon svg` 笔重规则依赖这一层）", () => {
    const html = renderToStaticMarkup(
      createElement(NAV_ITEMS[0].Icon, { size: 16, className: "anim-icon", "aria-hidden": true })
    );
    expect(html).toMatch(/^<div class="anim-icon" aria-hidden="true"><svg /);
  });
});

/**
 * 设置面（业主指令 2026-10-16 第二批）：侧栏底部设置钮（SETTINGS_GLYPHS.entry，
 * 悬停驱动）与设置页一级分类（categories）。分类键 = SettingsPage CATEGORIES 的 id，
 * 漏登记时 SettingsPage 访问未定义键是编译错误（`satisfies` 保留字面量键集合），
 * 这里再钉住键集合与每枚字形的对照 / 冻结状态。
 */
describe("设置面字形：设置钮与设置页分类", () => {
  it("分类键集合 = 设置页五个一级分类", () => {
    expect(Object.keys(SETTINGS_GLYPHS.categories).sort()).toEqual(["about", "appearance", "download", "engine", "general"]);
  });

  it("外观 palette：vendored 组件（shadcn registry 拉入仓）——圆点与 lucide-react 逐点一致，轮廓为动画反向重绘", () => {
    const vendored = SETTINGS_GLYPHS.categories.appearance;
    const html = markup(vendored);
    expect(elementsOf(html).length).toBe(5); // 1 条轮廓 path + 4 枚圆点
    const dots = geometry(vendored).filter((t) => t.startsWith("CIR("));
    const refDots = geometry(Palette).filter((t) => t.startsWith("CIR("));
    expect(dots).toEqual(refDots);
    expect(geometry(vendored)).not.toEqual(geometry(Palette));
    expect(html).toContain('stroke-dasharray="70"');
  });

  it("设置钮 settings：已知冻结（直齿旧画法），仍与 lucide-react 现版不同形", () => {
    const frozen = SETTINGS_GLYPHS.entry;
    expect(elementsOf(markup(frozen)).length).toBe(2); // path + circle
    expect(markup(frozen)).toContain("M12.22 2h"); // 画法指纹：上游再变也红
    expect(geometry(frozen)).not.toEqual(geometry(Settings));
  });

  it("通用 sliders-horizontal：已知冻结（导轨 y=4/12/20），仍与现版不同形", () => {
    const frozen = SETTINGS_GLYPHS.categories.general;
    expect(elementsOf(markup(frozen)).length).toBe(9); // 6 段导轨 + 3 枚手柄
    expect(markup(frozen)).toContain('x1="21" x2="14" y1="4" y2="4"');
    expect(geometry(frozen)).not.toEqual(geometry(SlidersHorizontal));
  });

  it("引擎 cpu：已知冻结（8 针 + 6×6 内芯），仍与现版不同形", () => {
    const frozen = SETTINGS_GLYPHS.categories.engine;
    expect(elementsOf(markup(frozen)).length).toBe(10); // 2 rect + 8 针
    expect(markup(frozen)).toContain('d="M15 2v2"');
    expect(geometry(frozen)).not.toEqual(geometry(Cpu));
  });

  it("下载 download：两侧渲染几何逐段一致（与导航队列同一枚字形）", () => {
    expect(geometry(SETTINGS_GLYPHS.categories.download)).toEqual(geometry(Download));
  });

  it("关于 badge-percent：两侧渲染几何逐段一致", () => {
    expect(geometry(SETTINGS_GLYPHS.categories.about)).toEqual(geometry(BadgePercent));
  });
});

/**
 * 受控偏差守卫：九枚 vendored 组件的 stopAnimation 必须保持「快速平滑归位」。
 *
 * 契约经三稿收敛（业主 2026-10-16 两次真窗口报障）：
 * - 原版 `controls.start("normal")` 带动画归位 → History 时针 -360°→0° 可见回转一整圈，
 *   业主报「点其他图标时 history 仍有一段动画」；
 * - v2 瞬停（stop + set）修掉回转，但字形瞬跳，业主报「history 归位更生硬」；
 * - v3 定稿 = 0.15s 短补间归位：不播整段回程，也不瞬跳。唯一例外是 History 的时针
 *   （-360° 整圈回转 ≡ 0°，任何补间都重演整圈回转）——独立一副 controls 瞬时写回。
 * 重新 `pnpm dlx shadcn add` 拉取会把修复覆盖回原版——这组断言就是那天的红叉。
 */
describe("vendored 受控停：九枚 stopAnimation 保持快速平滑归位", () => {
  const GLYPHS = [
    "badge-percent",
    "chart-line",
    "cpu",
    "download",
    "history",
    "home",
    "palette",
    "settings",
    "sliders-horizontal",
  ];
  it.each(GLYPHS)("%s.tsx 归位为 0.15s 短补间，无整段回放 / 瞬停残留", (name) => {
    const src = readFileSync(join(ROOT, "renderer", "src", "components", "ui", `${name}.tsx`), "utf8");
    expect(src, `${name} 缺 0.15s 短补间归位`).toMatch(/controls\.start\("normal", \{ duration: 0\.15, ease: "easeOut" \}\)/);
    expect(src, `${name} 的 stop 退回整段回放（原版 start("normal")）`).not.toMatch(/controls\.start\("normal"\)/);
    expect(src, `${name} 的 stop 退回瞬停（v2 的 controls.set）`).not.toMatch(/controls\.set\("normal"\)/);
  });

  it("history.tsx 时针例外：独立一副 controls 瞬时写回（-360°≡0°，补间 = 整圈回转）", () => {
    const src = readFileSync(join(ROOT, "renderer", "src", "components", "ui", "history.tsx"), "utf8");
    expect(src, "缺 handControls.stop()").toMatch(/handControls\.stop\(\)/);
    expect(src, "缺 handControls.set(\"normal\")").toMatch(/handControls\.set\("normal"\)/);
  });
});

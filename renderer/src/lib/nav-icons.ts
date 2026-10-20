/**
 * 侧栏字形真源（业主指令 2026-10-16 两批：先「切换页面时图标要有动效」，
 * 再「设置面图标也登记」——侧栏底部设置钮与设置页一级分类）。
 *
 * 字形全部走 lucide-animated 官方 shadcn registry 拉平入仓（`components/ui/*.tsx`，
 * 每枚一条 `pnpm dlx shadcn add @lucide-animated/<name>`，registry 别名配在 components.json）——
 * 业主 2026-10-16 定调：「所有动态图标都可以用 pnpm dlx shadcn add 的方式导入」。
 * npm 包 `lucide-animated` 从此不再被 import：它把全包四百余枚图标当副作用打进 bundle
 * （顶层 forwardRef 调用无 PURE 标注、包内无 sideEffects 声明）——撤包实测启动 chunk
 * 1,258 kB → 713 kB（gzip 283 → 228）；逐枚入仓后死重消失，包内缺失的 palette 一类字形
 * 也一并解决。
 *
 * 入仓组件形状（九枚同构，差异已勘）：
 * - 外壳 `div`：`className` 直接落在这层（仅 palette 多一行 `cn("inline-flex …")` 前置类）；
 * - 内是 `svg`：`stroke=currentColor`、`strokeWidth="2"` 硬编码为呈现属性 ——
 *   样式层 `.anim-icon svg` 规则把它压回全站笔重 1.5；尺寸走 `size`（缺省 28，这里传 16）；
 * - `forwardRef` 出 `{ startAnimation, stopAnimation }`；**挂上 ref 后组件自己不再响应 hover**，
 *   触发权在我方（`components/AnimIcon`：成为当前项那一下 start、离开那一下 stop）。
 *   动效一律保持 registry 默认（业主指令 2026-10-20「恢复默认动画，不特别配置了」，
 *   撤销 2026-10-16 三稿收敛的 0.15s 短补间与 History 时针例外——那两轮报障记录在
 *   docs/UIUX-HANDOFF.md，重新拉取即默认态，`tests/nav-icons.test.ts` 守卫锁定现状）；
 *   但复位本身不可省：单值变体（History 的指针、Download 的箭头）落定后不回原位，
 *   不复位则二次激活时 start 的目标 == 当前值，动效静默失效（本机实测坐实）。
 *   AnimIcon 的离开复位正是干这个的。
 *
 * 两张表：`NAV_ITEMS`（侧栏四页，顺序 = ⌃1–4 映射）与 `SETTINGS_GLYPHS`（设置钮 + 分类）。
 * key、文案、组件写在同一张表里，漏一行是编译错误而不是「少一颗图标」。
 *
 * ⚠ 入仓快照冻结在旧版 lucide 画法的三枚：settings（直齿）、cpu（8 针 + 6×6 内芯）、
 * sliders-horizontal（导轨 y=4·12·20）——与本仓 lucide-react 的现版（圆齿 / 12 针 /
 * y=5·12·19）不同形。`tests/nav-icons.test.ts` 把它们登记成「已知冻结」：断言仍不同形，
 * 上游哪天追平或再变都会红，提醒回来重新登记。
 */
import { BadgePercentIcon } from "../components/ui/badge-percent";
import { ChartLineIcon } from "../components/ui/chart-line";
import { CpuIcon } from "../components/ui/cpu";
import { DownloadIcon } from "../components/ui/download";
import { HistoryIcon } from "../components/ui/history";
import { HomeIcon } from "../components/ui/home";
import { PaletteIcon } from "../components/ui/palette";
import { SettingsIcon } from "../components/ui/settings";
import { SlidersHorizontalIcon } from "../components/ui/sliders-horizontal";

export type NavKey = "home" | "downloads" | "history" | "stats";

/** 入仓字形的 ref 句柄（九枚 d.ts 形状同构，收口成一份） */
export interface AnimGlyphHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

/** 动效字形组件共享同一副 props 与 ref 契约（size 缺省 28；挂 ref 后自身 hover 失效），按 HomeIcon 的组件类型收口 */
export type AnimGlyph = typeof HomeIcon;

export interface NavItem {
  key: NavKey;
  label: string;
  Icon: AnimGlyph;
}

/**
 * 数组顺序 = ⌃1–4 的映射顺序，改这里等于改快捷键。
 *
 * 统计图标是折线（业主指令 2026-10-16：「统计用这个 chart-line」）。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "首页", Icon: HomeIcon },
  { key: "downloads", label: "队列", Icon: DownloadIcon },
  { key: "history", label: "历史", Icon: HistoryIcon },
  { key: "stats", label: "统计", Icon: ChartLineIcon },
];

/** 设置面字形：entry = 侧栏底部设置钮（App 悬停驱动）；categories 键 = SettingsPage CATEGORIES 的 id */
export const SETTINGS_GLYPHS = {
  entry: SettingsIcon,
  categories: {
    general: SlidersHorizontalIcon,
    download: DownloadIcon,
    appearance: PaletteIcon,
    engine: CpuIcon,
    about: BadgePercentIcon,
  },
} satisfies {
  entry: AnimGlyph;
  categories: Record<string, AnimGlyph>;
};

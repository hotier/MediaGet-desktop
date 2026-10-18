/**
 * 浮空 toast（shadcn/ui 的 sonner 封装，业主指令 2026-10-15）。
 *
 * 为什么换掉自绘 toast：此前三处提示（首页导入、历史复制、更新结果）各自维护
 * `useState<string>` + `setTimeout`，并把内容渲染成**内容流里的 `<Alert>`** ——
 * 出现/消失都会把下方内容顶一下，且「提示」与真正的错误横幅视觉同形。
 * 设计文档早把这条记为缺陷（docs/UIUX-DESIGN.md §3.1：「toast 复用内容流里的
 * .banner → 出现即布局跳动」）。sonner 是 portal 到 body 的固定定位浮层，
 * 天然不占位，自带队列/进出动效/`aria-live`，比我们手写更稳。
 *
 * 与官方 shadcn 版的两处差别，都是本仓现实：
 * 1. 官方用 `next-themes` 的 `useTheme()` 取明暗 —— 本仓没有该依赖
 *   （主题是自研 theme.ts：`data-theme` 属性 + matchMedia），改订阅 `subscribeTheme`，
 *    同一条判定，不重复实现。
 * 2. 不 `@import "sonner/dist/styles.css"` —— sonner 的 JS 运行时已自注入同一份样式
 *   （实测显式引入会让产物 CSS 多背 14 kB 重复，且 CSP `style-src 'unsafe-inline'`
 *    放行注入）。取色因此完全走下面 style 里的变量覆盖。
 *
 * 取色不走 sonner 内置 gray 阶梯：层 2 语义 Token 是本仓唯一色彩真源，
 * 把 sonner 消费的几个变量（--normal-bg/-text/-border）直接指过去，
 * 明暗与五套 [data-style] 色带自动跟随。
 *
 * 位置定 top-right：§3.1 原写「底部右对齐」，但底部现在是作品信息 Sheet 的地盘，
 * 叠上去互相遮；沿用更新播报既有的右上角位（业主已在现版本见过并默认）。
 *
 * 宽度随文案自适应（业主指令 2026-10-15：「均使用图标+提示的格式，根据内容动态显示 sonner 宽度」）：
 * sonner 把 `width: var(--width)` 写死在 `[data-sonner-toast]` 上，而 `--width` **同时**是 toaster
 * 容器的宽度 —— 容器里全是 absolute 子元素（宽度不参与撑开），直接改 `--width` 会把容器一起压塌，
 * 堆叠位移（`--lift-amount`）与进出动效都跟着错位。因此只在**单条** toast 的内联 style 上覆盖宽度：
 * `fit-content` 让短文案收窄，`max-width` 保持设计口径 20rem 封顶（长文案仍在 320 内换行），
 * `min-width` 兜住「图标 + 两三个字」的极短档，避免缩成一小坨。
 * 容器 `--width` 不动，堆叠与动效照旧。
 */
import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { getResolvedTheme, subscribeTheme } from "~/lib/theme";

/**
 * 四档图标换 lucide（不用 sonner 自带 svg）：全站图标只有一个来源是既有纪律
 * （PlatformIcon 之外全 lucide），且语义色走层 2 的 ok/warn/err/info ——
 * sonner 内置图标色是它自己的 gray 阶梯，与本仓色带无关。
 */
const ICONS: NonNullable<ToasterProps["icons"]> = {
  success: <CircleCheck className="size-4 text-ok" strokeWidth={1.5} />,
  info: <Info className="size-4 text-info" strokeWidth={1.5} />,
  warning: <TriangleAlert className="size-4 text-warn" strokeWidth={1.5} />,
  error: <CircleAlert className="size-4 text-err" strokeWidth={1.5} />,
};

function Toaster({ ...props }: ToasterProps): React.ReactElement {
  const [theme, setTheme] = useState<"light" | "dark">(getResolvedTheme);

  useEffect(() => subscribeTheme(setTheme), []);

  return (
    <Sonner
      theme={theme}
      position="top-right"
      // 垂直下移：sonner 桌面默认 32px，紧贴窗控带与顶栏，读起来像贴在标题上；
      // 56px 让 toast 落进内容区上沿（业主指令 2026-10-18「全局 toast 都往下移动一点」）。
      // 只给 top，right/bottom/left 仍取 sonner 自己的默认值
      offset={{ top: 56 }}
      // 浮层层级：压过 Radix 浮层（z-50）与底部 Sheet，但不与原生菜单争抢
      className="toaster group"
      icons={ICONS}
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--line)",
          "--border-radius": "var(--r-md)",
          // 浮层宽（sonner 默认 356px，设计口径 320）；--width 是它的内联变量，覆盖即可
          "--width": "20rem",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // 阴影走浮层专用 shadow-pop（--sh-pop，明暗两档已各配一值）
          toast: "shadow-pop",
          description: "text-muted-foreground",
        },
        /**
         * 宽度按内容走（见文件头「宽度随文案自适应」）：
         * `fit-content` 覆盖 sonner 写死的 `width: var(--width)`，短文案收窄、长文案由 max-width 封顶；
         * 右对齐（`right: 0`）因此在窄提示上保持右边线齐平，不吃容器的堆叠位移。
         */
        style: {
          width: "fit-content",
          maxWidth: "var(--width)",
          // 极短档（如「复制失败」）兜一个下限，避免缩成图标挤着两个字的一小坨
          minWidth: "10rem",
          /**
           * 字号跟「界面字号」走：sonner 自带 `font-size: 13px` 写死在
           * `[data-sonner-toast][data-styled='true']` 上，只有内联样式压得过它。
           * 必须用驼峰 `fontSize` —— 此前这里写的是 `"font-size"`，React 会当作未知属性丢弃
           * （控制台报 "Unsupported style property font-size"），于是设置页调界面字号时
           * toast 纹丝不动（2026-10-15 实测：--fs-content 13px→17px，toast 仍是 13px）。
           */
          fontSize: "var(--fs-content)",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };

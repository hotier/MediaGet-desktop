/**
 * 应用字标（横版「M + MediaGet」）：应用内品牌位只有这一处出口（与 PlatformIcon 同规）。
 *
 * 资产 = `renderer/public/brand/logo-lockup-on-{dark,light}.png`，由 `scripts/make-icons.cjs`
 * 从 `brand/` 的品牌母版生成（母版是平底单色成品图，脚本只做「拆蒙版 + 换墨色 + 重采样」）。
 * 为什么要两份位图而不是一份 + 反相滤镜：墨色是资产自身的事实，主题切换只该决定显示哪一份；
 * 滤镜在品牌将来换彩色时会让白底档静默变成反色。
 *
 * 两份图恒在 DOM 里，靠 `styles.css` 的 `.brand-lockup[data-ink]` 规则二选一显示 ——
 * 于是换主题不需要 React 重新渲染，也不会先闪一帧另一种墨色。
 */
import { cn } from "../lib/utils";

const SRC = {
  "on-dark": "./brand/logo-lockup-on-dark.png",
  "on-light": "./brand/logo-lockup-on-light.png",
} as const;

export function BrandLogo({ className }: { className?: string }): React.ReactElement {
  return (
    // 外层给一个可读名：两张图里必然有一张被 CSS 藏起来，alt 挂谁都会在另一个主题下失声
    <span role="img" aria-label="MediaGet" className="inline-flex items-center">
      {(Object.keys(SRC) as Array<keyof typeof SRC>).map((ink) => (
        <img
          key={ink}
          className={cn("brand-lockup", className)}
          data-ink={ink}
          src={SRC[ink]}
          alt=""
          draggable={false}
        />
      ))}
    </span>
  );
}

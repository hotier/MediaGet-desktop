/**
 * 品牌加载动画：三点跳动（业主 2026-10-23）。
 *
 * 原来的预览遮罩用 `Loader2 + animate-spin`——那圈转环是浏览器/系统「正在加载」的通用语汇，
 * 盖在视频画面上读起来像系统提示，不是这个 App 的反馈。这里换成点阵：无边框、无轨道，
 * 节奏由 `styles.css` 的 `brand-dot` 给（三颗点相位差 160ms，错开才有「依次抬起」）。
 *
 * 颜色一律走 `currentColor`，组件本身不产色：预览遮罩上传 `text-white/90`，
 * 浅色底上传 `text-muted-foreground`。纯装饰——无障碍语义留给外层（`role="status"` + 那句文案），
 * 这里 `aria-hidden`，否则读屏会读出一串没有内容的盒子。
 */
import { cn } from "../lib/utils";

export function BrandLoader({
  className,
  /**
   * 点的大小：默认 8px（预览遮罩），小号 6px 给按钮内联用。
   * 写成枚举而不是外部传 class，是为了不把「动画推迟 5px」这个几何假定量外面也承担。
   */
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md";
}): React.ReactElement {
  return (
    <span aria-hidden="true" className={cn("inline-flex items-center gap-1", className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn("brand-dot animate-brand-dot rounded-full bg-current", size === "sm" ? "size-1.5" : "size-2")}
        />
      ))}
    </span>
  );
}

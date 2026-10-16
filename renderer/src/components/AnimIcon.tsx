/**
 * 动效字形的受控包装（导航图标 / 设置钮 / 设置页分类字形共用；分类的字形是从
 * shadcn registry 拉入仓的 vendored 组件，外壳与 ref 契约同构）。
 *
 * 三件事：
 * 1. 触发权归调用方——挂上 ref 后组件自身不再响应 hover，本组件在 `active` 变为 true
 *    的那一下 startAnimation()；缺省 mount 时不播（`wasActive` 以初始值起步，首屏没有
 *    「切换」可言）。`animateOnMount` 翻转这条：设置页用它——进入设置页本身就是一次
 *    切换，挂载时已是当前项的那枚分类图标要播一次（业主 2026-10-16 报「点击设置转到
 *    设置页时定位到的那个图标没有动画」）。
 * 2. **离开时必须 stopAnimation() 复位**——这不是可选的润色：History 的指针、Download
 *    的箭头是单值变体，落定后不回原位；不复位则二次激活时 start 的目标 == 当前值，
 *    动效静默失效（本机实测坐实）。库自身的 hover 语义同样是 leave 时复位。
 *    复位形态经三稿收敛：registry 原版的 `start("normal")` 是整段回放（History 时针
 *    可见回转一整圈，业主报「仍有一段动画」）；v2 的瞬停（stop + set）又生硬（业主再报
 *    「history 归位更生硬」）；v3 定稿 = 0.15s 短补间归位，不播整段回程也不瞬跳
 *    （History 的时针例外，独立一副 controls 瞬时写回）。tests/nav-icons.test.ts 有
 *    守卫防 registry 重新拉取把修复覆盖回原版。
 *
 * 系统「减弱动态效果」开着则整个跳过——动效是 JS 补间，styles.css 那条 CSS
 * reduced-motion 规则管不到它，只能在这里拦。
 * aria-hidden：同一行/同一钮已有可见文字，图标不进无障碍树，同一句话不念两遍。
 * 字号契约：`className` 传 "anim-icon"，styles.css 把它压回全站笔重 1.5
 * （组件内 svg 的 strokeWidth="2" 是硬编码呈现属性，只能由 CSS 覆盖）。
 */
import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { AnimGlyph, AnimGlyphHandle } from "../lib/nav-icons";

export function AnimIcon({
  Icon,
  active,
  animateOnMount = false,
}: {
  Icon: AnimGlyph;
  active: boolean;
  animateOnMount?: boolean;
}): React.ReactElement {
  const ref = useRef<AnimGlyphHandle>(null);
  const reduced = useReducedMotion();
  // animateOnMount 时起点置 false：挂载后首个 effect 即视作「刚切进来」，active 的那枚播一次；
  // 非当前项（active=false）不受影响，之后的切换仍走正常的差分逻辑
  const wasActive = useRef(animateOnMount ? false : active);
  useEffect(() => {
    if (!reduced) {
      if (active && !wasActive.current) ref.current?.startAnimation();
      else if (!active && wasActive.current) ref.current?.stopAnimation();
    }
    wasActive.current = active;
  }, [active, reduced]);
  return <Icon ref={ref} size={16} className="anim-icon" aria-hidden="true" />;
}

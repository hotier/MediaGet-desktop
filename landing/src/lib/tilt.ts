/**
 * 模拟窗「重力倾斜」——motion 的 vanilla 绑定（与 React 版 useMotionValue /
 * useSpring / useTransform 同一套内核，只是不用 hook）。
 *
 * 业主 2026-10-22 指定：参照 ego.app 主页 demo 面板的做法，幅度必须克制。
 * 原先是 index.astro 里手写的半隐式欧拉积分（约 50 行）；换成 motion 之后，
 * 弹簧、映射、样式绑定各用一段现成实现，把我方需要维护的数值积分交给库。
 *
 * 四条等价关系（改之前先对照，别凭想象换掉其中一个）：
 *   useMotionValue(0)                   → motionValue(0)
 *   useSpring(mv, { stiffness, damping }) → springValue(mv, { stiffness, damping })
 *   useTransform(v, [-0.5, 0.5], [...]) → mapValue(v, [-0.5, 0.5], [...])
 *   <motion.div style={{ rotateX, rotateY, transformPerspective }} />
 *                                       → styleEffect(element, { rotateX, rotateY, transformPerspective })
 *
 * 角度写数字而不是 "2deg"：styleEffect 按 transform 值类型自动补单位
 * （motion-dom 的 transformValueTypes.rotateX / rotateY = degrees）；字符串写两遍
 * 只是多一处能写错的地方。
 *
 * 为什么是模块而不是内联脚本：motion 要先被打包。代价是 file:// 双击产物时这支
 * 不跑——窗体平放，与「减动偏好直接不初始化」同一条降级，不白屏。
 *
 * 为什么不自己拼 transform 字符串：rotateX / rotateY / transformPerspective 是
 * motion 的 transform 通道，同一个 effect 会合成成一条 transform（transformPropOrder
 * 里 transformPerspective 排第一，输出 perspective(1200px)）。自己拼字符串就得复制
 * 那套顺序，写反一次透视就挂到旋转后面去。
 */
import { mapValue, motionValue, springValue, styleEffect } from "motion";

/** 归一化位移（±0.5）× 这个系数 = 角度，于是最大 2° */
const DEGREES_PER_UNIT = 4;

/** 透视距离（px）：1200 是「相机退得够远」那一档，再近会让 2° 显出卡片感 */
const PERSPECTIVE = 1200;

/** 编排动画广播的载荷（landing/src/pages/index.astro 的打字机投这个事件） */
interface TiltGateDetail {
  /** true = 别的动画正在占注意力，倾斜让位 */
  active: boolean;
}

export interface TiltHandle {
  /** 编排动画期间关掉跟随：目标归零、弹簧回弹；恢复后继续跟手 */
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

/**
 * 给一扇窗挂上指针跟随的 3D 倾斜。
 *
 * 不满足前置条件时返回 null（而不是抛错），三条都是「宁可不动」：
 *   1. 没有这个元素（别的页复用这个模块时）；
 *   2. 读者勾了「减少动态效果」；
 *   3. 环境没有 hover 能力——触屏的 pointermove 只在拖动时来，会把窗钉在歪角上。
 */
export function initTilt(element?: HTMLElement | null): TiltHandle | null {
  const app = element === undefined ? document.querySelector<HTMLElement>(".tour .app") : element;
  if (!app) return null;

  const query = window.matchMedia ? window.matchMedia.bind(window) : null;
  if (query && query("(prefers-reduced-motion: reduce)").matches) return null;
  if (query && !query("(hover: hover) and (pointer: fine)").matches) return null;

  /* 两个目标值（指针归一化位置，±0.5）+ 两路弹簧。只 set 不读，不碰 React state */
  const pointerX = motionValue(0);
  const pointerY = motionValue(0);
  const springX = springValue(pointerX, { stiffness: 300, damping: 30 });
  const springY = springValue(pointerY, { stiffness: 300, damping: 30 });

  /* rotateY 跟着横向位移（右移为正），rotateX 跟着纵向（下移为负，窗顶朝里）。
     两个方向相反是镜像逻辑：指针往右下走，右边缘该离读者更远。 */
  const rotateY = mapValue(springX, [-0.5, 0.5], [-0.5 * DEGREES_PER_UNIT, 0.5 * DEGREES_PER_UNIT]);
  const rotateX = mapValue(springY, [-0.5, 0.5], [0.5 * DEGREES_PER_UNIT, -0.5 * DEGREES_PER_UNIT]);

  const stopEffect = styleEffect(app, {
    transformPerspective: motionValue(PERSPECTIVE),
    rotateX,
    rotateY,
  });

  /* 不碰 will-change：常驻会给这扇 1240×720 的窗占一份合成层内存，反复开关又要每轮
     重建层（倾斜过程中最容易看见的抖动）。motion 逐帧写 transform 时浏览器自己会
     在这一批帧里提升，停手后自然回落。 */

  let enabled = true;

  const setEnabled = (next: boolean) => {
    if (enabled === next) return;
    enabled = next;
    /* 关掉时立刻松手：目标归零，让弹簧自己回弹——硬写 transform 会让归位变成瞬跳 */
    if (!next) {
      pointerX.set(0);
      pointerY.set(0);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!enabled || event.pointerType === "touch") return;
    const rect = app.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
    pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
  };

  const onPointerLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };

  /* 编排动画（当前是首屏打字机的逐字播放）播放期间让位：
     两层动画抢注意力时，读者看到的是「字在动、窗也在动」的互相打架 */
  const onGate = (event: Event) => {
    const detail = (event as CustomEvent<TiltGateDetail>).detail;
    setEnabled(!detail || detail.active !== true);
  };

  app.addEventListener("pointermove", onPointerMove, { passive: true });
  app.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("mg:tilt", onGate);

  return {
    setEnabled,
    destroy() {
      app.removeEventListener("pointermove", onPointerMove);
      app.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("mg:tilt", onGate);
      stopEffect();
    },
  };
}

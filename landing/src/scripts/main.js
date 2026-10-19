/* 落地页按需水合入口。
 *
 * 静态优先：HTML/CSS 已完整可读；本文件只做三件按需的事——
 *   1. 打上 html.js 标记（正文入场动画的隐藏开关，只有这里跑得起来才允许藏内容）
 *   2. 滚动状态与克制的淡入（无 JS 时全部内容直接可见）
 *   3. 条件满足时动态 import() 加载首屏 WebGL island
 *
 * Astro 把这里打成 type="module"，而 file:// 下模块脚本会被 CORS 拦掉——双击 dist/index.html
 * 时本文件根本不执行。所以 html.js 绝不能像原本那样写在 head 的内联脚本里：内联脚本在
 * file:// 下是能跑的，标记一打、正文就按 CSS 藏进 opacity:0，而负责揭示的模块永远不来，
 * 页面比不做动画更糟（整页空白）。标记留在这里，降级路径就自动回到「全部可见」。
 * 同一条 CORS 限制也决定了主题开关不归本文件管——监听器挂在这里，模块不执行时按钮就是死键，
 * 所以它写在 index.astro 的 head 内联脚本里（那里能跑），本文件只在被加载时负责入场动画与 island。
 */

/* global document, window, IntersectionObserver, requestAnimationFrame */

(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.add("js");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var coarsePointer = window.matchMedia("(pointer: coarse)").matches;

  /* —— 导航滚动状态 —— */
  var nav = document.getElementById("nav");
  var scrollQueued = false;

  function onScroll() {
    scrollQueued = false;
    if (nav) nav.classList.toggle("is-scrolled", window.scrollY > 24);
  }

  window.addEventListener(
    "scroll",
    function () {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(onScroll);
    },
    { passive: true }
  );
  onScroll();

  /* —— 克制的淡入：只有透明度与位移 —— */
  var blocks = document.querySelectorAll(".block, .tour");

  function stagger(section) {
    /* 时延挂在入场选择器真正命中的那一层（CSS 里 `html.js .block > *` / `.tour > *`）。
       .tour 开头几子是五颗隐形 radio：把时延排在它们身上，可见内容的入场就整体往后拖。 */
    var index = 0;
    Array.prototype.forEach.call(section.children, function (child) {
      if (child.classList.contains("tour-radio")) return;
      child.style.setProperty("--d", index * 70 + "ms");
      index += 1;
    });
  }

  if (!("IntersectionObserver" in window)) {
    Array.prototype.forEach.call(blocks, stagger);
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          stagger(entry.target);
          entry.target.classList.add("in");
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -6% 0px" }
    );
    Array.prototype.forEach.call(blocks, function (section) {
      revealObserver.observe(section);
    });
  }

  /* —— island 1：首屏 WebGL 奇点 ——
   * 条件：非减少动效、非触屏、视口足够宽、浏览器有 WebGL。
   * 移动端 / 降级路径保留静态海报与圆环，不下载也不运行渲染循环。 */
  var hero = document.querySelector(".hero");
  var canvas = document.getElementById("heroCanvas");

  function webglAvailable() {
    try {
      var probe = document.createElement("canvas");
      return Boolean(
        probe.getContext("webgl2") ||
          probe.getContext("webgl") ||
          probe.getContext("experimental-webgl")
      );
    } catch {
      return false;
    }
  }

  if (hero && canvas && !reduceMotion && !coarsePointer && window.innerWidth >= 720 && webglAvailable()) {
    import("./hero-visual.js")
      .then(function (module) {
        module.initHeroVisual(canvas, hero);
      })
      .catch(function () {
        /* 模块加载失败：静态海报继续展示，页面不受影响 */
      });
  }
})();

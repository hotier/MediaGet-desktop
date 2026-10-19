/* 首屏视觉 island：一个被吸入奇点的粒子盘。
 *
 * 设计约束：
 * - 只在首屏运行；滚出视口或页面隐藏即停 rAF（不铺满全站的重型渲染）。
 * - 移动端 / 触屏 / 减少动效 / 无 WebGL 时本模块不会被 import，
 *   由 CSS 静态海报与事件视界圆环兜底。
 * - LCP 是 h1 文本：canvas 初始透明，第一帧就绪后才淡入接管。
 * - 物理用简化的开普勒轨道（角度积分），不求解引力，保证不掉帧也不发散。
 */

/* global document, window, requestAnimationFrame, cancelAnimationFrame, IntersectionObserver, getComputedStyle */

const VERTEX_SHADER = `
attribute vec2 aPos;
attribute float aHeat;
attribute float aLife;
uniform float uDpr;
uniform float uSize;
varying float vHeat;
varying float vLife;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = uSize * uDpr * (0.7 + aHeat * 1.8);
  vHeat = aHeat;
  vLife = aLife;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
varying float vHeat;
varying float vLife;
void main() {
  vec2 offset = gl_PointCoord - vec2(0.5);
  float d = length(offset);
  if (d > 0.5) discard;
  float alpha = smoothstep(0.5, 0.1, d);
  vec3 color = mix(uColorA, uColorB, clamp(vHeat, 0.0, 1.0));
  gl_FragColor = vec4(color, alpha * uOpacity * vLife);
}`;

const CENTER_Y = 0.2; /* 与 CSS 的 rings top:40% 对齐 */
const FLATTEN = 0.34; /* 圆盘压扁，制造透视 */
const RADIUS_MIN = 0.06;
const RADIUS_MAX = 0.42;

function readColor(name, fallback) {
  var raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  var parts = String(raw || "")
    .split(",")
    .map(function (piece) {
      return Number(piece.trim());
    });
  if (parts.length !== 3 || parts.some(function (value) {
    return !isFinite(value);
  })) {
    return fallback;
  }
  return parts;
}

function compile(gl, type, source) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    var log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("shader compile failed: " + log);
  }
  return shader;
}

export function initHeroVisual(canvas, hero) {
  /* 不留 drawing buffer：每帧都要重画，留着只是多一份全屏缓冲。
     （原先靠它在停帧后保住最后一张画面，代价是把「回前台不重启」这个 bug 藏成了「看着像静止的艺术处理」。） */
  var gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });

  if (!gl) {
    gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
  }
  if (!gl) throw new Error("webgl unavailable");

  var program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("program link failed: " + gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  var aPos = gl.getAttribLocation(program, "aPos");
  var aHeat = gl.getAttribLocation(program, "aHeat");
  var aLife = gl.getAttribLocation(program, "aLife");
  var uDpr = gl.getUniformLocation(program, "uDpr");
  var uSize = gl.getUniformLocation(program, "uSize");
  var uColorA = gl.getUniformLocation(program, "uColorA");
  var uColorB = gl.getUniformLocation(program, "uColorB");
  var uOpacity = gl.getUniformLocation(program, "uOpacity");

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.clearColor(0, 0, 0, 0);

  var colorA = readColor("--viz-dot", [0.92, 0.95, 1]);
  var colorB = readColor("--viz-hot", [0.36, 0.62, 1]);
  gl.uniform3fv(uColorA, colorA);
  gl.uniform3fv(uColorB, colorB);
  gl.uniform1f(uOpacity, 0.75);
  gl.uniform1f(uSize, 2.6);

  var buffer = gl.createBuffer();
  var count = 0;
  var stride = 4; /* x, y, heat, life */
  var data = new Float32Array(0);
  var radius = new Float32Array(0);
  var angle = new Float32Array(0);
  var omega = new Float32Array(0);
  var life = new Float32Array(0);
  var span = new Float32Array(0);
  var driftX = new Float32Array(0);
  var driftY = new Float32Array(0);

  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var aspect = 1;
  var pointerX = 0;
  var pointerY = 0;
  var pointerActive = false;
  var frame = null;
  var lastTime = 0;
  var running = false;
  var inView = true;
  var lost = false;

  function spawn(index, initial) {
    var t = Math.random();
    radius[index] = RADIUS_MIN + (RADIUS_MAX - RADIUS_MIN) * Math.pow(t, 0.85);
    angle[index] = Math.random() * Math.PI * 2;
    /* 开普勒式角速度：内圈快、外圈慢 */
    omega[index] = (0.34 / Math.pow(radius[index] + 0.16, 1.5)) * (0.9 + Math.random() * 0.2);
    life[index] = initial ? Math.random() : 0;
    span[index] = 5 + Math.random() * 9;
    driftX[index] = 0;
    driftY[index] = 0;
  }

  function allocate() {
    var area = canvas.clientWidth * canvas.clientHeight;
    count = Math.round(Math.min(11000, Math.max(3200, area / 1400)));
    data = new Float32Array(count * stride);
    radius = new Float32Array(count);
    angle = new Float32Array(count);
    omega = new Float32Array(count);
    life = new Float32Array(count);
    span = new Float32Array(count);
    driftX = new Float32Array(count);
    driftY = new Float32Array(count);
    for (var i = 0; i < count; i += 1) spawn(i, true);
  }

  function resize() {
    var width = Math.max(1, canvas.clientWidth);
    var height = Math.max(1, canvas.clientHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    aspect = width / height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1f(uDpr, dpr);
    allocate();
  }

  function update(dt) {
    var i;
    var x;
    var y;
    var heat;
    var lifeValue;

    for (i = 0; i < count; i += 1) {
      angle[i] += omega[i] * dt;
      life[i] += dt / span[i];
      if (life[i] >= 1) spawn(i, false);

      var jitter = 1 + (((i * 37) % 11) / 11 - 0.5) * 0.09;
      var r = radius[i] * jitter;
      var cos = Math.cos(angle[i]);
      var sin = Math.sin(angle[i]);

      x = (r * cos) / aspect;
      y = CENTER_Y + r * sin * FLATTEN;

      /* 指针形成一个局部涡旋：附近粒子被轻轻拉过去，松手后弹回 */
      if (pointerActive) {
        var dx = pointerX - x;
        var dy = pointerY - y;
        var dist2 = dx * dx + dy * dy;
        if (dist2 < 0.16) {
          var pull = (1 - dist2 / 0.16) * 0.0022;
          driftX[i] += dx * pull;
          driftY[i] += dy * pull;
        }
      }
      driftX[i] *= 0.975;
      driftY[i] *= 0.975;
      x += driftX[i];
      y += driftY[i];

      heat = 1 - Math.min(1, (radius[i] - RADIUS_MIN) / (RADIUS_MAX - RADIUS_MIN));
      lifeValue = Math.sin(Math.PI * Math.min(1, life[i]));
      /* 盘的近端（屏幕下方）更亮，压扁后才有体积感 */
      lifeValue *= 0.55 + 0.45 * Math.max(0, Math.sin(angle[i]));

      var base = i * stride;
      data[base] = x;
      data[base + 1] = y;
      data[base + 2] = heat;
      data[base + 3] = lifeValue;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride * 4, 0);
    gl.vertexAttribPointer(aHeat, 1, gl.FLOAT, false, stride * 4, 8);
    gl.vertexAttribPointer(aLife, 1, gl.FLOAT, false, stride * 4, 12);
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aHeat);
    gl.enableVertexAttribArray(aLife);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  function loop(now) {
    if (!running) return;
    frame = requestAnimationFrame(loop);
    var dt = lastTime ? Math.min(0.033, (now - lastTime) / 1000) : 0.016;
    lastTime = now;
    update(dt);
  }

  function start() {
    if (running || lost) return;
    running = true;
    lastTime = 0;
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
  }

  /* 离开视口 / 切到后台：停渲染，回来再续 */
  var heroObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          function (entries) {
            inView = entries.some(function (entry) {
              return entry.isIntersecting;
            });
            if (inView) start();
            else stop();
          },
          { threshold: 0.04 }
        )
      : null;
  if (heroObserver && hero) heroObserver.observe(hero);

  /* 回前台必须自己重启：IO 只在交叉状态真的变化时派发，切标签页不动交叉状态，
     所以它不会补一条 entry 进来。这里原先调 takeRecords()（只取出并清空队列，
     不执行回调），等于「hidden 时停掉」之后再没人把它开回来——首屏动画切一次
     后台就永久定格，要等用户滚动越过硬边才复活。inView 由 IO 记账，本处直接照它决定。 */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else if (inView) start();
  });

  /* 主题切换：取色探针换粒子配色 */
  document.addEventListener("mg:theme", function () {
    colorA = readColor("--viz-dot", colorA);
    colorB = readColor("--viz-hot", colorB);
    gl.uniform3fv(uColorA, colorA);
    gl.uniform3fv(uColorB, colorB);
  });

  /* 指针涡旋（桌面端） */
  window.addEventListener(
    "pointermove",
    function (event) {
      if (event.pointerType === "touch") return;
      var rect = canvas.getBoundingClientRect();
      pointerX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointerY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
      pointerActive = true;
    },
    { passive: true }
  );
  window.addEventListener("pointerleave", function () {
    pointerActive = false;
  });

  /* 上下文丢失：让静态海报接手，不反复重连 */
  canvas.addEventListener("webglcontextlost", function (event) {
    event.preventDefault();
    lost = true;
    stop();
    canvas.classList.remove("is-ready");
  });

  var resizeQueued = false;
  window.addEventListener(
    "resize",
    function () {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(function () {
        resizeQueued = false;
        resize();
      });
    },
    { passive: true }
  );

  resize();
  start();
  /* 首帧画完再接管，LCP 始终是 h1 文本 */
  requestAnimationFrame(function () {
    if (!lost) canvas.classList.add("is-ready");
  });
}

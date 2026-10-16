#!/usr/bin/env node
/**
 * 应用图标资产生成器（纯 Node，无栅格化依赖 —— 本机既没有 ImageMagick 也没有 rsvg，
 * `convert` 是磁盘命令不是转换器）。
 *
 * 图形真源就是本文件里的解析式几何（SDF + 6×6 超采样），产出物提交进仓库：
 *   build/icon.png                       ← 256 母版，给设计与人工比对
 *   build/icon.ico                       ← electron-builder 的 buildResources 自动取用（exe/任务栏/安装器）
 *   resources/icons/window.png           ← BrowserWindow 图标（64）
 *   resources/icons/tray.png(+@2x)       ← 托盘（16 / 32，@2x 供高分屏）
 *
 * 用法：
 *   node scripts/make-icons.cjs --sheet   # 只出 build/_sheet.png 对照表，人眼挑方案
 *   node scripts/make-icons.cjs --write   # 落全部资产
 * 改图标 = 改下面的 MARK/配色参数重跑，不去外部编辑器里导出（那会把资产变成没人能复现的二进制）。
 */
const { deflateSync } = require("node:zlib");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const BUILD = join(ROOT, "build");
const ICONS = join(ROOT, "resources", "icons");

// —— 品牌面：蓝白主题的 accent（#2f6fed 家族，与 UIUX-DESIGN §1 承接条款同一相）——
const TILE_TOP = [0x4d, 0x86, 0xf4];
const TILE_BOT = [0x1e, 0x55, 0xc9];
const INK = [255, 255, 255];

/** 圆角方 tile 的半径比例（Windows 11 的 tile 语言，不是大圆角卡片） */
const TILE_RADIUS = 0.225;
/** 图形占 tile 的比例（16px 上还要认得出，宁小勿碎） */
const MARK_SCALE = 0.62;

// ————————————————————————————————————————————————
// 距离场：每个形状给「带符号距离」，<0 在里，覆盖度靠 6×6 超采样累加
// ————————————————————————————————————————————————
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}
/** 菱形（旋转 45° 的正方形），h = 半对角线 */
function sdDiamond(x, y, cx, cy, h) {
  return (Math.abs(x - cx) + Math.abs(y - cy) - h) / Math.SQRT2;
}
/** 线段粗细：|d| <= w/2 */
function ring(d, w) {
  return Math.abs(d) - w / 2;
}

/**
 * 线宽 Hinting：距离场按像素算，16px 上 0.115u 只有 1.1 像素宽，斜边必然碎成棋盘。
 * 下限是**设备像素**（常量，不随尺寸缩放），所以小尺寸自动加粗、大尺寸回到设计比例 ——
 * 手工图标里的小尺寸变体，这里用一条 max 表达。
 */
const MIN_STROKE_PX = 2;
function hint(w) {
  return Math.max(w, MIN_STROKE_PX);
}

/**
 * 三款候选（--sheet 用来肉眼挑）：
 * A 嵌套菱形 = 文档里 [◈ logo MediaGet] 的落形；B 下载箭头（与队列语义同形）；C 菱形+箭头合成。
 * 签名 (x, y, c, u, S)：c=画布中心，u=图形尺度，S=本档像素边长。
 */
const MARKS = {
  A: (x, y, c, u) => {
    const outer = sdDiamond(x, y, c, c, 0.5 * u);
    const inner = sdDiamond(x, y, c, c + 0.02 * u, 0.2 * u);
    return Math.min(ring(outer, hint(0.115 * u)), inner);
  },
  B: (x, y, c, u) => {
    const t = hint(0.115 * u) / 2;
    const shaft = sdRoundBox(x, y, c, c - 0.16 * u, t, 0.2 * u, t);
    const head = sdDiamond(x, y, c, c + 0.16 * u, 0.24 * u);
    const tray = sdRoundBox(x, y, c, c + 0.42 * u, 0.34 * u, t * 0.7, t * 0.7);
    return Math.min(shaft, Math.min(head, tray));
  },
  C: (x, y, c, u) => {
    const outer = ring(sdDiamond(x, y, c, c, 0.5 * u), hint(0.115 * u));
    const t = hint(0.1 * u) / 2;
    const arrow = Math.min(
      sdRoundBox(x, y, c, c - 0.1 * u, t, 0.14 * u, t),
      sdDiamond(x, y, c, c + 0.14 * u, 0.19 * u)
    );
    return Math.min(outer, arrow);
  },
};

/** 渲染 S×S 的 RGBA（transparent 底，tile 撑满） */
function render(size, mark) {
  const S = size;
  const buf = new Uint8ClampedArray(S * S * 4);
  const sd = 6;
  const step = 1 / sd;
  const c = S / 2;
  const u = S * MARK_SCALE;
  const rad = S * TILE_RADIUS;
  const half = S / 2 - Math.max(1, S * 0.02); // 留一丝外缩，16px 上边缘不发糊
  const shape = MARKS[mark];
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let cov = 0;
      let ink = 0;
      for (let sy = 0; sy < sd; sy++) {
        for (let sx = 0; sx < sd; sx++) {
          const x = px + sx * step;
          const y = py + sy * step;
          if (sdRoundBox(x, y, c, c, half, half, rad) <= 0) {
            cov += 1;
            if (shape(x, y, c, u) <= 0) ink += 1;
          }
        }
      }
      cov /= sd * sd;
      ink /= sd * sd;
      const t = (py + 0.5) / S;
      const i = (py * S + px) * 4;
      for (let k = 0; k < 3; k++) {
        const base = TILE_TOP[k] + (TILE_BOT[k] - TILE_TOP[k]) * t;
        buf[i + k] = base + (INK[k] - base) * ink;
      }
      buf[i + 3] = Math.round(cov * 255);
    }
  }
  return buf;
}

// ————————————————————————————————————————————————
// PNG / ICO 容器（zlib 出 IDAT，CRC32 自己算）
// ————————————————————————————————————————————————
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(width * height * 4 + height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function encodeIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);
  const offset = 6 + 16 * entries.length;
  let cursor = offset;
  const dirs = entries.map((e) => {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0; // palette
    d[3] = 0; // reserved
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(cursor, 12);
    cursor += e.png.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.png)]);
}

/** 把 RGBA 贴进画布（源带 alpha，目标先铺底色） */
function paste(canvas, W, rgba, size, x, y, bg) {
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = (py * size + px) * 4;
      const a = rgba[i + 3] / 255;
      const j = ((y + py) * W + (x + px)) * 4;
      for (let k = 0; k < 3; k++) canvas[j + k] = bg[k] * (1 - a) + rgba[i + k] * a;
      canvas[j + 3] = 255;
    }
  }
}
/** 最近邻放大：小尺寸的糊与缺笔要按「放大后的原样」看，不能靠重采样美化 */
function upscale(rgba, size, factor) {
  const S = size * factor;
  const out = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (Math.floor(y / factor) * size + Math.floor(x / factor)) * 4;
      const j = (y * S + x) * 4;
      for (let k = 0; k < 4; k++) out[j + k] = rgba[i + k];
    }
  }
  return { rgba: out, size: S };
}

/** 三档检视：16px 放大 8×（托盘/任务栏真实那一档）、32px 放大 4×、128px 原样（设计本来面目） */
const PROVES = [
  { size: 16, factor: 8 },
  { size: 32, factor: 4 },
  { size: 128, factor: 1 },
];

function sheet() {
  const marks = Object.keys(MARKS);
  const cell = 132;
  const gap = 12;
  const W = gap + marks.length * (cell + gap);
  const H = gap + PROVES.length * (cell + gap);
  const canvas = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    canvas[i * 4] = 0xe8;
    canvas[i * 4 + 1] = 0xec;
    canvas[i * 4 + 2] = 0xf2;
    canvas[i * 4 + 3] = 255;
  }
  marks.forEach((m, col) => {
    PROVES.forEach((p, row) => {
      const bg = row === 1 ? [0x14, 0x18, 0x1f] : [0xf7, 0xf9, 0xfc];
      const x = gap + col * (cell + gap);
      const y = gap + row * (cell + gap);
      for (let i = 0; i < cell * cell; i++) {
        const j = ((y + Math.floor(i / cell)) * W + (x + (i % cell))) * 4;
        canvas[j] = bg[0];
        canvas[j + 1] = bg[1];
        canvas[j + 2] = bg[2];
      }
      const up = upscale(render(p.size, m), p.size, p.factor);
      paste(canvas, W, up.rgba, up.size, x + (cell - up.size) / 2, y + (cell - up.size) / 2, bg);
    });
  });
  writeFileSync(join(BUILD, "_sheet.png"), encodePng(W, H, canvas));
  return join(BUILD, "_sheet.png");
}

function write() {
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(ICONS, { recursive: true });
  const mark = "A";
  const pngOf = (size) => encodePng(size, size, render(size, mark));
  writeFileSync(join(BUILD, "icon.png"), pngOf(256));
  writeFileSync(join(ICONS, "tray.png"), pngOf(16));
  writeFileSync(join(ICONS, "tray@2x.png"), pngOf(32));
  writeFileSync(join(ICONS, "window.png"), pngOf(64));
  // 16/24/32/48/64/128/256：托盘、任务栏、Alt+Tab、安装器、缩略视图各取所需
  const ico = encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngOf(size) })));
  writeFileSync(join(BUILD, "icon.ico"), ico);
  return { mark, icoBytes: ico.length };
}

const mode = process.argv.includes("--sheet") ? sheet : write;
const result = mode();
console.log("[make-icons]", JSON.stringify(result));

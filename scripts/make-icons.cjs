#!/usr/bin/env node
/**
 * 品牌资产管线（纯 Node：自写 PNG 解码 + 重采样 + zlib 出 PNG/ICO，无栅格化依赖 ——
 * 本机既没有 ImageMagick 也没有 rsvg，`convert` 是磁盘命令不是转换器）。
 *
 * 真源 = `brand/` 里的品牌母版（业主 2026-10-20 交来的一整套图）。那批母版是
 * 「平底 + 单色墨」的成品图（白底黑墨 / 黑底白墨，都不带 alpha），所以本脚本的第一件事
 * 是把它们拆成**蒙版**：先用中位色认出底色，再按「离底色多远 / 离墨色多远」算覆盖率。
 * 拆出来的蒙版才是可复用的那一层 —— 换墨色、换尺寸、叠到别的底色上都不再回头求母版。
 *
 * 产出物提交进仓库（都是生成物，别手改）：
 *   build/icon.png                        ← 256 母版，给设计与人工比对
 *   build/icon.ico                        ← electron-builder 的 buildResources 自动取用（exe/任务栏/安装器）
 *   resources/icons/window.png            ← BrowserWindow 图标（64）
 *   resources/icons/tray.png(+@2x)        ← 托盘（16 / 32，@2x 供高分屏）
 *   renderer/public/brand/logo-lockup-*.png ← 应用内与落地页的横版字标（两份墨色，见下）
 *   renderer/public/brand/favicon.png     ← 窗口/页签图标（64）
 *   landing/public/og.png                 ← 分享卡 1200×630（落地页 og:image）
 *   build/installerSidebar.bmp            ← NSIS 完成页侧边图 164×314（electron-builder 默认取用）
 *   build/installerHeader.bmp             ← NSIS 内页顶部图 150×57（同上）
 *
 * 用法：
 *   node scripts/make-icons.cjs --sheet   # 只出 build/_sheet.png 对照表（16/32/48/128/256 六档），人眼挑
 *   node scripts/make-icons.cjs --write   # 落全部资产（默认）
 *
 * 为什么字标要两份位图而不是一份 + CSS 反相：母版是**纯黑**墨，反相在白底档会得到纯白墨，
 * 看着没问题，但这份资产将来若换成彩色品牌就会静默变成反色。两份墨色各自出图，
 * 主题切换只是 display 的事，不靠滤镜猜。
 */
const { deflateSync, inflateSync } = require("node:zlib");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const BRAND = join(ROOT, "brand");
const BUILD = join(ROOT, "build");
const ICONS = join(ROOT, "resources", "icons");
const RENDERER_BRAND = join(ROOT, "renderer", "public", "brand");
const LANDING_PUBLIC = join(ROOT, "landing", "public");

/** 母版文件（换品牌 = 换这几个文件再重跑，不改下面的数字） */
const SRC = {
  /** 横版字标：黑墨白底，638×180。字标只认这一份 —— 「MediaGet」的字形与字距以它为准 */
  lockup: "01_logo_horizontal_black_white.png",
  /** 图形：白底黑墨，225×180。应用图标与托盘里的那枚 M（比 07 的大，重采样起点更干净） */
  mark: "05_icon_black_white.png",
  /** 竖版字标：黑墨白底，267×225（图形叠字标）。安装器侧边图用它——164px 宽的窄条里横版会糊 */
  vertical: "03_logo_vertical_black_white.png",
};

/** 图标版式：圆角方 tile + 居中图形。数值取自母版实测（见文件末尾的 --sheet 对照表） */
const TILE_RADIUS = 0.18; // 母版 tile 的圆角半径 / 边长
const MARK_RATIO = 0.585; // 图形高 / tile 高
/** 小尺寸光学补偿：16/24px 上按母版比例缩出来的图形只剩 9px，笔画会糊成一团 */
const SMALL_SIZE = 24;
const SMALL_MARK_RATIO = 0.7;

/** 墨色（母版实测：tile 近黑、图形近白；不纯黑纯白是为了跟母版的观感一致） */
const TILE_COLOR = [11, 12, 13];
const MARK_COLOR = [255, 255, 255];

// ————————————————————————————————————————————————
// PNG 解码：8bit / 非交错 / 灰度·RGB·调色板以外的四种常见色彩类型
// ————————————————————————————————————————————————
function decodePng(buf) {
  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ct = data[9];
      if (data[12] !== 0) throw new Error("不支持交错 PNG（品牌母版不该是这种）");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error(`不支持的位深 ${depth}：品牌母版应为 8bit`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!ch) throw new Error(`不支持的色彩类型 ${ct}（只吃灰度/灰度+A/RGB/RGBA）`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[off++];
    const line = Buffer.from(raw.subarray(off, off + stride));
    off += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (ch === 4) {
        out[i] = line[x * 4];
        out[i + 1] = line[x * 4 + 1];
        out[i + 2] = line[x * 4 + 2];
        out[i + 3] = line[x * 4 + 3];
      } else if (ch === 3) {
        out[i] = line[x * 3];
        out[i + 1] = line[x * 3 + 1];
        out[i + 2] = line[x * 3 + 2];
        out[i + 3] = 255;
      } else if (ch === 1) {
        out[i] = out[i + 1] = out[i + 2] = line[x];
        out[i + 3] = 255;
      } else {
        out[i] = out[i + 1] = out[i + 2] = line[x * 2];
        out[i + 3] = line[x * 2 + 1];
      }
    }
  }
  return { w, h, data: out };
}

const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * 平底单色图 → 覆盖率蒙版。
 *
 * 底色取**中位数**（母版里绝大多数像素是底），墨色取最远的那个极值档，覆盖率
 * `alpha = |L - 底色| / |墨色 - 底色|` —— 抗锯齿边缘因此天然是半透明，
 * 而不是「阈值一刀切」那种带锯齿的硬边。墨色本身取最靠近墨极值的像素均值，
 * 于是 01 的墨是母版那个近黑、不是硬写成 #000。
 */
function inkMask(img) {
  const { w, h, data } = img;
  const hist = new Float64Array(256);
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    hist[Math.round(LUM(r, g, b))] += 1;
  }
  let acc = 0;
  let bg = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= (w * h) / 2) {
      bg = v;
      break;
    }
  }
  // 墨 = 离底色最远的非空档（白底→最暗档，黑底→最亮档）
  let ink = bg;
  if (bg > 127) {
    for (let v = 0; v < 256; v++) if (hist[v] > w * h * 0.0005) { ink = v; break; }
  } else {
    for (let v = 255; v >= 0; v--) if (hist[v] > w * h * 0.0005) { ink = v; break; }
  }
  if (ink === bg) throw new Error("母版是纯色：认不出图形");

  const span = ink - bg;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const l = LUM(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    const a = (l - bg) / span;
    alpha[i] = a < 0 ? 0 : a > 1 ? 1 : a;
    if (alpha[i] > 0.98) {
      for (let k = 0; k < 3; k++) sums[k] += data[i * 4 + k];
      counts[0] += 1;
    }
  }
  const inkColor = sums.map((s) => Math.round(s / Math.max(1, counts[0])));
  return { w, h, alpha, inkColor, bg, ink };
}

/** 蒙版裁到墨迹边界（母版留白不进资产，尺寸才由调用方说了算） */
function cropMask(mask) {
  const { w, h, alpha } = mask;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0.05) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("蒙版是空的");
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) out[y * cw + x] = alpha[(y + minY) * w + x + minX];
  }
  return { w: cw, h: ch, alpha: out, inkColor: mask.inkColor };
}

/**
 * 单轴重采样：缩小时按覆盖面积加权（box），放大时按三角形核（≈ 双线性）。
 * 两者共用一个「权重 = 源区间与目标像素的交集长度」的表达，缩小时它就是面积平均。
 */
function resampleX(src, w, h, dw) {
  const scale = w / dw;
  const kernel = Math.max(1, scale);
  const out = new Float32Array(dw * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < dw; x++) {
      const center = (x + 0.5) * scale;
      const lo = Math.floor(center - kernel);
      const hi = Math.ceil(center + kernel);
      let sum = 0;
      let wsum = 0;
      for (let s = lo; s <= hi; s++) {
        if (s < 0 || s >= w) continue;
        const dist = Math.abs(s + 0.5 - center) / kernel;
        const wgt = dist >= 1 ? 0 : 1 - dist;
        if (wgt <= 0) continue;
        sum += src[y * w + s] * wgt;
        wsum += wgt;
      }
      out[y * dw + x] = wsum > 0 ? sum / wsum : 0;
    }
  }
  return { w: dw, h, alpha: out };
}

function resampleY(src, w, h, dh) {
  const scale = h / dh;
  const kernel = Math.max(1, scale);
  const out = new Float32Array(w * dh);
  for (let y = 0; y < dh; y++) {
    const center = (y + 0.5) * scale;
    const lo = Math.floor(center - kernel);
    const hi = Math.ceil(center + kernel);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let wsum = 0;
      for (let s = lo; s <= hi; s++) {
        if (s < 0 || s >= h) continue;
        const dist = Math.abs(s + 0.5 - center) / kernel;
        const wgt = dist >= 1 ? 0 : 1 - dist;
        if (wgt <= 0) continue;
        sum += src[s * w + x] * wgt;
        wsum += wgt;
      }
      out[y * w + x] = wsum > 0 ? sum / wsum : 0;
    }
  }
  return { w, h: dh, alpha: out };
}

/** 等比缩放到指定高度（宽度按蒙版本来的长宽比取整，不拉伸字形） */
function maskToHeight(mask, height) {
  const width = Math.max(1, Math.round((height * mask.w) / mask.h));
  const tmp = resampleX(mask.alpha, mask.w, mask.h, width);
  return resampleY(tmp.alpha, tmp.w, tmp.h, height);
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

/**
 * 24 位未压缩 BMP（NSIS 的安装器图只认位图，不认 PNG）。
 * 两个必须遵守的格式细节：像素**自下而上**、通道顺序是 **BGR**，且每行补齐到 4 字节；
 * 尺寸也必须精确（侧边图 164×314、顶部图 150×57），MUI 不会替我们裁。
 */
function encodeBmp(width, height, rgba) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(54 + pixelBytes, 2); // 文件总长
  out.writeUInt32LE(54, 10); // 像素数据偏移
  out.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // 正数 = 自下而上
  out.writeUInt16LE(1, 26); // planes
  out.writeUInt16LE(24, 28); // bpp
  out.writeUInt32LE(0, 30); // BI_RGB
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38); // ≈72 DPI
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      out[dst + x * 3] = rgba[src + x * 4 + 2];
      out[dst + x * 3 + 1] = rgba[src + x * 4 + 1];
      out[dst + x * 3 + 2] = rgba[src + x * 4];
    }
  }
  return out;
}

// ————————————————————————————————————————————————
// 合成：圆角 tile 上的图形 / 透明底上的字标 / 分享卡
// ————————————————————————————————————————————————
/** 圆角方 tile 的覆盖率（4×4 超采样，16px 上边缘也不会锯齿） */
function tileCoverage(size, half, radius) {
  const cov = new Float32Array(size * size);
  const c = size / 2;
  const ss = 4;
  const step = 1 / ss;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) * step;
          const y = py + (sy + 0.5) * step;
          const dx = Math.abs(x - c) - half + radius;
          const dy = Math.abs(y - c) - half + radius;
          const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
          if (d <= 0) hits += 1;
        }
      }
      cov[py * size + px] = hits / (ss * ss);
    }
  }
  return cov;
}

/** 蒙版双线性取样（合成时按目标像素反查源像素） */
function sampleMask(mask, x, y) {
  if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return 0;
  const x0 = Math.floor(x - 0.5);
  const y0 = Math.floor(y - 0.5);
  const fx = x - 0.5 - x0;
  const fy = y - 0.5 - y0;
  const at = (px, py) => (px < 0 || py < 0 || px >= mask.w || py >= mask.h ? 0 : mask.alpha[py * mask.w + px]);
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bot * fy;
}

/**
 * 应用图标：黑 tile + 白图形，tile 之外全透明。
 * 小尺寸按 SMALL_MARK_RATIO 放大图形并几乎铺满画布（1px 的边都被系统裁掉不如让图形占满）。
 */
function renderAppIcon(mark, size) {
  const small = size <= SMALL_SIZE;
  const inset = small ? 0 : size * 0.02;
  const half = size / 2 - inset;
  const radius = Math.max(1.5, half * 2 * TILE_RADIUS);
  const cov = tileCoverage(size, half, radius);
  const markH = Math.max(4, Math.round(half * 2 * (small ? SMALL_MARK_RATIO : MARK_RATIO)));
  const scaled = maskToHeight(mark, markH);
  const markX = (size - scaled.w) / 2;
  const markY = (size - scaled.h) / 2;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const a = sampleMask({ w: scaled.w, h: scaled.h, alpha: scaled.alpha }, x + 0.5 - markX, y + 0.5 - markY);
      const j = i * 4;
      for (let k = 0; k < 3; k++) {
        rgba[j + k] = Math.round(TILE_COLOR[k] * (1 - a) + MARK_COLOR[k] * a);
      }
      rgba[j + 3] = Math.round(Math.min(1, cov[i]) * 255);
    }
  }
  return rgba;
}

/** 透明底字标：把蒙版染成指定墨色，尺寸按高度给 */
function renderLockup(mask, height, ink) {
  const scaled = maskToHeight(mask, height);
  const rgba = new Uint8ClampedArray(scaled.w * scaled.h * 4);
  for (let i = 0; i < scaled.w * scaled.h; i++) {
    rgba[i * 4] = ink[0];
    rgba[i * 4 + 1] = ink[1];
    rgba[i * 4 + 2] = ink[2];
    rgba[i * 4 + 3] = Math.round(scaled.alpha[i] * 255);
  }
  return { w: scaled.w, h: scaled.h, rgba };
}

/** 分享卡（1200×630）：深底 + 左字标 + 右侧一枚极淡的大图形（母版 OG 的同一个构图） */
function renderOg(lockupMask, markMask) {
  const W = 1200;
  const H = 630;
  const canvas = new Uint8ClampedArray(W * H * 4);
  const bg = [8, 9, 11];
  for (let i = 0; i < W * H; i++) {
    canvas[i * 4] = bg[0];
    canvas[i * 4 + 1] = bg[1];
    canvas[i * 4 + 2] = bg[2];
    canvas[i * 4 + 3] = 255;
  }
  const blit = (mask, height, ink, ox, oy, opacity) => {
    const art = renderLockup(mask, height, ink);
    for (let y = 0; y < art.h; y++) {
      for (let x = 0; x < art.w; x++) {
        const dx = ox + x;
        const dy = oy + y;
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
        const a = (art.rgba[(y * art.w + x) * 4 + 3] / 255) * opacity;
        if (a <= 0) continue;
        const j = (dy * W + dx) * 4;
        for (let k = 0; k < 3; k++) canvas[j + k] = Math.round(canvas[j + k] * (1 - a) + ink[k] * a);
      }
    }
  };
  // 右侧那枚大图形故意出血（越过画布右缘）：它是底纹不是标志，读起来才像「同一枚 M 的余响」
  const markH = 560;
  const markW = Math.round((markH * markMask.w) / markMask.h);
  blit(markMask, markH, [255, 255, 255], W - markW + 90, Math.round((H - markH) / 2) + 30, 0.06);
  const lockH = 104;
  blit(lockupMask, lockH, [255, 255, 255], 96, Math.round((H - lockH) / 2), 1);
  return { w: W, h: H, rgba: canvas };
}

/** 实底画布（安装器图不需要透明：MUI 直接铺位图，带 alpha 的 BMP 反而不被认） */
function solidCanvas(w, h, rgb) {
  const canvas = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    canvas[i * 4] = rgb[0];
    canvas[i * 4 + 1] = rgb[1];
    canvas[i * 4 + 2] = rgb[2];
    canvas[i * 4 + 3] = 255;
  }
  return canvas;
}

/** 把 renderLockup 出来的带 alpha 墨迹叠到实底画布上（裁剪掉越界部分） */
function blitOnto(canvas, W, H, art, ox, oy) {
  for (let y = 0; y < art.h; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= H) continue;
    for (let x = 0; x < art.w; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= W) continue;
      const a = art.rgba[(y * art.w + x) * 4 + 3] / 255;
      if (a <= 0) continue;
      const j = (dy * W + dx) * 4;
      const s = (y * art.w + x) * 4;
      for (let k = 0; k < 3; k++) canvas[j + k] = Math.round(canvas[j + k] * (1 - a) + art.rgba[s + k] * a);
    }
  }
}

/**
 * NSIS 安装器两图（尺寸是 MUI 写死的，改一个像素就会糊）：
 * - 侧边图 164×314：完成页用，深底 + 白色**竖版**字标（164px 宽放横版字标会缩成一团）。
 * - 顶部图 150×57：目录页/安装页用，白底 + 近黑**横版**字标，右对齐留 10px 呼吸
 *   （MUI 把顶部图贴齐右边缘，白底让它与页头无缝）。
 */
function renderInstallerArt(verticalMask, lockupMask) {
  const SW = 164;
  const SH = 314;
  const sidebar = solidCanvas(SW, SH, TILE_COLOR);
  const markH = 108;
  const vart = renderLockup(verticalMask, markH, MARK_COLOR);
  blitOnto(sidebar, SW, SH, vart, Math.round((SW - vart.w) / 2), 92);

  const HW = 150;
  const HH = 57;
  const header = solidCanvas(HW, HH, [255, 255, 255]);
  const hart = renderLockup(lockupMask, 30, lockupMask.inkColor);
  blitOnto(header, HW, HH, hart, HW - hart.w - 10, Math.round((HH - hart.h) / 2));

  return { sidebar: { w: SW, h: SH, rgba: sidebar }, header: { w: HW, h: HH, rgba: header } };
}

// ————————————————————————————————————————————————
// 检视表：一条命令看清 16/24/32/48/128/256 各档在浅底与深底上的样子
// ————————————————————————————————————————————————
function buildSheet(mark) {
  const sizes = [16, 24, 32, 48, 128, 256];
  const gap = 16;
  const W = gap + sizes.reduce((sum, s) => sum + Math.max(s, 32) + gap, 0);
  const H = gap + 2 * (288 + gap);
  const canvas = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    canvas[i * 4] = 0xe8;
    canvas[i * 4 + 1] = 0xec;
    canvas[i * 4 + 2] = 0xf2;
    canvas[i * 4 + 3] = 255;
  }
  sizes.forEach((size, col) => {
    const cell = Math.max(size, 32);
    [0xf7f9fc, 0x14181f].forEach((bg, row) => {
      const x0 = gap + sizes.slice(0, col).reduce((sum, s) => sum + Math.max(s, 32) + gap, 0) + (cell - size) / 2;
      const y0 = gap + row * (288 + gap) + (288 - size) / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const j = ((y0 + y) * W + (x0 + x)) * 4;
          canvas[j] = (bg >> 16) & 0xff;
          canvas[j + 1] = (bg >> 8) & 0xff;
          canvas[j + 2] = bg & 0xff;
        }
      }
      const art = renderAppIcon(mark, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const src = (y * size + x) * 4;
          const a = art[src + 3] / 255;
          const j = ((y0 + y) * W + (x0 + x)) * 4;
          for (let k = 0; k < 3; k++) canvas[j + k] = Math.round(canvas[j + k] * (1 - a) + art[src + k] * a);
        }
      }
    });
  });
  writeFileSync(join(BUILD, "_sheet.png"), encodePng(W, H, canvas));
  return join(BUILD, "_sheet.png");
}

// ————————————————————————————————————————————————
function main() {
  const mark = cropMask(inkMask(decodePng(readFileSync(join(BRAND, SRC.mark)))));
  const lockup = cropMask(inkMask(decodePng(readFileSync(join(BRAND, SRC.lockup)))));
  const vertical = cropMask(inkMask(decodePng(readFileSync(join(BRAND, SRC.vertical)))));

  if (process.argv.includes("--sheet")) {
    mkdirSync(BUILD, { recursive: true });
    return { sheet: buildSheet(mark) };
  }

  [BUILD, ICONS, RENDERER_BRAND, LANDING_PUBLIC].forEach((dir) => mkdirSync(dir, { recursive: true }));

  const iconPng = (size) => encodePng(size, size, renderAppIcon(mark, size));
  writeFileSync(join(BUILD, "icon.png"), iconPng(256));
  writeFileSync(join(ICONS, "tray.png"), iconPng(16));
  writeFileSync(join(ICONS, "tray@2x.png"), iconPng(32));
  writeFileSync(join(ICONS, "window.png"), iconPng(64));
  // 16/24/32/48/64/128/256：托盘、任务栏、Alt+Tab、安装器、缩略视图各取所需
  const ico = encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: iconPng(size) })));
  writeFileSync(join(BUILD, "icon.ico"), ico);

  const LOCKUP_H = 80;
  const onLight = renderLockup(lockup, LOCKUP_H, lockup.inkColor);
  const onDark = renderLockup(lockup, LOCKUP_H, MARK_COLOR);
  writeFileSync(join(RENDERER_BRAND, "logo-lockup-on-light.png"), encodePng(onLight.w, onLight.h, onLight.rgba));
  writeFileSync(join(RENDERER_BRAND, "logo-lockup-on-dark.png"), encodePng(onDark.w, onDark.h, onDark.rgba));
  writeFileSync(join(RENDERER_BRAND, "favicon.png"), iconPng(64));

  const og = renderOg(lockup, mark);
  writeFileSync(join(LANDING_PUBLIC, "og.png"), encodePng(og.w, og.h, og.rgba));

  // 安装器两图：文件名是 electron-builder 的默认落点（buildResources 目录下），
  // 文件名一对上它就自己接走 —— package.json 里不需要再写 installerSidebar/Header。
  const art = renderInstallerArt(vertical, lockup);
  writeFileSync(join(BUILD, "installerSidebar.bmp"), encodeBmp(art.sidebar.w, art.sidebar.h, art.sidebar.rgba));
  writeFileSync(join(BUILD, "installerHeader.bmp"), encodeBmp(art.header.w, art.header.h, art.header.rgba));

  return {
    lockup: `${onLight.w}x${onLight.h}`,
    mark: `${mark.w}x${mark.h}`,
    icoBytes: ico.length,
    installerArt: `${art.sidebar.w}x${art.sidebar.h} + ${art.header.w}x${art.header.h}`,
  };
}

console.log("[make-icons]", JSON.stringify(main()));

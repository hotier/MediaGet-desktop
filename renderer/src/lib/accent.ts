/**
 * 动态魔法色（Air「专辑封面魔法色」的迁移位：视频缩略图主色驱动）。
 * 缩略图 → 32×32 降采样 → 饱和度加权直方图取主色 → 亮度钳位 L∈[0.45,0.75]
 * → 写 documentElement 的 --accent-color（:root 已声明 400ms 过渡，禁跳变）；
 * --accent-ink 按相对亮度翻转（浅 accent→深字 / 深 accent→浅字）。
 * 提取失败（含跨域污染画布）= 移除内联覆盖，回落样式表 --air-accent-fallback。
 * 不在 JS 里写 hex：颜色字面量只活在 Token 层 1。
 */
import { useEffect } from "react";

const L_MIN = 0.45;
const L_MAX = 0.75;

function relLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("cover load failed"));
    img.src = src;
  });
}

/** 返回 "rgb(r g b)"（已亮度钳位）；失败返回 null（调用方回落）。 */
export async function extractAccent(src: string): Promise<string | null> {
  try {
    const img = await loadImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 32, 32);
    const { data } = ctx.getImageData(0, 0, 32, 32); // 跨域未授权 → SecurityError

    // 每通道 32 级量化直方图；权重 = 像素数 ×(1+3×饱和度)，极端明暗像素降权
    type Bucket = { w: number; r: number; g: number; b: number };
    const buckets = new Map<number, Bucket>();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const [, s, l] = rgbToHsl(r, g, b);
      if (l < 0.06 || l > 0.94) continue; // 死黑/过曝不参与主色
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const w = 1 + s * 3;
      const cur = buckets.get(key);
      if (cur) {
        cur.w += w;
        cur.r += r * w;
        cur.g += g * w;
        cur.b += b * w;
      } else {
        buckets.set(key, { w, r: r * w, g: g * w, b: b * w });
      }
    }
    let best: Bucket | null = null;
    for (const b of buckets.values()) {
      if (!best || b.w > best.w) best = b;
    }
    if (!best) return null;

    let r = best.r / best.w;
    let g = best.g / best.w;
    let b = best.b / best.w;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (l < L_MIN || l > L_MAX) [r, g, b] = hslToRgb(h, s, Math.min(L_MAX, Math.max(L_MIN, l)));
    return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
  } catch {
    return null;
  }
}

/** cover 变化 → 魔法色 400ms 渐变；cover=null → 回落缺省灰。App 层唯一消费点。 */
export function useAccent(cover: string | null): void {
  useEffect(() => {
    const root = document.documentElement;
    const reset = () => {
      root.style.removeProperty("--accent-color");
      root.style.removeProperty("--accent-ink");
    };
    if (!cover) {
      reset();
      return;
    }
    let alive = true;
    void extractAccent(cover).then((rgb) => {
      if (!alive) return;
      if (!rgb) {
        reset();
        return;
      }
      root.style.setProperty("--accent-color", rgb);
      const [r, g, b] = rgb
        .slice(4, -1)
        .split(/[\s/]+/)
        .map(Number);
      root.style.setProperty(
        "--accent-ink",
        relLuminance(r, g, b) > 0.5 ? "var(--air-on-accent-dark)" : "var(--air-on-accent-light)"
      );
    });
    return () => {
      alive = false;
    };
  }, [cover]);
}

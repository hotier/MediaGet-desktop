/**
 * 本地合流产物的 Range 解析（2026-10-21）。
 *
 * 合流后的 mp4 是本地文件，播放器拖动进度条全靠 Range：解析错了的表现不是报错，
 * 而是「拖到最后一段黑屏」或「时长读不出来」，所以逐档钉死。
 */
import { describe, expect, it } from "vitest";
import { parseByteRange } from "../electron/main/preview-protocol";

describe("parseByteRange（本地文件分段）", () => {
  const SIZE = 1000;

  it("没有 Range（或空文件）→ null，调用方给整段 200", () => {
    expect(parseByteRange(null, SIZE)).toBeNull();
    expect(parseByteRange("", SIZE)).toBeNull();
    expect(parseByteRange("bytes=0-99", 0)).toBeNull();
  });

  it("闭区间、开区间都按字节偏移解析", () => {
    expect(parseByteRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=100-", SIZE)).toEqual({ start: 100, end: 999 });
    expect(parseByteRange("bytes=0-999", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("`bytes=-N` 是「末尾 N 字节」，不是结束偏移", () => {
    expect(parseByteRange("bytes=-100", SIZE)).toEqual({ start: 900, end: 999 });
    // 后缀比文件还大 → 从头给
    expect(parseByteRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  it("末尾超界钳到文件尾（播放器经常按整段长度末尾多要一点）", () => {
    expect(parseByteRange("bytes=900-99999", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("起点越界或区间倒置 → unsatisfiable（回 416，播放器据此重拉元数据）", () => {
    expect(parseByteRange("bytes=1000-", SIZE)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=2000-3000", SIZE)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=500-100", SIZE)).toBe("unsatisfiable");
  });

  it("多段与怪格式按整段给（<video> 从不发多段，不值得为它做 multipart）", () => {
    expect(parseByteRange("bytes=0-9,20-29", SIZE)).toBeNull();
    expect(parseByteRange("bytes=abc", SIZE)).toBeNull();
    expect(parseByteRange("items=0-9", SIZE)).toBeNull();
    expect(parseByteRange("bytes=-", SIZE)).toBeNull();
  });
});

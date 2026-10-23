/**
 * 双轨 MSE 预览的两个纯函数底座（2026-10-23）。
 *
 * 钉住两件事：① 网络块边界与盒边界无关，切分器必须跨任意分块拼出完整顶层盒；
 * ② 只有「两条轨的 codec + 容器都齐」才算可播，缺一项就该回退合流——
 * 拿半截 init 或不支持的容器去喂 SourceBuffer 只会让预览黑屏。
 */
import { describe, expect, it } from "vitest";
import {
  Fmp4Parser,
  concatBoxes,
  locateSegment,
  mseTrackMime,
  parseSidx,
  type Fmp4Box,
} from "../renderer/src/lib/fmp4";

function box(type: string, payloadLength: number, large = false): Uint8Array {
  const header = large ? 16 : 8;
  const bytes = new Uint8Array(header + payloadLength);
  const view = new DataView(bytes.buffer);
  if (large) {
    view.setUint32(0, 1);
    for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
    view.setUint32(8, 0);
    view.setUint32(12, header + payloadLength);
  } else {
    view.setUint32(0, header + payloadLength);
    for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  }
  bytes.fill(0xab, header);
  return bytes;
}

function feed(parser: Fmp4Parser, stream: Uint8Array, chunkSize: number): Fmp4Box[] {
  const out: Fmp4Box[] = [];
  for (let offset = 0; offset < stream.length; offset += chunkSize) {
    out.push(...parser.push(stream.slice(offset, offset + chunkSize)));
  }
  return out;
}

describe("Fmp4Parser", () => {
  it("任意分块边界都能拼出完整顶层盒", () => {
    const ftyp = box("ftyp", 8);
    const moov = box("moov", 12);
    const parser = new Fmp4Parser();
    const out = feed(parser, concatBoxes([ftyp, moov]), 3);
    expect(out.map((b) => b.type)).toEqual(["ftyp", "moov"]);
    expect(out[0].bytes).toEqual(ftyp);
    expect(out[1].bytes).toEqual(moov);
    expect(parser.pendingBytes).toBe(0);
  });

  it("fMP4 分片序列：init 与 moof+mdat 各自成盒", () => {
    const stream = concatBoxes([
      box("ftyp", 4),
      box("moov", 16),
      box("sidx", 8),
      box("moof", 6),
      box("mdat", 20),
    ]);
    const parser = new Fmp4Parser();
    const out = feed(parser, stream, 7);
    expect(out.map((b) => b.type)).toEqual(["ftyp", "moov", "sidx", "moof", "mdat"]);
    expect(parser.pendingBytes).toBe(0);
  });

  it("64 位 largesize 的盒照样按整盒吐出", () => {
    const mdat = box("mdat", 5, true);
    const parser = new Fmp4Parser();
    const out = feed(parser, mdat, 2);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("mdat");
    expect(out[0].bytes).toHaveLength(21);
  });

  it("半截盒留在缓冲里，补齐后才吐", () => {
    const ftyp = box("ftyp", 8);
    const parser = new Fmp4Parser();
    expect(parser.push(ftyp.slice(0, 5))).toEqual([]);
    expect(parser.pendingBytes).toBe(5);
    const rest = parser.push(ftyp.slice(5));
    expect(rest.map((b) => b.type)).toEqual(["ftyp"]);
    expect(parser.pendingBytes).toBe(0);
  });

  it("size=0（延伸到文件尾）判坏，让预览回退而不是喂半截数据", () => {
    const bytes = box("free", 4);
    new DataView(bytes.buffer).setUint32(0, 0);
    expect(() => new Fmp4Parser().push(bytes)).toThrow(/size=0/);
  });

  it("size 小于盒头判坏", () => {
    const bytes = box("free", 4);
    new DataView(bytes.buffer).setUint32(0, 4);
    expect(() => new Fmp4Parser().push(bytes)).toThrow(/invalid/);
  });
});

interface SidxSpec {
  version?: 0 | 1;
  timescale?: number;
  earliest?: number;
  firstOffset?: number;
  refs?: { size: number; duration: number }[];
}

function sidxBox(spec: SidxSpec = {}): Uint8Array {
  const version = spec.version ?? 0;
  const refs = spec.refs ?? [
    { size: 1000, duration: 5000 },
    { size: 2000, duration: 5000 },
    { size: 3000, duration: 5000 },
  ];
  const total = (version === 0 ? 32 : 40) + refs.length * 12;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, total);
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = "sidx".charCodeAt(i);
  bytes[8] = version;
  view.setUint32(12, 1); // reference_ID
  view.setUint32(16, spec.timescale ?? 1000);
  if (version === 0) {
    view.setUint32(20, spec.earliest ?? 0);
    view.setUint32(24, spec.firstOffset ?? 0);
    view.setUint16(30, refs.length);
  } else {
    view.setUint32(20, 0);
    view.setUint32(24, spec.earliest ?? 0);
    view.setUint32(28, 0);
    view.setUint32(32, spec.firstOffset ?? 0);
    view.setUint16(38, refs.length);
  }
  const refsAt = version === 0 ? 32 : 40;
  refs.forEach((ref, i) => {
    const at = refsAt + i * 12;
    view.setUint32(at, ref.size);
    view.setUint32(at + 4, ref.duration);
    view.setUint32(at + 8, 0x90000000); // starts_with_SAP=1, SAP_type=1
  });
  return bytes;
}

describe("parseSidx", () => {
  it("v0：时段、首段起点与每段字节长度都按规范读出", () => {
    const bytes = sidxBox({ timescale: 16000, firstOffset: 48 });
    expect(parseSidx(bytes, 6000)).toEqual({
      timescale: 16000,
      earliestTime: 0,
      mediaStart: 6000 + bytes.length + 48,
      references: [
        { size: 1000, duration: 5000 },
        { size: 2000, duration: 5000 },
        { size: 3000, duration: 5000 },
      ],
    });
  });

  it("v1：64 位 EPT / first_offset 也读得对", () => {
    const bytes = sidxBox({ version: 1, timescale: 90000, earliest: 9000, firstOffset: 64 });
    const index = parseSidx(bytes, 100);
    expect(index?.earliestTime).toBe(9000);
    expect(index?.mediaStart).toBe(100 + bytes.length + 64);
    expect(index?.references).toHaveLength(3);
  });

  it("ref_count=0、截断、非 sidx 一律不给索引", () => {
    expect(parseSidx(sidxBox({ refs: [] }))).toBeNull();
    expect(parseSidx(sidxBox().slice(0, 40))).toBeNull();
    const moov = sidxBox();
    for (let i = 0; i < 4; i += 1) moov[4 + i] = "moov".charCodeAt(i);
    expect(parseSidx(moov)).toBeNull();
  });
});

describe("locateSegment", () => {
  const bytes = sidxBox({ timescale: 1000, firstOffset: 16 });
  const index = parseSidx(bytes, 1000);
  const mediaStart = 1000 + bytes.length + 16;

  it("目标落在哪段就给出那段的字节起点与呈现时间", () => {
    expect(index).not.toBeNull();
    expect(locateSegment(index!, 0)).toEqual({ offset: mediaStart, startTime: 0, duration: 5 });
    expect(locateSegment(index!, 4.99)).toEqual({ offset: mediaStart, startTime: 0, duration: 5 });
    expect(locateSegment(index!, 5)).toEqual({ offset: mediaStart + 1000, startTime: 5, duration: 5 });
    expect(locateSegment(index!, 12.5)).toEqual({ offset: mediaStart + 3000, startTime: 10, duration: 5 });
  });

  it("越过末尾夹回最后一段，不产生文件外偏移", () => {
    expect(locateSegment(index!, 999)).toEqual({
      offset: mediaStart + 3000,
      startTime: 10,
      duration: 5,
    });
  });

  it("负数与 NaN 按 0 处理", () => {
    expect(locateSegment(index!, -3)?.startTime).toBe(0);
    expect(locateSegment(index!, Number.NaN)?.startTime).toBe(0);
  });
});

describe("mseTrackMime", () => {
  const ready = {
    audioUrl: "https://cdn.example.com/a.m4s?x=1",
    videoCodecs: "avc1.64001f",
    videoMimeType: "video/mp4",
    audioCodecs: "mp4a.40.2",
    audioMimeType: "audio/mp4",
  };

  it("双轨身份齐全时拼出两条 SourceBuffer MIME", () => {
    expect(mseTrackMime(ready)).toEqual({
      video: 'video/mp4; codecs="avc1.64001f"',
      audio: 'audio/mp4; codecs="mp4a.40.2"',
    });
  });

  it("mimeType 已自带 codecs 时不重复拼", () => {
    const out = mseTrackMime({
      ...ready,
      videoMimeType: 'video/mp4; codecs="avc1.64001f"',
    });
    expect(out?.video).toBe('video/mp4; codecs="avc1.64001f"');
  });

  it("支持 webm 轨道（YouTube 的 VP9/Opus 档）", () => {
    const out = mseTrackMime({
      ...ready,
      videoCodecs: "vp9",
      videoMimeType: "video/webm",
      audioCodecs: "opus",
      audioMimeType: "audio/webm",
    });
    expect(out).toEqual({ video: 'video/webm; codecs="vp9"', audio: 'audio/webm; codecs="opus"' });
  });

  it("没有音频轨（渐进式单文件）不建 MSE", () => {
    expect(mseTrackMime({ ...ready, audioUrl: undefined })).toBeNull();
  });

  it("缺任一 codec 都回退合流，不拿残缺身份硬播", () => {
    expect(mseTrackMime({ ...ready, videoCodecs: undefined })).toBeNull();
    expect(mseTrackMime({ ...ready, audioCodecs: undefined })).toBeNull();
    expect(mseTrackMime({ ...ready, audioMimeType: undefined })).toBeNull();
  });

  it("非 mp4/webm 容器交给 ffmpeg", () => {
    expect(mseTrackMime({ ...ready, videoMimeType: "video/x-flv" })).toBeNull();
  });
});

/**
 * 历史页聚合纯函数（renderer/src/lib/history-works.ts）。
 *
 * v8 起同一个作品在档里必然有两类行：解析行（files 空）与下载行（每个落地文件一行）。
 * 「哪一行的字段说了算」因此成了规则而不是 `g[0]` —— 下面第 2 条是这次改动唯一会静默
 * 出错的形状：重新解析过的已下载作品，若只看组头会显示成「类型 —」，界面上看着完全正常。
 */
import { describe, expect, it } from "vitest";
import { groupWorks } from "../renderer/src/lib/history-works";
import { parseHistoryEntry, workKeyOf } from "../shared/history";
import type { HistoryEntry } from "../types/ipc";

const SHARE = "https://v.kuaishou.com/abc";
const KEY = workKeyOf(SHARE);

/** 解析行（主进程 parse:run 写的那一条） */
const parseRow = (at: number): HistoryEntry =>
  parseHistoryEntry({ sourceUrl: SHARE, platform: "kuaishou", title: "秋日通勤", fallbackId: "p-x", at });

/** 下载行（落地文件写的那一条，图集多文件就是多行同 groupId） */
const fileRow = (id: string, bytes: number): HistoryEntry => ({
  id,
  groupId: KEY,
  platform: "kuaishou",
  title: "秋日通勤",
  kind: "video",
  bytes,
  files: [`/tmp/${id}.mp4`],
  createdAt: 3,
});

describe("groupWorks：解析行与下载行聚成一个作品", () => {
  it("解析过 + 下载过：文件数与类型都来自下载行，来源链接来自解析行", () => {
    const [row] = groupWorks([fileRow("d1", 500), parseRow(100)]);
    expect(row).toMatchObject({
      key: KEY,
      title: "秋日通勤",
      platform: "kuaishou",
      kind: "video",
      count: 1,
      bytes: 500,
      sourceUrl: SHARE,
    });
  });

  it("下载过的作品再重新解析一次（解析行顶到组首）：类型与大小不许退回「—」", () => {
    const rows = groupWorks([parseRow(900), fileRow("d1", 500), fileRow("d2", 700)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "video", count: 2, bytes: 1200 });
    // 时刻取组里最新：重解析要顶到列表前面
    expect(rows[0].createdAt).toBe(900);
  });

  it("只解析没下载：count=0、files 空、kind 缺（界面据此写「未下载」）", () => {
    const [row] = groupWorks([parseRow(100)]);
    expect(row.count).toBe(0);
    expect(row.files).toEqual([]);
    expect(row.kind).toBeUndefined();
    expect(row.bytes).toBeUndefined();
  });

  it("图集的多文件仍是一行，files 按组内顺序合并", () => {
    const rows = groupWorks([
      { id: "i1", groupId: KEY, kind: "image", files: ["/tmp/1.jpg"], createdAt: 3 },
      { id: "i2", groupId: KEY, kind: "image", files: ["/tmp/2.jpg"], createdAt: 3 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, kind: "image" });
    expect(rows[0].files).toEqual(["/tmp/1.jpg", "/tmp/2.jpg"]);
  });
});

describe("groupWorks：老记录与顺序", () => {
  it("老记录没有 groupId：按 id 自成一行，不许与别的作品并进去", () => {
    const rows = groupWorks([
      { id: "h-legacy-1", files: ["/tmp/a.mp4"], createdAt: 1 },
      { id: "h-legacy-2", files: ["/tmp/b.mp4"], createdAt: 2 },
    ]);
    expect(rows.map((r) => r.key)).toEqual(["h-legacy-1", "h-legacy-2"]);
    expect(rows[0].kind).toBeUndefined();
  });

  it("保持入参顺序（store 新在前，列表就是新在前）", () => {
    const other = workKeyOf("https://v.douyin.com/xyz");
    const rows = groupWorks([
      { id: "b", groupId: other, files: [], createdAt: 5 },
      { id: "a", groupId: KEY, files: [], createdAt: 1 },
    ]);
    expect(rows.map((r) => r.key)).toEqual([other, KEY]);
  });

  it("标题全缺才写「（未命名）」；作者昵称缺失时退回 ID", () => {
    const rows = groupWorks([
      { id: "x1", files: [], createdAt: 1 },
      {
        id: "x2",
        files: [],
        createdAt: 1,
        author: { id: "19324001" },
      },
    ]);
    expect(rows[0].title).toBe("（未命名）");
    expect(rows[1].authorName).toBe("19324001");
  });
});

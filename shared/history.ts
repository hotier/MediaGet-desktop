/**
 * 历史记录的身份规则（业主指令 2026-10-17：历史页是**解析历史**，不是下载台账）。
 *
 * 「解析一次就有一条记录」之后，同一个作品必然同时存在一条解析行（没有文件）与若干
 * 下载行（每个落地文件一条）。它们必须是界面里的**一行**，所以行身份不能由写入方各自编，
 * 得由链接算出来 —— 这就是 `workKeyOf`：解析侧与下载侧分别写行、却算出同一个键。
 *
 * 零依赖：不 import zod / electron / node:crypto，主进程、渲染进程与 dev mock 共用同一份，
 * 所以 dev 预览里的历史形状与真版本一致（漂移 = 拿预览评审了一个不存在的界面）。
 */
import type { AuthorSnapshot, HistoryEntry } from "../types/ipc";

/** FNV-1a 32 位：纯算术、跨进程可复算，不需要 crypto */
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 作品键 = 分享链接的 64 位摘要（两段 32 位 FNV 拼起来）。
 *
 * 为什么是摘要而不是链接原文：它要当 `id`/`groupId` 用，而 `history:remove` 的键宽上限 64；
 * 为什么要 64 位而不是 32 位：撞上一次的后果是两个不相干的作品在历史页合成一行、
 * 文件数与作者互相污染，这类错在界面上永远查不出来。5000 条窗口下 32 位的碰撞概率已不可忽略。
 *
 * 归一交给上游：分享链接在 `identify` 那一步就已从文案里抽成同一条 URL，这里只 trim。
 */
export function workKeyOf(sourceUrl?: string | null): string | undefined {
  const url = (sourceUrl ?? "").trim();
  if (!url) return undefined;
  const a = fnv1a(url, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a(`${url}#mediaget`, 0x9e3779b9).toString(16).padStart(8, "0");
  return `w-${a}${b}`;
}

/**
 * 这一行有没有落地文件。
 * 「解析过但没下载」就是 files 为空 —— 不另设标志位：文件数既是历史页那一列，也就是事实本身。
 */
export const isLanded = (entry: { files: string[] }): boolean => entry.files.length > 0;

/**
 * 解析成功 → 一条历史行（未下载态）。
 *
 * 只取标题、平台与作者快照：**媒体直链一概不进这里**（隐私红线，`data.url` / `images[]` /
 * `qualities[].url` 都是直链）。放在共享层而不是主进程内联，是因为 dev mock 要写出同一形状的行，
 * 两处各写一遍迟早漏掉某个字段，而漏掉的字段在界面上只是「少了一块」，不会有人报错。
 */
export function parseHistoryEntry(input: {
  /** 用户输入的分享链接（identify 归一后的那条），非直链 */
  sourceUrl?: string;
  platform?: string;
  title?: string;
  author?: AuthorSnapshot;
  /** 链接算不出作品键时（ID 直解模式）由调用方给一次性 id */
  fallbackId: string;
  at: number;
}): HistoryEntry {
  const key = workKeyOf(input.sourceUrl);
  return {
    id: key ?? input.fallbackId,
    // 有作品键时 groupId 与 id 同值：聚合按 groupId，重复解析覆盖按 id，两条规则指向同一个作品
    groupId: key,
    platform: input.platform,
    title: input.title,
    sourceUrl: input.sourceUrl,
    author: input.author,
    files: [],
    createdAt: input.at,
  };
}

/**
 * 历史行 → 「复制作品信息」的正文。只做信息变形，不碰资源、不碰网络 ——
 * 历史页按分工只处理信息。作者快照的造法在 `shared/author.ts`（两侧都要写它）。
 */
import type { AuthorSnapshot } from "../../../types/ipc";
import { fmtCount, fmtCreated } from "./format";

export interface WorkInfoInput {
  title: string;
  /** 平台显示名（注册表 displayName 的结果，不直出契约 key） */
  platformName?: string;
  kindLabel?: string;
  fileCount?: number;
  createdAt?: number;
  sourceUrl?: string;
  author?: AuthorSnapshot;
}

/** 「复制作品信息」的正文 —— 一行一项，缺项不占行 */
export function buildWorkInfoText(i: WorkInfoInput): string {
  const lines: string[] = [`标题：${i.title}`];
  const a = i.author;
  if (a?.name) {
    const stats: string[] = [];
    if (a.followerCount != null) stats.push(`粉丝 ${fmtCount(a.followerCount)}`);
    if (a.followingCount != null) stats.push(`关注 ${fmtCount(a.followingCount)}`);
    if (a.totalFavorited != null) stats.push(`获赞 ${fmtCount(a.totalFavorited)}`);
    lines.push(`作者：${a.name}${stats.length > 0 ? `（${stats.join(" · ")}）` : ""}`);
  }
  if (i.author?.id) lines.push(`作者ID：${i.author.id}`);
  if (i.author?.url) lines.push(`作者主页：${i.author.url}`);
  if (i.platformName) lines.push(`平台：${i.platformName}`);
  if (i.kindLabel) lines.push(`类型：${i.kindLabel}`);
  if (i.fileCount != null) lines.push(`文件数：${i.fileCount} 个`);
  if (i.createdAt != null) lines.push(`创建时间：${fmtCreated(i.createdAt)}`);
  if (i.sourceUrl) lines.push(`分享链接：${i.sourceUrl}`);
  return lines.join("\n");
}

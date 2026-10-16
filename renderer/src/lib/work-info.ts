/**
 * 历史页的两个纯函数出口：解析结果 → 作者快照、历史行 → 复制文本。
 * 都只做信息变形，不碰资源、不碰网络 —— 历史页按分工只处理信息。
 */
import type { AuthorSnapshot, ParseData } from "../../../types/ipc";
import { fmtCount, fmtCreated } from "./format";

/**
 * 解析数据 → 作者快照。一个字段都没有时返回 undefined，而不是写一个空对象进历史：
 * 空对象会让历史页渲染出一个点不开任何信息的假昵称。
 */
export function buildAuthorSnapshot(data?: ParseData | null): AuthorSnapshot | undefined {
  if (!data) return undefined;
  const snap: AuthorSnapshot = {
    name: data.author || undefined,
    id: data.authorId || data.uid || undefined,
    url: data.authorUrl || undefined,
    avatar: data.avatar || undefined,
    sign: data.sign || undefined,
    // YouTube 只给 subscriberCount，与 B站/抖音的 followerCount 同义
    followerCount: data.followerCount ?? data.subscriberCount,
    followingCount: data.followingCount,
    totalFavorited: data.totalFavorited,
  };
  return Object.values(snap).some((v) => v !== undefined) ? snap : undefined;
}

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

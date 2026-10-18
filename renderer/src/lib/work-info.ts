/**
 * 历史行 → 「复制作品信息」的正文。只做信息变形，不碰资源、不碰网络 ——
 * 历史页按分工只处理信息。作者快照的造法在 `shared/author.ts`、计数与发布时间的归一在
 * `shared/work-stat.ts`（两侧都要写它们）。
 */
import type { AuthorSnapshot, WorkStat } from "../../../types/ipc";
import { workStatItems } from "../../../shared/work-stat";
import { fmtBytes, fmtCount, fmtCreated } from "./format";

export interface WorkInfoInput {
  title: string;
  /** 平台显示名（注册表 displayName 的结果，不直出契约 key） */
  platformName?: string;
  kindLabel?: string;
  fileCount?: number;
  /** 落地字节数；只下了一半也有，未下载的行是 0 */
  bytes?: number;
  /** 本机解析/落地那一刻（界面上那一列「时间」就是它） */
  createdAt?: number;
  /** 作品在平台上的发布时刻；老记录没有 → 这一行不出现，不拿 createdAt 冒充 */
  publishedAt?: number;
  /** 解析那一刻的公开互动数 */
  stat?: WorkStat;
  sourceUrl?: string;
  /** 落地目录（第一个文件的父目录），与表格档同一口径 */
  dir?: string;
  author?: AuthorSnapshot;
}

/**
 * 「复制作品信息」的正文 —— 一行一项，缺项不占行。
 *
 * 字段集与表格档 `EXPORT_COLUMNS` 对齐（业主指令 2026-10-17「作品详情的复制按钮复制的内容字段也和
 * 导出的信息一样」），**排版各归各**：八档计数在这一档合成一行「数据：…」，作者四项挂在昵称后面的
 * 括号里，数值走 `fmtCount`/`fmtBytes` 的量级缩写——粘进聊天框的文本要短。`tests/work-info.test.ts`
 * 有一条守卫把「表格加一列、忘了同步这里」变成红叉。
 */
export function buildWorkInfoText(i: WorkInfoInput): string {
  const lines: string[] = [`标题：${i.title}`];
  const a = i.author;
  if (a?.name) {
    const stats: string[] = [];
    if (a.followerCount != null) stats.push(`粉丝 ${fmtCount(a.followerCount)}`);
    if (a.followingCount != null) stats.push(`关注 ${fmtCount(a.followingCount)}`);
    if (a.totalFavorited != null) stats.push(`获赞 ${fmtCount(a.totalFavorited)}`);
    if (a.videoCount != null) stats.push(`投稿 ${fmtCount(a.videoCount)}`);
    lines.push(`作者：${a.name}${stats.length > 0 ? `（${stats.join(" · ")}）` : ""}`);
  }
  if (a?.id) lines.push(`作者ID：${a.id}`);
  if (a?.url) lines.push(`作者主页：${a.url}`);
  if (i.platformName) lines.push(`平台：${i.platformName}`);
  if (i.kindLabel) lines.push(`类型：${i.kindLabel}`);
  if (i.fileCount != null) lines.push(`文件数：${i.fileCount} 个`);
  // 未下载的行 bytes 恒为 0，那一档不写「0 B」——会被读成「下过但下坏了」，而它的意思是「还没下」
  if (i.bytes != null && i.bytes > 0) lines.push(`大小：${fmtBytes(i.bytes)}`);
  // 「数据」是**当时**的公开计数：计数会涨，重解析就刷新，所以这行等于给自己盖了个时间戳。
  const items = workStatItems(i.stat);
  if (items.length > 0) lines.push(`数据：${items.map((s) => `${s.label} ${fmtCount(s.value)}`).join(" · ")}`);
  if (i.publishedAt != null) lines.push(`发布时间：${fmtCreated(i.publishedAt)}`);
  // 与上面那行成对出现才读得懂：两个时间一个是作品发的、一个是本机记的，标签不能都叫「时间」
  if (i.createdAt != null) lines.push(`解析时间：${fmtCreated(i.createdAt)}`);
  if (i.sourceUrl) lines.push(`分享链接：${i.sourceUrl}`);
  if (i.dir) lines.push(`落地目录：${i.dir}`);
  return lines.join("\n");
}

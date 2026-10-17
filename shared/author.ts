/**
 * 作者快照：解析结果 → 历史/任务上挂的那份作者信息。
 *
 * 为什么从 `renderer/src/lib/work-info.ts` 提到 shared：写历史的两侧都要它 ——
 * 下载行由渲染层随 enqueue 的 meta 带上来，解析行由主进程在 parse 成功时直接造。
 * 抄第二份就会有两套「哪些字段算一个作者」，而差异只体现在历史页少显示一行，没人报错。
 *
 * 零依赖：只 import 类型（`types/ipc` 本身零运行时）。
 */
import type { AuthorSnapshot, ParseData } from "../types/ipc";

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

/**
 * 作者快照：解析结果 → 历史/任务上挂的那份作者信息。
 *
 * 为什么从 `renderer/src/lib/work-info.ts` 提到 shared：写历史的两侧都要它 ——
 * 下载行由渲染层随 enqueue 的 meta 带上来，解析行由主进程在 parse 成功时直接造。
 * 抄第二份就会有两套「哪些字段算一个作者」，而差异只体现在历史页少显示一行，没人报错。
 *
 * 零依赖：类型来自 `types/ipc`（本身零运行时），标量口径借同层的 `coerce.ts` ——
 * 那层同时被引擎出口的收拢器吃着，所以「快照里的作者字段长什么样」在写侧与读侧是同一份答案。
 */
import type { AuthorSnapshot, ParseData } from "../types/ipc";
import { toCount, toText } from "./coerce";

/**
 * 解析数据 → 作者快照。一个字段都没有时返回 undefined，而不是写一个空对象进历史：
 * 空对象会让历史页渲染出一个点不开任何信息的假昵称。
 *
 * 文本档走 `toText`：内核把 bilibili 的 `uid` 填成**数字** mid 时（源码见 `coerce.ts` 头部那条
 * 依据），契约声明的是字符串，兜底就是把它写成字符串 —— 旧口径「类型不符就丢空」会让历史页
 * 凭空少一格作者 ID，而少一格这件事没人报错。
 *
 * 三档计数走 `toCount`：小红书等把计数填成字符串，契约声明的是数字，纯数字串收下、`"1.2万"`
 * 这种已缩水的写法留空（宁可不写这一档，也不把近似值当真数导进 Excel）。
 */
export function buildAuthorSnapshot(data?: ParseData | null): AuthorSnapshot | undefined {
  if (!data) return undefined;
  const snap: AuthorSnapshot = {
    name: toText(data.author),
    id: toText(data.authorId) ?? toText(data.uid),
    url: toText(data.authorUrl),
    avatar: toText(data.avatar),
    // kuaishou 走 profile 补全时写的是 authorSign，与 sign 同义
    sign: toText(data.sign ?? data.authorSign),
    // YouTube 只给 subscriberCount，与 B站/抖音的 followerCount 同义
    followerCount: toCount(data.followerCount ?? data.subscriberCount),
    followingCount: toCount(data.followingCount),
    totalFavorited: toCount(data.totalFavorited),
    // kuaishou 的作品数平铺在 worksCount（匿名解析就能拿到），与 videoCount 同义
    videoCount: toCount(data.videoCount ?? data.worksCount),
  };
  return Object.values(snap).some((v) => v !== undefined) ? snap : undefined;
}

/**
 * 盘上存量 → 契约形状（读侧归一，与 `store.loadHistory` 的平台键归一同一条口径）。
 *
 * 写入口归一只管得住今后：`toText` 之前的那些行还躺在 `history.json` 里，数字 `id` 一个就够
 * 让整次 `history:list` 过不了出参校验。不在读侧兜住，就等于「一条老记录永久锁死一整页」，
 * 而且症状是空态不是报错。幂等，所以不必回写文件。
 */
export function normalizeAuthorSnapshot(
  raw?: AuthorSnapshot | null
): AuthorSnapshot | undefined {
  if (!raw) return undefined;
  const snap: AuthorSnapshot = {
    name: toText(raw.name),
    id: toText(raw.id),
    url: toText(raw.url),
    avatar: toText(raw.avatar),
    sign: toText(raw.sign),
    followerCount: toCount(raw.followerCount),
    followingCount: toCount(raw.followingCount),
    totalFavorited: toCount(raw.totalFavorited),
    videoCount: toCount(raw.videoCount),
  };
  return Object.values(snap).some((v) => v !== undefined) ? snap : undefined;
}

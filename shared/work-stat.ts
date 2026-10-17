/**
 * 作品计数与发布时间的归一层（业主指令 2026-10-17：导出要带完整作品信息）。
 *
 * 为什么要单独一层，而不是把内核那份 `ParseData` 直接存进历史：
 *
 * 1. **直链**。`data.url` / `images[]` / `qualities[].url` 都是媒体直链，隐私红线规定它们
 *    绝不落盘（ARCHITECTURE §6）。要留的只有公开的数字与发布时间，所以必须挑字段而不是搬对象。
 * 2. **各平台填法不一**。B站/抖音/小红书填 `stat.*`；推特填平铺 `retweets`/`replies`/`views`；
 *    YouTube 填 `channelViews`，而它的作者级数字是 `subscriberCount`。没有这一层，
 *    「点赞」在导出里会有三四种来源，界面与导出各写一套必然漂移。
 * 3. **发布时间是三套单位**（逐个 parser 核过，2026-10-17）：B站 `pubdate`、抖音 `create_time`、
 *    小红书 `noteData.time`、YouTube `published` 都是**秒**；Instagram `taken_at_timestamp * 1000`
 *    与推特 `Date.parse(created_at)` 是**毫秒**；微博直接给 **ISO 字符串**。
 *    所以这里按量级判单位，而不是照某个平台写死。
 *
 * 零依赖：只 import 类型（`types/ipc` 本身零运行时），主进程、渲染进程与 dev mock 共用同一份。
 */
import type { ParseData, WorkStat } from "../types/ipc";

/** 计数档位的顺序即导出列序与 txt 行序 —— 顺序在这里定一次，别处别再排 */
export const WORK_STAT_SLOTS: Array<{
  key: keyof WorkStat;
  label: string;
  /** 各平台的等价来源，按优先级排（stat 里的规范位优先，平铺字段兜底） */
  pick: (d: ParseData) => unknown;
}> = [
  { key: "view", label: "播放", pick: (d) => d.stat?.view ?? d.views ?? d.channelViews },
  { key: "danmaku", label: "弹幕", pick: (d) => d.stat?.danmaku },
  { key: "like", label: "点赞", pick: (d) => d.stat?.like ?? d.like },
  { key: "retweet", label: "转发", pick: (d) => d.retweets },
  { key: "reply", label: "评论", pick: (d) => d.stat?.reply ?? d.replies },
  { key: "favorite", label: "收藏", pick: (d) => d.stat?.favorite ?? d.favorite },
  { key: "coin", label: "投币", pick: (d) => d.stat?.coin },
  { key: "share", label: "分享", pick: (d) => d.stat?.share ?? d.share },
];

/** 原始计数 → 数字（作者快照那边同一条口径，故导出给 `shared/author.ts` 用）。
 *
 * 小红书等平台的 interactInfo 计数**是字符串**（内核注释写明「可能是字符串，保留原始值交给前端
 * 格式化」），其中 `"1.2万"` 这类已缩水的写法拿不回精确值 —— 宁可不写这一档，也不要把近似值
 * 当真实数字导出去（导出是要进 Excel 求和的）。所以只收「纯数字串与有限数字」。
 */
export function toCount(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw === "string" && raw.trim() !== "" && /^[+-]?\d+(\.\d+)?$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/** 解析结果 → 计数快照。一档都没有时返回 undefined，而不是写一个空对象进历史 */
export function pickWorkStat(data?: ParseData | null): WorkStat | undefined {
  if (!data) return undefined;
  const snap: WorkStat = {};
  for (const slot of WORK_STAT_SLOTS) {
    const n = toCount(slot.pick(data));
    if (n !== undefined) snap[slot.key] = n;
  }
  return Object.values(snap).some((v) => v !== undefined) ? snap : undefined;
}

/**
 * 解析结果 → 发布时刻（本地毫秒）。
 *
 * 单位靠量级判：`>= 1e12` 只可能是毫秒（1e12 ms 是 2001 年，而 1e12 秒是公元 33658 年，
 * 秒级时间戳不可能越过这个界）。低于它按秒处理。
 * 未来的时刻（含一天宽限）判为不可信 —— 各平台都会在某些分支填 0，字符串分支还可能解析出
 * 一个错年份，而「三年后发布」这种值一旦进档，界面上看着正常、导出的表却是错的。
 */
export function pickPublishedAt(
  data?: ParseData | null,
  now: number = Date.now()
): number | undefined {
  if (!data) return undefined;
  const ms = toMillis(data.time);
  if (ms === undefined) return undefined;
  return ms > now + 86_400_000 ? undefined : ms;
}

/**
 * 计数快照 → 按档位顺序展开的「标签 + 数值」项（缺的档不占位）。
 *
 * 「作品信息」正文与结果卡的那排计数徽标都走它：一处决定「哪一档叫什么、按什么顺序出现」，
 * 否则同一个数在屏幕上叫「点赞」、在 txt 里叫「喜欢」这类漂移就只是时间问题。
 */
export function workStatItems(
  stat?: WorkStat
): Array<{ key: keyof WorkStat; label: string; value: number }> {
  if (!stat) return [];
  const out: Array<{ key: keyof WorkStat; label: string; value: number }> = [];
  for (const slot of WORK_STAT_SLOTS) {
    const v = stat[slot.key];
    if (typeof v === "number") out.push({ key: slot.key, label: slot.label, value: v });
  }
  return out;
}

/** 秒 / 毫秒 / ISO 串 / 数字串 → 毫秒；0、空串、NaN 一律 undefined（缺就是缺，不猜） */
function toMillis(raw: ParseData["time"]): number | undefined {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return raw >= 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const t = raw.trim();
    if (/^\d+$/.test(t)) return toMillis(Number(t));
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

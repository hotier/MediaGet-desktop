/**
 * 缓存项的展示名与顺序（UI 侧真源）。
 * 主进程 `app:cacheStatus` 只出「键 + 字节」，所以「哪个键叫什么、按什么顺序摆」必须有唯一落点，
 * 否则改名就会出现同一个桶在两个页面上叫两个名字。消费方：设置页「本地缓存」卡。
 * （2026-10-21 业主定调：设置页去冗余 tooltip，原逐项清理行为说明随 `hint` 字段一并移除。）
 */
import type { CacheItemKey } from "../../../types/ipc";

export const CACHE_ITEMS: Array<{ key: CacheItemKey; label: string }> = [
  { key: "net", label: "网络缓存" },
  { key: "partials", label: "断点残留" },
  { key: "junk", label: "临时残留" },
  { key: "logs", label: "日志文件" },
  { key: "records", label: "本机记录" },
];

const LABEL: Record<string, string> = Object.fromEntries(CACHE_ITEMS.map((i) => [i.key, i.label]));

export const cacheLabel = (key: string): string => LABEL[key] ?? key;

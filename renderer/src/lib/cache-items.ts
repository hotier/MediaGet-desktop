/**
 * 缓存项的展示名与顺序（UI 侧真源）。
 * 主进程 `app:cacheStatus` 只出「键 + 字节」，所以「哪个键叫什么、按什么顺序摆」必须有唯一落点，
 * 否则改名就会出现同一个桶在两个页面上叫两个名字。消费方：设置页「本地缓存」卡。
 * `hint` 描述的是清理行为，只有设置页用得上。
 */
import type { CacheItemKey } from "../../../types/ipc";

export const CACHE_ITEMS: Array<{ key: CacheItemKey; label: string; hint: string }> = [
  { key: "net", label: "网络缓存", hint: "解析留下的 HTTP 副本；清掉只是让下次重新拉取，不动本机文件" },
  { key: "partials", label: "孤儿断点", hint: "下载目录里没人认领的 .part 续传文件；进行中的下载会被避让，不会被打断" },
  { key: "junk", label: "临时残留", hint: "配置原子写的半成品与坏档备份，正常路径下应为 0" },
  { key: "logs", label: "日志文件", hint: "见下方「日志」卡片；清理即删除当前文件与轮转出的历史分片" },
  { key: "update", label: "更新包缓存", hint: "自动更新的下载落点，由更新流程自管，这里只报占用" },
  { key: "records", label: "本机记录", hint: "设置 / 队列 / 历史是用户数据不是缓存，永不清理" },
];

const LABEL: Record<string, string> = Object.fromEntries(CACHE_ITEMS.map((i) => [i.key, i.label]));

export const cacheLabel = (key: string): string => LABEL[key] ?? key;

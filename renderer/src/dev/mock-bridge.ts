/**
 * 浏览器预览用假桥（dev-only）：没有 preload 注入时把 `window.mg` 换成夹具实现，
 * 让五页在普通浏览器里跑起来、能截图、能对稿改视觉。
 *
 * 边界：只喂「契约形态的数据」，不模拟内核正确性 —— 解析成功率、真实落盘、
 * 托盘、原生菜单、DWM 阴影仍然只能在 Electron 里验。生产构建不打包本文件
 * （main.tsx 里由 `import.meta.env.DEV` 分支动态 import）。
 */
import {
  DEFAULT_SETTINGS,
  type AppMeta,
  type AppSettings,
  type AuthorSnapshot,
  type BinaryStatusReport,
  type CacheClearResult,
  type CacheItemKey,
  type CacheStatus,
  type DownloadItem,
  type DownloadTaskView,
  type EngineHealth,
  type EnqueueInput,
  type EnqueueOutcome,
  type HistoryEntry,
  type IdentifyOutcome,
  type InvokeResult,
  type MgBridge,
  type ParseData,
  type ParseRunOutcome,
  type StatsSnapshot,
  type StatsDateRange,
  type StatsQueryResult,
  type UpdateState,
  type WorkStat,
} from "../../../types/ipc";
import {
  PLATFORMS,
  canonicalKeys,
  displayName,
  engineCoverage,
  isEnabled,
  isRegistered,
} from "../../../shared/platforms";
import { buildAuthorSnapshot } from "../../../shared/author";
import { isLanded, parseHistoryEntry, workKeyOf } from "../../../shared/history";
import { pageUrlFromData } from "../../../shared/source-url";
import { pickPublishedAt, pickWorkStat } from "../../../shared/work-stat";

const ok = <T,>(data: T): InvokeResult<T> => ({ ok: true, data });

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MB = 1024 * 1024;
const KB = 1024;

/** 纯色偏渐变占位图：同源 data URI，画布不被污染，魔法色提取在预览里也真实生效 */
function swatch(hue: number, w = 480, h = 640): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="hsl(${hue} 62% 46%)"/>` +
    `<rect y="${h * 0.55}" width="${w}" height="${h * 0.45}" fill="hsl(${(hue + 18) % 360} 70% 30%)"/>` +
    `<circle cx="${w * 0.72}" cy="${h * 0.26}" r="${w * 0.16}" fill="hsl(${(hue + 300) % 360} 80% 66%)"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ————————————————————————————————————————————————
// 解析夹具：按输入里的域名/关键词挑一种契约形态
// ————————————————————————————————————————————————

const XHS_IMAGES = Array.from({ length: 9 }, (_, i) => swatch(340 - i * 12, 640, 640));

/** 导出给纯函数回归测试：每种契约形态都要能展开成不重复、不静默降级的下载计划 */
export const FIXTURES: Record<string, { platform: string; data: ParseData }> = {
  bilibili: {
    platform: "bilibili",
    data: {
      type: "video",
      title: "【4K 修复】二十年前的城市夜景胶片，一帧一帧重新上色",
      desc: "素材来自本地存档，仅作技术演示。三连是给UP主最大的支持。",
      author: "胶片修复所",
      authorId: "19324001",
      avatar: swatch(205, 96, 96),
      cover: swatch(212, 480, 300),
      duration: 372,
      qualityLabel: "1080P",
      url: "https://mirror.example/bili/1080p.m4s",
      audioUrl: "https://mirror.example/bili/audio.m4s",
      qualities: [
        { quality: 1080, label: "1080P", url: "https://mirror.example/bili/1080p.m4s" },
        { quality: 720, label: "720P", url: "https://mirror.example/bili/720p.m4s" },
        { quality: 480, label: "480P", url: "https://mirror.example/bili/480p.m4s" },
      ],
      videos: [
        {
          title: "P1 夜景篇",
          url: "https://mirror.example/bili/p1-1080.m4s",
          duration: 372,
          qualities: [
            { quality: 1080, label: "1080P", url: "https://mirror.example/bili/p1-1080.m4s" },
            { quality: 720, label: "720P", url: "https://mirror.example/bili/p1-720.m4s" },
          ],
        },
        {
          title: "P2 街巷篇",
          url: "https://mirror.example/bili/p2-1080.m4s",
          duration: 415,
          qualities: [
            { quality: 1080, label: "1080P", url: "https://mirror.example/bili/p2-1080.m4s" },
            { quality: 720, label: "720P", url: "https://mirror.example/bili/p2-720.m4s" },
          ],
        },
        {
          title: "P3 幕后：调色台本",
          url: "https://mirror.example/bili/p3-default.m4s",
          duration: 268,
          qualities: [{ quality: 720, label: "720P", url: "https://mirror.example/bili/p3-720.m4s" }],
        },
      ],
      stat: { view: 1284503, danmaku: 8421, reply: 3120, favorite: 46800, coin: 21500, share: 9800, like: 98200 },
      tname: "影视剪辑",
    },
  },
  redbook: {
    platform: "redbook",
    data: {
      type: "image",
      title: "秋日通勤穿搭｜九张图拆到单品",
      desc: "外套 / 针织 / 半裙 / 包 / 鞋 全清单在图 9。链接都是同款不同色。",
      author: "小满的衣柜",
      avatar: swatch(20, 96, 96),
      cover: XHS_IMAGES[0],
      images: XHS_IMAGES,
      // 作品 ID：让预览里的「来源」也是官方笔记页，而不是用户贴进来的短链
      noteId: "66f0c1d2000000001e012345",
      stat: { view: 48200, like: 6120, reply: 380, favorite: 2900 },
    },
  },
  // 混合形态夹具：视频 + 图片 + 发布时间同时在场。旧的互斥分类会把它判成其中一种，
  // 通用骨架必须两样都留（业主点名的「有的是视频+图片」）。
  weibo: {
    platform: "weibo",
    data: {
      type: "video",
      title: "坝上草原的秋：一条航拍 + 九张实拍",
      desc: "视频是剪辑，图是同期拍的素材",
      author: "草原观察员",
      authorId: "6612345678",
      avatar: swatch(150, 96, 96),
      cover: swatch(150, 480, 300),
      duration: 96,
      url: "https://mirror.example/weibo/video.mp4",
      images: [swatch(140), swatch(155), swatch(170)],
      stat: { view: 231000, like: 18200, reply: 940, share: 1260 },
      time: "2026-10-10T12:30:00+08:00",
      ipRegion: "北京",
    },
  },
  douyin: {
    platform: "douyin",
    data: {
      type: "video",
      title: "一分钟讲清楚：为什么地铁上的手机信号会突然掉",
      desc: "#科普 #通信 无水印版本",
      author: "信号铺子",
      avatar: swatch(0, 96, 96),
      cover: swatch(348, 480, 640),
      duration: 62,
      url: "https://mirror.example/dy/play.m3u8",
      audioUrl: "https://mirror.example/dy/music.mp3",
      qualityLabel: "1080P",
      music: { author: "信号铺子", title: "原声 · 一分钟讲清楚", avatar: swatch(348, 96, 96) },
      core: "00:23-00:38",
      stat: { view: 2041000, like: 152300, reply: 4120, share: 30800 },
      awemeId: "7412000000000000000",
    },
  },
  youtube: {
    platform: "youtube",
    data: {
      type: "video",
      title: "Building a mechanical keyboard from scratch — full build log",
      videoId: "mgMockVid01",
      author: "Switch Lab",
      avatar: swatch(358, 96, 96),
      cover: swatch(12, 480, 270),
      duration: 1840,
      url: "https://mirror.example/yt/720p.mp4",
      qualityLabel: "720P",
      qualities: [
        { quality: 2160, label: "4K", url: "https://mirror.example/yt/2160p.mp4" },
        { quality: 1080, label: "1080P", url: "https://mirror.example/yt/1080p.mp4" },
        { quality: 720, label: "720P", url: "https://mirror.example/yt/720p.mp4" },
      ],
      subscriberCount: 412000,
      videoCount: 168,
      channelViews: 41200000,
      stat: { view: 512400, like: 28400, reply: 1900 },
      statsUnreliable: true,
    },
  },
  qsmusic: {
    platform: "qsmusic",
    data: {
      type: "music",
      title: "晚风合唱团 · 山海（现场版）",
      name: "山海（现场版）",
      author: "晚风合唱团",
      avatar: swatch(268, 96, 96),
      cover: swatch(272, 480, 480),
      duration: 254,
      audioUrl: "https://mirror.example/qq/try.mp3",
      lyrics: "写者迹／ 吹不散的痕迹……",
      core: "01:12-01:40",
      stat: { like: 902000, reply: 128000 },
    },
  },
  acfun: {
    platform: "acfun",
    data: {
      type: "text",
      title: "这个内容只提供官方嵌入播放",
      author: "A站搬运菌",
      embedOnly: true,
      embedUrl: "https://www.acfun.cn/player/acfn9999999",
    },
  },
};

function detectPlatform(text: string): string | null {
  const t = text.toLowerCase();
  // 域名表取自注册表（长域名优先，`music.douyin.com` 才不会被 `douyin.com` 抢走）：
  // 预览的识别面 = 产品边界，不再手抄一张六行小表，否则关掉的平台在预览里绕过闸门
  const ordered = [...PLATFORMS].sort(
    (a, b) => maxDomainLen(b) - maxDomainLen(a)
  );
  for (const p of ordered) {
    if ([...p.domains, ...p.shortDomains].some((d) => t.includes(d))) return p.key;
  }
  return null;
}

const maxDomainLen = (p: (typeof PLATFORMS)[number]): number =>
  Math.max(0, ...p.domains.map((d) => d.length), ...p.shortDomains.map((d) => d.length));

// 与内核 extractUrlFromShareText 同字符类：在中文标点/全角空格处截断（预览的识别 kind 才与真核一致）
const URL_RE = /https?:\/\/[^\s\u3000\u00A0，。！？、；：（）【】《》"'“”‘’<>]+/i;

// ————————————————————————————————————————————————
// 下载队列模拟
// ————————————————————————————————————————————————

type TaskCb = (t: DownloadTaskView) => void;
type EventName = "progress" | "done" | "error";

const events: Record<EventName, Set<TaskCb>> = {
  progress: new Set(),
  done: new Set(),
  error: new Set(),
};

let seq = 0;
const tasks: DownloadTaskView[] = [];
/** taskId → 收到多少字节后故意失败（用来演示失败态与重试） */
const failAt = new Map<string, number>();

function sizeOf(kind: DownloadItem["kind"], i: number): number {
  if (kind === "image") return (280 + i * 40) * KB;
  if (kind === "audio") return 6.4 * MB;
  if (kind === "video") return 96 * MB;
  return 3.2 * MB;
}

function speedOf(kind: DownloadItem["kind"]): number {
  if (kind === "image") return 420 * KB;
  if (kind === "audio") return 1.6 * MB;
  return 4.8 * MB;
}

function emit(name: EventName, t: DownloadTaskView): void {
  for (const cb of events[name]) cb({ ...t });
}

function makeTask(item: DownloadItem, groupId: string, input: EnqueueInput, i: number): DownloadTaskView {
  seq += 1;
  const taskId = `t-${seq}`;
  const t: DownloadTaskView = {
    taskId,
    groupId,
    url: item.url,
    filename: item.filename,
    kind: item.kind,
    status: "queued",
    received: 0,
    total: sizeOf(item.kind, i),
    speed: 0,
    // 平均速度的采样对（契约 v18）：tick 只在 downloading 时累加，暂停期间不长
    transferMs: 0,
    transferBytes: 0,
    platform: input.meta?.platform,
    title: input.meta?.title,
    sourceUrl: input.meta?.sourceUrl,
    author: input.meta?.author,
    createdAt: Date.now(),
  };
  if (/fail/i.test(item.filename)) failAt.set(taskId, t.total * 0.62);
  return t;
}

/** 并发上限内的 queued → downloading（真队列同语义） */
function promote(maxConcurrent: number): void {
  let active = tasks.filter((t) => t.status === "downloading").length;
  for (const t of tasks) {
    if (active >= maxConcurrent) break;
    if (t.status !== "queued") continue;
    t.status = "downloading";
    t.speed = speedOf(t.kind as DownloadItem["kind"]);
    active += 1;
    emit("progress", t);
  }
}

let ticker: ReturnType<typeof setInterval> | null = null;

function stopIfIdle(): void {
  if (tasks.some((t) => t.status === "downloading" || t.status === "queued")) return;
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

const history: HistoryEntry[] = [];

/**
 * 解析成功即记一行（与主进程 ipc.ts 的 parse:run 同一动作、同一个 `parseHistoryEntry`）。
 * 预览里历史页要能评审「解析过但没下载」那一态，否则这条链只在真窗口里看得见。
 */
function rememberParse(outcome: ParseRunOutcome, sourceUrl: string | undefined): void {
  const entry = parseHistoryEntry({
    sourceUrl,
    platform: outcome.result.platform,
    title: outcome.result.data?.title ?? outcome.result.data?.desc,
    author: buildAuthorSnapshot(outcome.result.data),
    publishedAt: pickPublishedAt(outcome.result.data),
    stat: pickWorkStat(outcome.result.data),
    fallbackId: `p-${Date.now().toString(36)}`,
    at: Date.now(),
  });
  const at = history.findIndex((h) => h.id === entry.id);
  if (at >= 0) history.splice(at, 1); // 重复解析覆盖那一条，不堆行（与 store.upsertHistory 同语义）
  history.unshift(entry);
  if (history.length > 50) history.length = 50;
}

function remember(t: DownloadTaskView): void {
  history.unshift({
    id: `h-${t.taskId}`,
    // 作品键优先：解析行与下载行才会在历史页聚成同一行（与主进程 index.ts 同一条）
    groupId: workKeyOf(t.sourceUrl) ?? t.groupId,
    platform: t.platform,
    title: t.title ?? t.filename,
    kind: t.kind,
    bytes: t.total,
    files: [t.filePath ?? t.filename],
    sourceUrl: t.sourceUrl,
    author: t.author,
    createdAt: Date.now(),
  });
  if (history.length > 50) history.length = 50;
}

/**
 * 预览用计数档（stats:get）：本会话真正落进 history 的行如实累加，另外叠 13 天
 * **确定性**合成活动 —— 只有「今天」这一份数据时，趋势与热力的形状根本没法自检。
 * 伪随机取 day 索引的模，不用 Math.random：截图与断言要可重现。
 * 边界：renderer 不吃 electron/main 的空档工厂，所以桶结构在这里照契约造一遍。
 */
function mockStats(): StatsSnapshot {
  const DAY = 86_400_000;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const keys = canonicalKeys();
  const kinds = ["video", "image", "audio", "file"] as const;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const keyOf = (at: number): string => {
    const d = new Date(at);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const snap: StatsSnapshot = {
    schema: 1,
    since: dayStart.getTime() - 13 * DAY,
    updatedAt: Date.now(),
    totals: {
      downloads: 0,
      failures: 0,
      canceled: 2,
      bytes: 0,
      elapsedMs: 0,
      elapsedCount: 0,
      elapsedBytes: 0,
    },
    parse: { total: 0, failures: 0, local: 0, online: 0, mock: 0, durationMs: 0 },
    byDay: {},
    byPlatform: {},
    byKind: {},
    byHour: new Array<number>(168).fill(0),
  };

  const platformRow = (platform: string): StatsSnapshot["byPlatform"][string] =>
    (snap.byPlatform[platform] ??= { downloads: 0, failures: 0, bytes: 0, parses: 0, parseFailures: 0 });
  const dayRow = (at: number): StatsSnapshot["byDay"][string] =>
    (snap.byDay[keyOf(at)] ??= { downloads: 0, failures: 0, bytes: 0, parses: 0 });

  const addDownload = (
    at: number,
    platform: string,
    kind: string,
    bytes: number,
    elapsedMs: number
  ): void => {
    const size = Math.max(0, Math.floor(bytes));
    snap.totals.downloads += 1;
    snap.totals.bytes += size;
    if (elapsedMs > 0) {
      snap.totals.elapsedMs += Math.floor(elapsedMs);
      snap.totals.elapsedCount += 1;
      snap.totals.elapsedBytes += size; // 与主进程同一条总线：平均速度只算有耗时样本的那部分
    }
    const kb = (snap.byKind[kind || "unknown"] ??= { downloads: 0, bytes: 0 });
    kb.downloads += 1;
    kb.bytes += size;
    const pb = platformRow(platform);
    pb.downloads += 1;
    pb.bytes += size;
    const db = dayRow(at);
    db.downloads += 1;
    db.bytes += size;
    const d = new Date(at);
    snap.byHour[d.getDay() * 24 + d.getHours()] += 1;
  };

  const addFailure = (at: number, platform: string): void => {
    snap.totals.failures += 1;
    platformRow(platform).failures += 1;
    dayRow(at).failures += 1;
  };

  const addParse = (
    at: number,
    platform: string,
    via: "local" | "mock",
    okParse: boolean,
    ms: number
  ): void => {
    snap.parse.total += 1;
    snap.parse[via] += 1;
    snap.parse.durationMs += Math.floor(ms);
    if (!okParse) snap.parse.failures += 1;
    const pb = platformRow(platform);
    pb.parses += 1;
    if (!okParse) pb.parseFailures += 1;
    dayRow(at).parses += 1;
  };

  for (let back = 13; back >= 1; back--) {
    const count = 2 + ((back * 5) % 9);
    for (let i = 0; i < count; i++) {
      const at = dayStart.getTime() - back * DAY + (7 + ((back + i) % 15)) * 3_600_000 + i * 900_000;
      const platform = keys[(back + i) % keys.length];
      addDownload(
        at,
        platform,
        kinds[(back * 2 + i) % kinds.length],
        8_000_000 + ((back * 3 + i) % 40) * 4_500_000,
        1_200 + ((back + i) % 20) * 900
      );
      addParse(at, platform, "local", i % 7 !== 3, 90 + ((back + i) % 12) * 55);
    }
    for (let f = 0; f < (back % 3); f++) {
      addFailure(dayStart.getTime() - back * DAY + 21 * 3_600_000, keys[(back + f) % keys.length]);
    }
  }
  // 本会话的真实行：历史页里有什么，统计页就该有什么 —— 但只有落地行算一次下载，
  // 解析行（files 为空）在主进程那边根本不进 stats.done，预览也不能把它数成文件
  for (const h of history) {
    if (!isLanded(h)) continue;
    addDownload(h.createdAt, h.platform ?? "", h.kind ?? "file", h.bytes ?? 0, 0);
  }

  return snap;
}

function mockStatsQuery(range: StatsDateRange): StatsQueryResult {
  const snapshot = mockStats();
  const start = new Date(...range.from.split("-").map(Number).map((value, index) => index === 1 ? value - 1 : value) as [number, number, number]);
  const end = new Date(...range.to.split("-").map(Number).map((value, index) => index === 1 ? value - 1 : value) as [number, number, number]);
  const byDay: StatsQueryResult["byDay"] = {};
  const totals: StatsQueryResult["totals"] = {
    downloads: 0, failures: 0, canceled: 0, bytes: 0, elapsedMs: 0,
    elapsedCount: 0, elapsedBytes: 0, parses: 0, parseFailures: 0,
  };
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const source = snapshot.byDay[key];
    const row = {
      downloads: source?.downloads ?? 0,
      failures: source?.failures ?? 0,
      canceled: 0,
      bytes: source?.bytes ?? 0,
      parses: source?.parses ?? 0,
      parseFailures: 0,
    };
    byDay[key] = row;
    totals.downloads += row.downloads;
    totals.failures += row.failures;
    totals.bytes += row.bytes;
    totals.parses += row.parses;
  }
  return {
    range,
    availableFrom: `${new Date(snapshot.since).getFullYear()}-${String(new Date(snapshot.since).getMonth() + 1).padStart(2, "0")}-${String(new Date(snapshot.since).getDate()).padStart(2, "0")}`,
    totals,
    byDay,
    byPlatform: Object.fromEntries(Object.entries(snapshot.byPlatform).map(([key, row]) => [key, {
      downloads: row.downloads, failures: row.failures, bytes: row.bytes, parses: row.parses, parseFailures: row.parseFailures,
    }])),
    byKind: snapshot.byKind,
    authors: [],
  };
}

function mockStatsGet(): Promise<InvokeResult<StatsSnapshot>>;
function mockStatsGet(range: StatsDateRange): Promise<InvokeResult<StatsQueryResult>>;
function mockStatsGet(range?: StatsDateRange): Promise<InvokeResult<StatsSnapshot | StatsQueryResult>> {
  return Promise.resolve(range ? ok(mockStatsQuery(range)) : ok(mockStats()));
}

function tick(): void {
  const stepSec = 0.2;
  for (const t of tasks) {
    if (t.status !== "downloading") continue;
    t.received = Math.min(t.total, t.received + t.speed * stepSec);
    // 与主进程同口径：只有真正在传的这段时长进平均速度的分母；暂停的 tick 根本不走这里
    t.transferMs += stepSec * 1000;
    t.transferBytes = t.received;
    const boom = failAt.get(t.taskId);
    if (boom !== undefined && t.received >= boom) {
      t.status = "error";
      t.speed = 0;
      // 「过期」归 note（主进程已换过一次链），error 只留服务器原话
      t.error = "HTTP 403 Forbidden";
      t.note = "直链已过期，已自动重新取链后仍失败";
      emit("error", t);
      continue;
    }
    if (t.received >= t.total) {
      t.status = "done";
      t.speed = 0;
      t.finishedAt = Date.now();
      t.filePath = `D:\\Downloads\\${t.filename}`;
      remember(t);
      emit("done", t);
      continue;
    }
    emit("progress", t);
  }
  stopIfIdle();
}

function startTicker(): void {
  if (!ticker) ticker = setInterval(tick, 200);
}

function seedQueue(): void {
  const input: EnqueueInput = {
    items: [],
    meta: { platform: "redbook", title: "秋日通勤穿搭｜九张图拆到单品", sourceUrl: "https://xhslink.com/mock" },
  };
  const gid = "g-seed-1";
  // 最后一条刻意是 paused：评审「暂停时保留速度与剩余」不用先去点一下暂停
  const seedStates = ["done", "done", "error", "downloading", "paused"] as const;
  seedStates.forEach((status, i) => {
    const t = makeTask(
      { url: `https://mirror.example/xhs/${i}.jpg`, filename: `秋日通勤穿搭-${i + 1}.jpg`, kind: "image" },
      gid,
      input,
      i
    );
    t.status = status;
    if (status === "done") {
      t.received = t.total;
      t.filePath = `D:\\Downloads\\${t.filename}`;
      t.finishedAt = Date.now() - (i + 1) * 47_000;
      // 完成行的平均速度 = transferBytes ÷ transferMs（契约 v18）。预览里把「传输时长」
      // 设成 20s 上下，创建时刻同时前移 —— 两个时间都要早于完成时刻才对得上台账
      t.createdAt = t.finishedAt - 20_000 - i * 3_000;
      t.transferMs = 20_000 + i * 3_000;
      t.transferBytes = t.total;
    }
    if (status === "error") {
      t.received = t.total * 0.62;
      t.error = "HTTP 403 Forbidden";
      t.note = "直链已过期，已自动重新取链后仍失败";
    }
    if (status === "downloading") {
      t.speed = speedOf("image");
      t.received = t.total * 0.34;
    }
    if (status === "paused") {
      // 暂停快照（契约 v17）：speed 留着不清，速度列与剩余列都按它结算
      t.speed = speedOf("image");
      t.received = t.total * 0.52;
      // 已经传了的这一截也带着自己的时长（v18）：继续下完时平均速度才对得上
      t.transferBytes = t.received;
      t.transferMs = (t.received / t.speed) * 1000;
    }
    tasks.push(t);
  });
  const video = makeTask(
    { url: "https://mirror.example/dy/play.m3u8", filename: "一分钟讲清楚：为什么地铁上的手机信号会突然掉.mp4", kind: "video" },
    "g-seed-2",
    {
      items: [],
      meta: { platform: "douyin", title: "一分钟讲清楚：为什么地铁上的手机信号会突然掉", sourceUrl: "https://v.douyin.com/mock" },
    },
    0
  );
  video.status = "downloading";
  video.speed = speedOf("video");
  video.received = video.total * 0.18;
  tasks.push(video);

  // 一条带作者快照、一条不带 —— 后者用来评审老记录（本版本之前写入）的优雅降级：
  // 缺作者、缺发布时间、缺互动计数，导出时那几格应当留空而不是补一个假值
  const seeds: Array<{
    platform: string;
    title: string;
    kind: string;
    bytes: number;
    file: string;
    author?: AuthorSnapshot;
    publishedAt?: number;
    stat?: WorkStat;
  }> = [
    {
      platform: "bilibili",
      title: "【4K 修复】二十年前的城市夜景胶片",
      kind: "video",
      bytes: 96 * MB,
      file: "二十年前的城市夜景胶片-1080P.mp4",
      publishedAt: Date.now() - 40 * 86_400_000,
      stat: { view: 1_284_503, danmaku: 8_421, like: 98_200, reply: 3_120, favorite: 46_800, coin: 21_500, share: 9_800 },
      author: {
        name: "胶片修复所",
        id: "19324001",
        url: "https://space.bilibili.com.example/19324001",
        avatar: swatch(205, 96, 96),
        sign: "每周一更，修复为主，不发广告。",
        followerCount: 1_284_000,
        followingCount: 312,
        totalFavorited: 8_600_000,
      },
    },
    {
      platform: "qsmusic",
      title: "晚风合唱团 · 山海（现场版）",
      kind: "audio",
      bytes: 6.4 * MB,
      file: "山海（现场版）.mp3",
    },
  ];
  for (const s of seeds) {
    history.push({
      id: `h-seed-${s.platform}`,
      platform: s.platform,
      title: s.title,
      kind: s.kind,
      bytes: s.bytes,
      files: [`D:\\Downloads\\${s.file}`],
      sourceUrl: `https://${s.platform}.example.com/mock`,
      author: s.author,
      publishedAt: s.publishedAt,
      stat: s.stat,
      createdAt: Date.now() - 36 * 3600_000,
    });
  }
  startTicker();
}

// ————————————————————————————————————————————————
// 更新状态机（假源：让 P6 的流式下载弹窗与设置页卡片在浏览器里也能评审）
// ————————————————————————————————————————————————

let updatePhase: UpdateState["phase"] = "idle";
let updatePercent = 0;
let updateSpeed: number | undefined;
let updateDownloaded = false; // 该版本是否已下完：下完后再次检测/下载不重演进度
let updateTimer: ReturnType<typeof setInterval> | null = null;
const updateCbs = new Set<(s: UpdateState) => void>();

const FAKE_CHANGELOG = [
  "v0.2.0 更新说明",
  "",
  "新增",
  "· 队列页重做：九列单行布局，主线程聚合行，状态徽标即动作按钮",
  "· 解析结果卡支持多清晰度预选与默认清晰度策略",
  "",
  "优化",
  "· 下载器流式落盘，单任务失败隔离，不再影响同组其他任务",
  "· 断点保留（keepPartials）与失败重试次数可在设置中调整",
  "",
  "修复",
  "· 修正快手等平台解析通道回归",
  "· 修复历史页作者列头像缺失",
].join("\n");

function updateSnapshot(err?: string): UpdateState {
  const total = 78 * MB;
  const showProgress =
    updatePhase === "downloading" || updatePhase === "downloaded" || updatePhase === "paused";
  const hasNew =
    updatePhase !== "idle" && updatePhase !== "up-to-date" && updatePhase !== "unsupported";
  return {
    phase: updatePhase,
    currentVersion: "0.1.0",
    availableVersion: hasNew ? "0.2.0" : undefined,
    percent: showProgress ? updatePercent : undefined,
    transferredBytes:
      updatePhase === "downloaded" ? total : Math.round((total * updatePercent) / 100),
    totalBytes: updatePhase === "available" ? undefined : total,
    bytesPerSecond: updatePhase === "downloading" ? updateSpeed : undefined,
    releaseNotes: hasNew ? FAKE_CHANGELOG : undefined,
    error: err,
    canCheck: true,
  };
}

function pushUpdate(err?: string): void {
  const s = updateSnapshot(err);
  for (const cb of updateCbs) cb(s);
}

/** 起一段进度流：从当前 updatePercent 继续推进，跑满 100% 落 downloaded。 */
function startUpdateTick(): void {
  if (updateTimer) return;
  updateSpeed = Math.round(3.6 * MB);
  updateTimer = setInterval(() => {
    updatePercent = Math.min(100, updatePercent + 9);
    if (updatePercent >= 100) {
      updatePhase = "downloaded";
      updateDownloaded = true;
      updateSpeed = undefined;
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = null;
    }
    pushUpdate();
  }, 420);
}

// ————————————————————————————————————————————————

/**
 * 预览用静态字体子集（真实枚举在主进程 font-list）；混排中英、按 zh 序近似排好。
 * 拉丁组末尾那几枚符号/图标字体（Segoe UI Symbol / Segoe MDL2 Assets / Symbol / Webdings / Wingdings）
 * 是故意留在名单里的：本机 `getFonts()` 实测 115 枚中就有这七枚，它们把 A–Z 重映射成图形，
 * 是「字体名画成乱码」那类缺陷的唯一复现素材，删掉就等于把最难看的用例从预览里藏起来。
 */
const MOCK_FONTS: string[] = [
  "Arial",
  "Cambria",
  "Consolas",
  "Courier New",
  "Georgia",
  "Microsoft JhengHei",
  "Microsoft Sans Serif",
  "Microsoft YaHei UI",
  "Segoe UI",
  "Segoe UI Variable Text",
  "Tahoma",
  "Times New Roman",
  "Verdana",
  "Segoe UI Symbol",
  "Segoe MDL2 Assets",
  "Symbol",
  "Webdings",
  "Wingdings",
  "等线",
  "仿宋",
  "黑体",
  "华文彩云",
  "华文行楷",
  "楷体",
  "宋体",
  "微软雅黑",
  "新宋体",
  "幼圆",
];

let settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  downloadDir: "D:\\Downloads",
  cookies: { BILIBILI_COOKIE: "***", IG_COOKIE: "***" },
};

// ————————————————————————————————————————————————
// 本机占用夹具（真扫描在主进程 cache.ts）：够设置页演「查看 → 清理 → 归零」
// ————————————————————————————————————————————————

const CACHE_LABEL_ORDER: CacheItemKey[] = ["net", "update", "partials", "junk", "logs", "records"];
/** 与主进程同一把尺：update（更新包由更新流程自管）与 records（用户数据不是缓存）不可清 */
const CACHE_CLEARABLE = new Set<CacheItemKey>(["net", "partials", "junk", "logs"]);

const mockCacheBytes: Record<CacheItemKey, number> = {
  net: 84 * MB,
  update: 78 * MB,
  partials: 6 * MB + 400 * KB,
  junk: 2 * KB,
  logs: 340 * KB,
  records: 96 * KB,
};

function mockCacheStatus(): CacheStatus {
  const items = CACHE_LABEL_ORDER.map((key) => ({
    key,
    bytes: Math.round(mockCacheBytes[key]),
    clearable: CACHE_CLEARABLE.has(key),
  }));
  return {
    items,
    totalBytes: items.reduce((n, i) => n + i.bytes, 0),
    clearableBytes: items.reduce((n, i) => n + (i.clearable ? i.bytes : 0), 0),
  };
}

const mockBridge: MgBridge = {
  getMeta: async () => ok<AppMeta>({ version: "0.1.0", electron: "34.0.0 (mock)", kernelMode: "local" }),

  identify: async ({ text }) => {
    const platform = detectPlatform(text);
    const url = text.match(URL_RE)?.[0] ?? null;
    return ok<IdentifyOutcome>({
      platform: platform ?? "",
      platformName: displayName(platform),
      url,
      kind: url ? (text.trim() === url ? "url" : "share-text") : "unknown",
    });
  },

  parse: async ({ text, platformHint }) => {
    await delay(560);
    const t = text.toLowerCase();
    if (t.includes("fail")) {
      return ok<ParseRunOutcome>({
        result: { code: 500, msg: "平台风控拦截：需要登录 Cookie 才能拿到清晰度列表", failType: "bot-gated" },
        via: "local",
        durationMs: 420,
      });
    }
    // 无链接的输入在内核侧就是 400（中文文案），预览也如实报错而不是兜底造一个 douyin 夹具
    if (!text.match(URL_RE)) {
      return ok<ParseRunOutcome>({
        result: { code: 400, msg: "未能从分享文案中提取到有效链接，请确认文案中包含视频分享链接" },
        via: "local",
        durationMs: 18,
      });
    }
    // 识别优先于 platformHint（与主引擎同规则：不把指鹿为马的提示当真）
    const key = detectPlatform(t) ?? platformHint ?? "douyin";
    // 供给闸门与主进程同源：注册表关掉的平台，不给它造出成功夹具
    if (isRegistered(key) && !isEnabled(key, settings.platformSwitches)) {
      return ok<ParseRunOutcome>({
        result: {
          code: 400,
          msg: `${displayName(key)}：解析已在设置里关闭（设置 → 引擎）`,
          platform: key,
        },
        via: "local",
        durationMs: 12,
      });
    }
    const fx = FIXTURES[key] ?? FIXTURES.douyin;
    const rawUrl = text.match(URL_RE)?.[0];
    const outcome: ParseRunOutcome = {
      // 平台按识别结果标：夹具正文只是替身，界面要画的是用户贴进来的那个平台
      result: { code: 200, msg: "解析成功", platform: key, data: structuredClone(fx.data) },
      via: "local",
      durationMs: key === "redbook" ? 38 : 168,
      // 真实资源页（与主进程同一口径）：夹具带作品 ID 时拼官方页面，否则保留输入链接
      sourceUrl: pageUrlFromData(key, fx.data) ?? rawUrl,
    };
    rememberParse(outcome, outcome.sourceUrl);
    return ok<ParseRunOutcome>(outcome);
  },

  download: {
    enqueue: async (input) => {
      const groupId = input.groupId ?? `g-${Date.now().toString(36)}`;
      const created = input.items.map((item, i) => {
        const t = makeTask(item, groupId, input, i);
        tasks.unshift(t);
        return t;
      });
      promote(settings.maxConcurrent);
      startTicker();
      return ok<EnqueueOutcome>({ taskIds: created.map((t) => t.taskId), groupId });
    },
    cancel: async (taskId) => {
      const t = tasks.find((x) => x.taskId === taskId);
      if (t) {
        t.status = "canceled";
        t.speed = 0;
        emit("progress", t);
        promote(settings.maxConcurrent);
      }
      return ok({ ok: true });
    },
    pause: async (taskId) => {
      const t = tasks.find((x) => x.taskId === taskId);
      if (t && (t.status === "downloading" || t.status === "queued")) {
        t.status = "paused";
        // 与主进程同语义（契约 v17）：speed 是暂停那一刻的快照，暂停后不清 —— 清了速度列与剩余列
        // 就一起变成「—」，暂停的行再也说不出「当时多快、还差多久」
        emit("progress", t);
        promote(settings.maxConcurrent);
      }
      return ok({ ok: true });
    },
    resume: async (taskId) => {
      const t = tasks.find((x) => x.taskId === taskId);
      if (t && (t.status === "paused" || t.status === "error" || t.status === "canceled")) {
        t.status = "queued";
        t.speed = 0; // 快照的寿命到「继续」为止：重新连上游时报旧速度就是说谎
        failAt.delete(taskId);
        t.error = undefined;
        promote(settings.maxConcurrent);
        startTicker();
      }
      return ok({ ok: true });
    },
    list: async () => ok(tasks.map((t) => ({ ...t }))),
    // 与主进程同语义：只移出终态行，queued/downloading 点名也不删
    clear: async (taskIds) => {
      const ids = new Set(taskIds);
      const keep = tasks.filter(
        (t) => !ids.has(t.taskId) || t.status === "queued" || t.status === "downloading"
      );
      const removed = tasks.length - keep.length;
      tasks.length = 0;
      tasks.push(...keep);
      return ok({ removed });
    },
    onProgress: (cb) => {
      events.progress.add(cb);
      return () => events.progress.delete(cb);
    },
    onDone: (cb) => {
      events.done.add(cb);
      return () => events.done.delete(cb);
    },
    onError: (cb) => {
      events.error.add(cb);
      return () => events.error.delete(cb);
    },
  },

  settings: {
    get: async () => ok(structuredClone(settings)),
    set: async (patch) => {
      // 与主进程 settingsSet 同语义：cookies 按 key 合并（""=清除，"***"=掩码回传不修改），不是整表替换
      const cookies = { ...settings.cookies };
      for (const [k, v] of Object.entries(patch.cookies ?? {})) {
        if (v === "***") continue;
        if (v === "") delete cookies[k];
        else cookies[k] = v;
      }
      settings = { ...settings, ...patch, cookies };
      return ok(structuredClone(settings));
    },
    // 假桥不开窗：延迟一拍后按「已登录」返回，并把该键置成掩码——
    // 只为让「抓取 → 已配置 → 保存」在预览里走得通，不代表真实抓取成功率。
    cookieLogin: async ({ cookieKey }) => {
      await new Promise((r) => setTimeout(r, 400));
      settings = { ...settings, cookies: { ...settings.cookies, [cookieKey]: "***" } };
      return ok({ captured: true, reason: "captured" as const });
    },
  },

  history: {
    list: async (filter) => {
      let rows = history.map((h) => ({ ...h }));
      if (filter?.platform) rows = rows.filter((h) => h.platform === filter.platform);
      if (filter?.limit) rows = rows.slice(0, filter.limit);
      return ok(rows);
    },
    // 与主进程 store.removeHistory 同口径：行键命中条目 id 或其 groupId 都删（选一行删整组）。
    // 界面上的「清空」也走这条（表头全选 = 可见全部行），v9 起没有独立的 clear 通道。
    remove: async (keys) => {
      const drop = new Set(keys);
      const kept = history.filter((h) => !(drop.has(h.id) || (h.groupId && drop.has(h.groupId))));
      history.length = 0;
      history.push(...kept);
      return ok(kept.map((h) => ({ ...h })));
    },
  },

  probe: {
    // 与主进程 engine.health() 同一条算式：注册表 × 引擎能力位 × 用户开关。
    // 假桥只假造数据，不假造能力 —— 预览里看到的三种真相必须和真应用措辞一致。
    engines: async () => {
      const able = (key: string): string[] => {
        const list: string[] = [];
        if (engineCoverage(key, "parseCore") === "ready") list.push("本地内核");
        return list;
      };
      const rows: EngineHealth[] = PLATFORMS.map((p, i) => {
        const covered = able(p.key);
        const supplied = isEnabled(p.key, settings.platformSwitches);
        return {
          platform: p.key,
          name: p.name,
          ok: supplied && covered.length > 0,
          detail: !supplied
            ? "注册表已关闭该平台（设置 → 引擎）"
            : covered.length > 0
              ? `可解引擎：${covered.join(" / ")}`
              : "无引擎今天声明可解",
          durationMs: 20 + i * 7,
        };
      });
      return ok<EngineHealth[]>(rows);
    },
  },

  stats: {
    get: mockStatsGet,
  },

  app: {
    pickDownloadDir: async () => ok("D:\\Downloads"),
    showInFolder: async () => ok({ ok: true }),
    // 预览里不模拟剪贴板轮询（真实行为只能在 Electron 里验）：订阅合法但永不触发
    onClipboardLink: () => () => {},
    // 镜像 dev 真实态：fetch-binaries 已落 resources/bin + manifest，dev 默认目录即该处 → 双 verified
    getBinaryStatus: async () =>
      ok<BinaryStatusReport>({
        manifestLoaded: true,
        packagedDir: "resources\\bin",
        binaries: [
          { name: "yt-dlp", available: true, origin: "extracted", path: "userData\\bin\\yt-dlp.exe", integrity: "verified" },
          { name: "ffmpeg", available: true, origin: "extracted", path: "userData\\bin\\ffmpeg.exe", integrity: "verified" },
        ],
      }),
    // 预览里字体枚举走静态子集（真实 font-list 只在 Electron 主进程跑），带小延迟以演「读取本机字体…」加载态
    listFonts: async () => {
      await delay(500);
      return ok<string[]>([...MOCK_FONTS]);
    },
    cacheStatus: async () => {
      await delay(220); // 真扫描要走磁盘，预览也演个短加载态
      return ok<CacheStatus>(mockCacheStatus());
    },
    clearCache: async (keys) => {
      await delay(320);
      const before = mockCacheStatus();
      const skipped = keys.filter((k) => !CACHE_CLEARABLE.has(k));
      for (const k of keys) if (CACHE_CLEARABLE.has(k)) mockCacheBytes[k] = 0;
      const report = mockCacheStatus();
      return ok<CacheClearResult>({ freed: before.totalBytes - report.totalBytes, skipped, report });
    },
    openLogDir: async () => ok({ ok: true }),
    openExternal: async () => ok({ ok: true }),
    // dev 预览跑在普通浏览器里（127.0.0.1 是安全上下文，且没有主进程那条 deny-all 权限钩子），
    // 所以这里直接写系统剪贴板：预览里点复制要真的复制得到，否则评审看不到成功态。
    // 写失败按原样 reject —— 调用方与真应用走同一条 catch 分支。
    copyText: async (text) => {
      await navigator.clipboard.writeText(text);
      return ok({ ok: true });
    },
    log: async () => ok({ ok: true }),
    update: {
      state: async () => ok(updateSnapshot()),
      check: async () => {
        updatePhase = "checking";
        pushUpdate();
        await delay(700);
        // 同版本已下好 → 直接回「已下载完成」，不退回 available 诱导重复下载
        updatePhase = updateDownloaded ? "downloaded" : "available";
        pushUpdate();
        return ok(updateSnapshot());
      },
      download: async () => {
        if (updateDownloaded || updatePhase === "downloaded") {
          updatePhase = "downloaded";
          updatePercent = 100;
          pushUpdate();
          return ok(updateSnapshot());
        }
        if (updatePhase !== "downloading") {
          updatePhase = "downloading";
          updatePercent = 0;
          pushUpdate();
        }
        startUpdateTick();
        return ok(updateSnapshot());
      },
      pause: async () => {
        if (updateTimer) {
          clearInterval(updateTimer);
          updateTimer = null;
        }
        updateSpeed = undefined;
        if (updatePhase === "downloading") {
          updatePhase = "paused";
          pushUpdate();
        }
        return ok(updateSnapshot());
      },
      resume: async () => {
        if (updatePhase === "paused") {
          updatePhase = "downloading";
          updatePercent = 0; // 无断点续传：恢复即从头重下
          pushUpdate();
          startUpdateTick();
        }
        return ok(updateSnapshot());
      },
      cancel: async () => {
        if (updateTimer) {
          clearInterval(updateTimer);
          updateTimer = null;
        }
        updateSpeed = undefined;
        updatePercent = 0;
        updateDownloaded = false; // 放弃下载：清除「已下完」标记，允许重新起流
        if (updatePhase === "downloading" || updatePhase === "paused") {
          updatePhase = "available";
          pushUpdate();
        }
        return ok(updateSnapshot());
      },
      install: async () => ok({ ok: true }),
      onState: (cb) => {
        updateCbs.add(cb);
        return () => updateCbs.delete(cb);
      },
    },
  },
};

/** 浏览器直开 vite 页面时安装；Electron 里 window.mg 已由 preload 注入，永不调用 */
export function installMockBridge(): void {
  window.mg = mockBridge;
  seedQueue();

  const badge = document.createElement("div");
  badge.textContent = "MOCK 预览 · 假桥（非真实解析/下载）";
  badge.setAttribute("data-mock-flag", "");
  badge.style.cssText = [
    "position:fixed",
    "right:10px",
    "bottom:10px",
    "z-index:9999",
    "font:11px/1.4 ui-monospace,monospace",
    "color:#f2f2f2",
    "background:#b4530f",
    "padding:4px 9px",
    "border-radius:999px",
    "opacity:.86",
    "pointer-events:none",
  ].join(";");
  document.body.append(badge);
}

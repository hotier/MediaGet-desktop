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
  type UpdateState,
} from "../../../types/ipc";
import {
  PLATFORMS,
  canonicalKeys,
  displayName,
  engineCoverage,
  isEnabled,
  isRegistered,
} from "../../../shared/platforms";

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
      stat: { view: 48200, like: 6120, reply: 380, favorite: 2900 },
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
  qqmusic: {
    platform: "qqmusic",
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

function remember(t: DownloadTaskView): void {
  history.unshift({
    id: `h-${t.taskId}`,
    groupId: t.groupId,
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
    via: "local" | "online" | "mock",
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
      addParse(at, platform, i % 6 === 5 ? "online" : "local", i % 7 !== 3, 90 + ((back + i) % 12) * 55);
    }
    for (let f = 0; f < (back % 3); f++) {
      addFailure(dayStart.getTime() - back * DAY + 21 * 3_600_000, keys[(back + f) % keys.length]);
    }
  }
  // 本会话的真实行：历史页里有什么，统计页就该有什么
  for (const h of history) addDownload(h.createdAt, h.platform ?? "", h.kind ?? "file", h.bytes ?? 0, 0);

  return snap;
}

function tick(): void {
  const stepSec = 0.2;
  for (const t of tasks) {
    if (t.status !== "downloading") continue;
    t.received = Math.min(t.total, t.received + t.speed * stepSec);
    const boom = failAt.get(t.taskId);
    if (boom !== undefined && t.received >= boom) {
      t.status = "error";
      t.speed = 0;
      t.error = "HTTP 403 Forbidden（直链已过期，重新解析后再下载）";
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
  const seedStates = ["done", "done", "error", "downloading", "queued"] as const;
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
    }
    if (status === "error") {
      t.received = t.total * 0.62;
      t.error = "HTTP 403 Forbidden（直链已过期，重新解析后再下载）";
    }
    if (status === "downloading") {
      t.speed = speedOf("image");
      t.received = t.total * 0.34;
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

  // 一条带作者快照、一条不带 —— 后者用来评审老记录（本版本之前写入）的优雅降级
  const seeds: Array<{ platform: string; title: string; kind: string; bytes: number; file: string; author?: AuthorSnapshot }> = [
    {
      platform: "bilibili",
      title: "【4K 修复】二十年前的城市夜景胶片",
      kind: "video",
      bytes: 96 * MB,
      file: "二十年前的城市夜景胶片-1080P.mp4",
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
      platform: "qqmusic",
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

/** 预览用静态字体子集（真实枚举在主进程 font-list）；混排中英、按 zh 序近似排好 */
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
          msg: `${displayName(key)}：解析已在设置里关闭（设置 → 引擎 → 平台能力）`,
          platform: key,
        },
        via: "local",
        durationMs: 12,
      });
    }
    const fx = FIXTURES[key] ?? FIXTURES.douyin;
    const online = t.includes("online");
    return ok<ParseRunOutcome>({
      // 平台按识别结果标：夹具正文只是替身，界面要画的是用户贴进来的那个平台
      result: { code: 200, msg: "解析成功", platform: key, data: structuredClone(fx.data) },
      via: online ? "online" : "local",
      fallbackReason: online ? "本地解析器未取得 vkey，已转线上回落通道" : undefined,
      durationMs: online ? 2140 : key === "redbook" ? 38 : 168,
    });
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
        t.speed = 0;
        emit("progress", t);
        promote(settings.maxConcurrent);
      }
      return ok({ ok: true });
    },
    resume: async (taskId) => {
      const t = tasks.find((x) => x.taskId === taskId);
      if (t && (t.status === "paused" || t.status === "error" || t.status === "canceled")) {
        t.status = "queued";
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
  },

  history: {
    list: async (filter) => {
      let rows = history.map((h) => ({ ...h }));
      if (filter?.platform) rows = rows.filter((h) => h.platform === filter.platform);
      if (filter?.limit) rows = rows.slice(0, filter.limit);
      return ok(rows);
    },
    clear: async () => {
      history.length = 0;
      return ok({ ok: true });
    },
  },

  probe: {
    // 与主进程 engine.health() 同一条算式：注册表 × 引擎能力位 × 用户开关。
    // 假桥只假造数据，不假造能力 —— 预览里看到的三种真相必须和真应用措辞一致。
    engines: async () => {
      const able = (key: string): string[] => {
        const list: string[] = [];
        if (engineCoverage(key, "parseCore") === "ready") list.push("本地内核");
        if (settings.fallbackOnline && engineCoverage(key, "onlineApi") === "ready") {
          list.push("线上 API");
        }
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
    get: async () => ok<StatsSnapshot>(mockStats()),
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

/**
 * 主进程入口（docs/ARCHITECTURE.md §2 index.ts）
 *
 * 应用生命周期 / 窗口 / 托盘 / 单实例锁。业务逻辑一律不在这里（只装配）。
 *
 * 安全（§6.4）：nodeIntegration:false、contextIsolation:true、sandbox:true、
 * webSecurity 不关、renderer 只加载本地文件。结果卡要预览的媒体经主进程 `mgpreview:`
 * 代理取流（preview-protocol.ts），渲染层自己仍然一条外链都不发。
 */
// ⚠️ 锁必须排第一条：storage-runtime 在模块求值时就会开库并跑迁移，锁晚于它等于让
// 第二个实例先写一遍库再退出。kernel-env 紧随其后：内核 xhs/bilibili/instagram 在模块作用域
// 读 Cookie，晚于 `./engine` 求值就永远读不到用户配置（2026-10-18 实测 cookieLen=0）。
import "./single-instance";
import "./kernel-env";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  Tray,
} from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { createEngine } from "./engine";
import { Downloader } from "./downloader";
import { createLinkRenewer } from "./link-renew";
import { queueDigest } from "./repositories";
import {
  closeStorage,
  historyRepository,
  isStorageClosed,
  migrationError,
  migrationReport,
  queueRepository,
  settingsRepository,
  statsRepository,
} from "./storage-runtime";
import { createStats } from "./stats";
import { profileSuffix, releaseChannel } from "./profile";
import { appUserModelIdOf } from "./release-channel";
import { createResources, readManifest } from "./resources";
import { createClipboardWatcher } from "./clipboard";
import { createDownloadNotifier } from "./notify";
import { createLogger } from "./logger";
import { createCacheProbe } from "./cache";
import { normalizeProxyUrl, proxyUrlFromRule, sessionProxyFor } from "./proxy";
import { createCookieLogin } from "./cookie-login";
import type { CookieLoginKey } from "../../shared/cookie-login";
import { DESKTOP_USER_AGENT, refererFor } from "./hotlink";
import { installPreviewProtocol, registerPreviewScheme } from "./preview-protocol";
import { TRACK_CACHE_TTL_MS, createTrackMerger } from "./media-merge";
import { SECRET_CONFIG_KEYS } from "../../core-adapter/config";
import { registerIpc } from "./ipc";
import { listInstalledFonts } from "./fonts";
import { createUpdater, pickAutoUpdater } from "./updater";
import { IPC, type DownloadTaskView, type HistoryEntry } from "../../types/ipc";
import { workKeyOf } from "../../shared/history";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const emit = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

// —— 单实例锁已在 single-instance.ts（本文件第一条 import）完成 ——

// Windows 通知/任务栏身份（beta 用 .beta 后缀：与安装器的 appId 同一份身份，见 release-channel.ts）
app.setAppUserModelId(appUserModelIdOf(releaseChannel));

// 预览取流的自定义 scheme：Chromium 在 ready 时就固化协议分类，这行必须在 whenReady 之前
registerPreviewScheme();

/**
 * 文件日志（设置→通用→日志）：userData/logs/app.log。
 * 级别与保留天数都从设置仓实时取 ⇒ 改设置即生效，不做进程级快照。
 * 启动先按保留天数清一次（比写第一行更早，避免「刚清完又留下一份旧的」）。
 */
const logger = createLogger({
  logDir: () => join(app.getPath("userData"), "logs"),
  getLevel: () => settingsRepository.loadConfig().settings.logLevel,
  getRetentionDays: () => settingsRepository.loadConfig().settings.logRetentionDays,
  mirrorConsole: isDev,
});

/**
 * 下载目录首次实体化（业主指令 2026-10-19：设置页要显示真路径，不是空串 + 占位提示）。
 *
 * `""` 的语义仍是「系统下载目录」（downloader 与缓存清理都按 `|| app.getPath("downloads")` 兜底），
 * 只是不再把它留白：启动时若还是空串，就写成本机真实路径，界面于是「填好了」。
 * 用户清空输入框点保存 = 回到跟随系统，下次启动会再落一次——空串始终是合法值，不是错误态。
 */
function materializeDownloadDir(): void {
  const cur = settingsRepository.loadConfig();
  if (cur.settings.downloadDir) return;
  settingsRepository.saveConfig({
    settings: { ...cur.settings, downloadDir: app.getPath("downloads") },
    kernel: cur.kernel,
  });
  // 只记「做过这件事」，不记路径本身（日志不进用户目录信息）
  logger.info("[settings] 下载目录已落为系统默认");
}
logger.pruneExpired();

// 迁移结果必须留痕：导入条数是「升级后历史还在不在」的唯一一行证据；
// 失败时源 JSON 未动、下次启动会重试，但用户必须能从日志知道这次没导进来。
if (migrationError) {
  logger.error(`[storage] 旧数据迁移未完成，本次按空库启动（源 JSON 已保留）：${migrationError}`);
} else {
  const imported = Object.entries(migrationReport.imported);
  if (imported.length > 0) {
    logger.info(
      `[storage] 旧数据已导入 SQLite：${imported.map(([source, rows]) => `${source} ${rows}`).join(" · ")}`
    );
  }
}

/**
 * 随包二进制目录（extraResources 落点）：
 * - prod：`process.resourcesPath/bin`
 * - dev：默认仓库 resources/bin（fetch-binaries.cjs 的落点，fetch 过即自动生效），
 *   MG_BIN_DIR 可覆盖；目录不存在时等价于「不自带」
 */
const packagedBinDir = isDev
  ? process.env.MG_BIN_DIR ?? join(app.getAppPath(), "resources", "bin")
  : typeof process.resourcesPath === "string"
    ? join(process.resourcesPath, "bin")
    : null;

/**
 * 随包图标目录（scripts/make-icons.cjs 从 `brand/` 母版产出 → extraResources 落 `resources/icons`）。
 * dev 直接吃仓库那份 ⇒ 改图标 = 重跑 `pnpm brand:assets` + 重启，不必重新打包。
 */
const iconDir = isDev
  ? join(app.getAppPath(), "resources", "icons")
  : typeof process.resourcesPath === "string"
    ? join(process.resourcesPath, "icons")
    : null;

/** 读一张随包图标；目录未知或文件缺失都返回空图，由调用方回落（图标不该阻断启动） */
function iconFromFile(name: string): Electron.NativeImage {
  if (!iconDir) return nativeImage.createEmpty();
  return nativeImage.createFromPath(join(iconDir, name));
}

/**
 * 完整性基线：随包 manifest.json（scripts/fetch-binaries.cjs 产出）。
 * 没有时 expectedHashes 为空 ⇒ 退回「只定位不校验」，并由
 * createResources().verified 如实汇报降级。
 */
const expectedHashes = readManifest(packagedBinDir, (m) => logger.warn(m)) ?? undefined;

const resources = createResources({
  userDataDir: app.getPath("userData"),
  packagedDir: packagedBinDir,
  readKernelConfig: (k) => settingsRepository.getKernelValue(k),
  expectedHashes,
  warn: (m) => logger.warn(m),
});

/**
 * 启动期如实汇报完整性档位（不静默降级）：缺 manifest 时应用仍能跑，
 * 但「只定位不校验」必须留下痕迹 —— 日志一条 + 设置页可见（app:getBinaryStatus）。
 */
if (!resources.verified) {
  logger.warn(
    "[resources] 未加载到随包 SHA-256 清单（manifest.json）：二进制仅定位、不校验完整性。" +
      "发布包不应出现此状态；本地开发用 `node scripts/fetch-binaries.cjs` 生成。"
  );
}

/**
 * 内核配置读取：用户自配 > （YTDLP/FFMPEG）资源定位自动值。
 * 内核 ytDlpClient 按 YTDLP_BIN 取二进制；随包释放后这里自动接上，
 * 未随包时 locate 返回 null → 不注入（TikTok 会解析失败；线上回落已于 2026-10-18 移除，没有转线上一说）。
 */
function readKernelConfig(key: string): string | undefined {
  const user = settingsRepository.getKernelValue(key);
  if (user) return user;
  if (key === "YTDLP_BIN") return resources.locate("yt-dlp")?.path;
  if (key === "FFMPEG_BIN") return resources.locate("ffmpeg")?.path;
  return undefined;
}

/**
 * 把「内核需要但从没拿到」的运行期配置铺进 process.env。
 *
 * 为什么必须在这一层做（两个独立事实叠出来的）：
 *  1. 内核多个模块在**模块作用域**读取 env 并固化 —— ytDlpClient.js:11
 *     `const YTDLP_CMD = (process.env.YTDLP_BIN || "yt-dlp")...`、
 *     instagram.js:18 `IG_COOKIE`、youtube.js:45 `YOUTUBE_API_KEY`。
 *  2. core-adapter/config 的 env 级只在 NODE_ENV=development 时开启
 *     （engine.ts:97 `allowEnv`），prod 下 config 层读不到 env。
 * 所以 prod 必须由主进程显式写 process.env，config 层只能算 dev 便利。
 *
 * 时序：engine 的核心入口是惰性 import（见 engine.ts loadCore 注释），
 * 首次求值推迟到第一次真正解析 —— 本函数在顶层同步执行，必定早于它。
 */
const publishedCookieKeys = new Set<string>();
/** 记录「我们铺进 env 的二进制路径」：用户改设置后要能覆盖，而 dev 手写的不动 */
const publishedBinaryKeys = new Set<string>();

function publishKernelEnv(): void {
  // —— 二进制路径：dev 显式设置的 env 优先；设置页改过的值要压过上次启动铺进去的旧值 ——
  for (const [envKey, cfgKey] of [
    ["YTDLP_BIN", "YTDLP_BIN"],
    ["FFMPEG_BIN", "FFMPEG_BIN"],
  ] as const) {
    const resolved = readKernelConfig(cfgKey);
    if (resolved) {
      if (!process.env[envKey] || publishedBinaryKeys.has(envKey)) {
        process.env[envKey] = resolved;
        publishedBinaryKeys.add(envKey);
      }
    } else if (publishedBinaryKeys.has(envKey)) {
      delete process.env[envKey];
      publishedBinaryKeys.delete(envKey);
    }
  }

  // —— 用户 Cookie：设置页是产品内的配置面，以它为准 ——
  // 只处理 SECRET_CONFIG_KEYS，避免任意设置键污染进程环境；
  // 只回收「我们自己铺过」的键，dev .env 里手写的 Cookie 不会被误删。
  const { settings } = settingsRepository.loadConfig();
  for (const key of SECRET_CONFIG_KEYS) {
    const value = settings.cookies?.[key];
    if (value) {
      process.env[key] = value;
      publishedCookieKeys.add(key);
    } else if (publishedCookieKeys.has(key)) {
      delete process.env[key];
      publishedCookieKeys.delete(key);
    }
  }
}
publishKernelEnv();

const engine = createEngine({
  readKernelConfig,
  getThrottleMs: () => settingsRepository.loadConfig().settings.throttleMs,
  // 供给开关读持久值（每次解析/体检各读一次）：渲染层 store 只是视图，不是第二本账
  getPlatformSwitches: () => settingsRepository.loadConfig().settings.platformSwitches,
  // 引擎开关同一处置：关掉的引擎不进选路与体检（与设置页「引擎开关」同一个真源）
  getEngineSwitches: () => settingsRepository.loadConfig().settings.engineSwitches,
  // 平台主引擎与回退开关（设置页「通道」下拉 + 「失败自动回退」）
  getPlatformEngines: () => settingsRepository.loadConfig().settings.platformEngines,
  getEngineFallback: () => settingsRepository.loadConfig().settings.engineFallback,
  // amagi 引擎的 Cookie 供给（每次解析现读，设置页保存后立即生效；只取用户自配，零硬编码）
  getCookies: () => settingsRepository.loadConfig().settings.cookies,
  // amagi 引擎的代理透传（manual 档才下发；system/direct 与非法地址都按直连，与 parse-core 的 hint 同口径）
  amagiGetProxyConfig: () => {
    const s = settingsRepository.loadConfig().settings;
    return { mode: s.proxyMode, url: s.proxyUrl };
  },
  // 解析失败现场落 app.log：结果卡只显示一句 msg，历史档不收失败行，排障只能靠这条。
  // 文本已在 engine.ts 过 `clipForLog`（压单行、截 300 字）；日志只落本机、不上传不外发，
  // 所以直链照原样留着——「哪条链 403」只能从现场看出来。
  log: (level, message) => logger[level](message),
});

/**
 * 「进行中」= 排队或正在下载（显式暂停不算）。关窗拦截与通知聚合共用同一把尺，
 * 避免「通知已结案但关窗仍被拦」这类两处判定漂移。
 */
const isActiveTask = (t: { status: DownloadTaskView["status"] }): boolean =>
  t.status === "queued" || t.status === "downloading";

/**
 * 系统通知（设置→通用→「系统通知」）：done/error 是文件粒度事件，聚合器按组
 * 收敛成一次播报（图集不逐张弹）；点击通知恢复窗口。
 */
const notifier = createDownloadNotifier({
  getPolicy: () => {
    const s = settingsRepository.loadConfig().settings;
    return { onDone: s.notifyOnDone, onError: s.notifyOnError };
  },
  hasActiveTask: (groupId) =>
    downloader.list().some((t) => t.groupId === groupId && isActiveTask(t)),
  show: ({ title, body }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on("click", showMainWindow);
    n.show();
  },
});

/**
 * 剪贴板监听（设置→通用→「复制链接自动填入」）：命中分享链接投事件给 renderer；
 * 开关保存即热更（registerIpc 的 onSettingsChanged）。
 */
const clipboardWatcher = createClipboardWatcher({
  readText: () => clipboard.readText(),
  identify: (text) => engine.identify(text),
  onLink: (link) => emit(IPC.evClipboardLink, link),
});
clipboardWatcher.setEnabled(settingsRepository.loadConfig().settings.clipboardWatch);

/** 全局唤起快捷键：任意界面按下 → 读剪贴板 → 本地识别 → 填首页输入框并唤起窗口 */
const CLIPBOARD_HOTKEY = "CommandOrControl+Alt+V";

/**
 * 快捷键**不**挂在 `clipboardWatch` 上：那个开关管的是「静默轮询剪贴板」，而按下即用户
 * 主动索取，语义不同，默认关着的开关不该顺手废掉一条显式入口。
 * 注册失败（键位已被别的程序占了）只记一条日志 —— 这是增强，不该弹窗打扰。
 * 必须在 app ready 之后调用（globalShortcut 的硬要求）。
 * 唤起窗口但不抢导航：用户停在队列/设置页时，链接按既有语义挂在待填队列，回到首页即填。
 */
function registerClipboardHotkey(): void {
  const ok = globalShortcut.register(CLIPBOARD_HOTKEY, () => {
    showMainWindow();
    clipboardWatcher.checkNow();
  });
  if (!ok) logger.warn(`[shortcut] ${CLIPBOARD_HOTKEY} 注册失败：键位可能已被其他程序占用`);
}

/**
 * 统计事件记录口（SQLite `stats_events`）：下载成败/取消与解析结果各落一行，
 * 统计页按日期范围聚合查询。事件与历史行在同一事务里写，二者不会一有一无。
 */
const stats = createStats({
  recordEvent: (event, historyEntry) => statsRepository.recordEvent(event, historyEntry),
  query: (range) => statsRepository.query(range),
  onEventError: () => logger.error("[stats] 统计事件写入失败"),
});

/**
 * DASH 双轨合流内核（预览与下载共用一份）。
 *
 * 产品规则：dash 的音频轨必须并进视频，交付的才是「一个完整的视频」。两处只是产物生命周期
 * 不同——预览进 temp 按哈希缓存、按 TTL 清；下载在下载目录里落 `.part` 并就地并流。
 * 这里的路径都是惰性求值的：模块加载时 app 还没 ready，取 `temp` 会炸。
 */
const trackMerger = createTrackMerger({
  getFfmpegPath: () => readKernelConfig("FFMPEG_BIN") ?? null,
  // dev 与打包版各清各的预览缓存：同一 URL 哈希会撞同一个文件，两边同时预览时
  // 一个进程的启动清理也可能删掉另一个正在播的产物
  cacheDir: () => join(app.getPath("temp"), `mediaget-media${profileSuffix}`),
  userAgent: DESKTOP_USER_AGENT,
  refererFor,
  // 失败原因已由内核把直链洗成 `<url>`：留一句给日志，排查「一直是转圈」时不再靠猜
  onFailure: (reason) => logger.warn(`[merge] ${reason}`),
});

const downloader = new Downloader({
  getDownloadDir: () =>
    settingsRepository.loadConfig().settings.downloadDir || app.getPath("downloads"),
  getMaxConcurrent: () => settingsRepository.loadConfig().settings.maxConcurrent,
  getRetryTimes: () => settingsRepository.loadConfig().settings.retryTimes,
  getKeepPartials: () => settingsRepository.loadConfig().settings.keepPartials,
  // 终态行落盘后从内存退休；重试/清理按 taskId 从 SQLite 取回或删除
  queue: {
    load: (taskId) => queueRepository.get(taskId),
    remove: (taskIds) => queueRepository.remove(taskIds),
  },
  // UA 治理照抄内核（lib/http.ts），不私自加码；与预览代理共用同一枚常量（hotlink.ts）
  defaultUserAgent: DESKTOP_USER_AGENT,
  // dash 双轨并流：与预览同一份内核。预览点过的那一对会直接复制缓存，省两轨下载
  tracks: trackMerger,
  // 直链到期（403）就顺着这条任务的分享链接重新取一次签名；认不出同一份资源则返回 null，
  // 交回原有重试与报错。合并与 TTL 都在 link-renew.ts，那边只报条数不打链（见该文件头部）。
  renewUrl: createLinkRenewer({
    reparse: async (sourceUrl) =>
      (await engine.parse(sourceUrl, undefined, undefined, { skipCache: true })).result.data,
  }),
  events: {
    progress: (t) => emit(IPC.evDownloadProgress, t),
    done: (t) => {
      emit(IPC.evDownloadDone, t);
      notifier.onTaskEvent("done", t);
      // 完成自动定位文件：默认关，开着并发下载会连环弹资源管理器（业主知情选择）
      if (settingsRepository.loadConfig().settings.openFolderOnDone && t.filePath) {
        shell.showItemInFolder(t.filePath);
      }
    },
    error: (t) => {
      emit(IPC.evDownloadError, t);
      notifier.onTaskEvent("error", t);
      stats.failure({ at: Date.now(), platform: t.platform, kind: t.kind, workKey: workKeyOf(t.sourceUrl) });
      // 失败是日志里最有价值的一类：文件名 + 原因 + 当前直链。日志只落本机、不外发
      // （§6 第 7 条），直链留着才分得清「签名失效」与「节点/CDN 问题」——剥掉它就只剩一句
      // 没法复现的「下载失败」。
      logger.error(`[download] ${t.filename} 失败: ${t.error ?? "未知原因"} url=${t.url ?? "-"}`);
    },
    persist: (tasks) => {
      // 关库后传输回调仍可能触发落盘：跳过，最后一批已在 closeStorage 的 flush 里写过
      if (!isStorageClosed()) queueRepository.saveMany(tasks);
    },
    history: ({ groupTask, files }) => {
      const entry: HistoryEntry = {
        id: groupTask.taskId,
        // 作品键（分享链接的摘要）优先：历史页一行 = 一个作品，解析行与它后续的下载行
        // 要落进同一行，靠的就是两侧从同一条链接算出同一个键。拿不到链接时退回本次
        // enqueue 的分组 id（老语义：一次批量一行）。
        groupId: workKeyOf(groupTask.sourceUrl) ?? groupTask.groupId,
        platform: groupTask.platform,
        title: groupTask.title ?? groupTask.filename,
        kind: groupTask.kind,
        bytes: groupTask.received,
        files,
        sourceUrl: groupTask.sourceUrl,
        author: groupTask.author,
        createdAt: Date.now(),
      };
      stats.done({
        at: groupTask.finishedAt ?? entry.createdAt,
        platform: groupTask.platform,
        kind: groupTask.kind,
        bytes: groupTask.received,
        elapsedMs:
          // 合流任务的 received 以落地文件为准（≈ 视频 + 音频 + 容器开销），与 transferBytes
          // 不再逐字节相等；平均速度仍然可算，别因此把它显示成「—」
          groupTask.transferMs > 0 ? Math.round(groupTask.transferMs) : undefined,
        workKey: entry.groupId,
        historyEntry: entry,
      });
    },
  },
});

/**
 * 内核态标记（app:getMeta / 关于页展示）：
 * - MG_KERNEL_MODE=mock → "mock"（离线骨架演示）
 * - 其余 → "local"：解析全在本机完成（线上回落在 2026-10-18 移除，
 *   不再按「抽取进度」猜测，避免为取 meta 提前求值内核）。
 * UI 里每条解析结果的 via 字段（local/mock）才是逐请求的真实通道。
 */
function kernelMode(): "local" | "mock" {
  return process.env.MG_KERNEL_MODE === "mock" ? "mock" : "local";
}

/**
 * 更新包缓存目录（只报占用，本模块从不清它 —— 见 cache.ts 规矩 1）。
 *
 * 路径公式取自 electron-updater（AppUpdater.js:550 `baseCachePath/<updaterCacheDirName || app.name>`），
 * 而 updaterCacheDirName 由 electron-builder 写进随包 app-update.yml（appInfo.js:126
 * = `sanitize(包名).toLowerCase() + "-updater"`），跟运行时 app.name（= productName）**不是同一个串**。
 * 因此优先读 yml，读不到才回落到 app.name；两处都对不上就是 0 —— 宁可少报，不可误删。
 */
function updaterCacheDir(): string | null {
  const base = (app as unknown as { baseCachePath?: string }).baseCachePath;
  if (!base) return null;
  const yml = join(
    typeof process.resourcesPath === "string" ? process.resourcesPath : app.getAppPath(),
    "app-update.yml"
  );
  try {
    const name = readFileSync(yml, "utf8").match(/^updaterCacheDirName:\s*(.+)$/m)?.[1]?.trim();
    if (name) return join(base, name.replace(/^["']|["']$/g, ""));
  } catch {
    /* 未打包 / 无 yml：走回落名 */
  }
  return join(base, app.getName());
}

const cache = createCacheProbe({
  session: () => session.defaultSession,
  userDataDir: () => app.getPath("userData"),
  downloadDir: () => settingsRepository.loadConfig().settings.downloadDir || app.getPath("downloads"),
  updaterCacheDir,
  livePartPaths: () => downloader.livePartPaths(),
  logs: logger,
});

// —— 自动更新（P6）——
// 状态机同步建好（未挂源时快照为 unsupported，dev 也读得到），更新源稍后异步挂：
// electron-updater 在模块加载时 require('electron')，必须动态 import；
// 且只有打包态才有发布通道 —— 未打包（dev、headless 测试）挂载等于对着
// 不存在的 latest.yml 发网络请求。
// 策略开关来自 AppSettings（设置→关于→更新策略）：启动检测 / 静默下载；安装固定走「立即重启」。
function updatePolicy(): { autoDownload: boolean } {
  return { autoDownload: settingsRepository.loadConfig().settings.updateAutoDownload };
}

/**
 * 开机自启（设置→通用→「启动」）：把偏好同步到系统登录项。
 * dev 不落注册表（否则写入的是 node_modules 里的 electron.exe 垃圾项），只存偏好，打包版生效；
 * 读-比-写：启动自愈（注册表被清理工具误删时恢复）+ 保存热更共用这一处，值一致时不写注册表。
 */
function applyLoginItem(enabled: boolean): void {
  if (!app.isPackaged) return;
  if (app.getLoginItemSettings().openAtLogin !== enabled) {
    app.setLoginItemSettings({ openAtLogin: enabled });
  }
}

/**
 * 网络代理（设置→下载→网络代理）→ 两套网络栈统一生效：
 * - Node fetch（解析内核 / 下载器）：undici 全局 dispatcher。Node 的 fetch
 *   不读系统代理也不读 HTTP_PROXY，必须显式挂 ProxyAgent；npm 版 undici 的
 *   setGlobalDispatcher 经全局符号与内置 undici 互通（node24 与 electron44 实测一致）。
 * - Electron net（更新器）：session.setProxy。system 模式本就走 Chromium 默认系统代理。
 * 幂等；启动（proxyReady）与设置保存（onSettingsChanged）各应用一次。
 * manual 地址非法/为空时回落直连（设置页有说明）；不 destroy 旧 agent，避免误杀在途下载连接。
 */
async function applyProxy(): Promise<void> {
  const settings = settingsRepository.loadConfig().settings;
  let nodeProxy: string | null = null;
  if (settings.proxyMode === "manual") {
    nodeProxy = normalizeProxyUrl(settings.proxyUrl);
  } else if (settings.proxyMode === "system") {
    try {
      // PAC 静态代理时结果与目标 URL 无关；动态 PAC 取对外流量口径
      nodeProxy = proxyUrlFromRule(await session.defaultSession.resolveProxy("https://github.com/"));
    } catch {
      nodeProxy = null;
    }
  }
  setGlobalDispatcher(nodeProxy ? new ProxyAgent(nodeProxy) : new Agent());
  await session.defaultSession.setProxy(sessionProxyFor(settings));
}

/** 代理初应用（随 app ready 起跑）：打包侧更新检查发起前先 await 它，别让检查跑在直连上 */
const proxyReady = app.whenReady().then(() => applyProxy());

const updater = createUpdater({
  currentVersion: app.getVersion(),
  // 通道判据同样是版本号：beta 只读 beta.yml 且允许 prerelease，稳定版只看 latest.yml。
  // 两边的 tag 过滤在 GitHubProvider 内部完成，这里只给策略。
  channel: releaseChannel === "beta" ? "beta" : "latest",
  allowPrerelease: releaseChannel === "beta",
  onChange: (state) => emit(IPC.evUpdateState, state),
});
updater.setPolicy(updatePolicy());

if (app.isPackaged) {
  void (async () => {
    await proxyReady; // 更新检查也吃用户代理
    try {
      // 不能解构 autoUpdater：打包后它只挂在命名空间的 default 上（见 pickAutoUpdater 注释）
      const mod = (await import("electron-updater")) as typeof import("electron-updater") & {
        default?: typeof import("electron-updater");
      };
      const autoUpdater = pickAutoUpdater(mod);
      if (!autoUpdater) throw new Error("electron-updater 未导出 autoUpdater");
      updater.attach(autoUpdater);
      // 启动检测开关关着就只挂源不检查；手动「检查更新」不受此开关限制
      if (settingsRepository.loadConfig().settings.updateOnStartup) {
        await updater.check(); // 静默检查一次，失败留在 error 由设置页重试
      }
    } catch (e) {
      // 无发布源 / electron-updater 不可用：保持 unsupported，不阻断启动。
      // 但失败必须留痕 —— 静默吞掉会让「永远没有更新源」查不出原因（2026-10-21 事故）。
      logger.warn(`[update] 更新源挂载失败，保持无源状态：${(e as Error).message || String(e)}`);
    }
  })();
}

/**
 * 设置写入后的副作用（`settings:set` 与「登录抓取 Cookie」共用这一条）。
 * 抽成具名函数是因为**第二条写入路径**出现了：抓取直接写档，若绕过这里，
 * 内核在模块作用域固化的 env 就还是旧 Cookie，症状恰好是「配了不生效」。
 */
function onSettingsChanged(): void {
  publishKernelEnv();
  updater.setPolicy(updatePolicy()); // 静默下载开关保存即热更
  clipboardWatcher.setEnabled(settingsRepository.loadConfig().settings.clipboardWatch); // 通知两开关是读取时求值，无需热更
  applyLoginItem(settingsRepository.loadConfig().settings.launchAtLogin); // 开机自启保存即同步系统登录项
  applyTitleBarOverlay(); // 明暗改完重贴按钮符号色（浅档配深符号，否则白符号消失在白底上）
  void applyProxy(); // 代理保存即热更（对新请求生效；在途连接不打断）
  logger.pruneExpired(); // 保留天数改完即清一次（级别是读取时求值，无需动作）
}

/** 登录抓取成功后写档：与 `settings:set` 的 cookies 分支同语义（settings.cookies + kernel 双写） */
function saveCapturedCookie(key: CookieLoginKey, header: string): void {
  const cur = settingsRepository.loadConfig();
  settingsRepository.saveConfig({
    settings: { ...cur.settings, cookies: { ...cur.settings.cookies, [key]: header } },
    kernel: { ...cur.kernel, [key]: header },
  });
}

const cookieLogin = createCookieLogin({
  saveCookie: saveCapturedCookie,
  onCaptured: onSettingsChanged,
  // 登录窗口跑在独立分区，不继承 defaultSession 的代理：按当前设置铺一次
  prepareSession: async (ses) => {
    await ses.setProxy(sessionProxyFor(settingsRepository.loadConfig().settings));
  },
  getParent: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  logger,
});

registerIpc({
  ipcMain,
  engine,
  downloader,
  settingsRepository,
  historyRepository,
  queueRepository,
  getAppMeta: () => ({ version: app.getVersion(), electron: process.versions.electron }),
  kernelMode,
  onSettingsChanged,
  cookieLogin,
  logger,
  cache,
  stats,
  updater,
  getBinaryStatus: () => ({
    manifestLoaded: resources.verified,
    packagedDir: packagedBinDir,
    binaries: resources.describe(),
  }),
  getFonts: () => listInstalledFonts(),
  // 复制动作由主进程代发：下面那条「所有权限请求一律拒」把渲染层的 navigator.clipboard
  // 整条挡死（Electron 把写剪贴板也报成 clipboard-read），而隐私面不接受为它开洞。
  writeClipboard: (text) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),
  // dev 里出参不符契约会当场报 contract-drift；打包版不为校验付代价
  validateOutputs: !app.isPackaged,
});

/**
 * 唤起主窗口：托盘点击、通知点击、二次启动、全局快捷键共用同一条恢复路径
 */
function showMainWindow(): void {
  // second-instance 在模块作用域注册，理论上可早于 ready 触发：那时 createWindow 还没有
  // 会话/协议/权限钩子可依赖，交给 whenReady 的常规启动路径即可
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 真退出：先放行关窗拦截（关窗=最小化到托盘），再走 app.quit */
function quitApp(): void {
  isQuitting = true;
  app.quit();
}

/**
 * 自定义顶栏（Windows · Window Controls Overlay）：`titleBarStyle:'hidden'` 让 web 内容顶到
 * 窗口上沿，只有最小化/最大化/关闭三枚按钮仍由系统画。选它而不是 `frame:false` 自绘：
 * 贴边最大化、Win11 悬停快照布局飞窗、读屏可达性都是系统给的，自绘要逐条重做，
 * 而且按钮几何由 DPI/缩放决定，猜出来的宽度一定和实际对不上。
 * 非 Windows 保持原生标题条：mac 的灯位与 Linux 的边框各有平台规矩，首发只在 Win 上改。
 */
const TITLEBAR_H = 40; // 与 renderer 的 --wco-h 同值：那条带就是按钮的家，高了对不齐
const usesWindowControlsOverlay = process.platform === "win32";

/** 按钮底色透明 → 融进我们那条带，hover 高亮仍由系统画；符号色取当前档正文墨色 */
function titleBarOverlay(): Electron.TitleBarOverlay {
  return {
    color: "#00000000",
    symbolColor: overlaySymbolColor(),
    height: TITLEBAR_H,
  };
}

/**
 * 符号色跟 styles.css 的墨色 token（暗 #e4e6e8 / 浅 #1b1e21）。主进程看不到 CSS，
 * 就按同一套解析规则自己算：theme=system 时读 nativeTheme —— 这正是 renderer 的
 * matchMedia 在 Electron 里跟随的同一个源，两处不会漂成两个答案。
 */
function overlaySymbolColor(): string {
  const theme = settingsRepository.loadConfig().settings.theme;
  const dark = theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors);
  return dark ? "#e4e6e8" : "#1b1e21";
}

/** 明暗或主题风格改完即刻重贴：不重贴的话浅档按钮符号是白的，直接看不见 */
function applyTitleBarOverlay(): void {
  if (!usesWindowControlsOverlay) return;
  mainWindow?.setTitleBarOverlay(titleBarOverlay());
}

function createWindow(): void {
  const winIcon = iconFromFile("window.png");
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: "MediaGet",
    icon: winIcon.isEmpty() ? undefined : winIcon,
    ...(usesWindowControlsOverlay && {
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlay(),
    }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // 外链一律交系统浏览器；renderer 不加载远程内容
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // 同页跳转也要挡：preload 会随每次导航重新注入，主窗口一旦被导航到远程页面，
  // `window.mg` 就交到了那页手里（sandbox/CSP 只是兜底，这是唯一把桥送出去的路径）。
  // 放行打包态的 file:// 与开发服务器自身的 origin，其余拦下并交系统浏览器。
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    let allowed = url.startsWith("file://");
    if (!allowed && isDev && devUrl) {
      try {
        allowed = new URL(url).origin === new URL(devUrl).origin;
      } catch {
        allowed = false;
      }
    }
    if (allowed) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(join(__dirname, "../../dist-renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 关窗即最小化到托盘（P5：下载中关窗=杀死全部任务，是用户可感知的最高伤害项）：
  // preventDefault 后窗口只是隐藏，进程与下载队列存活；托盘菜单/二次启动负责恢复。
  // 「下载中阻止退出」是默认行为、无开关：即便关了关窗最小化，有任务在跑也藏进托盘；
  // 真正的退出走托盘菜单（before-quit 置 isQuitting 放行）。
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    const busy = downloader.list().some(isActiveTask);
    const { settings } = settingsRepository.loadConfig();
    if (busy || (settings.minimizeToTray ?? true)) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

/** 托盘（关窗最小化的另一半）。图标缺失时用纯色 16px 图占位，不阻塞功能。 */
function createTray(): void {
  if (tray) return;
  const icon = iconFromFile("tray.png");
  const retina = iconFromFile("tray@2x.png");
  if (!icon.isEmpty() && !retina.isEmpty()) {
    // 150%/200% 缩放的托盘取 @2x 那一档；只给 16px 会被系统拉伸发糊
    const { width, height } = icon.getSize();
    icon.addRepresentation({ width: width * 2, height: height * 2, buffer: retina.toBitmap() });
  }
  tray = new Tray(icon.isEmpty() ? createFallbackTrayIcon() : icon);
  tray.setToolTip("MediaGet");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: showMainWindow },
      { type: "separator" },
      { label: "退出", click: quitApp },
    ])
  );
  tray.on("click", showMainWindow);
}

function createFallbackTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x2f; // B
    buf[i * 4 + 1] = 0x6f; // G
    buf[i * 4 + 2] = 0xed; // R（accent #2f6fed）
    buf[i * 4 + 3] = 255; // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

app.on("second-instance", showMainWindow);

app.whenReady().then(() => {
  // 迁移失败要看得见：否则用户只看到「历史/设置全没了」，而盘上的档其实还在。
  // 按空库继续启动而不是退出 —— 源 JSON 保留、下次启动重试，用户还能进来看日志。
  if (migrationError) {
    dialog.showErrorBox(
      "本地数据迁移未完成",
      `旧版 JSON 数据未能导入本机数据库，本次以空数据启动。原始文件仍保留在用户数据目录，下次启动会重试。\n\n${migrationError}`
    );
  }

  // 下载目录先落成真实路径，设置页才有值可显示（见本函数上方说明）
  materializeDownloadDir();

  // 桌面 UA/Referer 下载链路依赖主进程 fetch 的 UA；平台 Cookie 由内核按
  // core-adapter/config 注入，不经过 session cookie 库（隐私边界）。
  // 这条 deny-all 顺带挡死渲染层的 navigator.clipboard.writeText：Chromium 写剪贴板要过这条钩子，
  // 且 Electron 把写也报成 `clipboard-read`（无法只放行写）。所以复制走 `app:copyText` 由主进程
  // 代发，不放宽这里 —— 详见 types/ipc.ts 的 v11 注与 docs/UIUX-HANDOFF.md §6。
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  // 预览代理：ready 之后才装（protocol.handle 在就绪前调用会返回 false），scheme 特权已在模块期声明。
  // B站登录态的 dash 是 video-only 分片，靠同一份合流内核并上音频轨才能进 <video>；
  // 产物写系统 temp（不是 userData），启动时按 TTL 清一次，直链不进日志。
  installPreviewProtocol({ merger: trackMerger });
  void trackMerger.prune(TRACK_CACHE_TTL_MS);

  // 无应用菜单栏：Windows 用户不知道 Alt 后面是什么，菜单里的动作这里全有替代——
  // 编辑类由 Chromium 原生快捷键完成，退出与显示由托盘完成，重载 dev 走 detach 的开发者工具。
  // 设 null 而不是留个空 Menu：空 Menu 仍占一条菜单栏高度并把窗口往下推。
  Menu.setApplicationMenu(null);
  createWindow();
  createTray();
  registerClipboardHotkey();
  // theme=system 时系统换档不会走 settings 写入，按钮符号色得跟着 nativeTheme 走
  nativeTheme.on("updated", applyTitleBarOverlay);

  // 登录项与偏好对账（注册表被外部清理时随下次启动自愈）
  applyLoginItem(settingsRepository.loadConfig().settings.launchAtLogin);

  // 队列恢复：只取还要跑的行（排队/下载中/暂停）；终态台账留在 SQLite 里由队列页翻页
  const restoredQueue = queueRepository.loadRecoverable();
  downloader.restore(restoredQueue);

  // 启动留痕：只有报错的日志看不出「进程什么时候起过」，一行档期信息给排查一个锚点。
  // 队列那半写的是摘要（条数 + 状态分布）而不是光一个数：「恢复了 0 项」和
  // 「恢复了 5 项（done 5）」是两种完全不同的事故，前者才需要去追 queue_tasks 的写入方
  if (!app.isPackaged) logger.info(`[app] dev 档数据目录：${app.getPath("userData")}（与打包版隔离）`);
  logger.info(
    `[app] 启动 v${app.getVersion()} ${isDev ? "dev" : "packaged"} · 内核 ${kernelMode()} · 队列恢复 ${queueDigest(restoredQueue)}`
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  isQuitting = true;
  tray?.destroy();
  tray = null;
  notifier.dispose();
  clipboardWatcher.dispose();
  // 队列最后一笔先落库，再关库：WAL checkpoint(TRUNCATE) 让 -wal 不把最后一批写留在盘上。
  closeStorage(() => queueRepository.saveMany(downloader.snapshot()));
});

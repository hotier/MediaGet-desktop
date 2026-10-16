/**
 * 主进程入口（docs/ARCHITECTURE.md §2 index.ts）
 *
 * 应用生命周期 / 窗口 / 菜单 / 单实例锁。业务逻辑一律不在这里（只装配）。
 *
 * 安全（§6.4）：nodeIntegration:false、contextIsolation:true、sandbox:true、
 * webSecurity 不关、renderer 只加载本地文件。
 */
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { createEngine } from "./engine";
import { createOnlineFallback } from "./fallback";
import { Downloader } from "./downloader";
import { JsonStore } from "./store";
import { createResources, readManifest } from "./resources";
import { createClipboardWatcher } from "./clipboard";
import { createDownloadNotifier } from "./notify";
import { createLogger } from "./logger";
import { createCacheProbe } from "./cache";
import { normalizeProxyUrl, proxyUrlFromRule } from "./proxy";
import { SECRET_CONFIG_KEYS } from "../../core-adapter/config";
import { registerIpc } from "./ipc";
import { listInstalledFonts } from "./fonts";
import { createUpdater } from "./updater";
import { IPC, type DownloadTaskView, type HistoryEntry, type PersistedQueueTask } from "../../types/ipc";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const emit = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

// —— 单实例锁（深链/二次启动聚焦现有窗口）——
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Windows 通知/任务栏身份
app.setAppUserModelId("cc.hotier.mediaget.desktop");

// —— 装配 ——
// onError 用后绑定箭头：logger 本身要读 store，构造期还不能互相引用
const store = new JsonStore(app.getPath("userData"), (m) => logger.error(m));

/**
 * 文件日志（设置→通用→日志）：userData/logs/app.log。
 * 级别与保留天数都从 store 实时取 ⇒ 改设置即生效，不做进程级快照。
 * 启动先按保留天数清一次（比写第一行更早，避免「刚清完又留下一份旧的」）。
 */
const logger = createLogger({
  logDir: () => join(app.getPath("userData"), "logs"),
  getLevel: () => store.loadConfig().settings.logLevel,
  getRetentionDays: () => store.loadConfig().settings.logRetentionDays,
  mirrorConsole: isDev,
});
logger.pruneExpired();

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
 * 完整性基线：随包 manifest.json（scripts/fetch-binaries.cjs 产出）。
 * 没有时 expectedHashes 为空 ⇒ 退回「只定位不校验」，并由
 * createResources().verified 如实汇报降级。
 */
const expectedHashes = readManifest(packagedBinDir, (m) => logger.warn(m)) ?? undefined;

const resources = createResources({
  userDataDir: app.getPath("userData"),
  packagedDir: packagedBinDir,
  readKernelConfig: (k) => store.getKernelValue(k),
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
 * 未随包时 locate 返回 null → 不注入（TikTok 走线上回落）。
 */
function readKernelConfig(key: string): string | undefined {
  const user = store.getKernelValue(key);
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
 *     instagram.js:18 `IG_COOKIE`、qqmusic-id.js:31 `QQMUSIC_COOKIE`、
 *     youtube.js:45 `YOUTUBE_API_KEY`。
 *  2. core-adapter/config 的 env 级只在 NODE_ENV=development 时开启
 *     （engine.ts:97 `allowEnv`），prod 下 config 层读不到 env。
 * 所以 prod 必须由主进程显式写 process.env，config 层只能算 dev 便利。
 *
 * 时序：engine 的核心入口是惰性 import（见 engine.ts loadCore 注释），
 * 首次求值推迟到第一次真正解析 —— 本函数在顶层同步执行，必定早于它。
 */
const publishedCookieKeys = new Set<string>();

function publishKernelEnv(): void {
  // —— 二进制路径：dev 已显式设置的 env 优先（不覆盖开发者手配）——
  for (const [envKey, cfgKey] of [
    ["YTDLP_BIN", "YTDLP_BIN"],
    ["FFMPEG_BIN", "FFMPEG_BIN"],
  ] as const) {
    const resolved = readKernelConfig(cfgKey);
    if (resolved && !process.env[envKey]) process.env[envKey] = resolved;
  }

  // —— 用户 Cookie：设置页是产品内的配置面，以它为准 ——
  // 只处理 SECRET_CONFIG_KEYS，避免任意设置键污染进程环境；
  // 只回收「我们自己铺过」的键，dev .env 里手写的 Cookie 不会被误删。
  const { settings } = store.loadConfig();
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
  getThrottleMs: () => store.loadConfig().settings.throttleMs,
  isFallbackEnabled: () => store.loadConfig().settings.fallbackOnline,
  onlineFallback: createOnlineFallback({
    getBase: () => store.loadConfig().settings.onlineApiBase,
  }),
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
    const s = store.loadConfig().settings;
    return { onDone: s.notifyOnDone, onError: s.notifyOnError };
  },
  hasActiveTask: (groupId) =>
    downloader.list().some((t) => t.groupId === groupId && isActiveTask(t)),
  show: ({ title, body }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
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
clipboardWatcher.setEnabled(store.loadConfig().settings.clipboardWatch);

const downloader = new Downloader({
  getDownloadDir: () =>
    store.loadConfig().settings.downloadDir || app.getPath("downloads"),
  getMaxConcurrent: () => store.loadConfig().settings.maxConcurrent,
  getRetryTimes: () => store.loadConfig().settings.retryTimes,
  getKeepPartials: () => store.loadConfig().settings.keepPartials,
  // UA 治理照抄内核（lib/http.ts），不私自加码
  defaultUserAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  events: {
    progress: (t) => emit(IPC.evDownloadProgress, t),
    done: (t) => {
      emit(IPC.evDownloadDone, t);
      notifier.onTaskEvent("done", t);
      // 完成自动定位文件：默认关，开着并发下载会连环弹资源管理器（业主知情选择）
      if (store.loadConfig().settings.openFolderOnDone && t.filePath) {
        shell.showItemInFolder(t.filePath);
      }
    },
    error: (t) => {
      emit(IPC.evDownloadError, t);
      notifier.onTaskEvent("error", t);
      // 失败是日志里最有价值的一类：只投文件名与原因，**不投 url**（隐私红线：日志不落媒体直链）
      logger.error(`[download] ${t.filename} 失败: ${t.error ?? "未知原因"}`);
    },
    persist: (tasks) => store.saveQueueThrottled(tasks as PersistedQueueTask[]),
    history: ({ groupTask, files }) => {
      const entry: HistoryEntry = {
        id: groupTask.taskId,
        groupId: groupTask.groupId,
        platform: groupTask.platform,
        title: groupTask.title ?? groupTask.filename,
        kind: groupTask.kind,
        bytes: groupTask.received,
        files,
        sourceUrl: groupTask.sourceUrl,
        author: groupTask.author,
        createdAt: Date.now(),
      };
      store.appendHistory(entry);
    },
  },
});

/**
 * 内核态标记（app:getMeta / 关于页展示）：
 * - MG_KERNEL_MODE=mock → "mock"（离线骨架演示）
 * - 其余 → "local"：parse-core 统一入口注册表覆盖全平台，本地即主通道，
 *   线上回落只是异常逃生口（不再按「抽取进度」猜测，避免为取 meta 提前求值内核）。
 * UI 里每条解析结果的 via 字段（local/online/mock）才是逐请求的真实通道。
 */
function kernelMode(): "local" | "online" | "mock" {
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
  downloadDir: () => store.loadConfig().settings.downloadDir || app.getPath("downloads"),
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
  return { autoDownload: store.loadConfig().settings.updateAutoDownload };
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
 * - Node fetch（解析内核 / 下载器 / 线上回落）：undici 全局 dispatcher。Node 的 fetch
 *   不读系统代理也不读 HTTP_PROXY，必须显式挂 ProxyAgent；npm 版 undici 的
 *   setGlobalDispatcher 经全局符号与内置 undici 互通（node24 与 electron44 实测一致）。
 * - Electron net（更新器）：session.setProxy。system 模式本就走 Chromium 默认系统代理。
 * 幂等；启动（proxyReady）与设置保存（onSettingsChanged）各应用一次。
 * manual 地址非法/为空时回落直连（设置页有说明）；不 destroy 旧 agent，避免误杀在途下载连接。
 */
async function applyProxy(): Promise<void> {
  const { proxyMode, proxyUrl } = store.loadConfig().settings;
  let nodeProxy: string | null = null;
  let sessionProxy: Electron.ProxyConfig;
  if (proxyMode === "off") {
    sessionProxy = { mode: "direct" };
  } else if (proxyMode === "manual") {
    nodeProxy = normalizeProxyUrl(proxyUrl);
    sessionProxy = nodeProxy ? { mode: "fixed_servers", proxyRules: nodeProxy } : { mode: "direct" };
  } else {
    sessionProxy = { mode: "system" };
    try {
      // PAC 静态代理时结果与目标 URL 无关；动态 PAC 取对外流量口径
      nodeProxy = proxyUrlFromRule(await session.defaultSession.resolveProxy("https://github.com/"));
    } catch {
      nodeProxy = null;
    }
  }
  setGlobalDispatcher(nodeProxy ? new ProxyAgent(nodeProxy) : new Agent());
  await session.defaultSession.setProxy(sessionProxy);
}

/** 代理初应用（随 app ready 起跑）：打包侧更新检查发起前先 await 它，别让检查跑在直连上 */
const proxyReady = app.whenReady().then(() => applyProxy());

const updater = createUpdater({
  currentVersion: app.getVersion(),
  onChange: (state) => emit(IPC.evUpdateState, state),
});
updater.setPolicy(updatePolicy());

if (app.isPackaged) {
  void (async () => {
    await proxyReady; // 更新检查也吃用户代理
    try {
      const { autoUpdater } = await import("electron-updater");
      updater.attach(autoUpdater);
      // 启动检测开关关着就只挂源不检查；手动「检查更新」不受此开关限制
      if (store.loadConfig().settings.updateOnStartup) {
        await updater.check(); // 静默检查一次，失败留在 error 由设置页重试
      }
    } catch {
      /* 无发布源 / electron-updater 不可用：保持 unsupported，不阻断启动 */
    }
  })();
}

registerIpc({
  ipcMain,
  engine,
  downloader,
  store,
  getAppMeta: () => ({ version: app.getVersion(), electron: process.versions.electron }),
  kernelMode,
  onSettingsChanged: () => {
    publishKernelEnv();
    updater.setPolicy(updatePolicy()); // 静默下载开关保存即热更
    clipboardWatcher.setEnabled(store.loadConfig().settings.clipboardWatch); // 通知两开关是读取时求值，无需热更
    applyLoginItem(store.loadConfig().settings.launchAtLogin); // 开机自启保存即同步系统登录项
    void applyProxy(); // 代理保存即热更（对新请求生效；在途连接不打断）
    logger.pruneExpired(); // 保留天数改完即清一次（级别是读取时求值，无需动作）
  },
  logger,
  cache,
  updater,
  getBinaryStatus: () => ({
    manifestLoaded: resources.verified,
    packagedDir: packagedBinDir,
    binaries: resources.describe(),
  }),
  getFonts: () => listInstalledFonts(),
  // dev 里出参不符契约会当场报 contract-drift；打包版不为校验付代价
  validateOutputs: !app.isPackaged,
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: "即刻解析",
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
    const { settings } = store.loadConfig();
    if (busy || (settings.minimizeToTray ?? true)) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

/** 托盘（关窗最小化的另一半）。无随包托盘图标时用纯色 16px 图占位，不阻塞功能。 */
function createTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromPath(join(__dirname, "../../resources/tray.png"));
  const image = icon.isEmpty() ? nativeImage.createEmpty() : icon;
  tray = new Tray(image.isEmpty() ? createFallbackTrayIcon() : image);
  tray.setToolTip("即刻解析");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) createWindow();
          else {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show();
  });
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

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // 桌面 UA/Referer 下载链路依赖主进程 fetch 的 UA；平台 Cookie 由内核按
  // core-adapter/config 注入，不经过 session cookie 库（隐私边界）。
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  createWindow();
  createTray();

  // 登录项与偏好对账（注册表被外部清理时随下次启动自愈）
  applyLoginItem(store.loadConfig().settings.launchAtLogin);

  // 队列恢复（P2 验收：重启后队列/历史完整）
  const restoredQueue = store.loadQueue();
  downloader.restore(restoredQueue as PersistedQueueTask[]);

  // 启动留痕：只有报错的日志看不出「进程什么时候起过」，一行档期信息给排查一个锚点
  logger.info(
    `[app] 启动 v${app.getVersion()} ${isDev ? "dev" : "packaged"} · 内核 ${kernelMode()} · 队列恢复 ${restoredQueue.length} 项`
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  store.flush();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  tray?.destroy();
  tray = null;
  notifier.dispose();
  clipboardWatcher.dispose();
  store.saveQueueThrottled(downloader.snapshot() as PersistedQueueTask[]);
  store.flush();
});

/**
 * 主进程入口（docs/ARCHITECTURE.md §2 index.ts）
 *
 * 应用生命周期 / 窗口 / 菜单 / 单实例锁。业务逻辑一律不在这里（只装配）。
 *
 * 安全（§6.4）：nodeIntegration:false、contextIsolation:true、sandbox:true、
 * webSecurity 不关、renderer 只加载本地文件。
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray } from "electron";
import { join } from "node:path";
import { createEngine } from "./engine";
import { createOnlineFallback } from "./fallback";
import { Downloader } from "./downloader";
import { JsonStore } from "./store";
import { createResources, readManifest } from "./resources";
import { SECRET_CONFIG_KEYS } from "../../core-adapter/config";
import { registerIpc } from "./ipc";
import { IPC, type HistoryEntry, type PersistedQueueTask } from "../../types/ipc";

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
const store = new JsonStore(app.getPath("userData"));

/**
 * 随包二进制目录（extraResources 落点）：
 * - prod：`process.resourcesPath/bin`
 * - dev：MG_BIN_DIR 指向本地 resources/bin（或 null = 不自带）
 */
const packagedBinDir = isDev
  ? process.env.MG_BIN_DIR ?? null
  : typeof process.resourcesPath === "string"
    ? join(process.resourcesPath, "bin")
    : null;

/**
 * 完整性基线：优先用随包 manifest.json（scripts/fetch-binaries.cjs 产出），
 * 其次用 dev 目录下的同名清单。都没有时 expectedHashes 为空 ⇒ 退回
 * 「只定位不校验」，并由 createResources().verified 如实汇报降级。
 */
const expectedHashes =
  readManifest(packagedBinDir) ??
  (isDev ? readManifest(process.env.MG_BIN_DIR ?? null) : null) ??
  undefined;

const resources = createResources({
  userDataDir: app.getPath("userData"),
  packagedDir: packagedBinDir,
  readKernelConfig: (k) => store.getKernelValue(k),
  expectedHashes,
});

/**
 * 启动期如实汇报完整性档位（不静默降级）：缺 manifest 时应用仍能跑，
 * 但「只定位不校验」必须留下痕迹 —— 日志一条 + 设置页可见（app:getBinaryStatus）。
 */
if (!resources.verified) {
  console.warn(
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

const downloader = new Downloader({
  getDownloadDir: () =>
    store.loadConfig().settings.downloadDir || app.getPath("downloads"),
  getMaxConcurrent: () => store.loadConfig().settings.maxConcurrent,
  // UA 治理照抄内核（lib/http.ts），不私自加码
  defaultUserAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  events: {
    progress: (t) => emit(IPC.evDownloadProgress, t),
    done: (t) => emit(IPC.evDownloadDone, t),
    error: (t) => emit(IPC.evDownloadError, t),
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

registerIpc({
  ipcMain,
  engine,
  downloader,
  store,
  getAppMeta: () => ({ version: app.getVersion(), electron: process.versions.electron }),
  kernelMode,
  onSettingsChanged: publishKernelEnv,
  getBinaryStatus: () => ({
    manifestLoaded: resources.verified,
    packagedDir: packagedBinDir,
    binaries: resources.describe(),
  }),
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
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    const { settings } = store.loadConfig();
    if (settings.minimizeToTray ?? true) {
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

  // 队列恢复（P2 验收：重启后队列/历史完整）
  downloader.restore(store.loadQueue() as PersistedQueueTask[]);

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
  store.saveQueueThrottled(downloader.snapshot() as PersistedQueueTask[]);
  store.flush();
});

// —— 自动更新（P3 完整启用；这里挂骨架，无 update URL 时静默）——
void (async () => {
  if (isDev) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.on("update-available", (info) =>
      emit(IPC.evUpdateAvailable, { version: info.version })
    );
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      /* 无发布源/离线：静默 */
    });
  } catch {
    /* electron-updater 不可用不阻断启动 */
  }
})();

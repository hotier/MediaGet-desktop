/**
 * 主进程入口（docs/ARCHITECTURE.md §2 index.ts）
 *
 * 应用生命周期 / 窗口 / 菜单 / 单实例锁。业务逻辑一律不在这里（只装配）。
 *
 * 安全（§6.4）：nodeIntegration:false、contextIsolation:true、sandbox:true、
 * webSecurity 不关、renderer 只加载本地文件。
 */
import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { createEngine } from "./engine";
import { createOnlineFallback } from "./fallback";
import { Downloader } from "./downloader";
import { JsonStore } from "./store";
import { createResources } from "./resources";
import { registerIpc } from "./ipc";
import { IPC, type HistoryEntry, type PersistedQueueTask } from "../../types/ipc";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;
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
const resources = createResources({
  userDataDir: app.getPath("userData"),
  // 真实 Electron 下 resourcesPath 必有；桩/无头环境防御性回落 null（= 无 packaged 二进制）
  packagedDir: isDev
    ? process.env.MG_BIN_DIR ?? null
    : typeof process.resourcesPath === "string"
      ? join(process.resourcesPath, "bin")
      : null,
  readKernelConfig: (k) => store.getKernelValue(k),
});

/**
 * 内核配置读取：用户自配 > （YTDLP/FFMPEG）资源定位自动值。
 * 内核 ytDlpClient 按 YTDLP_BIN 取二进制；P3 随包释放后这里自动接上，
 * 未随包时 locate 返回 null → 不注入（TikTok 走线上回落）。
 */
function readKernelConfig(key: string): string | undefined {
  const user = store.getKernelValue(key);
  if (user) return user;
  if (key === "YTDLP_BIN") return resources.locate("yt-dlp")?.path;
  if (key === "FFMPEG_BIN") return resources.locate("ffmpeg")?.path;
  return undefined;
}

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
        platform: groupTask.platform,
        title: groupTask.title ?? groupTask.filename,
        files,
        createdAt: Date.now(),
      };
      store.appendHistory(entry);
    },
  },
});

/**
 * 内核态标记（app:getMeta / 关于页展示）：
 * - 本地已抽取平台 > 0 → "local"（识别与部分解析走本机内核，其余经线上回落补全）
 * - MG_KERNEL_MODE=mock → "mock"（离线骨架演示）
 * UI 里每条解析结果的 via 字段（local/online/mock）才是逐请求的真实通道。
 */
function kernelMode(): "local" | "online" | "mock" {
  if (process.env.MG_KERNEL_MODE === "mock") return "mock";
  return engine.localCoverage().length > 0 ? "local" : "online";
}

registerIpc({
  ipcMain,
  engine,
  downloader,
  store,
  getAppMeta: () => ({ version: app.getVersion(), electron: process.versions.electron }),
  kernelMode,
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
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // 桌面 UA/Referer 下载链路依赖主进程 fetch 的 UA；平台 Cookie 由内核按
  // core-adapter/config 注入，不经过 session cookie 库（隐私边界）。
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  createWindow();

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

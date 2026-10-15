/**
 * IPC handler 注册（docs/ARCHITECTURE.md §2 ipc.ts）
 *
 * 边界纪律：
 * - 所有入参先经 zod 校验（renderer 是不可信输入源），才进引擎/下载器；
 *   schema 不在本文件声明，唯一真源是 `types/ipc-contract.ts`（2026-10-14 单一真源改造）；
 * - 出参统一信封 `{ ok:true, data } | { ok:false, error:{ code, message, failType? } }`（§3）；
 *   dev 构建（`validateOutputs`）额外用 CONTRACT 的 out schema 校验出参 —— 契约漂移要
 *   当场炸，不能让 UI 拿到形状不对的数据后静默降级；
 * - 不在此直接调平台解析器 —— 一律经 engine；Referer/域名信息取自内核
 *   PLATFORM_INFO，不复制域名表（§4 防盗链）。
 */
import { z } from "zod";
import { shell } from "electron";
import { PLATFORM_INFO, sanitizeFilename } from "@mediaget/parse-core";
import {
  describeIssues,
  CacheClearInputSchema,
  EnqueueInputSchema,
  FolderPathSchema,
  HistoryFilterSchema,
  IdentifyInputSchema,
  LogWriteInputSchema,
  ParseInputSchema,
  SettingsPatchSchema,
  TaskIdInputSchema,
  CONTRACT,
} from "../../types/ipc-contract";
import {
  IPC,
  DEFAULT_SETTINGS,
  type AppMeta,
  type AppSettings,
  type BinaryStatusReport,
  type CacheStatus,
  type EngineHealth,
  type EnqueueOutcome,
  type HistoryEntry,
  type InvokeResult,
  type UpdateState,
} from "../../types/ipc";
import type { createEngine } from "./engine";
import type { Downloader } from "./downloader";
import type { JsonStore } from "./store";
import type { Updater } from "./updater";
import type { CacheProbe } from "./cache";
import type { AppLogger } from "./logger";
import type { IpcMainLike } from "./ipc-env";

type Engine = ReturnType<typeof createEngine>;

/**
 * 从 wrap 的 schema 实参反推 handler 的入参类型。
 *
 * 为什么不直接把 schema 声明成 `z.ZodTypeAny | null`：那样会抹掉推断，
 * 每个 handler 都要自己写类型断言 —— 契约就白单一次源了。
 * 传 null（无入参通道）时落到 unknown。
 */
type InOf<S> = S extends z.ZodTypeAny ? z.infer<S> : unknown;

function ok<T>(data: T): InvokeResult<T> {
  return { ok: true, data };
}
function fail(code: string, message: string, failType?: string): InvokeResult<never> {
  return { ok: false, error: { code, message, failType } };
}

/** 平台 → 防盗链 Referer（域名真源 = 内核 PLATFORM_INFO） */
function refererFor(platform: string | undefined): string | undefined {
  if (!platform) return undefined;
  const info = (PLATFORM_INFO as Record<string, { domains: string[] }>)[platform];
  return info?.domains?.[0] ? `https://${info.domains[0]}/` : undefined;
}

export interface IpcRegistryDeps {
  ipcMain: IpcMainLike;
  engine: Engine;
  downloader: Downloader;
  store: JsonStore;
  getAppMeta: () => { version: string; electron: string };
  kernelMode: () => AppMeta["kernelMode"];
  /**
   * 设置写入后的副作用钩子（index.ts 注入 = publishKernelEnv）。
   * 存在的理由：内核在**模块作用域**固化 process.env 里的 Cookie，
   * 用户在设置页改 Cookie 后必须把新值铺回 process.env，否则要重启才生效。
   */
  onSettingsChanged?: () => void;
  /**
   * 随包二进制完整性状态提供者（index.ts 注入 = resources.describe）。
   * 存在的理由：manifest 缺失会让运行时静默降级为「只定位不校验」——
   * 把状态暴露给 UI 才谈得上「降级可见」。
   */
  getBinaryStatus?: () => BinaryStatusReport;
  /**
   * 本机字体枚举（index.ts 注入 = fonts.listInstalledFonts，进程内缓存）。
   * 缺省（未注入 / 非 win / 枚举失败）→ 返回空数组，UI 回落「系统默认」占位不报错。
   */
  getFonts?: () => Promise<string[]>;
  /**
   * 文件日志（index.ts 注入 = createLogger）。存在的理由：渲染层的异常在主进程
   * 视角是看不见的，给它一条「写到同一个日志文件」的路，才谈得上「日志」两处合一；
   * 「打开日志目录」也经这里取目录，避免第二处路径真源。
   */
  logger: AppLogger;
  /** 本机占用统计与清理（index.ts 注入 = createCacheProbe） */
  cache: CacheProbe;
  /**
   * 自动更新状态机（index.ts 注入 = createUpdater）。
   * update:check/download 内部吞错并把结果收敛进快照，因此恒返回成功信封；
   * update:install 只在 downloaded 下有效，其余情况由快照守卫（UI 不提供按钮）。
   */
  updater: Updater;
  /**
   * dev 构建 = true（index.ts 传 `!app.isPackaged`）：出参也过 CONTRACT 的 out schema。
   * 存在的理由：契约漂移在 dev 里只会让 UI 少显示一个字段、没人报错，
   * 到打包版本才暴露；把它变成 dev 期的一次 `contract-drift` 错误才是划算的顺序。
   */
  validateOutputs: boolean;
}

export function registerIpc(deps: IpcRegistryDeps): void {
  const { ipcMain, engine, downloader, store, updater } = deps;

  /**
   * 统一注册：入参按 schema 校验（renderer 是不可信输入源），出参在 dev 下按
   * CONTRACT 校验，错误一律收敛成信封。文案沿用 `path: message; …` 格式 ——
   * 设置页要把它拆到字段级内联提示（docs/UIUX-DESIGN.md §错误三层）。
   */
  const wrap =
    <S, Out>(channel: keyof typeof CONTRACT, inSchema: S, handler: (input: InOf<S>) => Out | Promise<Out>) => {
      ipcMain.handle(channel, async (_event, input: unknown) => {
        try {
          const parsed = (inSchema === null
            ? undefined
            : (inSchema as z.ZodTypeAny).parse(input)) as InOf<S>;
          const data = await handler(parsed);
          if (deps.validateOutputs) {
            try {
              CONTRACT[channel].out.parse(data);
            } catch (e) {
              // 出参漂移单列 code：它不是用户输入错，改的是主进程/契约
              return fail("contract-drift", `${channel} 出参不符契约：${describeIssues(e as z.ZodError)}`);
            }
          }
          return ok(data);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return fail("bad-input", describeIssues(e));
          }
          const err = e as { failType?: string; message?: string };
          return fail("internal", err.message || String(e), err.failType);
        }
      });
    };

  // —— app:getMeta ——
  wrap<unknown, AppMeta>(IPC.appGetMeta, null, () => {
    const meta = deps.getAppMeta();
    return {
      version: meta.version,
      electron: meta.electron,
      kernelMode: deps.kernelMode(),
      platforms: engine.platforms(),
    };
  });

  // —— parse:identify（纯识别，不发起抓取）——
  wrap(IPC.parseIdentify, IdentifyInputSchema, ({ text }) => engine.identify(text));

  // —— parse:run（统一入口）——
  wrap(IPC.parseRun, ParseInputSchema, async (parsed) =>
    engine.parse(parsed.text, parsed.source, parsed.id, {
      platformHint: parsed.platformHint,
      forceOnline: parsed.forceOnline,
    })
  );

  // —— download:enqueue ——
  wrap(IPC.downloadEnqueue, EnqueueInputSchema, (input): EnqueueOutcome => {
    const { items, groupId, meta } = input;
    const referer = meta?.platform ? refererFor(meta.platform) : undefined;
    // 文件名统一走内核 utils/filename 净化（勿在客户端复制规则）
    const normalized = items.map((it) => ({
      ...it,
      filename: sanitizeFilename(it.filename, 80, "download"),
      referer: it.referer ?? referer,
    }));
    const gid = groupId ?? `g-${Date.now().toString(36)}`;
    const taskIds = downloader.enqueue(normalized, gid, meta);
    return { taskIds, groupId: gid };
  });

  // —— download:cancel / pause / resume / list ——
  wrap(IPC.downloadCancel, TaskIdInputSchema, ({ taskId }) => ({
    ok: downloader.cancel(taskId),
  }));
  wrap(IPC.downloadPause, TaskIdInputSchema, ({ taskId }) => ({
    ok: downloader.pause(taskId),
  }));
  wrap(IPC.downloadResume, TaskIdInputSchema, ({ taskId }) => ({
    ok: downloader.resume(taskId),
  }));
  wrap(IPC.downloadList, null, () => downloader.list());

  // —— settings ——
  wrap<unknown, AppSettings>(IPC.settingsGet, null, () => {
    const { settings } = store.loadConfig();
    // 返回给 renderer 的 Cookie 只给「是否已配置」的脱敏视图，值留在主进程
    const masked: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      cookies: Object.fromEntries(
        Object.entries(settings.cookies ?? {}).map(([k, v]) => [k, v ? "***" : ""])
      ),
    };
    return masked;
  });
  wrap(IPC.settingsSet, SettingsPatchSchema, (patch): AppSettings => {
    const cur = store.loadConfig();
    const next: { settings: AppSettings; kernel: Record<string, string> } = {
      settings: { ...cur.settings },
      kernel: { ...cur.kernel },
    };
    if (patch.downloadDir !== undefined) next.settings.downloadDir = patch.downloadDir;
    if (patch.maxConcurrent !== undefined) next.settings.maxConcurrent = patch.maxConcurrent;
    if (patch.fallbackOnline !== undefined) next.settings.fallbackOnline = patch.fallbackOnline;
    if (patch.onlineApiBase !== undefined) next.settings.onlineApiBase = patch.onlineApiBase;
    if (patch.throttleMs !== undefined) next.settings.throttleMs = patch.throttleMs;
    if (patch.minimizeToTray !== undefined) next.settings.minimizeToTray = patch.minimizeToTray;
    if (patch.launchAtLogin !== undefined) next.settings.launchAtLogin = patch.launchAtLogin;
    if (patch.proxyMode !== undefined) next.settings.proxyMode = patch.proxyMode;
    if (patch.proxyUrl !== undefined) next.settings.proxyUrl = patch.proxyUrl;
    if (patch.theme !== undefined) next.settings.theme = patch.theme;
    if (patch.themeStyle !== undefined) next.settings.themeStyle = patch.themeStyle;
    if (patch.fontSizePx !== undefined) next.settings.fontSizePx = patch.fontSizePx;
    if (patch.fontFamily !== undefined) next.settings.fontFamily = patch.fontFamily;
    if (patch.openFolderOnDone !== undefined) next.settings.openFolderOnDone = patch.openFolderOnDone;
    if (patch.retryTimes !== undefined) next.settings.retryTimes = patch.retryTimes;
    if (patch.defaultQuality !== undefined) next.settings.defaultQuality = patch.defaultQuality;
    if (patch.keepPartials !== undefined) next.settings.keepPartials = patch.keepPartials;
    if (patch.notifyOnDone !== undefined) next.settings.notifyOnDone = patch.notifyOnDone;
    if (patch.notifyOnError !== undefined) next.settings.notifyOnError = patch.notifyOnError;
    if (patch.clipboardWatch !== undefined) next.settings.clipboardWatch = patch.clipboardWatch;
    if (patch.logLevel !== undefined) next.settings.logLevel = patch.logLevel;
    if (patch.logRetentionDays !== undefined) next.settings.logRetentionDays = patch.logRetentionDays;
    if (patch.updateOnStartup !== undefined) next.settings.updateOnStartup = patch.updateOnStartup;
    if (patch.updateAutoDownload !== undefined) next.settings.updateAutoDownload = patch.updateAutoDownload;
    if (patch.cookies) {
      const entries = Object.entries(patch.cookies) as [string, string][];
      for (const [k, v] of entries) {
        if (v === "***") continue; // renderer 回传掩码 = 不修改
        if (v === "") {
          delete next.settings.cookies[k];
          delete next.kernel[k];
        } else {
          next.settings.cookies[k] = v;
          next.kernel[k] = v;
        }
      }
    }
    store.saveConfig(next);
    // Cookie 变更立即铺进 process.env（内核模块作用域读 env，重启才生效太反直觉）
    deps.onSettingsChanged?.();
    return {
      ...next.settings,
      cookies: Object.fromEntries(
        Object.entries(next.settings.cookies).map(([k, v]) => [k, v ? "***" : ""])
      ),
    };
  });

  // —— history ——
  wrap(IPC.historyList, HistoryFilterSchema.optional(), (filter): HistoryEntry[] => {
    let list = store.loadHistory();
    if (filter?.platform) list = list.filter((h) => h.platform === filter.platform);
    return list.slice(0, filter?.limit ?? 200);
  });
  wrap<unknown, { ok: boolean }>(IPC.historyClear, null, () => {
    store.clearHistory();
    return { ok: true };
  });
  // —— probe:engines（本地版体检：如实汇报解析通道覆盖，不发抓取、不打平台风控）——
  wrap<unknown, Promise<EngineHealth[]>>(IPC.probeEngines, null, async () => {
    const local = new Set(await engine.localCoverage());
    const onlineReady = engine.fallbackEnabled();
    return engine.platforms().map((p) => ({
      platform: p.key,
      name: p.name,
      ok: local.has(p.key) || onlineReady,
      detail: local.has(p.key)
        ? "本地内核直连（parse-core 注册表覆盖）"
        : onlineReady
          ? "经线上回落通道"
          : "本地内核未覆盖且线上回落已关闭：不可用",
    }));
  });

  // —— app:getBinaryStatus（随包二进制完整性：把「降级」如实报到 UI）——
  wrap<unknown, BinaryStatusReport>(IPC.appGetBinaryStatus, null, () => {
    const report = deps.getBinaryStatus?.();
    return (
      report ?? { manifestLoaded: false, packagedDir: null, binaries: [] }
    );
  });

  // —— update:*（P6：快照 + 状态机动作，状态迁移全在主进程）——
  wrap<unknown, UpdateState>(IPC.updateGetState, null, () => updater.snapshot());
  wrap<unknown, Promise<UpdateState>>(IPC.updateCheck, null, () => updater.check());
  wrap<unknown, Promise<UpdateState>>(IPC.updateDownload, null, () => updater.download());
  wrap<unknown, UpdateState>(IPC.updatePause, null, () => updater.pause());
  wrap<unknown, Promise<UpdateState>>(IPC.updateResume, null, () => updater.resume());
  wrap<unknown, UpdateState>(IPC.updateCancel, null, () => updater.cancel());
  wrap<unknown, { ok: boolean }>(IPC.updateInstall, null, () => {
    updater.install();
    return { ok: true };
  });

  // —— 辅助通道（renderer 经白名单调用）——
  wrap<unknown, Promise<string | null>>(IPC.appPickDownloadDir, null, async () => {
    const { dialog, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getFocusedWindow();
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : res.filePaths[0];
  });
  wrap(IPC.appShowInFolder, FolderPathSchema, (path) => {
    shell.showItemInFolder(path);
    return { ok: true };
  });

  // —— app:listFonts（设置→外观→界面字体 可搜索下拉的数据源；主进程 font-list 枚举 + 缓存）——
  wrap<null, Promise<string[]>>(IPC.appListFonts, null, () => deps.getFonts?.() ?? Promise.resolve([]));

  // —— app:cacheStatus / app:cacheClear（设置→通用→本地缓存）——
  // 扫描按需进行（只在打开该卡片/点清理时跑），且清理只回一份新快照，UI 不再补发 status。
  wrap<unknown, Promise<CacheStatus>>(IPC.appCacheStatus, null, () => deps.cache.status());
  wrap(IPC.appCacheClear, CacheClearInputSchema, ({ keys }) => deps.cache.clear(keys));

  // —— app:openLogDir（日志目录就在 userData/logs，路径真源只有 logger 一处）——
  wrap<unknown, Promise<{ ok: boolean }>>(IPC.appOpenLogDir, null, async () => {
    // openPath 返回空串 = 成功，非空 = 失败原因（不抛异常，故自己转成 ok）
    const error = await shell.openPath(deps.logger.dir());
    return { ok: !error };
  });

  // —— app:log（渲染层异常转发：window.onerror / unhandledrejection 落到同一个文件）——
  wrap(IPC.appLog, LogWriteInputSchema, ({ level, message }) => {
    deps.logger.write(level, `[renderer] ${message}`);
    return { ok: true };
  });
}

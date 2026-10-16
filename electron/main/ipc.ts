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
import { basename, extname } from "node:path";
import { shell } from "electron";
import { PLATFORM_INFO, sanitizeFilename } from "@mediaget/parse-core";
import { resolveKey } from "../../shared/platforms";
import {
  describeIssues,
  CacheClearInputSchema,
  ClearTasksInputSchema,
  EnqueueInputSchema,
  FolderPathSchema,
  HistoryFilterSchema,
  HistoryRemoveInputSchema,
  IdentifyInputSchema,
  LogWriteInputSchema,
  ParseInputSchema,
  SettingsPatchSchema,
  TaskIdInputSchema,
  UrlInputSchema,
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
  type StatsSnapshot,
  type UpdateState,
} from "../../types/ipc";
import type { createEngine } from "./engine";
import type { Downloader } from "./downloader";
import type { JsonStore } from "./store";
import type { StatsRecorder } from "./stats";
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
   * 生命周期计数器（index.ts 注入 = createStats）。统计页的真源：
   * 解析在这里顺路记一笔 via/耗时，下载的 done/failure 由 index.ts 的事件口记。
   */
  stats: StatsRecorder;
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
    };
  });

  // —— parse:identify（纯识别，不发起抓取）——
  wrap(IPC.parseIdentify, IdentifyInputSchema, ({ text }) => engine.identify(text));

  // —— parse:run（统一入口）——
  // 计数在这一层记，不在 engine 里记：engine 的返回点有九处（本地/线上/mock），
  // 挂在出口一处收口才不会随着内部分支增加而漏计。
  wrap(IPC.parseRun, ParseInputSchema, async (parsed) => {
    const at = Date.now();
    const outcome = await engine.parse(parsed.text, parsed.source, parsed.id, {
      platformHint: parsed.platformHint,
      forceOnline: parsed.forceOnline,
    });
    deps.stats.parse({
      at,
      // 归一到契约键后落盘：否则 `xhs` 与 `redbook` 会在平台榜上算成两个平台
      platform: resolveKey(outcome.result.platform ?? parsed.platformHint ?? ""),
      via: outcome.via,
      ok: outcome.result.code === 200,
      durationMs: outcome.durationMs,
    });
    return outcome;
  });

  /**
 * 文件名净化：拆成「名字本体 + 扩展名」分别处理，再拼回。
 *
 * 为什么不能直接把完整文件名丢给 sanitizeFilename：那个函数的 maxLen 作用在整个串上，
 * 会从尾部硬砍 —— 超长标题的结果是「秋日通勤…标标标-108」，**扩展名连同清晰度后缀一起
 * 被砍掉**，落盘成没有 .mp4 的文件，Windows 判定不了类型、双击打不开。
 *
 * 所以这里给本体留出扩展名所需的长度：名字超长时优先砍在「保留前后」的省略号上
 * （见 renderer download-plan 的 ellipsizeMiddle，与预览同口径），这里只做兜底 ——
 * 即便 renderer 传来的名字已经超长，扩展名也必须活着。
 */
function sanitizeWithExt(name: string, maxLen: number): string {
  const ext = extname(name);
  const stem = ext ? basename(name, ext) : name;
  // 扩展名本身也要留位置；最小给本体 8 格，装不下极短扩展名时以扩展名为先（保类型）
  const stemBudget = Math.max(8, maxLen - ext.length);
  return sanitizeFilename(stem, stemBudget, "download") + (ext ? ext.toLowerCase() : "");
}

// —— download:enqueue ——
  wrap(IPC.downloadEnqueue, EnqueueInputSchema, (input): EnqueueOutcome => {
    const { items, groupId, meta } = input;
    const referer = meta?.platform ? refererFor(meta.platform) : undefined;
    // 文件名统一走内核 utils/filename 净化（勿在客户端复制规则）
    const normalized = items.map((it) => ({
      ...it,
      filename: sanitizeWithExt(it.filename, 80),
      referer: it.referer ?? referer,
    }));
    const gid = groupId ?? `g-${Date.now().toString(36)}`;
    const taskIds = downloader.enqueue(normalized, gid, meta);
    return { taskIds, groupId: gid };
  });

  // —— download:cancel / pause / resume / list ——
  wrap(IPC.downloadCancel, TaskIdInputSchema, ({ taskId }) => {
    const okCancel = downloader.cancel(taskId);
    // 取消是用户动作不是失败，但它决定「队列里为什么少了一个」——只记总数，不记平台
    if (okCancel) deps.stats.cancel();
    return { ok: okCancel };
  });
  wrap(IPC.downloadPause, TaskIdInputSchema, ({ taskId }) => ({
    ok: downloader.pause(taskId),
  }));
  wrap(IPC.downloadResume, TaskIdInputSchema, ({ taskId }) => ({
    ok: downloader.resume(taskId),
  }));
  wrap(IPC.downloadList, null, () => downloader.list());
  // —— download:clear —— 队列卫生：终态行移出内存与落盘档（活跃任务由 downloader 拒删）
  wrap(IPC.downloadClear, ClearTasksInputSchema, ({ taskIds }) => ({
    removed: downloader.clear(taskIds),
  }));

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
    if (patch.filenamePreset !== undefined) next.settings.filenamePreset = patch.filenamePreset;
    if (patch.filenameExtra !== undefined) next.settings.filenameExtra = patch.filenameExtra;
    if (patch.keepPartials !== undefined) next.settings.keepPartials = patch.keepPartials;
    if (patch.notifyOnDone !== undefined) next.settings.notifyOnDone = patch.notifyOnDone;
    if (patch.notifyOnError !== undefined) next.settings.notifyOnError = patch.notifyOnError;
    if (patch.clipboardWatch !== undefined) next.settings.clipboardWatch = patch.clipboardWatch;
    if (patch.logLevel !== undefined) next.settings.logLevel = patch.logLevel;
    if (patch.logRetentionDays !== undefined) next.settings.logRetentionDays = patch.logRetentionDays;
    if (patch.updateOnStartup !== undefined) next.settings.updateOnStartup = patch.updateOnStartup;
    if (patch.updateAutoDownload !== undefined) next.settings.updateAutoDownload = patch.updateAutoDownload;
    // 整表替换：渲染层 store 每次提交完整开关快照，"关掉默认开"要落显式 false，"恢复默认"靠删键——
    // 逐键合并会让删键无法表达，语义上等价于两套真源。
    if (patch.platformSwitches !== undefined) next.settings.platformSwitches = { ...patch.platformSwitches };
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
  // —— history:remove（多选删除：行键 = 条目 id 或 groupId，store 侧双命中删整组）——
  // 返回删除后的剩余列表而非 ok 旗：UI 直接拿去刷新，省一次 history.list 回读。
  wrap(IPC.historyRemove, HistoryRemoveInputSchema, ({ keys }): HistoryEntry[] =>
    store.removeHistory(keys)
  );
  // —— probe:engines（本地版体检：注册表 × 在场引擎 × 用户开关，不发抓取、不打平台风控）——
  // 三件事一次算清：这平台供不供（开关）、谁能解（引擎自报 ∧ 注册表能力位）、为什么不行（detail）。
  // 平台行集来自注册表而不是内核自述，所以关掉的/内核没登记但我们能解的平台都在表上。
  wrap<unknown, Promise<EngineHealth[]>>(IPC.probeEngines, null, async () => engine.health());

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

  // —— app:openExternal（结果卡「在浏览器打开」：scheme 校验已在 UrlInputSchema 收口）——
  wrap(IPC.appOpenExternal, UrlInputSchema, async (input) => {
    // openExternal 用 activate:false：不抢焦点，用户还在本软件里操作
    await shell.openExternal(input.url, { activate: false });
    return { ok: true };
  });
  // —— stats:get（统计页数据源：recorder 的内存态直出，不让 UI 每次读盘再对不上）——
  wrap<null, StatsSnapshot>(IPC.statsGet, null, () => deps.stats.snapshot());
}

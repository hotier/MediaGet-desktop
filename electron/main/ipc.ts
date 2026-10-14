/**
 * IPC handler 注册（docs/ARCHITECTURE.md §2 ipc.ts）
 *
 * 边界纪律：
 * - 所有入参先经 zod 校验（renderer 是不可信输入源），才进引擎/下载器；
 * - 出参统一信封 `{ ok:true, data } | { ok:false, error:{ code, message, failType? } }`（§3）；
 * - 不在此直接调平台解析器 —— 一律经 engine；Referer/域名信息取自内核
 *   PLATFORM_INFO，不复制域名表（§4 防盗链）。
 */
import { z } from "zod";
import { shell } from "electron";
import { PLATFORM_INFO } from "@/lib/platforms";
import { sanitizeFilename } from "@/utils/filename";
import {
  IPC,
  DEFAULT_SETTINGS,
  type AppMeta,
  type AppSettings,
  type EngineHealth,
  type EnqueueInput,
  type EnqueueOutcome,
  type HistoryEntry,
  type HistoryFilter,
  type InvokeResult,
} from "../../types/ipc";
import type { createEngine } from "./engine";
import type { Downloader } from "./downloader";
import type { JsonStore } from "./store";
import type { IpcMainLike } from "./ipc-env";

type Engine = ReturnType<typeof createEngine>;

// —— zod 入参 schema ——
const IdentifySchema = z.object({ text: z.string().max(4000) });
const ParseSchema = z.object({
  text: z.string().max(4000),
  platformHint: z.string().max(40).optional(),
  source: z.string().max(40).optional(),
  id: z.string().max(200).optional(),
  forceOnline: z.boolean().optional(),
});
const DownloadItemSchema = z.object({
  url: z.string().url().max(4000),
  filename: z.string().min(1).max(200),
  referer: z.string().url().max(2000).optional(),
  headers: z.record(z.string().max(100), z.string().max(4000)).optional(),
  kind: z.enum(["video", "image", "audio", "file"]),
});
const EnqueueSchema = z.object({
  items: z.array(DownloadItemSchema).min(1).max(200),
  groupId: z.string().max(64).optional(),
  meta: z
    .object({
      platform: z.string().max(40).optional(),
      title: z.string().max(200).optional(),
      sourceUrl: z.string().max(2000).optional(),
    })
    .optional(),
});
const TaskIdSchema = z.object({ taskId: z.string().min(1).max(64) });
const SettingsPatchSchema = z
  .object({
    downloadDir: z.string().max(500).optional(),
    maxConcurrent: z.number().int().min(1).max(10).optional(),
    fallbackOnline: z.boolean().optional(),
    onlineApiBase: z.string().url().max(200).optional(),
    cookies: z.record(z.string().max(60), z.string().max(20000)).optional(),
    throttleMs: z.number().int().min(0).max(60000).optional(),
  })
  .strict();
const HistoryFilterSchema = z
  .object({ platform: z.string().max(40).optional(), limit: z.number().int().min(1).max(500).optional() })
  .optional();

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
}

export function registerIpc(deps: IpcRegistryDeps): void {
  const { ipcMain, engine, downloader, store } = deps;

  const wrap =
    <T>(channel: string, handler: (input: unknown) => Promise<T> | T) => {
      ipcMain.handle(channel, async (_event, input: unknown) => {
        try {
          return ok(await handler(input));
        } catch (e) {
          if (e instanceof z.ZodError) {
            return fail("bad-input", e.issues.map((i: z.ZodIssue) => `${i.path.join(".")}: ${i.message}`).join("; "));
          }
          const err = e as { failType?: string; message?: string };
          return fail("internal", err.message || String(e), err.failType);
        }
      });
    };

  // —— app:getMeta ——
  wrap(IPC.appGetMeta, (): AppMeta => {
    const meta = deps.getAppMeta();
    return {
      version: meta.version,
      electron: meta.electron,
      kernelMode: deps.kernelMode(),
      platforms: engine.platforms(),
    };
  });

  // —— parse:identify（纯识别，不发起抓取）——
  wrap(IPC.parseIdentify, (input) => {
    const { text } = IdentifySchema.parse(input);
    return engine.identify(text);
  });

  // —— parse:run（统一入口）——
  wrap(IPC.parseRun, async (input) => {
    const parsed = ParseSchema.parse(input);
    return engine.parse(parsed.text, parsed.source, parsed.id, {
      platformHint: parsed.platformHint,
      forceOnline: parsed.forceOnline,
    });
  });

  // —— download:enqueue ——
  wrap(IPC.downloadEnqueue, (input): EnqueueOutcome => {
    const { items, groupId, meta } = EnqueueSchema.parse(input) as EnqueueInput;
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
  wrap(IPC.downloadCancel, (input) => {
    const { taskId } = TaskIdSchema.parse(input);
    return { ok: downloader.cancel(taskId) };
  });
  wrap(IPC.downloadPause, (input) => {
    const { taskId } = TaskIdSchema.parse(input);
    return { ok: downloader.pause(taskId) };
  });
  wrap(IPC.downloadResume, (input) => {
    const { taskId } = TaskIdSchema.parse(input);
    return { ok: downloader.resume(taskId) };
  });
  wrap(IPC.downloadList, () => downloader.list());

  // —— settings ——
  wrap(IPC.settingsGet, (): AppSettings => {
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
  wrap(IPC.settingsSet, (input): AppSettings => {
    const patch = SettingsPatchSchema.parse(input);
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
    return {
      ...next.settings,
      cookies: Object.fromEntries(
        Object.entries(next.settings.cookies).map(([k, v]) => [k, v ? "***" : ""])
      ),
    };
  });

  // —— history ——
  wrap(IPC.historyList, (input): HistoryEntry[] => {
    const filter = HistoryFilterSchema.parse(input) as HistoryFilter | undefined;
    let list = store.loadHistory();
    if (filter?.platform) list = list.filter((h) => h.platform === filter.platform);
    return list.slice(0, filter?.limit ?? 200);
  });
  wrap(IPC.historyClear, () => {
    store.clearHistory();
    return { ok: true };
  });
  // —— probe:engines（本地版体检：如实汇报解析通道覆盖，不发抓取、不打平台风控）——
  wrap(IPC.probeEngines, async (): Promise<EngineHealth[]> => {
    const local = new Set(engine.localCoverage());
    const onlineReady = engine.fallbackEnabled();
    return engine.platforms().map((p) => ({
      platform: p.key,
      name: p.name,
      ok: local.has(p.key) || onlineReady,
      detail: local.has(p.key)
        ? "本地内核已抽取（P0 完成）"
        : onlineReady
          ? "经线上回落通道"
          : "本地未抽取且线上回落已关闭：不可用",
    }));
  });

  // —— 辅助通道（renderer 经白名单调用）——
  wrap("app:pickDownloadDir", async () => {
    const { dialog, BrowserWindow } = await import("electron");
    const win = BrowserWindow.getFocusedWindow();
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : res.filePaths[0];
  });
  wrap("app:showInFolder", (input) => {
    const p = z.string().max(1000).parse(input);
    shell.showItemInFolder(p);
    return { ok: true };
  });
}

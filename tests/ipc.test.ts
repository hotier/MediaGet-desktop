/**
 * IPC 契约测试：信封格式、zod 入参校验、统一错误码、Cookie 掩码。
 * 用假 ipcMain 捕获 handler，绕开 Electron runtime。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerIpc } from "../electron/main/ipc";
import { createEngine, type KernelMode } from "../electron/main/engine";
import { Downloader } from "../electron/main/downloader";
import { createCacheProbe } from "../electron/main/cache";
import { createLogger } from "../electron/main/logger";
import { openDatabase } from "../electron/main/database";
import {
  createHistoryRepository,
  createQueueRepository,
  createSettingsRepository,
  createStatsRepository,
} from "../electron/main/repositories";
import { createStats } from "../electron/main/stats";
import { createUpdater } from "../electron/main/updater";
import type { SourceUrlResolver } from "../electron/main/source-url";
import { workKeyOf } from "../shared/history";
import { IPC, type EngineHealth, type InvokeResult, type ParseResult } from "../types/ipc";

type Handler = (event: unknown, input: unknown) => Promise<InvokeResult<unknown>>;

function harness(
  opts: { forceMode?: KernelMode; resolveSourceUrl?: SourceUrlResolver } = {}
) {
  const handlers = new Map<string, Handler>();
  const fakeIpc = {
    handle(channel: string, listener: Handler) {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, listener);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "mg-ipc-test-"));
  const database = openDatabase(join(dir, "mediaget.sqlite"));
  const settingsRepository = createSettingsRepository(database);
  const historyRepository = createHistoryRepository(database);
  const queueRepository = createQueueRepository(database);
  const statsRepository = createStatsRepository(database);
  const engine = createEngine({
    readKernelConfig: (k) => settingsRepository.getKernelValue(k),
    getThrottleMs: () => settingsRepository.loadConfig().settings.throttleMs,
    // 开关读持久值（与 index.ts 同接线）：这条链路是 P2 的验收面，下面有用例钉它
    getPlatformSwitches: () => settingsRepository.loadConfig().settings.platformSwitches,
    // 引擎开关同一接线（v30）：关掉的引擎不参与选路与体检
    getEngineSwitches: () => settingsRepository.loadConfig().settings.engineSwitches,
    // 主引擎与回退开关（v31）：通道下拉 + 「失败自动回退」写的就是这两项
    getPlatformEngines: () => settingsRepository.loadConfig().settings.platformEngines,
    getEngineFallback: () => settingsRepository.loadConfig().settings.engineFallback,
    // 假内核：只声明 kuaishou 覆盖，探测/解析通道全部离线可控
    coreLoader: async () => ({
      localParserKeys: () => ["kuaishou"],
      unifiedParseLocal: async () => ({
        code: 200,
        msg: "解析成功",
        platform: "kuaishou",
        // 直链与分享链接刻意不同源、还带签名：历史档里搜到这两个词就是隐私红线破了
        data: {
          url: "https://cdn-direct.example.com/a.mp4?sign=SECRET",
          title: "快手作品",
          author: "测试作者",
          // 秒级发布时刻 + stat 计数：与真内核各平台的填法同构，用来钉「归一后落盘」这条链
          time: 1759000000,
          stat: { view: 520000, like: 30, favorite: 9 },
        },
      }),
    }),
    // amagi 离线桩（客户端全方法失败 + 短链展开恒 null）：解析/探针通道零真网
    amagiMakeClient: () => ({
      douyin: { parseWork: async () => ({ success: false, error: { kind: "network", message: "offline-stub" } }) },
      bilibili: {
        fetchVideoInfo: async () => ({ success: false, error: { kind: "network", message: "offline-stub" } }),
        fetchVideoStreamUrl: async () => ({ success: false, error: { kind: "network", message: "offline-stub" } }),
        convertAvToBv: async () => ({ success: false, error: { kind: "network", message: "offline-stub" } }),
        fetchUserCard: async () => ({ success: false, error: { kind: "network", message: "offline-stub" } }),
      },
      kuaishou: { fetchVideoWork: async () => ({ success: false, error: { kind: "network", message: "offline-stub" } }) },
      xiaohongshu: { fetchNoteDetail: async () => ({ success: false, error: { kind: "network", message: "offline-stub" } }) },
    }),
    amagiExpandUrl: async () => null,
    // mock 档只为验一条语义：演示结果不落历史（用例见本 describe 末尾）
    forceMode: opts.forceMode,
  });
  const downloader = new Downloader({
    getDownloadDir: () => dir,
    getMaxConcurrent: () => 3,
    getRetryTimes: () => 2,
    getKeepPartials: () => false,
    defaultUserAgent: "UA-TEST",
    events: {
      progress: () => {},
      done: () => {},
      error: () => {},
      persist: (tasks) => queueRepository.saveMany(tasks),
      history: () => {},
    },
  });
  /**
   * 假 session：网络缓存退化成一个可清零的数字，
   * 够断言「清理后占用归零 + 同一份快照同步返回」，不依赖 Electron runtime。
   */
  const netCache = {
    bytes: 4096,
    async getCacheSize(): Promise<number> {
      return this.bytes;
    },
    async clearCache(): Promise<void> {
      this.bytes = 0;
    },
  };
  const logger = createLogger({
    logDir: () => join(dir, "logs"),
    getLevel: () => settingsRepository.loadConfig().settings.logLevel,
    getRetentionDays: () => settingsRepository.loadConfig().settings.logRetentionDays,
  });
  const cache = createCacheProbe({
    session: () => netCache,
    userDataDir: () => dir,
    downloadDir: () => dir,
    updaterCacheDir: () => null,
    livePartPaths: () => downloader.livePartPaths(),
    logs: logger,
  });
  // 真事件账本：stats:get 的出参形状由 validateOutputs 顺带守住，造假桩等于放弃这条保障
  const stats = createStats({
    recordEvent: (event, historyEntry) => statsRepository.recordEvent(event, historyEntry),
    query: (range) => statsRepository.query(range),
  });
  // 剪贴板写入的捕获点：真实现是 Electron 的 `clipboard`（测试环境没有），这里收的就是
  // handler 真正交出去的那串字符 —— 下面的用例靠它验「文本原样到、被拒的那次没落到写入」。
  const clipboardWrites: string[] = [];
  /**
   * 剪贴板读取的桩。默认为空串——真应用里「剪贴板没内容」就走这条分支，不是错误。
   * 用可变盒子是为了让「读到东西」的用例就地覆盖，不必再造一份 registerIpc。
   */
  const clipboardReads = { value: "" };
  registerIpc({
    ipcMain: fakeIpc,
    engine,
    downloader,
    settingsRepository,
    historyRepository,
    queueRepository,
    getAppMeta: () => ({ version: "0.0.0-test", electron: "44" }),
    kernelMode: () => "local",
    // 来源链接归一：缺省离线桩（原样返回），跟跳行为归 source-url.test.ts（禁真网络）
    resolveSourceUrl: opts.resolveSourceUrl ?? (async ({ raw }) => raw ?? undefined),
    getFonts: async () => ["Arial", "Segoe UI", "微软雅黑"],
    writeClipboard: (text) => clipboardWrites.push(text),
    // 读取侧：默认为空串（「剪贴板里没东西」），需要内容的用例自己覆盖 clipboardReads
    readClipboard: () => clipboardReads.value,
    logger,
    cache,
    stats,
    updater: createUpdater({ currentVersion: "0.0.0-test", onChange: () => {} }),
    // 出参也过契约：这批用例跑的是真 handler，正好当 contract 的冒烟面
    validateOutputs: true,
  });

  const call = async (channel: string, input?: unknown): Promise<InvokeResult<unknown>> => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h({}, input);
  };
  /** 旧库缺键：直接改写设置行，模拟「上一版本写下的档」（读侧必须补默认值） */
  const dropSettings = (...keys: string[]): void => {
    const stored = database.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'settings'");
    const raw = stored ? (JSON.parse(stored.value) as Record<string, unknown>) : {};
    for (const key of keys) delete raw[key];
    database.run(
      "INSERT INTO app_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(raw)
    );
  };
  return {
    call,
    database,
    settingsRepository,
    historyRepository,
    dir,
    logger,
    cache,
    netCache,
    clipboardWrites,
    clipboardReads,
    dropSettings,
    cleanup: () => {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("IPC 信封与校验", () => {
  it("app:getMeta 返回版本 + 信封 ok（平台清单不再经 IPC 广播）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.appGetMeta);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const meta = r.data as { version: string; platforms?: unknown[] };
      expect(meta.version).toBe("0.0.0-test");
      expect(meta.platforms).toBeUndefined();
    }
    cleanup();
  });

  it("parse:identify 校验输入长度（超长 → bad-input）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.parseIdentify, { text: "x".repeat(5000) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bad-input");
    cleanup();
  });

  it("parse:identify 正常识别（本地内核模块经 IPC 可达）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.parseIdentify, {
      text: "看看 https://v.douyin.com/abc123/ 的视频",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { platform: string; platformName: string };
      expect(d.platform).toBe("douyin");
      expect(d.platformName).toBe("抖音");
    }
    cleanup();
  });

  it("download:enqueue 校验 items 非空、url 合法", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.downloadEnqueue, { items: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bad-input");
    cleanup();
  });

  it("download:enqueue 文件名净化 + Referer 自动补（内核域名表）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.downloadEnqueue, {
      items: [{ url: "https://cdn.example.com/a.mp4", filename: "测试:视频?<>|.mp4", kind: "video" }],
      meta: { platform: "douyin", title: "t" },
    });
    expect(r.ok).toBe(true);
    const listR = await call(IPC.downloadList);
    expect(listR.ok).toBe(true);
    if (listR.ok) {
      const page = listR.data as { rows: { filename: string; url: string; referer?: string }[] };
      const t = page.rows.find((x) => x.url === "https://cdn.example.com/a.mp4");
      // Windows 非法字符被净化（内核 sanitizeFilename 规则）
      expect(t?.filename).not.toMatch(/[\\/:*?"<>|]/);
    }
    cleanup();
  });

  it("settings:set 保存后 settings:get 返回掩码 Cookie；*** 回传不改值", async () => {
    const { call, settingsRepository, cleanup } = harness();
    const set = await call(IPC.settingsSet, {
      cookies: { DOUYIN_COOKIE: "real-cookie-value", maxConcurrent: undefined },
      throttleMs: 500,
    }).catch(() => null);
    void set;
    // cookies 走 schema：value ≤20000 OK；但 patch 里的 maxConcurrent undefined 会被 strict 拒
    const set2 = await call(IPC.settingsSet, { cookies: { DOUYIN_COOKIE: "real-cookie-value" } });
    expect(set2.ok).toBe(true);
    const get = await call(IPC.settingsGet);
    expect(get.ok).toBe(true);
    if (get.ok) {
      const s = get.data as { cookies: Record<string, string>; throttleMs: number };
      expect(s.cookies.DOUYIN_COOKIE).toBe("***");
    }
    // 落盘的是真值，不是掩码
    expect(settingsRepository.loadConfig().kernel.DOUYIN_COOKIE).toBe("real-cookie-value");
    expect(settingsRepository.loadConfig().settings.cookies.DOUYIN_COOKIE).toBe("real-cookie-value");

    // renderer 把掩码原样回传 → 不覆盖真值
    await call(IPC.settingsSet, { cookies: { DOUYIN_COOKIE: "***" } });
    expect(settingsRepository.loadConfig().kernel.DOUYIN_COOKIE).toBe("real-cookie-value");

    // 空串 = 清除
    await call(IPC.settingsSet, { cookies: { DOUYIN_COOKIE: "" } });
    expect(settingsRepository.loadConfig().kernel.DOUYIN_COOKIE).toBeUndefined();
    cleanup();
  });

  it("settings:set 可写字段往返（P2 明暗主题前的可选布尔面）", async () => {
    const { call, settingsRepository, dropSettings, cleanup } = harness();
    try {
      const flag = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { minimizeToTray?: boolean }).minimizeToTray : undefined;

      // 默认 true（关窗最小化到托盘，下载中关窗不杀任务）
      expect(flag(await call(IPC.settingsGet))).toBe(true);

      const set = await call(IPC.settingsSet, { minimizeToTray: false });
      expect(set.ok).toBe(true);
      expect(settingsRepository.loadConfig().settings.minimizeToTray).toBe(false);
      expect(flag(await call(IPC.settingsGet))).toBe(false);

      // 旧档缺字段（无 minimizeToTray 键）→ DEFAULT_SETTINGS 兜底
      dropSettings("minimizeToTray");
      expect(flag(await call(IPC.settingsGet))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("settings:set theme 往返（P2 明暗主题小契约）", async () => {
    const { call, settingsRepository, dropSettings, cleanup } = harness();
    try {
      const themeOf = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { theme?: string }).theme : undefined;

      expect(themeOf(await call(IPC.settingsGet))).toBe("system");

      const set = await call(IPC.settingsSet, { theme: "light" });
      expect(set.ok).toBe(true);
      expect(settingsRepository.loadConfig().settings.theme).toBe("light");
      expect(themeOf(await call(IPC.settingsGet))).toBe("light");

      await call(IPC.settingsSet, { theme: "dark" });
      expect(settingsRepository.loadConfig().settings.theme).toBe("dark");

      // 枚举外值被 strict schema 拒绝，不落盘
      const bad = await call(IPC.settingsSet, { theme: "neon" });
      expect(bad.ok).toBe(false);
      expect(settingsRepository.loadConfig().settings.theme).toBe("dark");

      // 旧档缺 theme 键 → DEFAULT_SETTINGS 兜底 system
      dropSettings("theme");
      expect(themeOf(await call(IPC.settingsGet))).toBe("system");
    } finally {
      cleanup();
    }
  });

  it("settings:set fontSizePx 往返（界面字号可配置）", async () => {
    const { call, settingsRepository, dropSettings, cleanup } = harness();
    try {
      const sizeOf = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { fontSizePx?: number }).fontSizePx : undefined;

      expect(sizeOf(await call(IPC.settingsGet))).toBe(13);

      const set = await call(IPC.settingsSet, { fontSizePx: 15 });
      expect(set.ok).toBe(true);
      expect(settingsRepository.loadConfig().settings.fontSizePx).toBe(15);
      expect(sizeOf(await call(IPC.settingsGet))).toBe(15);

      // 区间外（契约 11–18）与非整数被拒，不落盘
      for (const bad of [{ fontSizePx: 20 }, { fontSizePx: 13.5 }]) {
        const r = await call(IPC.settingsSet, bad);
        expect(r.ok).toBe(false);
        expect(settingsRepository.loadConfig().settings.fontSizePx).toBe(15);
      }

      // 旧档缺 fontSizePx 键 → DEFAULT_SETTINGS 兜底 13
      dropSettings("fontSizePx");
      expect(sizeOf(await call(IPC.settingsGet))).toBe(13);
    } finally {
      cleanup();
    }
  });

  it("settings:set fontFamily 往返（本机字体族自由串）", async () => {
    const { call, settingsRepository, dropSettings, cleanup } = harness();
    try {
      const famOf = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { fontFamily?: string }).fontFamily : undefined;

      // 默认 system（哨兵：清内联 --font-ui，吃基座字体栈）
      expect(famOf(await call(IPC.settingsGet))).toBe("system");

      // 自由串：拉丁名、含空格名、中文字面名都合法（值来自 app:listFonts 枚举，不再限枚举）
      for (const name of ["Arial", "Segoe UI", "微软雅黑"]) {
        const set = await call(IPC.settingsSet, { fontFamily: name });
        expect(set.ok).toBe(true);
        expect(settingsRepository.loadConfig().settings.fontFamily).toBe(name);
        expect(famOf(await call(IPC.settingsGet))).toBe(name);
      }

      // 空串（min(1)）与超长（max(64)）被 strict schema 拒绝，不落盘
      const empty = await call(IPC.settingsSet, { fontFamily: "" });
      expect(empty.ok).toBe(false);
      const overlong = await call(IPC.settingsSet, { fontFamily: "x".repeat(65) });
      expect(overlong.ok).toBe(false);
      expect(settingsRepository.loadConfig().settings.fontFamily).toBe("微软雅黑");

      // 旧档缺 fontFamily 键 → DEFAULT_SETTINGS 兜底 system
      dropSettings("fontFamily");
      expect(famOf(await call(IPC.settingsGet))).toBe("system");
    } finally {
      cleanup();
    }
  });

  it("app:listFonts 返回本机枚举的字体族清单", async () => {
    const { call, cleanup } = harness();
    try {
      const r = await call(IPC.appListFonts);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toEqual(["Arial", "Segoe UI", "微软雅黑"]);
    } finally {
      cleanup();
    }
  });

  it("settings:set 通知/剪贴板/自启/代理往返（默认值与旧档兜底）", async () => {
    const { call, settingsRepository, dropSettings, cleanup } = harness();
    try {
      type Six = {
        notifyOnDone: boolean;
        notifyOnError: boolean;
        clipboardWatch: boolean;
        launchAtLogin: boolean;
        proxyMode: string;
        proxyUrl: string;
      };
      const six = async (): Promise<Six | null> => {
        const r = await call(IPC.settingsGet);
        return r.ok ? (r.data as Six) : null;
      };

      // 默认：通知开（下载器驻托盘时完成/失败要有感知），剪贴板监听关（隐私默认），自启关，代理跟随系统
      expect(await six()).toMatchObject({
        notifyOnDone: true,
        notifyOnError: true,
        clipboardWatch: false,
        launchAtLogin: false,
        proxyMode: "system",
        proxyUrl: "",
      });

      const set = await call(IPC.settingsSet, {
        notifyOnDone: false,
        clipboardWatch: true,
        launchAtLogin: true,
        proxyMode: "manual",
        proxyUrl: "127.0.0.1:7897",
      });
      expect(set.ok).toBe(true);
      expect(settingsRepository.loadConfig().settings).toMatchObject({
        notifyOnDone: false,
        notifyOnError: true,
        clipboardWatch: true,
        launchAtLogin: true,
        proxyMode: "manual",
        proxyUrl: "127.0.0.1:7897",
      });

      // 旧档缺字段 → DEFAULT_SETTINGS 兜底
      dropSettings("notifyOnDone", "clipboardWatch", "launchAtLogin", "proxyMode", "proxyUrl");
      expect(await six()).toMatchObject({
        notifyOnDone: true,
        clipboardWatch: false,
        launchAtLogin: false,
        proxyMode: "system",
        proxyUrl: "",
      });
    } finally {
      cleanup();
    }
  });

  it("settings:set logLevel/logRetentionDays 往返 + 旧档兜底默认", async () => {
    const { call, settingsRepository, dropSettings, cleanup } = harness();
    try {
      const get = async (): Promise<Record<string, unknown> | null> => {
        const r = await call(IPC.settingsGet);
        return r.ok ? (r.data as Record<string, unknown>) : null;
      };
      // 默认：全级别记录、留 30 天（门槛每次写都重取，保存即生效不需重启）
      expect(await get()).toMatchObject({ logLevel: "info", logRetentionDays: 30 });

      // 写非默认值：与缺省相同的值证明不了 set 真的落盘
      const set = await call(IPC.settingsSet, { logLevel: "error", logRetentionDays: 14 });
      expect(set.ok).toBe(true);
      expect(settingsRepository.loadConfig().settings).toMatchObject({ logLevel: "error", logRetentionDays: 14 });

      // 越界/枚举外一律 bad-input（保留天数契约 1–90）
      const bad = await call(IPC.settingsSet, { logRetentionDays: 0 });
      expect(bad.ok).toBe(false);
      const badLevel = await call(IPC.settingsSet, { logLevel: "verbose" });
      expect(badLevel.ok).toBe(false);

      dropSettings("logLevel", "logRetentionDays");
      expect(await get()).toMatchObject({ logLevel: "info", logRetentionDays: 30 });
    } finally {
      cleanup();
    }
  });

  it("app:log 落盘一行；logLevel=off 后停写", async () => {
    const { call, dir, cleanup } = harness();
    try {
      const logFile = join(dir, "logs", "app.log");
      const r = await call(IPC.appLog, { level: "warn", message: "渲染层炸了\n第二行" });
      expect(r.ok).toBe(true);
      // 换行折成 | ：日志必须一行一条，否则不可解析
      expect(readFileSync(logFile, "utf8")).toContain("[renderer] 渲染层炸了 | 第二行");

      await call(IPC.settingsSet, { logLevel: "off" });
      await call(IPC.appLog, { level: "error", message: "不该出现" });
      expect(readFileSync(logFile, "utf8")).not.toContain("不该出现");

      const bad = await call(IPC.appLog, { level: "off", message: "x" });
      expect(bad.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("app:cacheStatus → app:cacheClear：真删具名文件，不可清项进 skipped", async () => {
    const { call, dir, cleanup } = harness();
    try {
      writeFileSync(join(dir, "orphan.mp4.part"), "x".repeat(1000));
      writeFileSync(join(dir, "orphan.mp4.part.meta"), "y".repeat(200));
      writeFileSync(join(dir, "config.json.corrupt-1700000000000"), "z".repeat(300));
      // 活动任务的断点由 downloader.livePartPaths() 避让，这里没有活任务 ⇒ 全算孤儿

      const before = await call(IPC.appCacheStatus);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const items = (before.data as { items: { key: string; bytes: number; clearable: boolean }[] }).items;
      const of = (k: string) => items.find((i) => i.key === k);
      expect(of("net")).toMatchObject({ bytes: 4096, clearable: true });
      expect(of("partials")).toMatchObject({ bytes: 1200, clearable: true });
      expect(of("junk")).toMatchObject({ bytes: 300, clearable: true });
      // 只报占用、永不清理的两项
      expect(of("update")).toMatchObject({ bytes: 0, clearable: false });

      const cleared = await call(IPC.appCacheClear, { keys: ["net", "partials", "junk", "update"] });
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) return;
      const res = cleared.data as { freed: number; skipped: string[]; report: { totalBytes: number } };
      expect(res.skipped).toEqual(["update"]);
      expect(res.freed).toBe(4096 + 1200 + 300);
      expect(existsSync(join(dir, "orphan.mp4.part"))).toBe(false);
      expect(existsSync(join(dir, "orphan.mp4.part.meta"))).toBe(false);
      expect(existsSync(join(dir, "config.json.corrupt-1700000000000"))).toBe(false);

      const after = await call(IPC.appCacheStatus);
      expect(after.ok && after.data).toMatchObject({ clearableBytes: 0 });
    } finally {
      cleanup();
    }
  });

  it("app:openLogDir 走 shell.openPath 且返回 ok 标志", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.appOpenLogDir);
    expect(r.ok && r.data).toEqual({ ok: true });
    cleanup();
  });

  it("app:copyText 文本原样交给主进程；空串与超限在写入之前就被拒（v11）", async () => {
    const { call, clipboardWrites, cleanup } = harness();
    const text = "标题：示例视频\n作者：小满";
    const r = await call(IPC.appCopyText, { text });
    expect(r.ok && r.data).toEqual({ ok: true });
    expect(clipboardWrites).toEqual([text]);
    // 空串＝「复制不到东西」，超限＝renderer 被攻破后拿通道灌巨串：两次都不许落到写入
    for (const bad of [{ text: "" }, { text: "x".repeat(200_001) }]) {
      const r = await call(IPC.appCopyText, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("bad-input");
    }
    expect(clipboardWrites).toHaveLength(1);
    cleanup();
  });

  it("app:readClipboard 原样回吐；空剪贴板是空串而不是错误；超 4000 截断（v34）", async () => {
    const { call, clipboardReads, cleanup } = harness();

    // 空剪贴板：「没东西可粘」不是失败，界面靠空串自己决定说什么
    const empty = await call(IPC.appReadClipboard, undefined);
    expect(empty.ok && empty.data).toEqual({ text: "" });

    clipboardReads.value = "标题：示例视频 https://v.douyin.com/abc/";
    const r = await call(IPC.appReadClipboard, undefined);
    expect(r.ok && r.data).toEqual({ text: clipboardReads.value });

    // 截断与 parse:input 的 4000 上限对齐：粘进来是为了接着解析，多出来的也用不上
    clipboardReads.value = "x".repeat(5000);
    const big = await call(IPC.appReadClipboard, undefined);
    expect(big.ok && (big.data as { text: string }).text.length).toBe(4000);
    cleanup();
  });

  it("settings:set 拒绝未知字段（strict schema）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.settingsSet, { evilField: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bad-input");
    cleanup();
  });

  it("probe:engines：假核只覆盖 kuaishou，amagi 补上四家，其余平台如实标红", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.probeEngines);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const list = r.data as { platform: string; ok: boolean; engines?: string[] }[];
      const ks = list.find((x) => x.platform === "kuaishou");
      const dy = list.find((x) => x.platform === "douyin");
      const xg = list.find((x) => x.platform === "xigua");
      expect(ks?.ok).toBe(true); // 假内核声明覆盖
      expect(dy?.ok).toBe(true); // 假核不覆盖，但 amagi 声明可解
      expect(dy?.engines).toEqual(["amagi"]);
      expect(xg?.ok).toBe(false); // amagi 不覆盖 xigua，假核也没有 → 如实标红
    }
    cleanup();
  });

  it("平台开关：settings:set 落盘 → 解析路由被切断 → 体检如实标红（P2 全链路）", async () => {
    const { call, cleanup } = harness();
    const text = "https://v.kuaishou.com/abc";
    const run = async (): Promise<ParseResult> => {
      const r = await call(IPC.parseRun, { text });
      if (!r.ok) throw new Error(`parse:run 应当受理，实际 ${JSON.stringify(r)}`);
      return (r.data as { result: ParseResult }).result;
    };
    expect((await run()).code).toBe(200);

    await call(IPC.settingsSet, { platformSwitches: { kuaishou: { enabled: false } } });
    // 同一条链接照搬：闸门排在结果缓存之前，缓存里的成功结果不许替关掉的平台放行
    const off = await run();
    expect(off.code).toBe(400);
    expect(off.msg).toContain("已在设置里关闭");

    const probe = await call(IPC.probeEngines);
    if (probe.ok) {
      const ks = (probe.data as EngineHealth[]).find((x) => x.platform === "kuaishou");
      expect(ks?.ok).toBe(false);
      expect(ks?.detail).toContain("已关闭");
    }

    await call(IPC.settingsSet, { platformSwitches: { kuaishou: { enabled: true } } });
    expect((await run()).code).toBe(200);
    cleanup();
  });

  it("引擎开关：settings:set 落盘 → 该引擎退出选路 → 体检同步（v30 全链路）", async () => {
    const { call, cleanup } = harness();
    // 带作品 ID 的链接才会走到 amagi 的取数（短链展开桩恒 null，会得到 400 而不是网络失败）
    const text = "https://www.kuaishou.com/short-video/abc123";
    // skipCache：结果缓存排在引擎选路之前，不跳过就永远命中第一条成功结果
    const run = async (): Promise<{ result: ParseResult; viaEngine?: string }> => {
      const r = await call(IPC.parseRun, { text, skipCache: true });
      if (!r.ok) throw new Error(`parse:run 应当受理，实际 ${JSON.stringify(r)}`);
      return r.data as { result: ParseResult; viaEngine?: string };
    };
    expect((await run()).result.code).toBe(200);

    await call(IPC.settingsSet, { engineSwitches: { parseCore: { enabled: false } } });
    // parseCore 退出选路：kuaishou 只剩 amagi（离线桩必然失败），如实交出它的失败答复
    const off = await run();
    expect(off.viaEngine).toBe("amagi");
    expect(off.result.code).toBe(502);

    const probe = await call(IPC.probeEngines);
    if (probe.ok) {
      const ks = (probe.data as EngineHealth[]).find((x) => x.platform === "kuaishou");
      expect(ks?.engines).toEqual(["amagi"]);
    }

    // 删键 = 恢复默认全开；同一份档里引擎开关是整表替换
    await call(IPC.settingsSet, { engineSwitches: {} });
    expect((await run()).result.code).toBe(200);
    cleanup();
  });

  it("平台主引擎：settings:set 落盘 → 主引擎先试、失败回退；关掉回退后只试主引擎（v31）", async () => {
    const { call, cleanup } = harness();
    const text = "https://www.kuaishou.com/short-video/abc123";
    const run = async (): Promise<{ result: ParseResult; viaEngine?: string }> => {
      const r = await call(IPC.parseRun, { text, skipCache: true });
      if (!r.ok) throw new Error(`parse:run 应当受理，实际 ${JSON.stringify(r)}`);
      return r.data as { result: ParseResult; viaEngine?: string };
    };
    expect((await run()).result.code).toBe(200);

    // 选 amagi 当主引擎：它离线必然失败 → 回退 mediaget 解出
    await call(IPC.settingsSet, { platformEngines: { kuaishou: "amagi" } });
    const fell = await run();
    expect(fell.viaEngine).toBe("parseCore");
    expect(fell.result.code).toBe(200);

    const listed = await call(IPC.probeEngines);
    if (listed.ok) {
      const ks = (listed.data as EngineHealth[]).find((x) => x.platform === "kuaishou");
      expect(ks?.engineIds).toEqual(["amagi", "parseCore"]);
    }

    // 关掉回退：只剩主引擎，amagi 的失败就是最终答复
    await call(IPC.settingsSet, { engineFallback: false });
    const only = await run();
    expect(only.viaEngine).toBe("amagi");
    expect(only.result.code).toBe(502);

    // 删键 = 回默认 mediaget + 回退开
    await call(IPC.settingsSet, { platformEngines: {}, engineFallback: true });
    const reset = await run();
    expect(reset.viaEngine).toBe("parseCore");
    expect(reset.result.code).toBe(200);
    cleanup();
  });

  it("解析成功即落历史：不下载也留一行「未下载」（v8 语义，业主指令 2026-10-17）", async () => {
    const { call, historyRepository, cleanup } = harness();
    const text = "https://v.kuaishou.com/abc";
    const r = await call(IPC.parseRun, { text });
    expect(r.ok).toBe(true);

    const list = historyRepository.list().rows;
    expect(list).toHaveLength(1);
    const key = workKeyOf(text);
    expect(list[0]).toMatchObject({
      id: key,
      groupId: key,
      platform: "kuaishou",
      title: "快手作品",
      sourceUrl: text,
      files: [],
    });
    expect(list[0].author?.name).toBe("测试作者");
    // v10：发布时间归一到毫秒、计数按档位落盘 —— 导出要的「完整作品信息」就在这一行里
    expect(list[0].publishedAt).toBe(1759000000000);
    expect(list[0].stat).toEqual({ view: 520000, like: 30, favorite: 9 });
    // 历史页/首页「最近解析」读的是同一条通道：这里必须已经是 1 行而不是 0 行
    const listed = await call(IPC.historyList, { limit: 5 });
    expect(listed.ok && (listed.data as { rows: unknown[] }).rows.length).toBe(1);
    // 隐私红线：直链与签名参数都不许进档，档里那条链接只能是用户输入的分享链接
    expect(JSON.stringify(list)).not.toContain("cdn-direct");
    expect(JSON.stringify(list)).not.toContain("SECRET");

    // 同一条链接再解析一次 = 刷新那一行，历史页不许长成「重复解析的堆」
    await call(IPC.parseRun, { text });
    expect(historyRepository.list().rows).toHaveLength(1);
    cleanup();
  });

  it("来源链接归一后的真实页面同时进历史与出参（v16：短链不再是历史键）", async () => {
    const resolved = "https://www.kuaishou.com/short-video/7400000000000000001";
    const { call, historyRepository, cleanup } = harness({ resolveSourceUrl: async () => resolved });
    const text = "https://v.kuaishou.com/abc";
    const r = await call(IPC.parseRun, { text });
    if (!r.ok) throw new Error(`parse:run 应当受理，实际 ${JSON.stringify(r)}`);

    expect((r.data as { sourceUrl?: string }).sourceUrl).toBe(resolved);
    const list = historyRepository.list().rows;
    expect(list).toHaveLength(1);
    // 历史行与作品键都从真实页面算出：解析行与后续下载行才会聚成同一行
    expect(list[0].sourceUrl).toBe(resolved);
    expect(list[0].id).toBe(workKeyOf(resolved));
    expect(list[0].groupId).toBe(workKeyOf(resolved));
    cleanup();
  });

  it("解析失败不落历史：400 的结果不配占一行", async () => {
    const { call, historyRepository, cleanup } = harness();
    await call(IPC.settingsSet, { platformSwitches: { kuaishou: { enabled: false } } });
    const r = await call(IPC.parseRun, { text: "https://v.kuaishou.com/off" });
    if (!r.ok) throw new Error(`parse:run 应当受理，实际 ${JSON.stringify(r)}`);
    expect((r.data as { result: ParseResult }).result.code).toBe(400);
    expect(historyRepository.list().rows).toEqual([]);
    cleanup();
  });

  it("mock 兜底的成功结果不落历史：演示数据不进用户的账", async () => {
    const { call, historyRepository, cleanup } = harness({ forceMode: "mock" });
    const r = await call(IPC.parseRun, { text: "https://v.kuaishou.com/abc" });
    if (!r.ok) throw new Error(`parse:run 应当受理，实际 ${JSON.stringify(r)}`);
    const outcome = r.data as { result: ParseResult; via: string };
    expect(outcome.result.code).toBe(200);
    expect(outcome.via).toBe("mock");
    expect(historyRepository.list().rows).toEqual([]);
    cleanup();
  });
});

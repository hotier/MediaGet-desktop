/**
 * IPC 契约测试：信封格式、zod 入参校验、统一错误码、Cookie 掩码。
 * 用假 ipcMain 捕获 handler，绕开 Electron runtime。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerIpc } from "../electron/main/ipc";
import { createEngine } from "../electron/main/engine";
import { Downloader } from "../electron/main/downloader";
import { createCacheProbe } from "../electron/main/cache";
import { createLogger } from "../electron/main/logger";
import { JsonStore } from "../electron/main/store";
import { createUpdater } from "../electron/main/updater";
import { IPC, type InvokeResult } from "../types/ipc";

type Handler = (event: unknown, input: unknown) => Promise<InvokeResult<unknown>>;

function harness() {
  const handlers = new Map<string, Handler>();
  const fakeIpc = {
    handle(channel: string, listener: Handler) {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, listener);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "mg-ipc-test-"));
  const store = new JsonStore(dir);
  const engine = createEngine({
    readKernelConfig: (k) => store.getKernelValue(k),
    getThrottleMs: () => store.loadConfig().settings.throttleMs,
    isFallbackEnabled: () => false, // 测试全离线
    onlineFallback: async () => null,
    // 假内核：只声明 kuaishou 覆盖，探测/解析通道全部离线可控
    coreLoader: async () => ({
      localParserKeys: () => ["kuaishou"],
      unifiedParseLocal: async (input: string) => ({
        code: 200,
        msg: "解析成功",
        platform: "kuaishou",
        data: { url: input },
      }),
    }),
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
      persist: () => {},
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
    getLevel: () => store.loadConfig().settings.logLevel,
    getRetentionDays: () => store.loadConfig().settings.logRetentionDays,
  });
  const cache = createCacheProbe({
    session: () => netCache,
    userDataDir: () => dir,
    downloadDir: () => dir,
    updaterCacheDir: () => null,
    livePartPaths: () => downloader.livePartPaths(),
    logs: logger,
  });
  registerIpc({
    ipcMain: fakeIpc,
    engine,
    downloader,
    store,
    getAppMeta: () => ({ version: "0.0.0-test", electron: "44" }),
    kernelMode: () => "local",
    getFonts: async () => ["Arial", "Segoe UI", "微软雅黑"],
    logger,
    cache,
    updater: createUpdater({ currentVersion: "0.0.0-test", onChange: () => {} }),
    // 出参也过契约：这批用例跑的是真 handler，正好当 contract 的冒烟面
    validateOutputs: true,
  });

  const call = async (channel: string, input?: unknown): Promise<InvokeResult<unknown>> => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h({}, input);
  };
  return { call, store, dir, logger, cache, netCache, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("IPC 信封与校验", () => {
  it("app:getMeta 返回平台清单（来自内核）+ 信封 ok", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.appGetMeta);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const meta = r.data as { version: string; platforms: unknown[] };
      expect(meta.version).toBe("0.0.0-test");
      expect(Array.isArray(meta.platforms)).toBe(true);
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
      const tasks = listR.data as { filename: string; url: string; referer?: string }[];
      const t = tasks.find((x) => x.url === "https://cdn.example.com/a.mp4");
      // Windows 非法字符被净化（内核 sanitizeFilename 规则）
      expect(t?.filename).not.toMatch(/[\\/:*?"<>|]/);
    }
    cleanup();
  });

  it("settings:set 保存后 settings:get 返回掩码 Cookie；*** 回传不改值", async () => {
    const { call, store, cleanup } = harness();
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
    expect(store.loadConfig().kernel.DOUYIN_COOKIE).toBe("real-cookie-value");
    expect(store.loadConfig().settings.cookies.DOUYIN_COOKIE).toBe("real-cookie-value");

    // renderer 把掩码原样回传 → 不覆盖真值
    await call(IPC.settingsSet, { cookies: { DOUYIN_COOKIE: "***" } });
    expect(store.loadConfig().kernel.DOUYIN_COOKIE).toBe("real-cookie-value");

    // 空串 = 清除
    await call(IPC.settingsSet, { cookies: { DOUYIN_COOKIE: "" } });
    expect(store.loadConfig().kernel.DOUYIN_COOKIE).toBeUndefined();
    cleanup();
  });

  it("settings:set 可写字段往返（P2 明暗主题前的可选布尔面）", async () => {    const { call, store, cleanup } = harness();
    try {
      const flag = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { minimizeToTray?: boolean }).minimizeToTray : undefined;

      // 默认 true（关窗最小化到托盘，下载中关窗不杀任务）
      expect(flag(await call(IPC.settingsGet))).toBe(true);

      const set = await call(IPC.settingsSet, { minimizeToTray: false });
      expect(set.ok).toBe(true);
      expect(store.loadConfig().settings.minimizeToTray).toBe(false);
      expect(flag(await call(IPC.settingsGet))).toBe(false);

      // 旧档缺字段（无 minimizeToTray 键）→ DEFAULT_SETTINGS 兜底
      const raw = store.loadConfig();
      delete (raw.settings as { minimizeToTray?: boolean }).minimizeToTray;
      expect(flag(await call(IPC.settingsGet))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("settings:set theme 往返（P2 明暗主题小契约）", async () => {
    const { call, store, cleanup } = harness();
    try {
      const themeOf = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { theme?: string }).theme : undefined;

      expect(themeOf(await call(IPC.settingsGet))).toBe("system");

      const set = await call(IPC.settingsSet, { theme: "light" });
      expect(set.ok).toBe(true);
      expect(store.loadConfig().settings.theme).toBe("light");
      expect(themeOf(await call(IPC.settingsGet))).toBe("light");

      await call(IPC.settingsSet, { theme: "dark" });
      expect(store.loadConfig().settings.theme).toBe("dark");

      // 枚举外值被 strict schema 拒绝，不落盘
      const bad = await call(IPC.settingsSet, { theme: "neon" });
      expect(bad.ok).toBe(false);
      expect(store.loadConfig().settings.theme).toBe("dark");

      // 旧档缺 theme 键 → DEFAULT_SETTINGS 兜底 system
      const raw = store.loadConfig();
      delete (raw.settings as { theme?: string }).theme;
      expect(themeOf(await call(IPC.settingsGet))).toBe("system");
    } finally {
      cleanup();
    }
  });

  it("settings:set fontSizePx 往返（界面字号可配置）", async () => {
    const { call, store, cleanup } = harness();
    try {
      const sizeOf = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { fontSizePx?: number }).fontSizePx : undefined;

      expect(sizeOf(await call(IPC.settingsGet))).toBe(13);

      const set = await call(IPC.settingsSet, { fontSizePx: 15 });
      expect(set.ok).toBe(true);
      expect(store.loadConfig().settings.fontSizePx).toBe(15);
      expect(sizeOf(await call(IPC.settingsGet))).toBe(15);

      // 区间外（契约 11–18）与非整数被拒，不落盘
      for (const bad of [{ fontSizePx: 20 }, { fontSizePx: 13.5 }]) {
        const r = await call(IPC.settingsSet, bad);
        expect(r.ok).toBe(false);
        expect(store.loadConfig().settings.fontSizePx).toBe(15);
      }

      // 旧档缺 fontSizePx 键 → DEFAULT_SETTINGS 兜底 13
      const raw = store.loadConfig();
      delete (raw.settings as { fontSizePx?: number }).fontSizePx;
      expect(sizeOf(await call(IPC.settingsGet))).toBe(13);
    } finally {
      cleanup();
    }
  });

  it("settings:set fontFamily 往返（本机字体族自由串）", async () => {
    const { call, store, cleanup } = harness();
    try {
      const famOf = (r: Awaited<ReturnType<typeof call>>): unknown =>
        r.ok ? (r.data as { fontFamily?: string }).fontFamily : undefined;

      // 默认 system（哨兵：清内联 --font-ui，吃基座字体栈）
      expect(famOf(await call(IPC.settingsGet))).toBe("system");

      // 自由串：拉丁名、含空格名、中文字面名都合法（值来自 app:listFonts 枚举，不再限枚举）
      for (const name of ["Arial", "Segoe UI", "微软雅黑"]) {
        const set = await call(IPC.settingsSet, { fontFamily: name });
        expect(set.ok).toBe(true);
        expect(store.loadConfig().settings.fontFamily).toBe(name);
        expect(famOf(await call(IPC.settingsGet))).toBe(name);
      }

      // 空串（min(1)）与超长（max(64)）被 strict schema 拒绝，不落盘
      const empty = await call(IPC.settingsSet, { fontFamily: "" });
      expect(empty.ok).toBe(false);
      const overlong = await call(IPC.settingsSet, { fontFamily: "x".repeat(65) });
      expect(overlong.ok).toBe(false);
      expect(store.loadConfig().settings.fontFamily).toBe("微软雅黑");

      // 旧档缺 fontFamily 键 → DEFAULT_SETTINGS 兜底 system
      const raw = store.loadConfig();
      delete (raw.settings as { fontFamily?: string }).fontFamily;
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
    const { call, store, cleanup } = harness();
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
      expect(store.loadConfig().settings).toMatchObject({
        notifyOnDone: false,
        notifyOnError: true,
        clipboardWatch: true,
        launchAtLogin: true,
        proxyMode: "manual",
        proxyUrl: "127.0.0.1:7897",
      });

      // 旧档缺字段 → DEFAULT_SETTINGS 兜底
      const raw = store.loadConfig();
      delete (raw.settings as { notifyOnDone?: boolean }).notifyOnDone;
      delete (raw.settings as { clipboardWatch?: boolean }).clipboardWatch;
      delete (raw.settings as { launchAtLogin?: boolean }).launchAtLogin;
      delete (raw.settings as { proxyMode?: string }).proxyMode;
      delete (raw.settings as { proxyUrl?: string }).proxyUrl;
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
    const { call, store, cleanup } = harness();
    try {
      const get = async (): Promise<Record<string, unknown> | null> => {
        const r = await call(IPC.settingsGet);
        return r.ok ? (r.data as Record<string, unknown>) : null;
      };
      // 默认：全级别记录、留 7 天（门槛每次写都重取，保存即生效不需重启）
      expect(await get()).toMatchObject({ logLevel: "info", logRetentionDays: 7 });

      const set = await call(IPC.settingsSet, { logLevel: "error", logRetentionDays: 30 });
      expect(set.ok).toBe(true);
      expect(store.loadConfig().settings).toMatchObject({ logLevel: "error", logRetentionDays: 30 });

      // 越界/枚举外一律 bad-input（保留天数契约 1–90）
      const bad = await call(IPC.settingsSet, { logRetentionDays: 0 });
      expect(bad.ok).toBe(false);
      const badLevel = await call(IPC.settingsSet, { logLevel: "verbose" });
      expect(badLevel.ok).toBe(false);

      const raw = store.loadConfig();
      delete (raw.settings as { logLevel?: string }).logLevel;
      delete (raw.settings as { logRetentionDays?: number }).logRetentionDays;
      expect(await get()).toMatchObject({ logLevel: "info", logRetentionDays: 7 });
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

  it("settings:set 拒绝未知字段（strict schema）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.settingsSet, { evilField: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bad-input");
    cleanup();
  });

  it("probe:engines：回落关闭时未覆盖平台 ok=false（如实汇报）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.probeEngines);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const list = r.data as { platform: string; ok: boolean }[];
      const ks = list.find((x) => x.platform === "kuaishou");
      const dy = list.find((x) => x.platform === "douyin");
      expect(ks?.ok).toBe(true); // 假内核声明覆盖
      expect(dy?.ok).toBe(false); // 未覆盖且回落关（harness isFallbackEnabled=false）
    }
    cleanup();
  });

  it("history:clear 真正落盘（回归：不得注册占位假实现）", async () => {
    const { call, store, cleanup } = harness();
    store.appendHistory({ id: "h1", files: ["/tmp/x.mp4"], createdAt: Date.now() });
    expect(store.loadHistory().length).toBe(1);
    const r = await call(IPC.historyClear);
    expect(r.ok).toBe(true);
    expect(store.loadHistory().length).toBe(0);
    cleanup();
  });
});

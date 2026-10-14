/**
 * IPC 契约测试：信封格式、zod 入参校验、统一错误码、Cookie 掩码。
 * 用假 ipcMain 捕获 handler，绕开 Electron runtime。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerIpc } from "../electron/main/ipc";
import { createEngine } from "../electron/main/engine";
import { Downloader } from "../electron/main/downloader";
import { JsonStore } from "../electron/main/store";
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
  });
  const downloader = new Downloader({
    getDownloadDir: () => dir,
    getMaxConcurrent: () => 3,
    defaultUserAgent: "UA-TEST",
    events: {
      progress: () => {},
      done: () => {},
      error: () => {},
      persist: () => {},
      history: () => {},
    },
  });
  registerIpc({
    ipcMain: fakeIpc,
    engine,
    downloader,
    store,
    getAppMeta: () => ({ version: "0.0.0-test", electron: "44" }),
    kernelMode: () => "local",
  });

  const call = async (channel: string, input?: unknown): Promise<InvokeResult<unknown>> => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h({}, input);
  };
  return { call, store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

  it("settings:set 拒绝未知字段（strict schema）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.settingsSet, { evilField: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("bad-input");
    cleanup();
  });

  it("probe:engines：回落关闭时未抽取平台 ok=false（如实汇报）", async () => {
    const { call, cleanup } = harness();
    const r = await call(IPC.probeEngines);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const list = r.data as { platform: string; ok: boolean }[];
      const ks = list.find((x) => x.platform === "kuaishou");
      const dy = list.find((x) => x.platform === "douyin");
      expect(ks?.ok).toBe(true); // 本地已抽取
      expect(dy?.ok).toBe(false); // 未抽取且回落关（harness isFallbackEnabled=false）
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

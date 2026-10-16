/**
 * IPC 契约守门（types/ipc-contract.ts 的单一真源纪律）
 *
 * 这里防的不是「某个 handler 写错」，而是**契约表本身漂移**——那类错误不会有编译报错，
 * 只会让 UI 静默少字段：
 * 1. 通道表与 IPC 常量表必须一一对应（新增通道忘了登记 / 留下没人登记的死常量）；
 * 2. registerIpc 实际注册的集合 == CONTRACT 的键集合（多注册 = 校验旁路）；
 * 3. 每个有入参的通道，非法载荷必须被 `bad-input` 拦住，且文案带字段路径；
 * 4. 每个通道跑一次真实 handler，出参必须过 out schema（validateOutputs=true）；
 * 5. 出参漂移只在 dev 报错，打包版不为校验付代价 —— 两个方向都要钉住；
 * 6. 事件通道不进 CONTRACT（无入参校验语义），但载荷形状同样归 EVENTS 管。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerIpc, type IpcRegistryDeps } from "../electron/main/ipc";
import { CONTRACT, EVENTS, describeIssues, type InvokeContract } from "../types/ipc-contract";
import {
  DEFAULT_SETTINGS,
  IPC,
  type AppSettings,
  type CacheStatus,
  type DownloadTaskView,
  type InvokeResult,
  type UpdateState,
} from "../types/ipc";
import type { IpcMainLike } from "../electron/main/ipc-env";

type Handler = (event: unknown, input: unknown) => Promise<InvokeResult<unknown>>;

const TASK_VIEW: DownloadTaskView = {
  taskId: "t-1",
  groupId: "g-1",
  url: "https://cdn.example.com/a.mp4",
  filename: "a.mp4",
  kind: "video",
  status: "downloading",
  received: 1024,
  total: 4096,
  speed: 512,
  platform: "douyin",
  title: "示例视频",
  sourceUrl: "https://v.douyin.com/abc/",
  createdAt: 1700000000000,
};

/**
 * 更新状态机的假快照：update:* 的迁移逻辑归 updater.test.ts 管，
 * 这里只需要一个「类型即契约」的稳定快照（字面量由 UpdateState 约束）。
 */
const UPDATE_SNAPSHOT: UpdateState = { phase: "idle", currentVersion: "0.0.0-test", canCheck: false };

/** 占用快照的假形状：cacheStatus 出参与 cacheClear 内嵌 report 共用一份 */
const CACHE_REPORT: CacheStatus = {
  items: [
    { key: "net", bytes: 2048, clearable: true },
    { key: "update", bytes: 0, clearable: false },
    { key: "partials", bytes: 1024, clearable: true },
    { key: "junk", bytes: 0, clearable: true },
    { key: "logs", bytes: 4096, clearable: true },
    { key: "records", bytes: 512, clearable: false },
  ],
  totalBytes: 7680,
  clearableBytes: 7168,
};

interface StubOpts {
  validateOutputs?: boolean;
  getAppMeta?: IpcRegistryDeps["getAppMeta"];
  /** 让 history:list 的读取抛错，用来验内部异常的信封 */
  historyThrows?: boolean;
}

/**
 * 贴近真实的假 deps：形状真、行为空（不发网络、不落盘）。
 * 目的不是测各子系统（那是 ipc.test.ts / downloader.test.ts 的活），
 * 而是让**每个通道都能被调用一次**，从而让 out schema 接受一次真产出。
 */
function stubDeps(opts: StubOpts = {}): { handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, listener as Handler);
    },
  };
  const settings: AppSettings = { ...DEFAULT_SETTINGS, cookies: { DOUYIN_COOKIE: "raw" } };
  const deps = {
    ipcMain,
    engine: {
      platforms: () => [{ key: "douyin", name: "抖音", nameEn: "Douyin", supportsIdParse: false }],
      identify: (text: string) => ({
        platform: "douyin",
        platformName: "抖音",
        url: text.includes("http") ? text : null,
        kind: "url" as const,
      }),
      parse: async () => ({
        result: {
          code: 200,
          msg: "解析成功",
          platform: "douyin",
          data: { url: "https://cdn.example.com/a.mp4" },
        },
        via: "local" as const,
        durationMs: 12,
      }),
      localCoverage: async () => ["douyin"],
      fallbackEnabled: () => false,
    },
    downloader: {
      enqueue: () => ["t-1"],
      cancel: () => true,
      pause: () => true,
      resume: () => true,
      clear: () => 1,
      list: () => [TASK_VIEW],
    },
    store: {
      loadConfig: () => ({ settings, kernel: { ...settings.cookies } }),
      saveConfig: () => {},
      loadHistory: () => {
        if (opts.historyThrows) throw new Error("磁盘读失败");
        return [
          {
            // 刻意不带 author：这条同时是「老记录（作者快照此前不落盘）必须过 out schema」的用例
            id: "h-1",
            groupId: "g-1",
            platform: "douyin",
            title: "示例视频",
            kind: "video",
            bytes: 4096,
            files: ["C:/Downloads/a.mp4"],
            sourceUrl: "https://v.douyin.com/abc/",
            createdAt: 1700000000000,
          },
        ];
      },
      clearHistory: () => {},
    },
    getAppMeta: opts.getAppMeta ?? (() => ({ version: "0.0.0-test", electron: "44" })),
    kernelMode: () => "local" as const,
    getBinaryStatus: () => ({
      manifestLoaded: true,
      packagedDir: "C:/app/resources/bin",
      binaries: [
        {
          name: "yt-dlp" as const,
          available: true,
          origin: "packaged" as const,
          path: "C:/app/resources/bin/yt-dlp.exe",
          integrity: "verified" as const,
          expected: "0".repeat(64),
        },
      ],
    }),
    getFonts: async () => ["Arial", "微软雅黑"],
    /**
     * 日志/缓存两个服务在契约测试里只要「形状真」：轮转、按天清理、避让活断点
     * 这些行为归 logger.test.ts / cache.test.ts 管，这里守的是通道登记与信封。
     */
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      write: () => {},
      dir: () => "C:/Users/test/AppData/Roaming/MediaGet/logs",
      sizeBytes: () => 4096,
      clear: () => 4096,
      pruneExpired: () => 0,
    },
    cache: {
      status: async () => CACHE_REPORT,
      clear: async () => ({ freed: 1024, skipped: [], report: CACHE_REPORT }),
    },
    updater: {
      snapshot: () => UPDATE_SNAPSHOT,
      check: async () => UPDATE_SNAPSHOT,
      download: async () => UPDATE_SNAPSHOT,
      pause: () => UPDATE_SNAPSHOT,
      resume: async () => UPDATE_SNAPSHOT,
      cancel: () => UPDATE_SNAPSHOT,
      install: () => undefined,
    },
    validateOutputs: opts.validateOutputs ?? true,
  } as unknown as IpcRegistryDeps;
  registerIpc(deps);
  return { handlers };
}

/** 每个「有入参 schema」的通道：一份刻意非法的载荷 */
const BAD_INPUT: Record<string, unknown> = {
  [IPC.parseIdentify]: { text: "x".repeat(5000) },
  [IPC.parseRun]: {},
  [IPC.downloadEnqueue]: { items: [] },
  [IPC.downloadCancel]: { taskId: "" },
  [IPC.downloadPause]: { taskId: "" },
  [IPC.downloadResume]: { taskId: "" },
  // 空数组＝「清理但一颗都不给」，那是调用方没算清可清理集，不该被执行（也不该被当成全清）
  [IPC.downloadClear]: { taskIds: [] },
  [IPC.settingsSet]: { evilField: 1 },
  [IPC.historyList]: { limit: 0 },
  [IPC.appShowInFolder]: 1234,
  [IPC.appCacheClear]: { keys: ["not-a-cache"] },
  // off 是「不落盘」的门槛档，不是一条可写入的日志
  [IPC.appLog]: { level: "off", message: "x" },
};

/** 每个通道的一份合法调用（无入参通道传 undefined） */
const GOOD_INPUT: Record<string, unknown> = {
  [IPC.parseIdentify]: { text: "https://v.douyin.com/abc/" },
  [IPC.parseRun]: { text: "https://v.douyin.com/abc/" },
  [IPC.downloadEnqueue]: {
    items: [{ url: "https://cdn.example.com/a.mp4", filename: "a.mp4", kind: "video" }],
    meta: {
      platform: "douyin",
      title: "示例视频",
      author: { name: "小满", id: "u-1", followerCount: 12000 },
    },
  },
  [IPC.downloadCancel]: { taskId: "t-1" },
  [IPC.downloadPause]: { taskId: "t-1" },
  [IPC.downloadResume]: { taskId: "t-1" },
  [IPC.downloadClear]: { taskIds: ["t-1"] },
  [IPC.settingsSet]: { throttleMs: 100 },
  [IPC.appShowInFolder]: "C:/Downloads/a.mp4",
  [IPC.appCacheClear]: { keys: ["net", "logs"] },
  [IPC.appLog]: { level: "error", message: "渲染层炸了一处" },
};

/** CONTRACT 的键是字面量通道名，测试里按 string 索引需要这一层 widening */
const table = CONTRACT as Record<string, InvokeContract>;
const inSchemaOf = (channel: string): z.ZodTypeAny | null => table[channel].in;
const inputBearingChannels = Object.keys(table).filter((c) => inSchemaOf(c) !== null);
const nullInputChannels = Object.keys(table).filter((c) => inSchemaOf(c) === null);

describe("IPC 契约表", () => {
  it("每个 IPC 常量都登记在 CONTRACT 或 EVENTS 之一（无死通道）", () => {
    for (const channel of Object.values(IPC)) {
      const registered = channel in CONTRACT || channel in EVENTS;
      expect(registered, `通道 ${channel} 未登记在契约表`).toBe(true);
    }
  });

  it("invoke 通道与事件通道不重叠", () => {
    for (const channel of Object.keys(EVENTS)) {
      expect(channel in CONTRACT, `${channel} 既是 invoke 又是事件`).toBe(false);
    }
  });

  it("registerIpc 注册集合 == CONTRACT 键集合（多注册 = 校验旁路）", () => {
    const { handlers } = stubDeps();
    expect([...handlers.keys()].sort()).toEqual(Object.keys(CONTRACT).sort());
  });

  it("契约表每个通道都有 out；in 为 null 的通道就是不接受入参的那些", () => {
    for (const [channel, c] of Object.entries(CONTRACT)) {
      expect(c.out, `${channel} 缺 out schema`).toBeTruthy();
      expect(channel in BAD_INPUT, `${channel} 有入参却没非法载荷用例`).toBe(
        inSchemaOf(channel) !== null
      );
    }
    expect(nullInputChannels).toContain(IPC.appGetMeta);
    expect(inputBearingChannels).toContain(IPC.settingsSet);
  });
});

describe("入参校验（renderer 是不可信输入源）", () => {
  it("非法入参一律 bad-input，文案走 describeIssues 的 `path: message` 格式", async () => {
    const { handlers } = stubDeps();
    for (const [channel, input] of Object.entries(BAD_INPUT)) {
      const r = await handlers.get(channel)!({}, input);
      expect(r.ok, `${channel} 竟然放过了非法入参`).toBe(false);
      if (!r.ok) {
        expect(r.error.code, `${channel} 错误码`).toBe("bad-input");
        expect(r.error.message.length, `${channel} 空文案`).toBeGreaterThan(0);
      }
    }
  });

  it("字段路径进文案：设置页要按它做字段级内联提示", async () => {
    const { handlers } = stubDeps();
    const r = await handlers.get(IPC.parseRun)!({}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/^text: /);
  });

  it("in 为 null 的通道不做入参校验：传垃圾也不会得到 bad-input", async () => {
    const { handlers } = stubDeps();
    for (const channel of nullInputChannels) {
      const r = await handlers.get(channel)!({}, { injected: 1 });
      if (!r.ok) expect(r.error.code, `${channel} 不该被判成输入错`).not.toBe("bad-input");
    }
  });

  it("describeIssues 把多字段错误拼成一行（与 bad-input 同源）", () => {
    const parsed = CONTRACT[IPC.settingsSet].in!.safeParse({ theme: "neon", throttleMs: "fast" });
    expect(parsed.success).toBe(false);
    const text = describeIssues(parsed.error!);
    expect(text).toContain("theme:");
    expect(text).toContain("throttleMs:");
  });
});

describe("出参校验（dev-only 的契约漂移警报）", () => {
  it("每个通道的一次真实调用都过 out schema", async () => {
    const { handlers } = stubDeps({ validateOutputs: true });
    for (const channel of Object.keys(CONTRACT)) {
      const r = await handlers.get(channel)!(
        {},
        GOOD_INPUT[channel] ?? (inSchemaOf(channel) === null ? undefined : {})
      );
      expect(r.ok, `${channel} 出参不符契约：${r.ok ? "" : r.error.message}`).toBe(true);
    }
  });

  it("出参漂移 → dev 报 contract-drift，打包版放行（这就是 validateOutputs 的代价开关）", async () => {
    const drift = () => ({ version: "0.0.0-test", electron: undefined as unknown as string });
    const devR = await stubDeps({ validateOutputs: true, getAppMeta: drift }).handlers.get(
      IPC.appGetMeta
    )!({}, undefined);
    expect(devR.ok).toBe(false);
    if (!devR.ok) {
      expect(devR.error.code).toBe("contract-drift");
      expect(devR.error.message).toContain(IPC.appGetMeta);
    }
    const prodR = await stubDeps({ validateOutputs: false, getAppMeta: drift }).handlers.get(
      IPC.appGetMeta
    )!({}, undefined);
    expect(prodR.ok).toBe(true);
  });

  it("内部异常收敛成 internal，不被误报成 bad-input", async () => {
    const { handlers } = stubDeps({ historyThrows: true });
    const r = await handlers.get(IPC.historyList)!({}, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("internal");
      expect(r.error.message).toContain("磁盘读失败");
    }
  });
});

describe("作者快照（历史页作者列的数据源）", () => {
  const historyOut = CONTRACT[IPC.historyList].out!;
  const enqueueIn = CONTRACT[IPC.downloadEnqueue].in!;

  it("author 全字段可选：老记录（无此键）与新记录（有此键）都过 history:list 出参", () => {
    const legacy = { id: "h-0", files: [], createdAt: 1 };
    const withAuthor = {
      ...legacy,
      author: {
        name: "胶片修复所",
        id: "19324001",
        url: "https://space.bilibili.com/19324001",
        avatar: "https://cdn.example/a.png",
        sign: "每周一更",
        followerCount: 1284000,
        followingCount: 312,
        totalFavorited: 8600000,
      },
    };
    // 只带昵称也合法：平台各异（音乐类只有作者名），不能要求成对出现
    expect(historyOut.safeParse([legacy]).success).toBe(true);
    expect(historyOut.safeParse([withAuthor]).success).toBe(true);
    expect(historyOut.safeParse([{ ...legacy, author: { name: "只知昵称" } }]).success).toBe(true);
  });

  it("计数必须是数字：字符串粉丝数在入参侧就被拒，不进历史.json", () => {
    expect(
      enqueueIn.safeParse({
        items: [{ url: "https://cdn.example.com/a.mp4", filename: "a.mp4", kind: "video" }],
        meta: { author: { name: "小满", followerCount: "1.2万" } },
      }).success
    ).toBe(false);
  });

  it("作者主页/头像有长度上限（历史.json 无体积闸门）", () => {
    const long = "x".repeat(5000);
    expect(
      enqueueIn.safeParse({
        items: [{ url: "https://cdn.example.com/a.mp4", filename: "a.mp4", kind: "video" }],
        meta: { author: { url: long } },
      }).success
    ).toBe(false);
  });
});

describe("队列清理入参（download:clear 的两道闸门）", () => {
  const clearIn = CONTRACT[IPC.downloadClear].in!;
  const clearOut = CONTRACT[IPC.downloadClear].out!;
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);

  it("id 非空串、整批 1..500 颗（上限＝一次点完队列的规模，超出该分批而不是静默截断）", () => {
    expect(clearIn.safeParse({ taskIds: ["a"] }).success).toBe(true);
    expect(clearIn.safeParse({ taskIds: ids(500) }).success).toBe(true);
    expect(clearIn.safeParse({ taskIds: ids(501) }).success).toBe(false);
    expect(clearIn.safeParse({ taskIds: ["a", ""] }).success).toBe(false);
  });

  it("出参只认整数 removed（负数与小数都不可能是「被带走的颗数」）", () => {
    expect(clearOut.safeParse({ removed: 0 }).success).toBe(true);
    expect(clearOut.safeParse({ removed: -1 }).success).toBe(false);
    expect(clearOut.safeParse({ removed: 1.5 }).success).toBe(false);
  });
});

describe("事件载荷", () => {
  it("download 事件载荷复用 DownloadTaskViewSchema（缺字段即拒）", () => {
    const schema = EVENTS[IPC.evDownloadProgress];
    expect(schema.safeParse(TASK_VIEW).success).toBe(true);
    const broken = { ...TASK_VIEW } as Record<string, unknown>;
    delete broken.status;
    expect(schema.safeParse(broken).success).toBe(false);
  });

  it("app:updateState 载荷与 update:state 出参同一 schema（UI 只认一份形状）", () => {
    expect(EVENTS[IPC.evUpdateState]).toBe(CONTRACT[IPC.updateGetState].out);
  });
});

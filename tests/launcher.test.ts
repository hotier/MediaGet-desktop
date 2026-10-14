/**
 * dev:electron 启动器单测（纯函数部分）。
 *
 * 为什么值得单测：这段逻辑防的是**实测过**的启动崩溃（见
 * scripts/launch-electron.cjs 头注释的 A/B 矩阵）—— `ELECTRON_RUN_AS_NODE`
 * 只要存在（哪怕空串）就让 electron 以 Node 模式跑，主进程首行即 TypeError。
 * 回归成本极低（清一个键），但漏了就是「npm run dev 起不来」。
 *
 * 这里不 spawn 真 electron（headless 环境拉 GUI 无意义且不稳定），只断言
 * 环境清洗语义 —— 那正是修复的全部内容。
 */
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POISONED_ENV_KEYS, sanitizeEnv } = require("../scripts/launch-electron.cjs") as {
  POISONED_ENV_KEYS: string[];
  sanitizeEnv: (env: Record<string, string | undefined>) => {
    next: Record<string, string | undefined>;
    removed: string[];
  };
};

describe("launch-electron 环境清洗（defect #3 回归）", () => {
  it("清洗清单至少含 ELECTRON_RUN_AS_NODE（唯一实测触发键）", () => {
    expect(POISONED_ENV_KEYS).toContain("ELECTRON_RUN_AS_NODE");
  });

  it("值 '1' → 删除（真值形式）", () => {
    const { next, removed } = sanitizeEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/x" });
    expect("ELECTRON_RUN_AS_NODE" in next).toBe(false);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain('"1"');
  });

  it("值 '' → 同样删除（实测：空串一样让 electron 走 Node 模式）", () => {
    const { next, removed } = sanitizeEnv({ ELECTRON_RUN_AS_NODE: "", PATH: "/x" });
    expect("ELECTRON_RUN_AS_NODE" in next).toBe(false);
    expect(removed).toHaveLength(1);
  });

  it("未设置 → 不动，也不虚报 removed", () => {
    const { next, removed } = sanitizeEnv({ PATH: "/x" });
    expect(next).toEqual({ PATH: "/x" });
    expect(removed).toEqual([]);
  });

  it("不改动其它环境变量（只清污染键，别误伤 VITE_DEV_SERVER_URL）", () => {
    const { next } = sanitizeEnv({
      ELECTRON_RUN_AS_NODE: "1",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5433",
      MG_BIN_DIR: "D:\\bins",
    });
    expect(next.VITE_DEV_SERVER_URL).toBe("http://127.0.0.1:5433");
    expect(next.MG_BIN_DIR).toBe("D:\\bins");
  });

  it("不修改入参对象（纯函数，避免污染调用方的 process.env 视图）", () => {
    const env = { ELECTRON_RUN_AS_NODE: "1" };
    sanitizeEnv(env);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

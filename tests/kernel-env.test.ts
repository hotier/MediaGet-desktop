/**
 * 回归守卫（2026-10-18 事故）：设置页配的 Cookie 永远到不了内核。
 *
 * 现场：parse-core 的 `xhsCore` / `bilibiliCore` / `instagram` 在**模块作用域**读
 * `getConfigOrEnv("xhsCookie", "XHS_COOKIE", "")`，值在模块首次求值时就定死了。
 * 旧实现把 Cookie 铺进 `process.env` 的时机写在 `index.ts` 的函数体里（`publishKernelEnv()`），
 * 那时整张 import 图早已求值完毕 —— 实测小红书请求头 `cookieLen=0`（先 import 内核再设 env）
 * vs `cookieLen=33`（先设 env 再 import）。修法是把这件事挪进副作用模块 `./kernel-env`，
 * 并让它在 index.ts 里排在 `./engine` 之前。
 *
 * 这里只做源码级断言：模块求值顺序在单测里没有可靠的运行时探针（真正跑起来要 Electron），
 * 但「顺序被谁挪走」这件事本身可以在文本层钉死 —— 挪走就是重演这次事故。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const indexSrc = readFileSync(new URL("../electron/main/index.ts", import.meta.url), "utf8");
const kernelEnvSrc = readFileSync(new URL("../electron/main/kernel-env.ts", import.meta.url), "utf8");

/** 按出现顺序取模块说明符（两种 import 形态：`import "x"` 与 `import … from "x"`） */
function importsInOrder(src: string): string[] {
  const re = /^\s*import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
  return [...src.matchAll(re)].map((m) => m[1]);
}

describe("kernel-env：Cookie 必须在内核求值之前铺进环境", () => {
  it("index.ts 只让单实例锁排在 ./kernel-env 之前，./kernel-env 排在 ./engine 之前", () => {
    const specifiers = importsInOrder(indexSrc);
    // 锁要抢在 kernel-env 开库之前：第二个实例不许先碰 WAL 库与迁移标记再退出
    expect(specifiers.slice(0, 2)).toEqual(["./single-instance", "./kernel-env"]);
    expect(specifiers).toContain("./engine");
    expect(specifiers.indexOf("./kernel-env")).toBeLessThan(specifiers.indexOf("./engine"));
  });

  it("单实例锁模块不开库、不碰内核：只 import electron 与 profile，且先分档再抢锁", () => {
    const lockSrc = readFileSync(new URL("../electron/main/single-instance.ts", import.meta.url), "utf8");
    // profile 只依赖 electron 与 node:path，不触库；但它必须在抢锁前把 dev 的 userData 挪走，
    // 否则 dev 会先占住打包版的单实例锁（两个实例没法并排做 A/B）
    expect(importsInOrder(lockSrc)).toEqual(["electron", "./profile"]);
    const profileAt = lockSrc.indexOf("applyProfile()");
    const lockAt = lockSrc.indexOf("requestSingleInstanceLock()");
    expect(profileAt).toBeGreaterThan(-1);
    expect(profileAt).toBeLessThan(lockAt);
  });

  it("kernel-env 自己从本机设置库读 SECRET_CONFIG_KEYS 并写进 process.env", () => {
    expect(kernelEnvSrc).toMatch(/from\s+["']\.\/storage-runtime["']/);
    expect(kernelEnvSrc).toMatch(/SECRET_CONFIG_KEYS/);
    expect(kernelEnvSrc).toMatch(/loadConfig\(\)/);
    expect(kernelEnvSrc).toMatch(/process\.env\[key\]\s*=\s*value/);
    // 只补「还没有」的键：dev 环境变量手写的 Cookie 优先（与 publishKernelEnv 同一条）
    expect(kernelEnvSrc).toMatch(/!\s*process\.env\[key\]/);
  });
});

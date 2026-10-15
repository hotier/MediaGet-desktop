/**
 * 依赖边界校验（docs/ARCHITECTURE.md §1 三条硬约束，"CI 应校验"的可执行化）：
 * 1. renderer/** 不得出现 @/lib（服务端解析层）——只能经 IPC
 * 2. 全仓不得 import mediaGet src/app/api/**（route 层属于线上服务）
 * 3. 跨进程共享类型只从 types/ipc.ts 取（renderer/main 不各自复制信封）；
 *    契约的 zod schema 真源 types/ipc-contract.ts 只随主进程走 —— renderer 里
 *    出现 zod 或 ipc-contract 的值 import，就意味着 schema 整层被打包进渲染进程。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, pred: (p: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    // .qoder-credits 是 Qoder 应用写入本仓的会话画布产物（IDE 工件，非项目源码）——
    // 不排除的话，用例数会随 IDE 活动漂移，且边界规则会误扫这些文件
    if (
      e === "node_modules" ||
      e === "dist-electron" ||
      e === "dist-renderer" ||
      e === "release" ||
      e === ".qoder-credits"
    )
      continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}

const isSource = (p: string) => /\.s?[jt]sx?$/.test(p) && !p.includes(`${join("tests", "stubs")}`);

describe("铁律 2：全仓禁止 import mediaGet route 层", () => {
  const files = walk(ROOT, isSource);
  it.each(files.map((f) => [relative(ROOT, f)]))("%s 无 app/api import", (relPath) => {
    const src = readFileSync(join(ROOT, relPath), "utf8");
    expect(src).not.toMatch(/from\s+["']@\/app\/api/);
    expect(src).not.toMatch(/import\s*\(\s*["']@\/app\/api/);
    expect(src).not.toMatch(/["'][^"']*mediaGet[/\\]src[/\\]app[/\\]api/);
  });
});

describe("铁律 1：renderer 不触碰服务端解析层", () => {
  const files = walk(join(ROOT, "renderer"), isSource);
  it("存在 renderer 源文件", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each(files.map((f) => [relative(ROOT, f)]))("%s 无 @/lib import", (relPath) => {
    const src = readFileSync(join(ROOT, relPath), "utf8");
    // renderer 允许消费 mediaGet 纯前端 util（utils/、components/），但解析层 @/lib 禁止
    expect(src).not.toMatch(/from\s+["']@\/lib\//);
    expect(src).not.toMatch(/from\s+["']@\/app\//);
  });
});

describe("铁律 3：IPC 类型单一真源", () => {
  it("preload 与 bridge 都从 types/ipc 取类型", () => {
    const preload = readFileSync(join(ROOT, "electron/preload/index.ts"), "utf8");
    const bridge = readFileSync(join(ROOT, "renderer/src/lib/bridge.ts"), "utf8");
    expect(preload).toMatch(/types\/ipc/);
    expect(bridge).toMatch(/types\/ipc/);
  });

  it("preload 不暴露 ipcRenderer 原样（白名单只经 mg 对象）", () => {
    const preload = readFileSync(join(ROOT, "electron/preload/index.ts"), "utf8");
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*["']ipcRenderer/);
  });

  it("renderer 不引 zod 运行时：入参校验只属主进程，ipc.ts 必须零运行时", () => {
    // types/ipc.ts 用 `import type` 从 ipc-contract 派生类型；一旦有人写成值 import，
    // 整个 schema 层就会被 vite 打进 renderer 包（272KB → +zod），且边界从此双向耦合。
    const files = walk(join(ROOT, "renderer"), isSource);
    files.push(join(ROOT, "types", "ipc.ts"));
    for (const f of [...new Set(files)]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${relative(ROOT, f)} 里有 zod 值 import`).not.toMatch(
        /^\s*import\s+(?!type\s)[^;]*from\s+["']zod["']/m
      );
      expect(src, `${relative(ROOT, f)} 里有 ipc-contract 值 import`).not.toMatch(
        /^\s*import\s+(?!type\s)[^;]*from\s+["'][^"']*ipc-contract["']/m
      );
    }
  });
});

describe("零敏感资产入包（铁律 3/§6.1）", () => {
  it("仓库源码不含运维 Cookie 值字面量（gho_/服务端凭据模式）", () => {
    const files = walk(ROOT, (p) => isSource(p) && !p.includes(`${join("tests", "ipc.test.ts")}`));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/Buvid=\w{30,};.*SESSDATA=/s);
    }
  });
});

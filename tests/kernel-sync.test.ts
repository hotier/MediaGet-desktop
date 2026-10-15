/**
 * 内核契约同步守卫（铁律 1「单一代码源」的工件期形态）：
 * types/ipc-contract.ts 的 ParseResultSchema/ParseDataSchema 等是内核工件类型的镜像，
 * 上游加/改/删字段而镜像没跟进时，engine.ts 的 `as unknown as ParseResult` 会静默吞掉
 * 漂移，用户侧表现为结果卡漏字段或渲染 undefined。本测试用字段名集合双向对比把漂移变成当天红叉。
 *
 * 真源 = 已安装工件 `@mediaget/parse-core` 的 `dist/index.d.ts`（§8 双通道主渠道），
 * 不再读并列检出 `../mediaGet`；因此本守卫在 CI 常驻，装不上依赖即红而不是跳过。
 *
 * 2026-10-14 单一真源改造后，镜像侧不再是 interface 文本而是 zod schema：
 * 直接读 `.shape`（运行时真源），工件侧是 .d.ts 接口文本、只能正则抽取。
 *
 * 只比字段名与可选性，不比类型（镜像 platform?: string 有意宽于上游 VideoPlatformKey）。
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ParseDataSchema,
  ParseResultSchema,
  ParsedVideoItemSchema,
  ParsedVideoQualitySchema,
} from "../types/ipc-contract";

const require = createRequire(import.meta.url);

/** 已安装 parse-core 工件的类型入口（package.json exports['.'].types） */
function resolveKernelTypes(): string | null {
  let entry: string;
  try {
    entry = require.resolve("@mediaget/parse-core");
  } catch {
    return null;
  }
  const pkgDir = dirname(dirname(entry)); // dist/index.cjs → 包根
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const typesRel: string | undefined = pkg.exports?.["."]?.types ?? pkg.types;
  if (!typesRel) return null;
  const p = join(pkgDir, typesRel);
  return existsSync(p) ? p : null;
}
const KERNEL_TYPES = resolveKernelTypes();

/** 剥离块/行注释：字段行前的 JSDoc 不应并入语句导致解析丢失 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 取 `interface X { ... }`（工件 .d.ts 里不带 export，源码里带）的花括号体（深度配平） */
function interfaceBody(src: string, name: string): string | null {
  const m = new RegExp(`(?:export )?interface ${name}\\s*\\{`).exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/**
 * 解析接口体的顶层字段（名 → 可选）：按深度 1 的分号切语句，
 * 嵌套对象/联合类型的内部换行与分号不影响切分。索引签名（[key: string]）跳过。
 */
function extractFields(src: string, name: string): Map<string, boolean> | null {
  const body = interfaceBody(stripComments(src), name);
  if (body === null) return null;
  const fields = new Map<string, boolean>();
  let depth = 0;
  let stmt = "";
  const push = (s: string) => {
    const fm = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*:/.exec(s);
    if (fm) fields.set(fm[1], fm[2] === "?");
  };
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === ";" && depth === 0) {
      push(stmt);
      stmt = "";
    } else {
      stmt += ch;
    }
  }
  if (stmt.trim()) push(stmt); // 末条无分号
  return fields;
}

/**
 * 镜像侧字段集合：直接读 zod shape（运行时真源，比正则解析自己的源码更不容易骗过自己）。
 * 可选性 = 是否被 ZodOptional 包一层；`.passthrough()` 的额外键不算字段，与上游对齐判断无关。
 */
function schemaFields(schema: z.ZodObject<z.ZodRawShape>): Map<string, boolean> {
  const fields = new Map<string, boolean>();
  for (const [key, value] of Object.entries(schema.shape)) {
    fields.set(key, value instanceof z.ZodOptional);
  }
  return fields;
}

/** 工件类型名 → 镜像 schema（顺序即下面的对账用例顺序） */
const LOCAL_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  ParsedVideoQuality: ParsedVideoQualitySchema,
  ParsedVideoItem: ParsedVideoItemSchema,
  ParseData: ParseDataSchema,
  ParseResult: ParseResultSchema,
};

const pairs = [
  ["ParsedVideoQuality", "ParsedVideoQuality"],
  ["ParsedVideoItem", "ParsedVideoItem"],
  ["ParseData", "ParseData"],
  ["ApiResponse", "ParseResult"],
] as const;

describe("types/ipc-contract.ts 镜像与 @mediaget/parse-core 的 .d.ts 字段集合一致", () => {
  // 工件是 package.json 里的声明依赖，读不到类型入口说明安装坏了 —— 红，不跳过。
  it("已安装工件在位（@mediaget/parse-core 类型入口）", () => {
    expect(KERNEL_TYPES, `未找到 @mediaget/parse-core 的类型入口（pnpm install 未跑或 exports.types 变更？）`).not.toBeNull();
  });

  for (const [kernelName, localName] of pairs) {
    it(`${kernelName} → ${localName}`, () => {
      const kernel = extractFields(readFileSync(KERNEL_TYPES!, "utf8"), kernelName);
      const local = schemaFields(LOCAL_SCHEMAS[localName]);
      expect(kernel, `工件缺少 interface ${kernelName}（内核重构改名？核对消费点后同步本测试）`).not.toBeNull();

      const missing = [...kernel!.keys()].filter((f) => !local.has(f));
      const extra = [...local.keys()].filter((f) => !kernel!.has(f));
      // 工件新增而镜像缺 → 结果卡静默漏渲染；镜像多出 → 协议面漂移，必须跟工件对齐
      expect(missing, `${localName} 落后于工件，缺字段`).toEqual([]);
      expect(extra, `${localName} 有工件不存在的字段`).toEqual([]);

      for (const f of kernel!.keys()) {
        expect(
          local.get(f),
          `${localName}.${f} 可选性与工件不一致（契约松紧变化须复核消费端）`
        ).toBe(kernel!.get(f));
      }
    });
  }
});

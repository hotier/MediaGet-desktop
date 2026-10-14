/**
 * 内核契约同步守卫（铁律 1「单一代码源」的物理链接期形态）：
 * types/ipc-contract.ts 的 ParseResultSchema/ParseDataSchema 等是 mediaGet
 * src/types/api.ts 的镜像，上游加/改/删字段而镜像没跟进时，engine.ts 的
 * `as unknown as ParseResult` 会静默吞掉漂移，用户侧表现为结果卡漏字段或渲染 undefined。
 * 本测试用字段名集合双向对比把漂移变成当天红叉。parse-core 版本化工件发布后，
 * 本守卫改比对工件的 .d.ts（见 engine.ts 切换清单）。
 *
 * 2026-10-14 单一真源改造后，镜像侧不再是 interface 文本而是 zod schema：
 * 直接读 `.shape`（运行时真源），上游侧仍是 TS 接口文本、只能正则抽取。
 *
 * 只比字段名与可选性，不比类型（镜像 platform?: string 有意宽于上游 VideoPlatformKey）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ParseDataSchema,
  ParseResultSchema,
  ParsedVideoItemSchema,
  ParsedVideoQualitySchema,
} from "../types/ipc-contract";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// 上游 P0 迁移后真源在 packages/parse-core/src/types/api.ts（src/types/api.ts 只剩薄壳）；
// 迁移前的旧检出回退读 src/types/api.ts。
function resolveUpstreamTypes(): string | null {
  for (const p of [
    join(ROOT, "..", "mediaGet", "packages", "parse-core", "src", "types", "api.ts"),
    join(ROOT, "..", "mediaGet", "src", "types", "api.ts"),
  ]) {
    if (existsSync(p)) {
      const src = readFileSync(p, "utf8");
      if (src.includes("export interface ParseData")) return p;
    }
  }
  return null;
}
const UPSTREAM_TYPES = resolveUpstreamTypes() ?? join(ROOT, "..", "mediaGet", "src", "types", "api.ts");

/** 剥离块/行注释：字段行前的 JSDoc 不应并入语句导致解析丢失 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 取 `export interface X { ... }` 的花括号体（深度配平） */
function interfaceBody(src: string, name: string): string | null {
  const m = new RegExp(`export interface ${name}\\s*\\{`).exec(src);
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

/** 上游名 → 镜像 schema（顺序即下面的对账用例顺序） */
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

const upstreamMissing = !existsSync(UPSTREAM_TYPES);

describe("types/ipc-contract.ts 镜像与上游 src/types/api.ts 字段集合一致", () => {
  // 物理链接期守卫：parse-core 工件化后并列检出删除，届时本套件整体跳过（不算假绿，
  // 工件 .d.ts 比对由切换 PR 一并落地）。
  it.skipIf(upstreamMissing)("上游检出在位（../mediaGet）", () => {
    expect(existsSync(UPSTREAM_TYPES)).toBe(true);
  });

  for (const [upstreamName, localName] of pairs) {
    it.skipIf(upstreamMissing)(`${upstreamName} → ${localName}`, () => {
      const upstream = extractFields(readFileSync(UPSTREAM_TYPES, "utf8"), upstreamName);
      const local = schemaFields(LOCAL_SCHEMAS[localName]);
      expect(upstream, `上游缺少 interface ${upstreamName}（上游重构？核对消费点后同步本测试）`).not.toBeNull();

      const missing = [...upstream!.keys()].filter((f) => !local.has(f));
      const extra = [...local.keys()].filter((f) => !upstream!.has(f));
      // 上游新增而镜像缺 → 结果卡静默漏渲染；镜像多出 → 协议面漂移，必须跟上游对齐
      expect(missing, `${localName} 落后于上游，缺字段`).toEqual([]);
      expect(extra, `${localName} 有上游不存在的字段`).toEqual([]);

      for (const f of upstream!.keys()) {
        expect(
          local.get(f),
          `${localName}.${f} 可选性与上游不一致（契约松紧变化须复核消费端）`
        ).toBe(upstream!.get(f));
      }
    });
  }
});

/**
 * 契约标量口径，与「按契约声明收拢上游载荷」这一层兜底。
 *
 * 为什么要有这层：上游内核只做**字段名**映射，不做**类型**归一。真源在
 * `../mediaGet/packages/parse-core/src/lib/normalize-result.ts:118` —— 它把 bilibili 的数字 mid
 * 写成 `user.uid as string`（`as` 是编译期幻觉，运行时仍是数字；来源 `bilibiliCore.js:436` 的
 * `owner.mid`），`youtube.js:907` 的 authorId 同样没转，`xhsCore.js:653-656` 的互动计数原样带
 * `?? ""` 而契约声明的是数字。解析器都是 `.js`，所以 `ParseData` 那份接口声明在赋值处使不上劲。
 *
 * 脏值的后果不是「这一格显示不出来」而是「这一整页没了」：`ParseDataSchema` 末尾是
 * `.passthrough()`（内核可以多带字段，升级不必回头改契约），于是脏值能在 `parse:run` 的出参校验里
 * 全身而退、被抄进历史档，再让**整次 `history:list`** 判成 contract-drift（2026-10-18 历史页那次）。
 * 所以收拢点排在**引擎出口**，排在结果缓存之前 —— 缓存里存的必须是干净那份。
 *
 * 三条规则，方向固定：
 * 1. **合法的载荷一个字节都不改**（`fitToContract` 第一行整表 safeParse 过就直接原样带回）。
 * 2. **能收就收**：数字 id 收成字符串（保留而不是丢弃），纯数字串计数收成数字。
 * 3. **收不拢的只有可选档才留空**；必填档原样留着，让它按原样去碰出参校验——
 *    删字段是静默丢数据，报错才是这条线该有的下场。
 */
import type { ZodTypeAny } from "zod";

/**
 * 文本档归一：字符串裁首尾空白，数字/大整数**收成字符串**，别的（对象、数组、布尔、空串）留空。
 *
 * 数字那一档是这次翻案的重点：内核把 bilibili 的 mid 填成 `290526283` 时，旧口径是「类型不符就丢空」，
 * 于是作者 ID 在历史页里凭空少一格。契约声明的是字符串，那正确的兜底是**把它写成字符串**而不是扔掉——
 * 信息留着，出参校验也过。
 */
export function toText(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const s = raw.trim();
    return s === "" ? undefined : s;
  }
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : undefined;
  if (typeof raw === "bigint") return raw.toString();
  return undefined;
}

/**
 * 原始值 → 有限数字（含 0 与负数，含纯数字串）。这是**契约的 number 档**该有的口径。
 */
export function toNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "" || !/^[+-]?\d+(\.\d+)?$/.test(t)) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * 原始计数 → 数字（作者快照与结果计数共用这一条口径）：只收「正数」。
 *
 * 小红书等平台的 interactInfo 计数**是字符串**（内核注释写明「可能是字符串，保留原始值交给前端
 * 格式化」），其中 `"1.2万"` 这类已缩水的写法拿不回精确值 —— 宁可不写这一档，也不要把近似值
 * 当真实数字导出去（导出是要进 Excel 求和的）。0 在这里也算「没有这一档」：
 * 计数快照只写有内容的档，界面才不会排出一列零。
 */
export function toCount(raw: unknown): number | undefined {
  const n = toNumber(raw);
  return n !== undefined && n > 0 ? n : undefined;
}

type ZodDef = {
  typeName?: string;
  innerType?: ZodTypeAny;
  options?: ZodTypeAny[];
  /** zod 3 把数组元素声明放在 `_def.type`（实例上的 `.element` 只是它的 getter） */
  type?: ZodTypeAny;
  element?: ZodTypeAny;
  values?: readonly unknown[];
  shape?: (() => Record<string, ZodTypeAny>) | Record<string, ZodTypeAny>;
};

const defOf = (s: ZodTypeAny): ZodDef => (s as unknown as { _def?: ZodDef })._def ?? {};

const shapeOf = (s: ZodTypeAny): Record<string, ZodTypeAny> => {
  const raw = defOf(s).shape;
  if (typeof raw === "function") {
    try {
      return raw();
    } catch {
      return {};
    }
  }
  return raw ?? {};
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isOmissible = (s: ZodTypeAny): boolean => {
  const t = defOf(s).typeName;
  return t === "ZodOptional" || t === "ZodNullable";
};

/**
 * 按声明把 `value` 收进 `schema` 的形状里；收拢失败时原样带回（不假装字段不存在）。
 *
 * 表不在这儿写：**契约就是表**——本层只读 `schema` 的节点类型，所以契约新增一个字段不需要动这里，
 * 也不会出现「契约改了、兜底表漏了一档」那种静默漂移。
 */
export function fitToContract<T>(schema: ZodTypeAny, value: T): T {
  if (schema.safeParse(value).success) return value;
  return (fit(schema, value) ?? value) as T;
}

/** 收不拢返回 undefined，由调用方决定「留空」还是「原样留着报错」 */
function fit(schema: ZodTypeAny, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (schema.safeParse(value).success) return value;
  const d = defOf(schema);
  switch (d.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return d.innerType ? fit(d.innerType, value) : undefined;
    case "ZodString":
      return toText(value);
    case "ZodNumber":
      return toNumber(value);
    case "ZodBoolean":
      return typeof value === "boolean" ? value : undefined;
    case "ZodEnum":
      return d.values?.includes(value) ? value : undefined;
    case "ZodUnion":
      for (const option of d.options ?? []) {
        const fitted = fit(option, value);
        if (fitted !== undefined && option.safeParse(fitted).success) return fitted;
      }
      return undefined;
    case "ZodArray": {
      if (!Array.isArray(value)) return undefined;
      const el = d.type ?? d.element;
      if (!el) return value;
      // 元素收不拢就原样留着那颗：数组里少一颗是数据丢失，多一颗非法则由出参校验如实报错
      return value.map((item) => {
        const fitted = fit(el, item);
        return fitted === undefined ? item : fitted;
      });
    }
    case "ZodObject": {
      if (!isRecord(value)) return undefined;
      const out: Record<string, unknown> = { ...value }; // 未声明的键原样留着（契约是 passthrough）
      for (const [key, child] of Object.entries(shapeOf(schema))) {
        if (!(key in out)) continue; // 缺项保持缺项，不替内核编造字段
        const fitted = fit(child, out[key]);
        // 收拢过的就采用，哪怕这颗仍未完全合契：能修一格是一格，剩下的交给出参校验如实报错。
        // 反过来（校验不过就退回原值）会把同层修好的字段一起丢掉，报错信息反而更假。
        if (fitted === undefined) {
          if (isOmissible(child)) delete out[key]; // 可选档留空，别拿脏值毁掉整份载荷
        } else out[key] = fitted;
      }
      return out;
    }
    default:
      return undefined; // 认不出的节点类型不动它：这层只负责收，不负责猜
  }
}

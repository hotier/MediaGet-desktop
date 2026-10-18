/**
 * 引擎出口的契约收拢层（`shared/coerce.ts`）——业主指令 2026-10-18：
 * 「先检查上游解析引擎是否做字段归一化处理，如果没有完善的话帮我做兜底，包含 uid 这种」。
 *
 * 查过了：内核只做**字段名**映射（`../mediaGet/packages/parse-core/src/lib/normalize-result.ts`
 * 的 `FIELD_SOURCES` + 通用拷贝循环），类型一处不收，解析器又全是 `.js`，所以 `ParseData`
 * 那份接口在赋值处使不上劲。后果不是「这一格显示不出来」而是「这一整页没了」，
 * 2026-10-18 历史页那次空态就是这么来的（回归见 tests/store.test.ts）。
 *
 * 钉住三条判据，方向都不许反过来：
 * ① 合法载荷**原样带回**（同一引用）——这层不许把干净数据重排一遍；
 * ② 能收就收：数字 mid → 字符串、`"5000"` 计数 → 数字，信息留在档里；
 * ③ 收不拢的只有可选档才留空；必填档原样留着让出参校验如实报错——静默删字段等于丢数据。
 */
import { describe, expect, it } from "vitest";
import { fitToContract, toNumber, toText } from "../shared/coerce";
import { ParseResultSchema } from "../types/ipc-contract";

describe("toText", () => {
  it("字符串裁首尾，数字与大整数收成字符串（这就是 uid 那一档的兜底）", () => {
    expect(toText(" MS4wLjAB ")).toBe("MS4wLjAB");
    expect(toText(290526283)).toBe("290526283");
    expect(toText(1.5)).toBe("1.5");
    expect(toText(9007199254740993n)).toBe("9007199254740993");
  });

  it("空串与非标量留空：不给契约字段填「0」「null」这种看着像值的噪声", () => {
    expect(toText("")).toBeUndefined();
    expect(toText("   ")).toBeUndefined();
    expect(toText(Number.NaN)).toBeUndefined();
    expect(toText(null)).toBeUndefined();
    expect(toText(true)).toBeUndefined();
    expect(toText({ mid: 1 })).toBeUndefined();
    expect(toText(["a"])).toBeUndefined();
    expect(toText(undefined)).toBeUndefined();
  });
});

describe("toNumber", () => {
  it("有限数字含 0 与负数都收（这是契约的 number 档，不是结果卡的显示口径）", () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-3)).toBe(-3);
    expect(toNumber(" 5000 ")).toBe(5000);
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber(10n)).toBe(10);
  });

  it("缩水的写法与 NaN/Infinity 不收", () => {
    expect(toNumber("1.2万")).toBeUndefined();
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("abc")).toBeUndefined();
    expect(toNumber(Number.NaN)).toBeUndefined();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toNumber({})).toBeUndefined();
  });
});

describe("fitToContract(ParseResultSchema) —— 内核脏值逐条对应", () => {
  it("合法载荷原样带回，一个字节都不改（同一引用）", () => {
    const ok = {
      code: 200,
      msg: "解析成功",
      platform: "douyin",
      data: { title: "a", url: "https://x/a.mp4", time: 1_699_000_000, stat: { like: 12 } },
    };
    expect(fitToContract(ParseResultSchema, ok)).toBe(ok);
  });

  /** normalize-result.ts:118 的 `authorId: user.uid as string` —— `as` 是编译期幻觉，运行时仍是数字 */
  it("bilibili 的数字 mid 收成字符串：作者 ID 留着而不是丢掉", () => {
    const out = fitToContract(ParseResultSchema, {
      code: 200,
      msg: "解析成功",
      data: { author: "王刚", uid: 290526283, authorId: 402090056 },
    });
    expect(out.data?.uid).toBe("290526283");
    expect(out.data?.authorId).toBe("402090056");
    expect(ParseResultSchema.safeParse(out).success).toBe(true);
  });

  /**
   * 计数档两份口径要分清：契约的 number 档收 0（`toNumber`），结果卡与导出的显示口径不收
   * （`toCount`，见 shared/work-stat.ts）。小红书把 `interactInfo` 的计数原样带字符串（xhsCore.js:652-655）。
   */
  it("字符串计数收成数字，「1.2万」这种收不拢的只留空那一档", () => {
    const out = fitToContract(ParseResultSchema, {
      code: 200,
      msg: "解析成功",
      data: { like: "5000", stat: { favorite: "", reply: "1.2万", coin: "0" } },
    });
    expect(out.data?.like).toBe(5000);
    expect(out.data?.stat).toEqual({ coin: 0 });
    expect(ParseResultSchema.safeParse(out).success).toBe(true);
  });

  it("契约外的键原样留着（ParseDataSchema 是 passthrough，内核可以多带）", () => {
    const extra = { bvid: "BV1xx411c7mD", cid: 99 };
    const out = fitToContract(ParseResultSchema, {
      code: 200,
      msg: "解析成功",
      data: { title: "a", kernelExtras: extra, favorite: "1.2万", uid: 1 },
    });
    expect(out.data?.kernelExtras).toEqual(extra);
    // 声明外的平铺计数不在这里改：归一它的活儿在 read 侧（shared/work-stat.ts 的档位表）
    expect(out.data?.favorite).toBe("1.2万");
    expect(out.data?.uid).toBe("1");
  });

  it("嵌套数组逐颗收：videos[].url 的数字形状、qualities[].quality 的数字串", () => {
    const out = fitToContract(ParseResultSchema, {
      code: 200,
      msg: "解析成功",
      data: {
        videos: [
          { url: 42, qualities: [{ quality: "10", label: 1080 }] },
          { url: "https://x/b.mp4" },
        ],
      },
    });
    expect(out.data?.videos?.[0]?.url).toBe("42");
    expect(out.data?.videos?.[0]?.qualities?.[0]).toEqual({ quality: 10, label: "1080" });
    expect(out.data?.videos?.[1]?.url).toBe("https://x/b.mp4");
  });

  it("同层修好的一格不因另一格修不动而退回：能修一格是一格，剩下的如实报错", () => {
    const out = fitToContract(ParseResultSchema, {
      code: 200,
      msg: "解析成功",
      data: { videos: [{ url: null, duration: "100" }] },
    });
    expect(out.data?.videos?.[0]?.duration).toBe(100);
    expect(out.data?.videos?.[0]?.url).toBeNull();
    expect(ParseResultSchema.safeParse(out).success).toBe(false);
  });

  it("枚举值不在档内留空（type 是可选档，不猜）", () => {
    const out = fitToContract(ParseResultSchema, {
      code: 200,
      msg: "解析成功",
      data: { type: "livestream", title: "a" },
    });
    expect("type" in (out.data ?? {})).toBe(false);
    expect(out.data?.title).toBe("a");
  });

  it("union 档挑第一个能收下的分支（time 两种单位与数字串都原样走得通）", () => {
    expect(
      fitToContract(ParseResultSchema, { code: 200, msg: "ok", data: { time: "1699000000" } })
        .data?.time
    ).toBe("1699000000");
    expect(
      fitToContract(ParseResultSchema, { code: 200, msg: "ok", data: { time: [2026, 10, 18] } })
        .data?.time
    ).toBeUndefined();
  });

  it("data 不是对象时整档留空，而不是带一个脏值进缓存", () => {
    const out = fitToContract(ParseResultSchema, { code: 200, msg: "解析成功", data: "oops" });
    expect("data" in out).toBe(false);
  });

  it("缺项保持缺项：不替内核编造字段", () => {
    const out = fitToContract(ParseResultSchema, { code: 200, msg: "解析成功", data: { uid: 1 } });
    expect(Object.keys(out.data ?? {})).toEqual(["uid"]);
  });

  it("必填档收不拢时原样留着，让出参校验如实报错（删字段才是静默丢数据）", () => {
    const out = fitToContract(ParseResultSchema, { code: "200abc", msg: "解析成功" });
    expect(out.code).toBe("200abc");
    expect(ParseResultSchema.safeParse(out).success).toBe(false);
  });

  it("幂等：收过的载荷再收一次，结果一样", () => {
    const dirty = { code: 200, msg: "解析成功", data: { uid: 1, like: "5000", type: "livestream" } };
    const once = fitToContract(ParseResultSchema, dirty);
    const twice = fitToContract(ParseResultSchema, once);
    expect(twice).toEqual(once);
    expect(fitToContract(ParseResultSchema, twice)).toBe(twice);
  });
});

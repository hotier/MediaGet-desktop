/**
 * 夹具回归：把预览假桥里的每种真实契约形态喂给下载计划纯函数。
 *
 * 这条测试是因为实机预览里发现「芯片出现两个 1080P」而加的——内核经常把主直链
 * 同时写成 data.url 和 qualities[i].url，选择器必须把它认成同一档并默认选中它，
 * 否则「你现在拿到的是哪一档」就是说糊的。
 */
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../renderer/src/dev/mock-bridge";
import { buildPlan, buildQualityPlan } from "../renderer/src/lib/download-plan";

const cases = Object.entries(FIXTURES);

describe("真实契约形态 × 清晰度选择器", () => {
  it("每个夹具的芯片文案都不重复", () => {
    for (const [key, { data }] of cases) {
      const labels = buildQualityPlan(data).options.map((o) => o.label);
      expect(new Set(labels).size, `${key}: ${labels.join("/")}`).toBe(labels.length);
    }
  });

  it("默认选中位指向内核主直链那一档", () => {
    for (const [key, { data }] of cases) {
      const { options, primaryIndex } = buildQualityPlan(data);
      if (!data.url || options.length === 0) continue;
      const primary = options[primaryIndex];
      expect(primary, key).toBeDefined();
      // url=null 表示「就用 data.url」；否则这一档的 url 必须就是主直链
      if (primary.url !== null) expect(primary.url, key).toBe(data.url);
      if (data.qualityLabel) expect(primary.label, key).toBe(data.qualityLabel);
    }
  });

  it("主直链已在 qualities 里时不再合成默认档", () => {
    const { data } = FIXTURES.bilibili;
    const plan = buildQualityPlan(data);
    expect(plan.options.map((o) => o.label)).toEqual(["1080P", "720P", "480P", "仅音频"]);
    expect(plan.primaryIndex).toBe(0);
  });

  it("主直链不在 qualities 里时才合成默认档并置顶", () => {
    const { data } = FIXTURES.bilibili;
    const plan = buildQualityPlan({ ...data, url: "https://mirror.example/bili/weird.m3u8" });
    expect(plan.options[0].label).toBe("1080P"); // data.qualityLabel
    expect(plan.options[0].url).toBeNull();
    expect(plan.primaryIndex).toBe(0);
  });

  it("逐档展开的计划都不含空直链、也不重复下同一份", () => {
    for (const [key, { data }] of cases) {
      for (const opt of buildQualityPlan(data).options) {
        const plan = buildPlan(data, opt);
        const urls = plan.map((p) => p.url);
        expect(urls.every(Boolean), `${key} · ${opt.label}`).toBe(true);
        expect(new Set(urls).size, `${key} · ${opt.label}`).toBe(urls.length);
      }
    }
  });
});

describe("多 P 清晰度回落", () => {
  it("选中 1080P 时，只有 720P 的 P3 显式标注回落", () => {
    const { data } = FIXTURES.bilibili;
    const plan = buildQualityPlan(data);
    const entries = buildPlan(data, plan.options.find((o) => o.label === "1080P")!);
    expect(entries.find((e) => e.id === "p-2")).toMatchObject({
      url: "https://mirror.example/bili/p3-default.m4s",
      fallbackNote: "无 1080P，用默认清晰度",
    });
    expect(entries.find((e) => e.id === "p-1")?.url).toBe("https://mirror.example/bili/p2-1080.m4s");
  });

  it("选中 720P 时每个 P 都有对应档位，不出现回落标注", () => {
    const { data } = FIXTURES.bilibili;
    const entries = buildPlan(data, buildQualityPlan(data).options.find((o) => o.label === "720P")!);
    expect(entries.filter((e) => e.fallbackNote).map((e) => e.id)).toEqual([]);
  });

  it("默认选中位就是 1080P 时，多 P 同样按该档解析并标注缺口", () => {
    const { data } = FIXTURES.bilibili;
    const plan = buildQualityPlan(data);
    const entries = buildPlan(data, plan.options[plan.primaryIndex]);
    // 默认位指向真实档位（而不是「什么都不要求」），所以 P1/P2 拿到 1080P、P3 显式说没有
    expect(entries.find((e) => e.id === "p-0")?.url).toBe("https://mirror.example/bili/p1-1080.m4s");
    expect(entries.find((e) => e.id === "p-2")?.fallbackNote).toBe("无 1080P，用默认清晰度");
  });
});

describe("无媒体形态", () => {
  it("embedOnly 夹具展开成空计划（按钮据此禁用）", () => {
    const { data } = FIXTURES.acfun;
    expect(buildQualityPlan(data).options).toEqual([]);
    expect(buildPlan(data)).toEqual([]);
  });

  it("纯音频夹具的计划只有音频一项", () => {
    const { data } = FIXTURES.qqmusic;
    expect(buildPlan(data).map((p) => p.kind)).toEqual(["audio"]);
  });

  it("图集夹具逐张成项", () => {
    const { data } = FIXTURES.xhs;
    const entries = buildPlan(data);
    expect(entries).toHaveLength(9);
    expect(entries.every((e) => e.kind === "image")).toBe(true);
  });
});

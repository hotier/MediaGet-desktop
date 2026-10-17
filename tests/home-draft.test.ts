/**
 * 首页工作台的会话草稿（业主指令 2026-10-17：切走再切回，上一次解析的结果还在，
 * 除非重新解析了新的链接）。
 *
 * 两组判据各守一头：
 * - store 本体：整表替换 / id 不复用 / 补丁合并 —— 这三条决定「新批次覆盖旧结果」
 *   与「重试不追加卡片」是否成立；
 * - 首页接线（源码结构）：工作态一旦有人搬回 useState，切页就静默归零，
 *   而类型检查与渲染冒烟都不会红 —— 手法同 tests/empty-state.test.ts。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { useHomeDraft } from "../renderer/src/store/home-draft";
import type { ParseRunOutcome } from "../types/ipc";

const outcome = (title: string): ParseRunOutcome => ({
  result: { code: 200, msg: "解析成功", platform: "kuaishou", data: { title } },
  via: "local",
  durationMs: 10,
});

/** 每次用例从空草稿起：模块级 store 是单例，不清就会带着上一条的批次进来 */
beforeEach(() => {
  useHomeDraft.setState({ text: "", hint: "", items: [], busy: false, nextId: 0 });
});

describe("草稿表：批次与补丁", () => {
  it("新批次整表替换旧结果（「除非重新解析了新的链接」就是这一句）", () => {
    const first = useHomeDraft.getState().startBatch(["https://a", "https://b"]);
    expect(first).toHaveLength(2);
    useHomeDraft.getState().patchItem(first[0].id, { status: "done", outcome: outcome("旧作品") });

    const second = useHomeDraft.getState().startBatch(["https://c"]);
    const items = useHomeDraft.getState().items;
    expect(items.map((it) => it.text)).toEqual(["https://c"]);
    expect(items[0].id).toBe(second[0].id);
    expect(items[0].status).toBe("pending");
  });

  it("卡片 id 单调不复用：重挂载不能把编号退回 0 而撞到在飞的任务", () => {
    const a = useHomeDraft.getState().startBatch(["https://a"]);
    const b = useHomeDraft.getState().startBatch(["https://b", "https://c"]);
    expect(a.map((it) => it.id)).toEqual([1]);
    expect(b.map((it) => it.id)).toEqual([2, 3]);
  });

  it("patchItem 只命中那一条，且是合并而非覆盖", () => {
    const batch = useHomeDraft.getState().startBatch(["https://a", "https://b"]);
    useHomeDraft.getState().patchItem(batch[0].id, { status: "done", outcome: outcome("作品一") });
    useHomeDraft.getState().patchItem(batch[0].id, { at: 1730000000000 });
    const [one, two] = useHomeDraft.getState().items;
    // 第二次补丁没带 status/outcome，前一次的必须还在
    expect(one).toMatchObject({ status: "done", outcome: outcome("作品一"), at: 1730000000000 });
    expect(two.status).toBe("pending");
  });

  it("重试 = 把那张卡清回 pending，不新增卡片", () => {
    const batch = useHomeDraft.getState().startBatch(["https://a"]);
    useHomeDraft.getState().patchItem(batch[0].id, { status: "done", outcome: outcome("作品一"), at: 1 });
    useHomeDraft.getState().patchItem(batch[0].id, { status: "pending", outcome: undefined, at: undefined });
    const items = useHomeDraft.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");
    expect(items[0].outcome).toBeUndefined();
    expect(items[0].at).toBeUndefined();
  });

  it("输入草稿与进行态同住：busy 不是组件 state，切页打断不了在飞的批次", () => {
    useHomeDraft.getState().setText("  https://a  https://b ");
    useHomeDraft.getState().setHint("识别到 2 条");
    useHomeDraft.getState().setBusy(true);
    const s = useHomeDraft.getState();
    expect([s.text, s.hint, s.busy]).toEqual(["  https://a  https://b ", "识别到 2 条", true]);
  });
});

/** 首页只该留两个真正的组件态（帮助弹窗、最近解析列表），其余全在 store 里 */
const SRC = readFileSync(
  fileURLToPath(new URL("../renderer/src/pages/HomePage.tsx", import.meta.url)),
  "utf8"
);

describe("首页接线：工作态不得搬回组件", () => {
  it("草稿整份取自 store，本地 useState 只剩帮助弹窗与最近列表", () => {
    expect(SRC).toContain("useHomeDraft()");
    expect(SRC.match(/= useState[<(]/g) ?? []).toHaveLength(2);
    for (const name of ["text", "hint", "items", "busy"]) {
      expect(SRC, `草稿字段 ${name} 不得留在组件里`).not.toMatch(
        new RegExp(`const \\[[^\\]]*\\b${name}\\b[^\\]]*\\] = useState`)
      );
    }
  });

  it("结果卡拿到 parsedAt：直链计龄从到手那刻起算，不是从卡片重挂载起算", () => {
    expect(SRC).toMatch(/at: Date\.now\(\)/);
    expect(SRC).toContain("parsedAt={item.at}");
  });

  it("「最近解析」在批次落定后才重取（在飞时取会拿到半张表）", () => {
    expect(SRC).toContain('it.status !== "pending"');
    expect(SRC).toMatch(/if \(!settled\) return;[\s\S]{0,160}api\.history\.list/);
  });
});

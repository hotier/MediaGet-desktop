/**
 * 更新动作组渲染与回执守卫（react-dom/server + 纯函数，无 DOM）。
 *
 * 钉业主指令 2026-10-17 的两半：
 *  ① 「检查更新」常驻——原先 `canCheck` 为假时整颗按钮不渲染，dev 里那行右侧成一片空白，被读成缺陷；
 *  ② 无源时点了要出声——主进程 `check()` 在这种环境原样回吐快照、阶段不迁移，`update-announce`
 *     决策表永远不响，所以这一声只能由点击侧自己发。
 * 同时钉住「不许加一行」：环境说明不常驻 DOM，只在被点出来时以 toast 出现。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UpdateActions, noSourceNotice } from "../renderer/src/components/Update";
import type { UpdateState } from "../types/ipc";

const NO_SOURCE = "当前运行环境没有更新源";

const render = (s: UpdateState): string =>
  renderToStaticMarkup(createElement(UpdateActions, { state: s, onState: () => {} }));

describe("「检查更新」常驻", () => {
  it("无更新源（开发态）：按钮仍在且可点，说明不占行", () => {
    const html = render({ phase: "unsupported", currentVersion: "0.1.0", canCheck: false });
    expect(html).toContain("检查更新");
    expect(html).not.toMatch(/disabled=""/);
    expect(html).not.toContain(NO_SOURCE);
  });

  it("有更新源（发布态）：按钮可点", () => {
    const html = render({ phase: "idle", currentVersion: "0.1.0", canCheck: true });
    expect(html).toContain("检查更新");
    expect(html).not.toMatch(/disabled=""/);
  });

  it("检查中：按钮不消失，文案转为「检查中…」并置灰", () => {
    const html = render({ phase: "checking", currentVersion: "0.1.0", canCheck: true });
    expect(html).toContain("检查中…");
    expect(html).toMatch(/disabled=""/);
  });
});

describe("无源点击的回执", () => {
  it("无源：回吐那句环境说明（点击侧据此发 info toast）", () => {
    expect(noSourceNotice({ phase: "unsupported", currentVersion: "0.1.0", canCheck: false })).toBe(NO_SOURCE);
  });

  it("有源：不回执——有回执就不往主进程走了，这条 null 是分支的前提", () => {
    expect(noSourceNotice({ phase: "idle", currentVersion: "0.1.0", canCheck: true })).toBeNull();
  });
});

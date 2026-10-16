/**
 * 更新播报决策表（renderer/src/lib/update-announce.ts）的用例。
 * 钉住业主报的回归（2026-10-15）：取消下载后状态回落 available，
 * 不得再播「发现新版本」；同时守住原有的该播项（首次 available / up-to-date /
 * downloaded / error）与「同快照不重播」。
 */
import { describe, expect, it } from "vitest";
import { updateNotice } from "../renderer/src/lib/update-announce";
import type { UpdateState } from "../types/ipc";

type Phase = UpdateState["phase"];

const ALL: Phase[] = [
  "idle", "checking", "up-to-date", "available", "downloading", "paused", "downloaded", "error", "unsupported",
];

describe("updateNotice（prev → next 的播报档位）", () => {
  it("首次发现新版本播 info", () => {
    expect(updateNotice("idle", "available")).toBe("info");
    expect(updateNotice("checking", "available")).toBe("info");
    expect(updateNotice("up-to-date", "available")).toBe("info");
    expect(updateNotice("error", "available")).toBe("info");
  });

  it("取消/暂停下载后的 available 回落不播（业主报 2026-10-15 的 bug 本体）", () => {
    expect(updateNotice("downloading", "available")).toBeNull();
    expect(updateNotice("paused", "available")).toBeNull();
  });

  it("up-to-date / downloaded / error 各按档播", () => {
    expect(updateNotice("checking", "up-to-date")).toBe("info");
    expect(updateNotice("downloading", "downloaded")).toBe("info");
    expect(updateNotice("idle", "error")).toBe("error");
    expect(updateNotice("available", "error")).toBe("error");
  });

  it("进行中阶段不播（checking/downloading/paused 由流式下载弹窗承载）", () => {
    expect(updateNotice("available", "downloading")).toBeNull();
    expect(updateNotice("downloading", "paused")).toBeNull();
    expect(updateNotice("idle", "checking")).toBeNull();
  });

  it("同一阶段重复送达不播第二次（事件回灌 / 动作返回值与事件重复）", () => {
    for (const p of ALL) expect(updateNotice(p, p)).toBeNull();
  });

  it("未打包/无源的 unsupported 不播（横幅入口已隐藏，播报只会制造噪声）", () => {
    expect(updateNotice("idle", "unsupported")).toBeNull();
  });

  it("穷举不变量：同阶段必静默；非 null 只落在结果阶段；跨到 error 必是 error 档", () => {
    const RESULT: Phase[] = ["up-to-date", "available", "downloaded", "error"];
    for (const prev of ALL) {
      for (const next of ALL) {
        const n = updateNotice(prev, next);
        if (prev === next) {
          expect(n, `${prev}→${next} 同阶段重复送达不该播`).toBeNull();
          continue;
        }
        if (n !== null) expect(RESULT, `${prev}→${next} 播了非结果阶段`).toContain(next);
        if (next === "error") expect(n, `${prev}→error 应为 error 档`).toBe("error");
      }
    }
  });
});

/**
 * 落地页 CHANGELOG 解析的回归守卫。
 *
 * 事故（2026-10-21，CI 红）：release-it 产出的版本段是
 * `## [0.2.0](compare) (2026-10-21)` —— 版本号只在方括号里、紧跟日期。解析器却按
 * 「取标题里第一个 \S+ 当版本号」的老假设走，于是把整串 `(2026-10-21)` 当成版本号：
 * 每个版本都误报「缺日期」，changelog 页也显示不出「发布于」。
 *
 * 为什么跑真脚本而不是抄一份正则：解析规则的真源在 scripts/build-landing.cjs，
 * 测试里抄第二份就等于养一个会悄悄过期的影子规则。脚本是纯 Node、离线档，
 * 不碰网络（本机 --online 才需要代理，CI 直连）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = `${ROOT}scripts/build-landing.cjs`;

let run: ReturnType<typeof spawnSync>;

beforeAll(() => {
  // 产物（changelog.json / version.json / 镜像资产）都在 .gitignore 里，跑一次无副作用
  run = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
});

describe("build-landing.cjs：CHANGELOG 解析", () => {
  it("脚本跑通（离线档）", () => {
    // spawnSync 即使给了 encoding，stderr 的类型仍是 string | Buffer，须显式转 string
    expect(run.status, String(run.stderr)).toBe(0);
  });

  it("没有解析告警（缺日期 / 读不出版本号 / 列表项跑出小节）", () => {
    expect(run.stdout).not.toMatch(/缺日期|读不出版本号|列表项落在小节之外|小节内的非列表行/);
  });

  it("每个版本都解析出版本号与发布日期", () => {
    const parsed = JSON.parse(readFileSync(`${ROOT}landing/changelog.json`, "utf8")) as {
      releases: { version: string; date: string | null }[];
    };
    expect(parsed.releases.length).toBeGreaterThan(0);
    for (const release of parsed.releases) {
      expect(release.version, `版本号解析异常：${JSON.stringify(release)}`).toMatch(/^\d+\.\d+\.\d+/);
      expect(release.date, `v${release.version} 没解析出发布日期`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

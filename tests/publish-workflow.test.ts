/**
 * 发布工作流守卫（2026-10-23：beta 出包全绿、发布步 gh 报
 * "To use GitHub CLI ... set the GH_TOKEN environment variable"）。
 *
 * 起因：发布步骤收进 _publish.yml 时，旧 release.yml step 上的 `GH_TOKEN: ${{ github.token }}`
 * 没跟过来。job 上的 `permissions: contents: write` 只决定 token 的权限，不等于把它交给 gh。
 * 这类掉配置本地没有任何门会红，只有真打 tag 才暴露，且暴露时安装包已经白出了一遍。
 *
 * 同一处还钉住上传集合：`release/*.yml` 会把 electron-builder 的 builder-debug.yml
 * 一起发到 Release 上，更新清单只能按 latest.yml / beta.yml 两个名字收。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** YAML 注释里的「gh release」「release/*.yml」是说明文字，不参与断言 */
function stripYamlComments(s: string): string {
  return s.replace(/^\s*#.*$/gm, "");
}

const GH_CALL = /\bgh\s+(?:release|api|pr|issue|workflow)\b/;
const GH_TOKEN = /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/;

describe("gh 凭据", () => {
  it("调 gh 的工作流都显式注入 GH_TOKEN", () => {
    const offenders = readdirSync(DIR)
      .filter((f) => f.endsWith(".yml"))
      .filter((f) => {
        const code = stripYamlComments(readFileSync(`${DIR}${f}`, "utf8"));
        return GH_CALL.test(code) && !GH_TOKEN.test(code);
      });
    expect(offenders, `这些工作流调用 gh 但没把 github.token 交给它：${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("守卫不空转：_publish.yml 仍在调 gh", () => {
    // 发布步骤若被改名/挪走，上面那条会「零文件命中」假绿——这里钉住它确实被覆盖
    expect(stripYamlComments(src(".github/workflows/_publish.yml"))).toMatch(GH_CALL);
  });
});

describe("Release 附件集合", () => {
  it("更新清单按名字收，不用 release/*.yml 整类（builder-debug.yml 也会命中）", () => {
    const publish = stripYamlComments(src(".github/workflows/_publish.yml"));
    const build = stripYamlComments(src(".github/workflows/_build-win.yml"));
    for (const [rel, code] of [
      ["_publish.yml", publish],
      ["_build-win.yml", build],
    ] as const) {
      expect(code, `${rel} 用了 release/*.yml`).not.toMatch(/release\/\*\.yml/);
      expect(code, `${rel} 没有按名字收 latest.yml / beta.yml`).toMatch(/release\/latest\.yml/);
      expect(code, `${rel} 没有按名字收 beta.yml`).toMatch(/release\/beta\.yml/);
    }
  });
});

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

/**
 * beta 版本号只存在于 tag（2026-10-23 定）。
 *
 * 事故形状：beta 号写进 `dev` 的 `package.json`，于是每次出 beta 都要为版本号单独提交一笔，
 * 且 `dev → main` 合并前必须手工回落（旧 GIT-WORKFLOW §3.4）——版本号在两条长期分支上
 * 各写一份、还要人工对齐，这类摩擦反复出现过（「落后 3 个提交」「beta 号把稳定号推偏」）。
 * 现在改成：分支停在已发布稳定号，出包时从 tag 注入。下面三条钉住这个形状不被改回去。
 */
describe("beta 版本号只存在于 tag", () => {
  it("出包时从 tag 注入版本，而不是读分支上写死的 beta 号", () => {
    const build = stripYamlComments(src(".github/workflows/_build-win.yml"));
    expect(build).toMatch(/v\*-beta\*/); // 只认 beta tag 的形状
    expect(build).toContain("npm version");
    expect(build).toContain("--no-git-tag-version"); // 注入不能顺手改 git 历史
    expect(build).toContain("--workspaces=false"); // 根件是 monorepo 宿主，别连带改 landing
  });

  it("发布步不再要求 tag 与 package.json 全等，只核对通道 + 基线不倒挂", () => {
    const publish = stripYamlComments(src(".github/workflows/_publish.yml"));
    expect(publish).not.toContain('pkg="v$version"'); // 全等断言是旧摩擦的源头
    expect(publish).toContain("tag_base"); // 取 tag 的基线号
    expect(publish).toMatch(/sort\s+-V/); // 语义化比较，别用字符串比大小
  });

  it("仓库自己的 package.json 不带 beta 号（这条防的是「下次又手改回去」）", () => {
    const pkg = JSON.parse(src("package.json")) as { version: string };
    expect(pkg.version, `package.json 的 version 带了预发布标识：${pkg.version}`).not.toMatch(/-/);
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

/**
 * commitlint 规则：`type(scope): 摘要`，与本仓既有提交风格一致。
 *
 * 为什么值得卡：release-it 的版本号完全由 commit 前缀推导（feat→minor、fix→patch、
 * `!`/BREAKING CHANGE→major），一个写歪的 `fix` 就会决定发版档位；CHANGELOG 也直接取
 * 摘要行。前缀不再是审美问题，是发版输入。
 *
 * 元组形式 `[等级, always|never, 值]`：commitlint v21 的 config schema 三个位置都定型了
 * （旧文档里的 `[2, 100]` 简写现在直接报 "must be string"），照 @commitlint/config-conventional
 * 自带 preset 的写法来。
 *
 * 放宽项与理由：
 * - body/footer 行长：中文正文按 100 字符折行既不自然也无意义（等级 0 = 关闭）。
 * - subject-case：中文无大小写、英文术语大小写混排（`HISTORY_MAX`、`CI runner`），不做形态限制。
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "subject-case": [0],
    "subject-empty": [2, "never"],
    // 本仓习惯把根因写进摘要（历史最长 106 字符），100 会挡掉真实风格；留到 120 只拦「把正文塞进标题」
    "header-max-length": [2, "always", 120],
    // scope 必填：历史提交全带 scope，检索与 CHANGELOG 分组都靠它
    "scope-empty": [2, "never"],
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"]
    ]
  }
};

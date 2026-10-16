#!/usr/bin/env node
// @ts-check
// preinstall 守卫：本仓只允许用 pnpm 安装依赖。
//
// 为什么要拦：仓库里同时存在 package-lock.json 与 pnpm-lock.yaml 时，两者对同一份
// package.json 会给出**不同的依赖树**（hoisted 提升 vs 符号链接），后装的那个悄悄
// 改写 node_modules，于是「CI 绿了本机坏」与「本机绿了 CI 坏」都无从排查。
// 业主已定本仓用 pnpm（见 docs/ARCHITECTURE.md §7），所以这不是偏好问题，是构建可复现性的前置条件。
//
// 实现取最小：读 npm_config_user_agent（npm/yarn/pnpm/bun 都会设置）判定调用方，
// 不下载任何东西、不访问网络——供应链上「装一个 only-allow 包来防止乱装包」本身
// 就多引入一个依赖，收益不抵成本。
//
// 注意：只拦 install。`npm run <script>` 走的是 Node 自带的 run-script，与依赖树无关，
// package.json 里 dev/build 仍沿用 `npm:` 前缀（concurrently 的内置约定），不受影响。

const agent = process.env.npm_config_user_agent ?? "";

// UA 首段固定是 `<客户端>/<版本>`，例：pnpm/11.22.0 npm/? node/v24.14.0 win32 x64
if (/^pnpm\//.test(agent)) process.exit(0);

const [client, version] = (agent.split(" ")[0] ?? "").split("/");

process.stderr.write(
  [
    "",
    "✖ 本仓必须用 pnpm 安装依赖。",
    "",
    `  检测到的包管理器：${client || "unknown"}${version ? ` (${version})` : ""}`,
    `  用户代理字符串：${agent || "(空，说明不是包管理器拉起的)"}`,
    "",
    "  为什么拦：package-lock.json 与 pnpm-lock.yaml 会生成两棵不同的依赖树，",
    "  混用导致 CI 与本机行为分叉，且 minimumReleaseAge 等 pnpm 供应链策略在 npm 下完全不生效。",
    "",
    "  请改用：pnpm install",
    "  若本机没有 pnpm：corepack enable pnpm（或 npm i -g pnpm）",
    "",
  ].join("\n"),
);
process.exit(1);

# 分支与合并规范

> 两句话：**main 是发版线，dev 是集成分支。** 日常改动全部先落 dev；只有「已发布版本坏了且等不了下一个正常版本」才允许直接改 main。两条路径收尾时都必须让 dev 包含 main。
>
> 本文只定「代码从哪进、从哪出、怎么同步」。跑哪几档验证见 [TESTING.md](TESTING.md)，审什么、合并条件见 [CODE-REVIEW.md](CODE-REVIEW.md) §3–4.3，发版命令与 CI 细节见 [AGENTS.md](../AGENTS.md)「提交与发版」。

## 0. 分支职责

| 分支 | 角色 | 允许的提交 | 不允许 |
|---|---|---|---|
| `main` | 可发布线，任何时刻都能出包 | 紧急修复（§2）、release-it 的 release commit、`dev` 的合并提交 | 日常功能与杂项、force push、手改稳定版本号 |
| `dev` | 集成分支 | 功能、重构、杂项、beta 版本号与 beta tag | 直接发稳定版、提前写 CHANGELOG |

- 单人期不强制 feature 分支；需要并行试验时开临时分支，但只能合回 dev，不直接合 main。
- 稳定 tag 只由 `pnpm release` 在 main 上打；beta tag 只在 dev 上打（§4）。
- tag 一经推送不移动、不删除。唯一例外：beta 预发布因 CI/流水线问题没跑成，需重指同一个 beta tag 重跑，且必须业主确认后执行。
- 平台、品牌等生成物与版本文件（`package.json`、`CHANGELOG.md`、`landing/version.json`）的写入权跟着分支走，见 §5。

## 1. 先选路径

| 情况 | 判据 | 走 |
|---|---|---|
| 已发布版本不可用：崩溃、安全、数据损坏、更新链路断 | 等不到下一个正常版本，或必须单独发 patch | §2 紧急修复 |
| 其余一切：新功能、重构、文档、依赖升级、CI、样式、杂项 | 能随下一个正常版本出去 | §3 正常开发 |
| beta 预发布 | 只影响预发布通道 | §4，不占上面两条 |

判断口诀：**用户正在用的版本坏了 → main；还没发出去的东西 → dev。**

## 2. 情况 1：紧急修复（直接改 main）

适用：影响已发布版本的可用性或安全，且必须尽快单独发一版。

```bash
git switch main
git pull --ff-only origin main

# 改代码；按 TESTING.md 跑最低够用档
# 动打包链路另加 L4 + pnpm verify:binaries:release
git add <具体文件>
git commit -m "fix(scope): 一句话说明修了什么"
```

发版（业主确认后）：

```bash
pnpm release
```

- `pnpm release` 只允许在 main 上跑，自动完成 typecheck/lint/test、bump、写 CHANGELOG、打 `vX.Y.Z` 附注标签、推送 main 与 tag。
- 推 main 与打 tag 都是对外动作，**逐次确认**；`pnpm release` 一次做完这两件，确认一次即可。
- 不需要给用户发版的修复（如仅注释/文档）不属于紧急路径，回 §3 走 dev。

同步回 dev（必须，同一轮内完成）：

```bash
git switch dev
git pull --ff-only origin dev     # 分叉了就先 merge origin/dev，不要 rebase
git merge main
# 冲突按 §5 解；解完跑 L0 + 受影响 L1，收尾 L3
git push origin dev
```

- **用 merge，不用 cherry-pick**：hotfix 在 dev 里必须与 main 是同一个提交，否则下一次 dev → main 会再冲突一次，还可能把修复覆盖掉。
- 验收：`git merge-base --is-ancestor main dev && echo ok` 必须输出 `ok`。

为什么必须同步：dev 不接 main 的话，下一次 `dev → main` 会拿旧代码覆盖修复，版本号与 CHANGELOG 也会分叉。

## 3. 情况 2：正常开发（dev → main 发版）

### 3.1 在 dev 上开发

```bash
git switch dev
git pull --ff-only origin dev

# 小步提交：type(scope): 摘要
# 前缀决定发版号与 CHANGELOG：feat→minor、fix→patch、! / BREAKING CHANGE→major，其余不进 CHANGELOG
```

需要审阅记录或改动跨天时，可以开 feature 分支合回 dev；单人日常直接提交 dev。

### 3.2 收尾验证

按 [TESTING.md](TESTING.md) 选档，合并前至少跑完 L0 + L3；动 `types/**` / `ipc.ts` 加 L2；动依赖或打包链路加 L4 + `pnpm verify:binaries:release`。**验证输出要留下来**，CI 绿不能替代自验。

### 3.3 等确认

业主明确说「可以发」之前：不合 main、不升稳定版本号、不打稳定 tag。

### 3.4 分支版本号：只写「已发布的稳定号」

**beta 号不进 `package.json`**（2026-10-23 起）：`dev` 的 version 永远等于**已发布**的稳定号（合并后自动跟随 main），beta 号只存在于 tag `vX.Y.Z-beta.N`，由 `_build-win.yml` 出包时注入（`npm version "$tag" --no-git-tag-version`）。

这条改动的意义就是**取消原来那一步「合并前手工回落 beta 号」**：

- 旧做法：beta 号写进 dev 的文件 → 合并前必须改成稳定号并单独提交一笔；release-it 从 `0.3.0-beta.1` 按 semver 递增还会跳号（minor 变 `0.4.0`）。
- 现做法：文件里没有预发布标识，`dev → main` 直接合；版本号由 tag（beta）与 release commit（stable）定，二者不打架。

发版时代查一次：`node -p "require('./package.json').version"` 应当等于**上一个**稳定版号（例如 `0.3.1`）。若 dev 上冒出了 `-beta`，说明有人又把它写回文件了——`tests/publish-workflow.test.ts` 会先红。

### 3.5 合并并发版

```bash
git push origin dev

git switch main
git pull --ff-only origin main

# --no-ff 是硬要求：main 上要能一眼看出这一版收了哪些集成分支内容，也方便整体 revert
git merge --no-ff dev -m "merge: dev → main（发版）"

pnpm release
```

- `pnpm release` 会按 commit 前缀推导版本号并给出交互确认；只有 fix 时选 patch，含 feat 时选 minor，`!` 时选 major。
- 发版完成后 `release.yml` 由 tag 触发（verify → build → publish），在 Release 上核对附件：安装包、7z、blockmap、`latest.yml` 齐全。

### 3.6 发版后同步 dev（必须，同一轮）

```bash
git switch dev
git pull --ff-only origin dev
git merge main        # 接回 release commit：版本号、CHANGELOG、landing/version.json
git push origin dev
```

验收同样是 `git merge-base --is-ancestor main dev` 为真。

## 4. beta 预发布（不参与上面的合并）

- **不改 `package.json`**：直接打附注 tag 推送即可——`git tag -a v0.4.0-beta.1 -m v0.4.0-beta.1 && git push origin v0.4.0-beta.1`。`_build-win.yml` 出包前从 tag 注入版本，`beta.yml` 只核对「通道匹配 + tag 基线不低于分支上的稳定号」，出包后发 GitHub prerelease。
- 分支上的 version 停在已发布稳定号（例如 `0.3.1`），所以 tag 的基线通常比它高（`0.4.0-beta.1` 对 `0.3.1`），这是正常的，不是写错。
- 不走 `pnpm release`（那会把 beta 号写进 CHANGELOG 和落地页）。
- beta 验证通过也不自动进 main；要转正按 §3 走，转正时 `pnpm release -- X.Y.Z` 显式给号（main 上的稳定号仍是上一个版本，所以精确版本不会被 semver 递增改偏）。
- 稳定版 `releases/latest` 看不到 prerelease，两条通道互不影响。

## 5. 冲突处理

| 冲突文件 | 取哪边 |
|---|---|
| `package.json` 的 `version`、`landing/version.json` | main（已发布的稳定号） |
| `CHANGELOG.md` | main（release-it 生成物，dev 不提前写） |
| 业务代码 | 按语义合并：修复意图不能丢，dev 的新结构优先；两边都要就都留 |
| `pnpm-lock.yaml` | 不手改：先定 `package.json`，再 `pnpm install` 重生成 |

- 禁止 `git merge -X ours/theirs` 整包吞掉，禁止 force push 覆盖冲突。
- 解完冲突本身也算一次改动：L0 + 受影响 L1，动契约加 L2，拿不准跑 L3，不能裸提交。
- 同一处代码 main 修过、dev 又重构过：以 dev 结构承接 main 的修复，提交信息写清「main 的哪个修复迁到了哪里」，并补一条能红的测试。
- 确认某条改动确实不适用于 dev 的新结构时，可以 cherry-pick 其余部分，但必须在提交信息里说明取舍；默认仍是整支 merge。

## 6. 红线

1. main 不接日常改动；dev 不发稳定版。
2. 不 force push `main` / `dev`；不移动稳定 tag。
3. 推 `main`、打 tag、`dev → main` 合并前必须有业主确认 + 自验输出；CI 绿只是底线。
4. 稳定版本号的递增只在 main 由 `pnpm release` 完成；**beta 号不得写进 `package.json`**（只活在 `vX.Y.Z-beta.N` tag 里，出包时注入），dev 的 version 永远等于已发布的稳定号。
5. 每次 main 变动（紧急修复或发版）后，**同一轮内**让 dev 包含 main；`git merge-base --is-ancestor main dev` 必须为真。
6. 合并一律用 merge，不 cherry-pick（例外见 §5 最后一条）。

## 7. 一页核对

**紧急修复**
- [ ] 确认影响的是已发布版本，且等不到下一个正常版本
- [ ] main 上修复 + 最低够用档验证
- [ ] 业主确认后 `pnpm release`
- [ ] `git switch dev && git merge main && git push origin dev`
- [ ] `git merge-base --is-ancestor main dev` 为真

**正常开发**
- [ ] 改动全部落在 dev，提交前缀正确
- [ ] 收尾跑完 L0 + L3（按 TESTING 加档）
- [ ] 业主确认可以发
- [ ] dev 的 `package.json` 就是已发布稳定号（没有 `-beta`；打了 beta 也不必改）
- [ ] `git merge --no-ff dev` 到 main，`pnpm release`
- [ ] Release 附件齐全，`release.yml` 绿
- [ ] main 合回 dev 并推送

# AGENTS.md

MediaGet Electron 桌面客户端（Windows 首发）。解析内核在 mediaGet 仓，本仓只消费它的版本化工件 `@mediaget/parse-core`。

深层依据不在此文件，按需要读：
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— §1 三条硬约束、§6 安全红线、§7 构建与发布、§8 分仓与同步（改架构前先读 §8）、§9 耦合治理（平台清单的归属在这里定过）
- [docs/UIUX-DESIGN.md](docs/UIUX-DESIGN.md) —— Token 分层与视觉语义真源；§7 覆盖 §1–2；§9 定统计页与图表底座（ECharts 唯一登记点、取色探针、作图三规）
- [README.md](README.md) —— 当前进度台账与命令表

## 改 IPC 通道 = 动六件套

载荷形状只在 `types/ipc-contract.ts` 用 zod 声明一次；`types/ipc.ts` 以 `import type` + `z.infer` 派生并保持**零运行时**（值 import 会把整层 schema 打进 renderer 包，`tests/boundaries.test.ts` 铁律 3 守着）。新增/改一个通道要同时落六处，少一处就是静默少字段而不是编译错误：

| # | 位置 | 内容 |
|---|------|------|
| 1 | `types/ipc.ts` | `IPC` 通道常量 + `MgBridge` 方法签名 |
| 2 | `types/ipc-contract.ts` | zod `CONTRACT`（入参/出参）；事件通道只进 `EVENTS` |
| 3 | `electron/main/ipc.ts` | handler 注册（按 `CONTRACT` 表统一校验入参） |
| 4 | `electron/preload/index.ts` | contextBridge 白名单 |
| 5 | `renderer/src/lib/bridge.ts` | 类型化封装 |
| 6 | `renderer/src/dev/mock-bridge.ts` | dev mock，签名与 `MgBridge` 同步 |

契约变更同时升 `CONTRACT_VERSION`——旧存档读进来按新版本解释，不升号会让用户把过期形状当合法数据。`tests/contract.test.ts` 把「漏登记」「多注册（=校验旁路）」「出参漂移」都变成当天红叉；改完跑它，别只跑 typecheck。

## 三条铁律

1. **单一代码源**：解析逻辑只在 `packages/parse-core/` 维护一份，本仓 import 工件、不复制。同步成本就是一个版本号——白名单外的符号（如 `createTtlCache`）在 `core-adapter/` 本地复刻，需要更多能力时让上游加进 exports 再发版，伸手拿内部实现会把升级变成定期冲突。
2. **依赖边界**：renderer 只能经 IPC 拿数据；全仓不 import route 层与 Next.js 运行时模块。
3. **零敏感资产入包**：运维 Cookie（`BILIBILI_COOKIE`、`IG_COOKIE`）等站点资产绝不打包、绝不硬编码；客户端只接受用户自配。

## 平台清单只有一个真源：`shared/platforms.ts`

「有哪些平台、叫什么、哪枚图标、哪个引擎能解、供不供」只写在这张零依赖表里，主进程与渲染进程 import 同一份。加平台 = 改这一处 + 放一枚 `renderer/public/logos/*.svg`，五页自动跟上；**再抄一份平台名或图标映射就是缺陷**——`tests/platform-registry.test.ts` 把「图标文件不存在」「与内核 `PLATFORM_INFO` 逐字段漂移」「声明 `parseCore: ready` 却没有本地 parser」「renderer 里手抄平台名」都变成红叉。

- **引擎与供给解耦**（2026-10-16 业主定调）：parse-core 只是引擎之一（还有 yt-dlp、后续更多）。`engines` 记覆盖度 `ready`/`declared`/`unknown`，`enabledByDefault` 由 ready 推出；内核那份降级成引擎侧事实，不再当产品边界。
- **契约键 vs 别名**：上游路由目录名（`xhs`、`ppxia`）只许活在 `legacyKeys`；写进 history/stats 前一律 `resolveKey()` 归一，**盘上存量则在读侧归一**（`store.loadHistory` 逐条、`stats` 的 `byPlatform` 并键相加），未登记键原样回吐、不进界面——注册表不许改写盘上历史。
- **开关**：持久化在 `settings.platformSwitches`（只存用户改过的，缺省跟 `enabledByDefault`），渲染层经 `renderer/src/store/platforms.ts` 乐观置态并整表提交；主进程读持久值，不读渲染层内存。
- **开关必须在主进程切断路由**：`engine.ts` 的供给闸门排在结果缓存与引擎轮询之前，关掉的平台直接 400。只在 UI 上隐藏它 = 假开关（解析照跑，历史还多几条）。
- **加一个引擎** = 往 `electron/main/engines.ts` 的列表加一项：`covers()` 报能力位、`run()` 用 `ok:false` 说「可换下一个引擎」并带上没得换时的最终答复。选路与开关判定不动；`via` 枚举 `local|online|mock` 答的是「结果从本机还是线上来」，不是「哪个引擎解的」，别把引擎 id 塞进去。
- `AppMeta.platforms` 已随契约 v6 删除：平台名不再经 IPC 广播。

## 隐私红线（写日志/存储前先核这一节）

- 文件日志与 config 同处 `userData`：**不写 Cookie 值、不写媒体直链**；下载失败只投「文件名 + 原因」。
- 渲染层转发上来的异常文本截到 2000 字符、单会话上限 50 条。
- Cookie 只活在主进程并全程脱敏；剪贴板文本不持久化；历史与队列不保留直链 URL。
- 不解析黑名单平台（微信视频号、付费/DRM），沿用内核判定；不做反检测加码。

## 验收门

`pnpm typecheck` + `pnpm lint` + `pnpm test`（全离线，禁真网络）+ 随包件校验 `pnpm run verify:binaries:release`。四门都是本机可跑的；提交口由 husky 只卡 `eslint --fix` 与 commitlint，重量级判定留在 CI 与 `pnpm release`。

## 本机的坑（配置里读不出来）

- **`pnpm run build` 末段在本机被拦**：electron-builder 解包卸载器时 spawn 失败（exit null），是环境限制不是代码问题。本机验收用 `pnpm run build:app`，出包优先 `portable`。
- **「UI 没变化」先看进程**：旧 Electron 实例持单实例锁会让新实例静默 `exit 0`，旧 vite 会占住 5433。重启 dev 前先按命令行把残留清干净。
- renderer 走 HMR，**主进程/preload 改动必须重启 Electron**才生效。
- Node 的全局 fetch 不读 Windows 系统代理：需要联网调试时导出 `HTTP_PROXY`/`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（git 则是另一个坑：`-c http.schannelCheckRevoke=false`）。
- 本机无 `gh` CLI；操作 GitHub 走 `git credential fill` 取 token + Node fetch。

## 提交与发版

提交格式 `type(scope): 摘要`，scope 必填、摘要 ≤120。前缀不是审美而是 `pnpm release` 的**发版输入**：`feat`→minor、`fix`→patch、`!` 或 `BREAKING CHANGE`→major，`docs`/`test`/`chore` 等不进 CHANGELOG。版本号只写进 `package.json`（包 `private`，不上注册表）。

二进制随包件的真源是 `resources/binaries.json`（版本 + 固定 tag 直链 + SHA-256）：`releases/latest/download` 会随上游发布漂移，不带 `--fail` 的 `curl -o` 会把 404 的 HTML 错误页原样写成 `.exe`。观察上游用 `node scripts/fetch-binaries.cjs --check-updates`（它把新资产下载下来算好 SHA-256，产出可直接粘贴的片段），**写回 `binaries.json` 由人完成**。`pnpm dev` 前置同一脚本的 `--soft`：下载失败只播报并以 0 退出（缺的那路运行时就降级，不挡 UI 开工），`binaries.json` 残缺仍非零退出；CI 走严格分支，别把这两条语义合并。

CI 打包固定 `--publish never`：发布动作统一由 tag 触发的 `release.yml` 末尾一次 `gh release create` 完成，否则 electron-builder 会另建一个 Release 撞成两个。`latest.yml` 必须与安装包同在一个 Release，缺它应用内「检测更新」永远查不到版本。

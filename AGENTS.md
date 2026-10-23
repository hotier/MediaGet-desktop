# AGENTS.md

MediaGet Electron 桌面客户端（Windows 首发）。解析内核在 mediaGet 仓，本仓只消费它的版本化工件 `@mediaget/parse-core`。

深层依据不在此文件，按需要读：
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— §1 三条硬约束、§6 安全红线、§7 构建与发布、§8 分仓与同步（改架构前先读 §8）、§9 耦合治理（平台清单的归属在这里定过）
- [docs/UIUX-DESIGN.md](docs/UIUX-DESIGN.md) —— Token 分层与视觉语义真源；§7 覆盖 §1–2；§9 定统计页与图表底座（ECharts 唯一登记点、取色探针、作图三规）
- [docs/CODE-REVIEW.md](docs/CODE-REVIEW.md) —— 审查标准与流程：P0–P3 分级判据、D0–D3 审查深度、按改动面分组的检查清单、一票否决项、事故反哺守卫的登记表（提 PR 前看 §3 对应那组，别通读）
- [README.md](README.md) —— 项目说明、命令表、里程碑状态；界面决策沿革不在这里（在 [docs/UIUX-HANDOFF.md](docs/UIUX-HANDOFF.md) §6 勘误记录）

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

## 依赖分类决定包体积

`dependencies` 只放**主进程运行时**（parse-core、amagi、better-sqlite3、ytdlp-nodejs、undici、zod、font-list、electron-updater 等）；渲染层依赖与 build-only 工具进 `devDependencies`——Vite 会把前者打进 `dist-renderer`，而 electron-builder 会把 `dependencies` 整棵复制进 `app.asar`。2026-10-23 重分类后 app.asar 176 MB → 28.6 MB、win-unpacked 666 MB → 446 MB。主进程 `require` 的包挪进 devDependencies，打包版启动即 `MODULE_NOT_FOUND`；渲染层包留在 dependencies，只会在包里多一份副本。改完分类必须启动一次打包版验证（详见 [ARCHITECTURE.md](docs/ARCHITECTURE.md) §7）。

## 平台清单只有一个真源：`shared/platforms.ts`

「有哪些平台、叫什么、哪枚图标、哪个引擎能解、供不供」只写在这张零依赖表里，主进程、渲染进程与落地页（`landing/`）import 同一份。加平台 = 改这一处 + 放一枚 `renderer/public/logos/*.svg`，五页自动跟上，落地页平台带也自动跟上（它按 `enabledByDefault` 生成，图标由 `scripts/build-landing.cjs` 从 `renderer/public/logos` 镜像到 `landing/public/logos`，那份是生成物、不入库）；**再抄一份平台名或图标映射就是缺陷**——`tests/platform-registry.test.ts` 把「图标文件不存在」「与内核 `PLATFORM_INFO` 逐字段漂移」「声明 `parseCore: ready` 却没有本地 parser」「renderer 里手抄平台名」都变成红叉。README 的「平台支持」表是唯一一处允许手抄的对外清单（外宣需要一张静态表），但也钉着 `tests/readme-platforms.test.ts`：平台集合必须等于 `PLATFORMS` 的显示名、Cookie 档位必须等于 `COOKIE_ROWS`、「N 个平台」必须等于注册表长度——加平台漏改 README 当天就红。

- **引擎与供给解耦**（2026-10-16 业主定调）：parse-core 只是引擎之一（还有 yt-dlp、后续更多）。`engines` 记覆盖度 `ready`/`declared`/`unknown`，`enabledByDefault` 由 ready 推出；内核那份降级成引擎侧事实，不再当产品边界。
- **契约键 vs 别名**：上游路由目录名（`xhs`）只许活在 `legacyKeys`；写进 history/stats 前一律 `resolveKey()` 归一（仓储写入口 `electron/main/repositories.ts` 兜底），**旧 JSON 存量则在一次性导入时归一**（`storage-migration.ts` 逐条，源文件原样保留），未登记键原样回吐、不进界面——注册表不许改写用户的源文件。
- **开关**：持久化在 `settings.platformSwitches`（只存用户改过的，缺省跟 `enabledByDefault`），渲染层经 `renderer/src/store/platforms.ts` 乐观置态并整表提交；主进程读持久值，不读渲染层内存。
- **引擎开关**（2026-10-21）：`settings.engineSwitches`（缺键=开，只存用户关掉的几项），渲染层 `renderer/src/store/engines.ts`；主进程 `engine.ts` 的 `availableEngines()` 直接过滤，选路与体检同时看不见它（只在 UI 隐藏 = 假开关）。全关时解析如实 400，不落演示数据。引擎名与一行说明只在 `shared/platforms.ts` 的 `ENGINE_INFO`，引擎 runner 的 `label` 也从它取。
- **主引擎与回退**（2026-10-21，通道改下拉）：`settings.platformEngines`（契约键 → 引擎 id，缺键 = `DEFAULT_PRIMARY_ENGINE` = mediaget）+ `settings.engineFallback`（缺省 true）。`engine.ts` 先按注册表 `enginePriority` 排全局顺序，再把用户选的主引擎提到首位；回退关掉时只试首位。体检用同一份顺序但**不按回退开关收窄**（否则用户没法把主引擎改回来）。`EngineHealth.engineIds` 与 `engines` 一一对应，是下拉的选项值——别拿 label 反查 id。回退必须带原因：主进程在 `ParseRunOutcome.attempts`（v32）里按顺序记下这一轮真调用过的引擎与各自业务码/`failType`/失败原文，结果卡据此显示「回退」徽标 + 轨迹、首页据此弹 toast；**缓存命中与 mock 兜底没进选路，该键缺省**——别用耗时之类的代理信号去猜回退。
- **开关必须在主进程切断路由**：`engine.ts` 的供给闸门排在结果缓存与引擎轮询之前，关掉的平台直接 400。只在 UI 上隐藏它 = 假开关（解析照跑，历史还多几条）。
- **开关界面 = 设置「引擎」体检表的「提供」列**（2026-10-16 落地）：翻转即 `setEnabled` 落盘并复检 `probe:engines`，「通道」徽标当场跟着变；它不进脏计数、也不受「放弃」影响（与本地缓存清理同一条语义，见 UIUX-DESIGN §2.4 例外条），别再把它接回草稿模型。
- **加一个引擎** = 往 `electron/main/engines.ts` 的列表加一项：`covers()` 报能力位、`run()` 用 `ok:false` 说「可换下一个引擎」并带上没得换时的最终答复。选路与开关判定不动；`via` 枚举 `local|mock` 答的是「结果从本机还是演示数据来」，不是「哪个引擎解的」，别把引擎 id 塞进去。
- `AppMeta.platforms` 已随契约 v6 删除：平台名不再经 IPC 广播。

## 品牌资产也只有一个真源：`brand/`

应用图标（`build/icon.png`、`build/icon.ico`）、窗口/托盘图标、应用内字标、favicon、落地页分享卡与 **NSIS 安装器两图**（`build/installerSidebar.bmp` 164×314、`build/installerHeader.bmp` 150×57，文件名对上即被 electron-builder 自动取用），全部由 `scripts/make-icons.cjs`（`pnpm brand:assets`）从 `brand/` 里的品牌母版生成。安装器那两张是**位图**（MUI 只认 BMP，尺寸写死，改一个像素就糊），`tests/installer.test.ts` 钉着它们的存在与尺寸。母版是**平底单色成品图**（不带 alpha），脚本负责把它们拆成覆盖率蒙版再换墨色/尺寸，所以**不要去外部编辑器里改产出物**——手改的那一份会在下次重跑时被覆盖。界面里字标只能经 `renderer/src/components/BrandLogo.tsx`（与 `PlatformIcon` 同规：同一实体同一图标），落地页那份由 `scripts/build-landing.cjs` 从 `renderer/public/brand` 镜像过去（生成物，已进 `.gitignore`）。

## 隐私红线（写日志/存储前先核这一节）

- 文件日志与 config 同处 `userData`，**不上传也不外发**：失败原文与媒体直链照原样落（2026-10-21 业主定调——本地应用没有「日志不写直链」这条红线，而「哪条链 403」只能从现场看出来，`engine.ts` 的 `clipForLog` 只压单行、截 300 字）；**不主动记 Cookie 值**——错误原文里本就没有它（引擎递给 yt-dlp 的是 cookiefile 路径而不是头串），专门打印只会把日志变成凭据副本。下载失败投「文件名 + 原因 + 当前直链」。
- 渲染层转发上来的异常文本截到 2000 字符、单会话上限 50 条。
- Cookie 只活在主进程并全程脱敏；剪贴板文本不持久化；历史与队列不保留直链 URL。
- dash 双轨一律合流（预览与下载共用 `electron/main/media-merge.ts`）：预览产物只落系统 `temp` 的 `mediaget-media/<直链哈希>.mp4`，文件名不带直链、不写日志、TTL 24h 启动清理；下载侧的 `.part.audio` / `.part.merged` 随任务完成或取消清理，`done` 行的 `audioUrl` 与 `url` 一起剥空（见 ARCHITECTURE §6 第 13 条）。
- 不解析黑名单平台（微信视频号、付费/DRM），沿用内核判定；不做反检测加码。

## 验收按档，不按门（详表在 [docs/TESTING.md](docs/TESTING.md)，改档前先读它）

一条主干：**按「改了什么」选最低够用档，同一批改动只在收尾时完整验证一次**。下面四门（`pnpm typecheck` + `pnpm lint` + `pnpm test`（全离线，禁真网络）+ 随包件 `pnpm run verify:binaries:release`）是**收尾与 CI** 的门，不是每个 edit 的随身手序。

- 文档 / 注释 / 勘误 → **不跑任何档**。界面文案、纯 className 与样式 → L0（typecheck + lint），改 `styles.css` 才加跑 `style-discipline` 那一个守卫。
- 业务逻辑 / 纯函数 → 对应的 L1 单测，收尾 L3 一次。动 `types/**` 或 `electron/main/ipc.ts` → L2（`contract` / `boundaries` / `ipc` / `kernel-sync`）。
- 新增 runtime 依赖、`resources/**`、打包链路 → 才 L4 与 `verify:binaries*`；主进程生命周期与像素/几何 → L5（实机人工，vitest 只吃 `tests/stubs/electron.ts`，测不到真窗口）。
- **禁止**：没改代码就重跑同一档；每 edit 跑一次全量；用 `pnpm test` 去验只有 L5 才验得到的东西（假绿比不绿更坏）。几何/视觉用 dev server `127.0.0.1:5433`（mock 桥）人工核对，**不写进验收门**。
- 新测试只写两类：**纯函数/逻辑分支**，与**把一次事故钉成一条断言的回归守卫**。不写 UI 快照、不写依赖真网络的用例、不为 DOM 冒烟引 jsdom（test 依赖只保留 vitest）。源码扫描型守卫（`boundaries` 按文件生成用例、`style-discipline`、`toast-sonner`）会让纯样式/文案改动也能红，碰这三面跑**对应那一个**，不是全量。
- 提交口由 husky 只卡 `eslint --fix` 与 commitlint，重量级判定留在 CI 与 `pnpm release`。本地少跑，兜底交给 CI。

## 本机的坑（配置里读不出来）

- **`pnpm run build` 末段在本机被拦**：electron-builder 解包卸载器时 spawn 失败（exit null），是环境限制不是代码问题。本机验收用 `pnpm run build:app`，出包优先 `portable`。
- **「UI 没变化」先看进程**：旧 Electron 实例持单实例锁会让新实例静默 `exit 0`，旧 vite 会占住 5433。重启 dev 前先按命令行把残留清干净。三档各有各的 userData：dev = `MediaGet-dev`、稳定版 = `MediaGet`、beta = `MediaGet (Beta)`，可以同时启动做 A/B；清数据只删对应那一档，别动另外两份。并排时全局快捷键 `Ctrl+Alt+V` 仍然只有一个实例能注册（系统级独占，不是分档失效）。
- **dev/打包版并排时全局快捷键只有一个能注册**（`Ctrl+Alt+V` 同一键位，先启动者拿到）；这是并排运行的系统级限制，不是分档没生效。
- renderer 走 HMR，**主进程/preload 改动必须重启 Electron**才生效。
- Node 的全局 fetch 不读 Windows 系统代理：需要联网调试时导出 `HTTP_PROXY`/`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（git 则是另一个坑：`-c http.schannelCheckRevoke=false`）。
- 本机无 `gh` CLI；操作 GitHub 走 `git credential fill` 取 token + Node fetch。

## 提交与发版

提交格式 `type(scope): 摘要`，scope 必填、摘要 ≤120。前缀不是审美而是 `pnpm release` 的**发版输入**：`feat`→minor、`fix`→patch、`!` 或 `BREAKING CHANGE`→major，`docs`/`test`/`chore` 等不进 CHANGELOG。版本号只写进 `package.json`（包 `private`，不上注册表）。

**分支模型**：日常改动先落 `dev`，业主确认后 `git merge --no-ff dev` 到 `main` 再 `pnpm release`；只有已发布版本的紧急修复直接改 `main`，发版后当轮把 `main` 合回 `dev`。两条路径的步骤、冲突处理与版本号规则见 [docs/GIT-WORKFLOW.md](docs/GIT-WORKFLOW.md)——beta 号进 main 前必须落回稳定号，否则 release-it 会把版本推偏。

**beta 通道**（2026-10-23）：不走 `pnpm release`（那会把 beta 号写进 CHANGELOG 和落地页）。在 dev 分支把 `package.json` 的 `version` 改成 `X.Y.Z-beta.N` 并提交，打 `vX.Y.Z-beta.N` 附注标签推送，`beta.yml` 校验 tag 与版本一致后出包并发布 GitHub prerelease。beta 有独立身份（`MediaGet (Beta)` / `cc.hotier.mediaget.desktop.beta` / `MediaGet Beta.exe` / `beta.yml`），与稳定版并排安装、数据互不相通；配置真源是 `electron-builder.beta.cjs`，运行时通道判据只有版本号的 `-beta.N`（`electron/main/release-channel.ts`）。

二进制随包件的真源是 `resources/binaries.json`（版本 + 固定 tag 直链 + SHA-256）：`releases/latest/download` 会随上游发布漂移，不带 `--fail` 的 `curl -o` 会把 404 的 HTML 错误页原样写成 `.exe`。观察上游用 `node scripts/fetch-binaries.cjs --check-updates`（它把新资产下载下来算好 SHA-256，产出可直接粘贴的片段），**写回 `binaries.json` 由人完成**。`pnpm dev` 前置同一脚本的 `--soft`：下载失败只播报并以 0 退出（缺的那路运行时就降级，不挡 UI 开工），`binaries.json` 残缺仍非零退出；CI 走严格分支，别把这两条语义合并。

CI 打包固定 `--publish never`：发布动作统一由 tag 触发的 `_publish.yml` 末尾一次 `gh release create` 完成，否则 electron-builder 会另建一个 Release 撞成两个。稳定版 `latest.yml`、beta `beta.yml` 必须与安装包同在一个 Release，缺它应用内「检测更新」永远查不到版本。`v*` 会同时匹配 beta tag，所以 `release.yml` 的三个 job 都带 tag 级过滤，beta 只走 `beta.yml`。

**.github 的分层别再拍平**（2026-10-21 收拢）：环境准备只有 `.github/actions/setup`（composite），验收只有 `_verify.yml`，出包 + 产物断言只有 `_build-win.yml`（输入 `channel: stable|beta`），发布只有 `_publish.yml`（输入 `channel` + `tag`）；`ci.yml` / `release.yml` / `beta.yml` 只写「什么时候跑」。以前这两段在 ci 与 release 各有一份拷贝，已经漂移过——资源落地断言与 `latest.yml`/`blockmap` 断言只长在 CI 那份上，于是「CI 绿、发出去的 Release 少附件」是结构上可能的。改 CI 要改那三个 `_` 文件，不要往调用方里加步骤。`release.yml` 支持手动干跑（`workflow_dispatch`，默认 `dry_run=true` 只出包不发布）——真发版前先点一次。

落地页（`landing/`）由**独立的** `landing.yml` 发到 GitHub Pages：push 到 main 且命中落地页相关路径（`landing/**`、`scripts/build-landing.cjs`、`brand/**`、`shared/**`、`renderer/public/{logos,brand}/**`、`package.json` 等）就重建并部署，也可以用 `workflow_dispatch` 手动补发。它走离线档构建，不等发版、也不查 Release——改一句文档措辞推上去就上线；版本号仍然跟得上，因为 `pnpm release` 改的 `package.json` 本身就在那组 paths 里。`release.yml` 只出安装包与 Release，不碰 Pages。产物自检是 `scripts/verify-landing.cjs`（七页 + 404 齐备、资源引用文档相对、每个本地引用都落盘、平台卡数与页内数字自洽、更新日志与 CHANGELOG 同步），只在部署链路里跑（`ci.yml` 不再重复构建，2026-10-21 移除）。产物是 `build.format="directory"`（URL 不带 .html，`/changelog/` 而非 `/changelog.html`；2026-10-22 业主定）：七页各在自己的目录，站内链接的前缀一律经 `landing/src/lib/rel.ts` 按页深度算，页面里不手写 `../`；404.html 是唯一保留扩展名的产物（Pages 按根下这个文件名接管未命中路径）。双击 dist/index.html 只能看首页自身——file:// 没有服务器补 index.html，目录链接会落到本地目录列表，这是原理性边界，预览请走 `landing:preview` 或真 Pages。`landing/dist` 塞进任意子路径都可用。Pages 需要 `Settings → Pages → Source = GitHub Actions`。

# mediaGet-desktop

「即刻解析」桌面客户端（Windows 首发）：基于 [mediaGet](https://github.com/hotier/mediaGet) 的视频解析能力，在本机完成**解析 + 下载**闭环。

- 仓库定位：桌面客户端工程（Electron）。**解析内核不在本仓**——单一代码源留在 `mediaGet` 仓 `packages/parse-core/`，本仓以**版本化 npm 工件** `@mediaget/parse-core` 消费（见下文「内核耦合」）。
- 状态：**P1–P6 主线已落地**（main/preload/renderer + core-adapter + IPC 契约 v3 + 下载管理器 + 线上回落 + 设置页五分类 + 自动更新 + 批量导入），解析面已**桌面化一致**：上游内核整体收敛为 `packages/parse-core` 统一入口（`unifiedParseLocal` + `localParserKeys`），黑名单/平台识别/全部 21 平台解析器/快手兜底/直链验证/source+id 模式**全部本地执行**（见「内核耦合」）。本仓不再自维护平台解析器表，只引用这一个核心。线上 `/api/parse` 降级为**逃生通道**（上游改版风暴、用户主动开启时才用），不再承担主解析；无网络且回落关闭时落 mock，结果来源（local/online/mock）在结果卡如实标注。发布链路（release-it + tag 触发的 `release.yml`）已接通，**尚未打第一个 `v*` 标签**——所以应用内「检测更新」目前查不到版本，这是缺 Release 而不是缺代码。
- 开发前置：只需本仓。`pnpm install --frozen-lockfile` 装齐依赖（含内核工件），**不需要并列检出 `../mediaGet`**——物理链接桥已于 2982811 拆除。包管理器只有 pnpm 一个：`packageManager` 字段是版本真源，用 npm/yarn 装会被根 `preinstall` 守卫直接拦掉。

## 为什么要桌面版

线上服务解析失败的头号原因是**数据中心出口 IP 被平台 WAF 拦截**（抖音 -412、B站 -352、小红书风控等）。桌面客户端使用用户**家庭宽带 IP 直连**，成功率普遍高于线上服务；同时具备浏览器拿不到的能力：

1. **下载即落盘**——解析直链普遍分钟级时效，客户端拿到直链立刻在主进程流式下载（Range 断点续传 + 平台 Referer 防盗链），体验远超 Web 版「复制直链」；
2. **TikTok 完整能力**——yt-dlp + ffmpeg 随包分发（线上 Serverless 环境受限不可用）；
3. **用户自带 Cookie**——抖音/小红书/Instagram 等 Cookie 由用户在本机设置页配置，不经过任何第三方服务器。

## 总体架构

```
┌────────────────────────── Electron ──────────────────────────┐
│                                                              │
│  renderer (Vite + React)          main (Node.js)             │
│  ├─ 解析页：粘贴→识别→结果卡        ├─ 解析引擎宿主            │
│  ├─ 下载队列 / 历史                │   import 解析内核 ────────┼──► @mediaget/parse-core（版本化工件）
│  ├─ 设置页（Cookie / 目录 / 代理）  ├─ 下载管理器               │    platforms / unified-parser
│  └─ 仅经 preload 白名单通信         │   fetch+Range+Referer    │    parse-handler / <platform>Core
│       (contextBridge/IPC)         ├─ yt-dlp/ffmpeg 资源定位   │    http / share-text / result-cache
│                                   ├─ 本地配置存储 (userData)  │
│                                   └─ 失败回落：调线上 API ────┼──► get.hotier.cc.cd（可选兜底）
└──────────────────────────────────────────────────────────────┘
```

三条铁律：

1. **单一代码源**：解析逻辑只在 mediaGet 仓的 `packages/parse-core/` 维护一份，本仓永远只 import 它的 `dist` 工件、不复制——上游平台接口一改，两端同时受益，避免分叉腐化。
2. **依赖边界**：本仓只允许 import `@mediaget/parse-core` 的 **exports 白名单符号**（`unifiedParseLocal` / `localParserKeys` 等，面由 `tests/kernel-sync.test.ts` 对 `dist/index.d.ts` 断言），**禁止 import route 层与任何 Next.js 运行时模块**；白名单之外的符号（如 `createTtlCache`）在本地 `core-adapter/` 复刻，不去工件里挖内部实现。这是 P0 内核抽取的验收标准。
3. **零敏感资产入包**：服务端 Cookie（`BILIBILI_COOKIE`、`IG_COOKIE` 等运维资产）绝不打包、绝不硬编码；客户端只接受用户自配，默认走游客链路。

## 仓库结构（规划）

```
mediaGet-desktop/
├─ docs/
│  ├─ ARCHITECTURE.md      # 本文档的详版（目录职责 / IPC 契约 / 数据流）
│  └─ UIUX-HANDOFF.md      # UI/UX 施工交接单（设计蓝图索引 / 合并策略 / 铁律 / 验收门）
├─ electron/
│  ├─ main/                # 主进程
│  │  ├─ index.ts          # 应用生命周期 / 窗口
│  │  ├─ engine.ts         # 解析引擎宿主：装配本地适配层 + unified-parser
│  │  ├─ ipc.ts            # IPC handler（parse / download / settings / history）
│  │  ├─ downloader.ts     # 下载管理器：流式落盘、Range 续传、Referer、重试
│  │  ├─ resources.ts      # yt-dlp/ffmpeg 定位与首启释放（拷到 userData）
│  │  └─ fallback.ts       # 本地解析失败 → 线上 API 回落（可开关）
│  ├─ preload/
│  │  └─ index.ts          # contextBridge 白名单 API（唯一渲染层入口）
│  └─ builder/             # electron-builder 配置（nsis + portable）
├─ renderer/               # Vite + Tailwind v4 + shadcn/ui + React
│  ├─ src/pages/           # 解析页 / 下载页 / 设置页 / 历史页 / 首页
│  ├─ src/components/      # 业务组件（ResultCard / QueueRail / PlatformIcon / Update）
│  ├─ src/components/ui/   # vendored shadcn 基座 16 件（cva + Radix + cn）
│  ├─ src/lib/bridge.ts    # 对 preload API 的类型化封装
│  └─ src/lib/utils.ts     # cn()：clsx + tailwind-merge
├─ components.json          # shadcn CLI 配置（alias `~/*` → renderer/src/*）
├─ core-adapter/           # 本地适配层（对解析内核的注入件）
│  ├─ cache.ts             # 结果缓存：内存 LRU（替代 Cloudflare Cache API）
│  ├─ analytics.ts         # no-op（替代 Turso 上报）
│  ├─ config.ts            # env → userData 配置文件两级取值（Cookie / 开关）
│  └─ ratelimit.ts         # 本地不限流 / 可配温和节流
├─ types/
│  ├─ ipc-contract.ts      # 载荷形状唯一声明处（zod）：每通道 in/out + CONTRACT/EVENTS 注册表
│  └─ ipc.ts               # 通道常量 + MgBridge + z.infer 派生类型（零运行时，renderer/main 共用）
├─ scripts/                # 工程件（Node 直跑的 .cjs，不打包进应用）
│  ├─ fetch-binaries.cjs   # 随包二进制：固定 tag 下载 + SHA-256 强校验 + manifest 生成 + 上游观察
│  ├─ launch-electron.cjs  # dev:electron 启动器（干净进程环境）
│  └─ only-pnpm.cjs        # 根 preinstall 守卫：非 pnpm 的包管理器一律拒装
└─ resources/              # binaries.json（二进制唯一真源）；bin/ 由脚本下载，不入库
```

## 内核耦合：mediaGet 侧的 P0 前置改造

本仓能「直接 import 解析内核」的前提是 mediaGet 完成抽取（对线上行为零影响）：

| # | 改造 | 说明 |
|---|------|------|
| 1 | 平台解析器纯函数化 | 各 `src/app/api/<platform>/route.js` 里的 `parseFn` 提为 `src/lib/<platform>Core.js`；route 变成 `parseCore + createApiHandler` 薄壳。分批：共用 `parser-kit` 的小平台 → 抖音/快手/B站/微博/小红书 → twitter/instagram/youtube |
| 2 | result-cache 存储可注入 | `caches.*`（CF Cache API）抽成 store 接口，默认实现不变，桌面注入 `createTtlCache` 内存 LRU |
| 3 | env 读取两级化 | Cookie 类 env 改为「`process.env` → 可注入配置对象」，桌面端用后者（用户自配、存本机） |
| 4 | 统一入口确认 | `parse-handler.js` / `unified-parser.js` 无 route/Next 依赖，可直接作桌面统一解析入口 |

消费方式（**已定稿，完整论证与同步流水线见 [docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md)**）：内核发布为 `@mediaget/parse-core` **版本化工件**，装在 npm 注册表上（`pnpm-lock.yaml` 里只有 `integrity`、没有 `tarball:` 解析记录，实测确认）。物理链接 `../mediaGet` 曾是本地联调的临时桥，**已于 2982811 拆除**——本仓不存在任何指向 `../mediaGet` 的路径别名。

当前状态：engine 直接 `import ... from "@mediaget/parse-core"` 取统一入口，**全部平台解析在本地执行**；线上回落只在用户显式开启、且本地异常/核心未覆盖时作为逃生通道，两者皆不可用时落 mock。白名单之外的符号（例如结果缓存要的 `createTtlCache`）在 `core-adapter/` 本地复刻，**不去工件里挖内部实现**——需要更多能力时应让上游把它加进 exports 并发新版本，而不是本仓伸手拿。

**P0 进度（2026-10-16 收口）**：mediaGet 侧步骤 1 **已全量落地**——解析内核依赖闭包（15 个 `src/lib` 模块 + `types/api` + `config/video-platforms` + `utils/filename`）迁入上游仓 `packages/parse-core/`（包名 `@mediaget/parse-core`，`src/index.ts` 为 exports 白名单入口），web 侧原路径改 re-export 薄壳、行为零变化（上游 1082 测试全绿 + `tsc --noEmit` 过）；余下 15 个平台的 route 内联解析逻辑逐字搬入 `packages/parse-core/src/lib/<platform>Core.js`，并新增 `parser-registry.js`（21 键覆盖识别面全平台）与 `unified-core.js`（`createUnifiedParser` / `unifiedParseLocal`）——web 的 `unified-parser.js` 退化为注入「kuaishou 纯函数 + platformRoutes 动态路由」的薄包装（保留中间件缓存/限流语义），桌面只引用核心的 `unifiedParseLocal` + `localParserKeys`，不再自维护平台解析器表。联机走线冒烟：21 个平台链接全部 `via=local`（B 站/YouTube 拿到真实标题与直链，抖音/西瓜/皮皮虾等返回各自平台的服务端错误文案）。步骤 2（发 `@mediaget/parse-core@0.1.2` 到注册表）与步骤 3（本仓切工件依赖、删 kernelAlias 与并列检出）**均已完成**：本仓经 `@mediaget/parse-core` 消费整桥，物理链接于 2982811 拆除；`tests/kernel-sync.test.ts` 改对已安装工件的 `dist/index.d.ts` 断言契约面，因此在 CI 常驻（不再有「并列检出缺失就跳过」的空窗）。

**UI/UX 施工进度（2026-10-14，按 [docs/UIUX-HANDOFF.md](docs/UIUX-HANDOFF.md) 排序）**：更新横幅文案已修正为与 electron-updater 实际行为一致；P0 三层 Design Token 基座落地（`renderer/src/styles.css` 单文件，暗色默认 + light 覆盖）；P3/批量图集下载页按 `groupId` 聚合 + 折叠；P5 托盘 + 关窗最小化（`minimizeToTray` 设置项，下载中关窗不杀任务）；P4 结果卡补全（画质选择器消费 `qualities`/`videos[].qualities`、图集缩略网格 + 模态预览、`stat`/`avatar`/`music`/频道计数元数据行含 `statsUnreliable` 警告、`embedOnly` 浏览器打开、`fallbackReason` 折叠、缓存命中 chip、失败态重试、直链 5 分钟时效提示——零 IPC 变更）；P2 明暗主题接线（小契约 `AppSettings.theme`，`renderer/src/lib/theme.ts` 解析 system/dark/light 落 `data-theme`，设置页「外观」卡）；布局改左右分栏（侧栏导航带 `⌃1–4` 快捷键角标）；品牌图标全站统一（复用上游 `public/logos` 21 枚 SVG 至 `renderer/public/logos`，`PlatformIcon` 单点出口，解析墙/结果卡/下载/历史/设置体检五处同源）；交互升级（粘贴 600ms 自动解析 + 实时识别提示条、平台墙点选注入 `platformHint`、Ctrl+1–4/Ctrl+,/Ctrl+D/Esc L1 快捷键、解析中骨架屏 + spinner、三页空态引导、卡片/按钮质感打磨）。**Air 风格迁移已落地（2026-10-14，规范见 [docs/UIUX-DESIGN.md §7](docs/UIUX-DESIGN.md)）**：Tailwind v4 CSS-first 接入（`@theme inline` 桥接三层 Token）；高对比黑白灰基座 + 三区悬浮玻璃布局（侧栏 220 / 顶栏 60 全局粘贴入口 Ctrl+K / 主内容 16px 间距；App 层仍订阅 `onProgress/onDone/onError` 供首页队列摘要跨页存活，但进度与暂停/继续/取消只在队列页呈现——2026-10-14 业主决策移除底部任务控制条，见 [docs/UIUX-HANDOFF.md](docs/UIUX-HANDOFF.md) §6）；动态魔法色（`renderer/src/lib/accent.ts`：缩略图 32×32 主色提取、HSL 亮度钳位、`@property --accent-color` 400ms 过渡、`--accent-ink` 按亮度翻转，零 IPC 变更）。剩余：真实 tray 图标资产。

**P6 自动更新已落地（2026-10-14）**：`electron/main/updater.ts` 把 electron-updater 的离散事件收敛成单一 `UpdateState` 快照（idle/checking/up-to-date/available/downloading/downloaded/error/unsupported）；契约面新增四个 invoke channel（`update:state` / `update:check` / `update:download` / `update:install`）与 `app:updateState` 事件，替换原先只带一个版本号的 `app:updateAvailable`。`autoDownload` 显式关闭（更新包几十 MB，不该静默吃用户的家庭带宽），下载由横幅按钮触发，`autoInstallOnAppQuit` 保持开；横幅按阶段给真实文案与动作（发现新版本→下载、下载中→进度条、已下载→立即重启、失败→重试），设置页新增「更新」卡承载主动检查。未打包运行（dev / headless 测试）如实报 `unsupported` 并隐藏检查入口，不假装有更新源。端到端实测前置：先在 GitHub Releases 发布带 `latest.yml` 的版本。

## 本地适配层职责（core-adapter）

| 线上组件 | 桌面替代 | 原因 |
|---|---|---|
| `api-middleware`（CORS/蜜罐/IP 限流/anti-bot 节流） | 不加载；IPC 直达 `parseFn` | 中间件是公网多租户防护，单机自用属纯开销 |
| `result-cache`（CF Cache API，24h） | 内存 LRU（同 TTL，直链时效内有效即可） | Electron 无 `caches` 全局 |
| `analytics`（Turso 统计） | no-op | 不上报用户行为，隐私边界 |
| `process.env` Cookie | userData JSON 配置（设置页读写） | 桌面没有部署环境变量 |
| `/api/video-proxy`、`/api/image` | 下载管理器内化：主进程 fetch 带 Referer/Range/UA | 逻辑同源，落盘替代转发 |

## 关键设计决策（已确认）

- **框架**：Electron（非 Tauri）——解析内核是 Node/JS，Tauri 需嵌 sidecar Node 两头维护；本项目随包 ffmpeg，体积收益不抵复杂度。
- **首发平台**：仅 Windows；`electron-builder` 出 `nsis` + `portable` 双产物。代码保持平台无关（不写 Win-only 假设），macOS/Linux 后续按需加目标。
- **渲染层**：不塞 Next.js standalone sidecar（方案 C 被否）：renderer 是纯 Vite+React 新壳，同源 API 假设全部替换为 IPC。
- **失败回落**：本地解析失败可选回落线上 API（站点有 24h 结果缓存兜底），兼顾住宅 IP 高成功率与最坏情况。
- **直链时效**：解析结果到下载启动的窗口以秒计——UI 上「下载」按钮直接触发主进程流式落盘，不做「先展示直链让用户点」的二跳。
- **更新**：`electron-updater` + GitHub Releases；无签名证书阶段接受 SmartScreen 提示，后续补签。
- **依赖基线（2026-10-14 第三次修订：对 UI 框架不设限）**：此前两轮是"零新增 → headless 白名单（Radix dialog/select/switch/toast + lucide-react，禁 Tailwind/shadcn/framer-motion/tanstack）"，现**取消全部组件库/样式范式/动画库/路由的禁令**，按需引入。仍然有效的只有两条：① CSP `default-src 'self'` 禁远程字体 / icon font / 外链 SVG（技术边界，与选库无关）；② 新增 runtime 依赖与 `pnpm-lock.yaml` 同 commit 提交，并过 `typecheck`/`lint`/`test` 验收门。当前 runtime 依赖：react / react-dom / zod / electron-updater / lucide-react + **shadcn 基线**（`class-variance-authority` / `clsx` / `tailwind-merge` / `tw-animate-css` + 11 个 `@radix-ui/*`：checkbox、dialog、label、progress、radio-group、select、separator、slot、switch、tooltip），dev 侧 `tailwindcss@4` + `@tailwindcss/vite`。**shadcn/ui 已于 2026-10-14 落地为渲染层基线**（[docs/UIUX-DESIGN.md](docs/UIUX-DESIGN.md) §8：`components.json` + `renderer/src/components/ui/` 16 件 vendored 组件 + `@theme inline` 把层 2 Token 桥成 shadcn 语义 utility）。代价如实记账：renderer 产物 272.64 kB/gzip 86.42 → **448.85 kB/gzip 145.26**；zod 仍不进 renderer 包（`boundaries.test.ts` 铁律 3 守着）。样式语义真源仍是 [docs/UIUX-DESIGN.md](docs/UIUX-DESIGN.md) §5.2 三层 CSS Token。业主同日进一步指令「**都放宽，按照 Motrix 的 UI 设计框架和理念，不要给自己设限**」，为冷灰工具风写的三条审美禁令（不用玻璃、单一高程、不上浮缩放）随之解除：`tests/style-discipline.test.ts` 放宽为三条与选库无关的工程断言（hex 只在层 1 色板、消费的 CSS 变量必须已声明、不残留 `--air-*`），阴影层级与动效交由组件库主题决定。

**UI 对账（2026-10-16，覆盖上面两段里的旧描述）**：以当前代码为准——
①**主题**：`accent.ts` 的动态魔法色已删除，改为 `themeStyle` 五套整带主题 × 明暗 × 字号三轴正交（浅档底色不染色、控件零填充只描边），`renderer/src/lib/accent.ts` 不存在，别再按「primary=封面主色」理解组件语义；
②**导航**：侧栏 `⌃1–4` 角标与 Ctrl+1–4 快捷键通道已去掉，设置改为独立页 + 覆盖式一级分类（解析与 Cookie 合成「引擎」、运行环境并入「关于」，现 5 类）；
③**更新呈现**：首页/队列/历史的「发现新版本」横幅已撤，关于页置顶「更新策略」行负责手动检测，结果走右上角 toast（见 `renderer/src/components/Update.tsx` 头注释）；
④**新增能力**：首页批量导入（粘贴 / txt·csv 文件，渲染层 per-token 串行、零 IPC 变更）、队列与历史筛选、设置项两批（下载四条 + 通知/剪贴板/自启/代理 + 缓存/日志）、主进程文件日志与缓存占用清理；契约面 `CONTRACT_VERSION = 3`。
剩余仍是：真实 tray 图标资产、以及**第一个 `v*` 标签**（发出去才有 `latest.yml`，应用内检测更新才可能成功）。
- **UI 基线 = shadcn/ui + Tailwind v4 + Radix（2026-10-14，对标 Motrix v2）**：渲染层从 1609 行自绘 `styles.css` 迁到组件库，组件样式写在 JSX 的 utility 里，CSS 只剩三层 Token 与少数无法 utility 化的全局（约 300 行）。语义映射钉死在蓝图 §8.3——**shadcn 的 `primary` 是本 App 的动态魔法色（封面主色），`accent` 是中性 hover 底，`muted` 是次级表面**，三者不可望文生义；色彩真源仍在层 1 色板。选型理由不是"流行"，而是与对标项目同栈后可以直接借用它的信息架构与组件行为，并让 Radix 接管焦点管理、Esc、ARIA 这些我们此前手写的部分。ui.shadcn.com 本机不可达，故组件源码 vendored 入仓由我们维护。
- **IPC 契约（2026-10-14 单一真源改造）**：载荷形状只在 `types/ipc-contract.ts` 用 zod 声明一次，`types/ipc.ts` 以 `import type` + `z.infer` 派生并保持**零运行时**（否则整层 schema 会被打进 renderer 包）。主进程按 `CONTRACT` 注册表统一校验入参，dev 构建额外校验出参（漂移报 `contract-drift`，打包版不付这个代价）。理由：interface 与 zod 段各写一遍时两份会静默背离，用户侧只表现为结果卡少个字段、无人报错；`tests/contract.test.ts` 把「漏登记通道」也变成当天红叉。对标 Motrix v2 的契约层做法。

## 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| P0（在 mediaGet 仓） | 上表 4 项内核抽取 | `npm test` 全绿；`test:live` 基线无回归；`desktop/` 视角零 `src/app/api` 依赖可行 |
| P1 | Electron 骨架：main + preload + 最小 renderer，跑通「粘贴→识别→解析→展示」 | ≥3 个主力平台真机解析成功 |
| P2 | 下载管理器 + 批量图集 + 历史 + 设置（Cookie/目录/回落开关） | 断点续传、Referer 平台下载成功；重启后队列/历史完整 |
| P3 | yt-dlp/ffmpeg 随包（TikTok）、electron-builder 打包、自动更新 | 干净 Win11 实机安装即用；TikTok 端到端 |
| P4 | 线上回落链路、远程功能开关、体验打磨 | 断网/上游改版场景降级正确 |

## 风险与对策

- **上游接口频繁变动** → 客户端版本滞后是常态：回落链路 + 远程开关（可扩展站点 `/api/config`）保证「坏消息先到、不白屏」。
- **平台风控升级** → 本地 UA/Referer/Cookie 治理照抄内核既有实现，不私自加码绕过；UA 池改动须经 `test:live`。
- **法律** → 工具属性（用户自带链接/Cookie、不代为存储与分发内容），沿用站点 DMCA/免责框架；不分发任何服务端凭据。
- **两仓分叉** → 铁律 1/2 + 契约守卫：`tests/kernel-sync.test.ts` 每次 CI 都拿镜像 zod schema 与已安装工件的 `dist/index.d.ts` 双向比字段集合，上游改签名而本仓没跟上，当天红叉（原先「并列检出跑固定链接冒烟」的 `smoke:kernel` 已随拆桥删除——网络冒烟既不 deterministic 又覆盖不到类型面）。

## 开发命令

前置只有一个：本仓 + pnpm。`packageManager: pnpm@11.22.0` 是版本真源（CI 的 `pnpm/action-setup` 直接读它），用 npm/yarn 装会被根 `preinstall` 守卫拦掉——不是偏好，是 `pnpm-lock.yaml` 与 `package-lock.json` 会给出两棵不同的依赖树。没有 pnpm 时 `corepack enable pnpm`。

```bash
pnpm install --frozen-lockfile  # 装依赖（含内核工件 @mediaget/parse-core）
pnpm dev                   # 先软补随包二进制（缺则下载，补不上只降级不挡开工），再 vite renderer + tsup main/preload + electron 联调（renderer 走 HMR，主进程/preload 改动需重启 Electron）
pnpm run build             # build:app + electron-builder --win（nsis + portable → release/）
pnpm run build:app         # 只出 dist-electron/ + dist-renderer/，不打包（本机验收门用这个）
pnpm run test              # vitest（适配层、下载器、IPC 契约、边界约束、回落通道、内核面守卫——全离线）
pnpm run typecheck         # tsc --noEmit
pnpm run lint              # eslint（flat config）
pnpm run fetch:binaries    # 手动补齐/重下随包二进制（`pnpm dev` 已自动软补；CI 用严格版，缺件即红）
pnpm run release           # 发版：先过三门禁，再按 commit 前缀升版本 + 写 CHANGELOG + 打 tag + push
pnpm run release:dry       # 同上但只打印将执行的命令，不动仓库
```

提交口由 husky 卡两道：`pre-commit` 对暂存件跑 `eslint --fix`，`commit-msg` 走 commitlint（`type(scope): 摘要`，scope 必填）。前者保证格式、后者保证 `pnpm release` 能从前缀推出正确档位——`feat` 升 minor、`fix` 升 patch、`!`/`BREAKING CHANGE` 升 major，其余前缀不进 CHANGELOG。

内核态速记：`MG_KERNEL_MODE=mock` 强制 mock（UI 联调）；默认 auto = 本地纯模块识别/快手解析 + 已开回落时线上补全；设置页可关回落。二进制（yt-dlp/ffmpeg）见 `resources/README.md`。

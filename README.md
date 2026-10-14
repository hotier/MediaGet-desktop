# mediaGet-desktop

「即刻解析」桌面客户端（Windows 首发）：基于 [mediaGet](https://github.com/hotier/mediaGet) 的视频解析能力，在本机完成**解析 + 下载**闭环。

- 仓库定位：桌面客户端工程（Electron）。**解析内核不在本仓**——单一代码源留在 `mediaGet` 仓 `src/lib/**`，本仓通过 workspace 引用（见下文「内核耦合」）。
- 状态：**P1 骨架已落地**（main/preload/renderer + core-adapter + IPC 契约 + 下载管理器 + 线上回落 + 边界 CI），解析面已**桌面化一致**：上游内核整体收敛为 `packages/parse-core` 统一入口（`unifiedParseLocal` + `localParserKeys`），黑名单/平台识别/全部 21 平台解析器/快手兜底/直链验证/source+id 模式**全部本地执行**（见「内核耦合」）。本仓不再自维护平台解析器表，只引用这一个核心。线上 `/api/parse` 降级为**逃生通道**（上游改版风暴、用户主动开启时才用），不再承担主解析；无网络且回落关闭时落 mock，结果来源（local/online/mock）在结果卡如实标注。
- 开发前置：两仓并列检出（`../mediaGet` 与 `../mediaGet-desktop` 同级），tsconfig/tsup/vitest 已按 `@ → ../mediaGet/src` 配好路径别名（消费方式 A·物理链接）。

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
│  ├─ 下载队列 / 历史                │   import 解析内核 ────────┼──► mediaGet/src/lib/**
│  ├─ 设置页（Cookie / 目录 / 代理）  ├─ 下载管理器               │    platforms / unified-parser
│  └─ 仅经 preload 白名单通信         │   fetch+Range+Referer    │    parse-handler / <platform>Core
│       (contextBridge/IPC)         ├─ yt-dlp/ffmpeg 资源定位   │    http / share-text / result-cache
│                                   ├─ 本地配置存储 (userData)  │
│                                   └─ 失败回落：调线上 API ────┼──► get.hotier.cc.cd（可选兜底）
└──────────────────────────────────────────────────────────────┘
```

三条铁律：

1. **单一代码源**：解析逻辑只在 `mediaGet/src/lib/**` 维护一份，本仓永远 import 不复制——上游平台接口一改，两端同时受益，避免分叉腐化。
2. **依赖边界**：本仓只允许 import `mediaGet/src/lib/**`，**禁止 import `src/app/api/**`（route 层）与任何 Next.js 运行时模块**。这是 P0 内核抽取的验收标准。
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
├─ renderer/               # Vite + React
│  ├─ src/pages/           # 解析页 / 下载页 / 设置页 / 历史页
│  ├─ src/components/      # 复用 mediaGet 的 utils 与部分展示组件
│  └─ src/lib/bridge.ts    # 对 preload API 的类型化封装
├─ core-adapter/           # 本地适配层（对解析内核的注入件）
│  ├─ cache.ts             # 结果缓存：内存 LRU（替代 Cloudflare Cache API）
│  ├─ analytics.ts         # no-op（替代 Turso 上报）
│  ├─ config.ts            # env → userData 配置文件两级取值（Cookie / 开关）
│  └─ ratelimit.ts         # 本地不限流 / 可配温和节流
└─ resources/              # yt-dlp.exe、ffmpeg.exe（git-lfs 或 CI 下载，不入库）
```

## 内核耦合：mediaGet 侧的 P0 前置改造

本仓能「直接 import 解析内核」的前提是 mediaGet 完成抽取（对线上行为零影响）：

| # | 改造 | 说明 |
|---|------|------|
| 1 | 平台解析器纯函数化 | 各 `src/app/api/<platform>/route.js` 里的 `parseFn` 提为 `src/lib/<platform>Core.js`；route 变成 `parseCore + createApiHandler` 薄壳。分批：共用 `parser-kit` 的小平台 → 抖音/快手/B站/微博/小红书 → twitter/instagram/youtube |
| 2 | result-cache 存储可注入 | `caches.*`（CF Cache API）抽成 store 接口，默认实现不变，桌面注入 `createTtlCache` 内存 LRU |
| 3 | env 读取两级化 | Cookie 类 env 改为「`process.env` → 可注入配置对象」，桌面端用后者（用户自配、存本机） |
| 4 | 统一入口确认 | `parse-handler.js` / `unified-parser.js` 无 route/Next 依赖，可直接作桌面统一解析入口 |

消费方式（**已定稿，完整论证与同步流水线见 [docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md)**）：内核发布为 `@mediaget/parse-core` **版本化工件**，首发载体是 mediaGet GitHub Release 附带的 tarball（零注册表运维，semver 语义完整，CI `npm ci` 直连可用）。物理链接 `../mediaGet` 仅作本地联调临时桥，**提交态必须是版本化工件**。

P0 工件尚未发布前，本仓 engine 用临时物理链接顶替：`await import("@/lib/unifiedCore")` 拿到 parse-core 统一入口，**全部平台解析在本地执行**；线上回落只在用户显式开启、且本地异常/核心未覆盖时作为逃生通道，两者皆不可用时落 mock。工件首发后的切换清单见 `electron/main/engine.ts` 头注释（4 步，一次 PR 完成）。

**P0 进度（2026-10-14）**：mediaGet 侧步骤 1 **已全量落地**——解析内核依赖闭包（15 个 `src/lib` 模块 + `types/api` + `config/video-platforms` + `utils/filename`）迁入上游仓 `packages/parse-core/`（包名 `@mediaget/parse-core`，`src/index.ts` 为 exports 白名单入口），web 侧原路径改 re-export 薄壳、行为零变化（上游 1082 测试全绿 + `tsc --noEmit` 过）；余下 15 个平台的 route 内联解析逻辑逐字搬入 `packages/parse-core/src/lib/<platform>Core.js`，并新增 `parser-registry.js`（21 键覆盖识别面全平台）与 `unified-core.js`（`createUnifiedParser` / `unifiedParseLocal`）——web 的 `unified-parser.js` 退化为注入「kuaishou 纯函数 + platformRoutes 动态路由」的薄包装（保留中间件缓存/限流语义），桌面只引用核心的 `unifiedParseLocal` + `localParserKeys`，不再自维护平台解析器表。联机走线冒烟：21 个平台链接全部 `via=local`（B 站/YouTube 拿到真实标题与直链，抖音/西瓜/皮皮虾等返回各自平台的服务端错误文案）。本仓物理链接穿过薄壳照常消费（`@/lib/*` 路径不变），`tests/kernel-sync.test.ts` 守卫镜像与上游真源字段集合一致。剩余：上游步骤 2（CI tag → Release tarball 发布）、本仓步骤 3（切 `@mediaget/parse-core` 工件依赖，删 kernelAlias/并列检出）。

**UI/UX 施工进度（2026-10-14，按 [docs/UIUX-HANDOFF.md](docs/UIUX-HANDOFF.md) 排序）**：更新横幅文案已修正为与 electron-updater 实际行为一致；P0 三层 Design Token 基座落地（`renderer/src/styles.css` 单文件，暗色默认 + light 覆盖）；P3/批量图集下载页按 `groupId` 聚合 + 折叠；P5 托盘 + 关窗最小化（`minimizeToTray` 设置项，下载中关窗不杀任务）；P4 结果卡补全（画质选择器消费 `qualities`/`videos[].qualities`、图集缩略网格 + 模态预览、`stat`/`avatar`/`music`/频道计数元数据行含 `statsUnreliable` 警告、`embedOnly` 浏览器打开、`fallbackReason` 折叠、缓存命中 chip、失败态重试、直链 5 分钟时效提示——零 IPC 变更）；P2 明暗主题接线（小契约 `AppSettings.theme`，`renderer/src/lib/theme.ts` 解析 system/dark/light 落 `data-theme`，设置页「外观」卡）；布局改左右分栏（侧栏导航带 `⌃1–4` 快捷键角标）；品牌图标全站统一（复用上游 `public/logos` 21 枚 SVG 至 `renderer/public/logos`，`PlatformIcon` 单点出口，解析墙/结果卡/下载/历史/设置体检五处同源）；交互升级（粘贴 600ms 自动解析 + 实时识别提示条、平台墙点选注入 `platformHint`、Ctrl+1–4/Ctrl+,/Ctrl+D/Esc L1 快捷键、解析中骨架屏 + spinner、三页空态引导、卡片/按钮质感打磨）。**Air 风格迁移已落地（2026-10-14，规范见 [docs/UIUX-DESIGN.md §7](docs/UIUX-DESIGN.md)）**：Tailwind v4 CSS-first 接入（`@theme inline` 桥接三层 Token）；高对比黑白灰基座 + 四区悬浮玻璃布局（侧栏 220 / 顶栏 60 全局粘贴入口 Ctrl+K / 主内容 16px 间距 / 底部任务控制条 80——App 层订阅 `onProgress/onDone/onError` 跨页存活，封面模糊背景 400ms 交叉淡入 + 下载中 20s 呼吸缩放）；动态魔法色（`renderer/src/lib/accent.ts`：缩略图 32×32 主色提取、HSL 亮度钳位、`@property --accent-color` 400ms 过渡、`--accent-ink` 按亮度翻转，零 IPC 变更）。剩余：P6 完整自动更新 UI、真实 tray 图标资产。

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
- **依赖基线（2026-10-14 修订）**：runtime 依赖从"零新增"放宽为**仅允许已评审的 headless 原语与图标包**——白名单：`@radix-ui/react-dialog` / `@radix-ui/react-select` / `@radix-ui/react-switch` / `@radix-ui/react-toast` / `lucide-react`（一次提完、lockfile 单 commit、CI 验证）。禁止：Tailwind / shadcn / framer-motion / tanstack 全家桶等绑架设计系统或样式范式的包。理由：模态/combobox/toast 的自研无障碍成本（1–2 天/件且易错）大于 headless 原语的供应链成本；Electron 安装包体积下 ~30KB 组件无感。样式仍走 [docs/UIUX-DESIGN.md](docs/UIUX-DESIGN.md) §5.2 的三层 CSS Token。

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
- **两仓分叉** → 铁律 1/2 + CI 冒烟：desktop CI 每次对 mediaGet 最新内核跑一组固定链接冒烟解析，接口腐化当天暴露。

## 开发命令（P1 已生效）

前置：两仓并列——`mediaGet` 检出到与本仓同级的 `../mediaGet`（tsconfig/tsup/vitest 的 `@` 别名指向 `../mediaGet/src`，消费方式 A·物理链接；CI 同构）。

```bash
npm install        # ELECTRON_SKIP_BINARY_DOWNLOAD=1 可跳过二进制下载（CI 冒烟用）
npm run dev        # vite renderer + tsup main/preload + electron 联调
npm run build      # 产物 → release/（nsis + portable）
npm run test       # vitest（适配层、下载器、IPC、边界约束、回落通道——全离线）
npm run typecheck  # tsc --noEmit
npm run lint       # eslint（flat config）
```

内核态速记：`MG_KERNEL_MODE=mock` 强制 mock（UI 联调）；默认 auto = 本地纯模块识别/快手解析 + 已开回落时线上补全；设置页可关回落。二进制（yt-dlp/ffmpeg）见 `resources/README.md`。

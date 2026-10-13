# mediaGet-desktop

「即刻解析」桌面客户端（Windows 首发）：基于 [mediaGet](https://github.com/hotier/mediaGet) 的视频解析能力，在本机完成**解析 + 下载**闭环。

- 仓库定位：桌面客户端工程（Electron）。**解析内核不在本仓**——单一代码源留在 `mediaGet` 仓 `src/lib/**`，本仓通过 workspace 引用（见下文「内核耦合」）。
- 状态：规划 / P0 前置阶段，尚无代码。

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
│  └─ ARCHITECTURE.md      # 本文档的详版（目录职责 / IPC 契约 / 数据流）
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

消费方式（二选一，倾向 A）：
- **A. monorepo 物理链接**：开发期两仓并列，desktop 的 `package.json` 以 `file:`/workspace 指向 `../mediaGet`，配合 `tsconfig` paths 解析 `@/lib/*`；
- **B. 发布 npm 包**：mediaGet 侧把内核单独发 `@mediaGet/parse-core`（私有或 scoped public），desktop 按版本消费。分叉风险最低但多一道发布流程。

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

## 开发命令（P1 起生效）

```bash
npm run dev        # vite renderer + electron 联调
npm run build      # 产物 → release/（nsis + portable）
npm run test       # vitest（适配层与下载器单测）
npm run lint
```

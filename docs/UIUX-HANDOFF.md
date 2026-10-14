# UI/UX 施工交接单（UIUX HANDOFF）

> 来源：UI 设计师 Agent 于 2026-10-14 产出的完整设计方案（只读分析，当时未改任何源码）。
> **蓝图全文已随仓库提供**：[docs/UIUX-DESIGN.md](UIUX-DESIGN.md)（844 行，本文引用的 § 均指该文档）。仓库外原件在 `D:\dsh_store\mediaGet-desktop-UIUX-Design.md`。
> 本文件是给开发会话（当前 goal：修复阻断缺陷 + 补齐 README P2/P3/P4 里程碑）的施工索引，不新增需求，只排序和标注风险。

## 1. 与当前 goal 的合并策略

设计方案的分阶段路线与现有 goal **不冲突、可穿插**，合并规则如下：

| 事项 | 时机 | 理由 |
| --- | --- | --- |
| 更新横幅文案修正 | **立即**（在任何阶段之前） | 现状文案"重启应用即自动更新"与实际不符：`electron/main/index.ts` 只监听 `update-available`，从未监听 `update-downloaded`、未调 `quitAndInstall`。先把横幅改为「发现新版本，去设置检查并安装」，完整更新 UI 归 P6 |
| P0 Token 基座 + P1 组件层修补 | 阻断缺陷（CI ffmpeg URL / manifest 校验 / dev:electron 沙箱 / storeDir）修完之后、里程碑大功能之前做 | P0 只动 `renderer/src/styles.css` 一个文件、零契约；越晚做，后面新页面越要按旧样式返工 |
| P3 下载页重构 | **与 goal 里的"下载管理器与批量图集"合并为同一件事** | 契约字段 `groupId` 已存在（数据在 `DownloadTaskView.groupId`），批量图集的 UI 形态就是 P3 的"按组聚合 + 折叠"；分开做必然返工 |
| P4 结果卡补全（画质选择器等） | 里程碑 P2/P3 功能验收后 | 全部是"契约里已有、渲染层漏读"（`ParseData.qualities` / `platforms[].name` / `meta` 元数据），零 IPC 变更 |
| P2 明暗主题 | 小契约（`AppSettings.theme?` 可选字段 + zod + `nativeTheme`），随时可做 | 注意 `SettingsPatchSchema` 是 `.strict()`，先加 schema 再发字段 |
| P5 托盘 + 关窗最小化 | **优先级高于 README P4 自动更新完善** | 现状 Windows 上 `window-all-closed` 直接 `app.quit()`，下载中关窗=杀死全部任务，是用户可感知的最高伤害项；Tray/globalShortcut 全仓零命中 |
| P6 各项 | 逐个评估，按需 | 每项契约成本（4 处联动 + zod + 测试）已在蓝图 §4.1 表格标注 |

## 2. 铁律（违反任何一条 = 打回）

1. **依赖只用白名单**（2026-10-14 业主修订，见 README「关键设计决策」与蓝图 C4）：允许 `@radix-ui/react-dialog` / `react-select` / `react-switch` / `react-toast` + `lucide-react`——headless/无样式，只接行为与 a11y，样式仍由 Token CSS 提供。**仍禁止** Tailwind / shadcn / framer-motion / tanstack。CSP `default-src 'self'` 依旧禁止任何远程字体/icon font。安装动作**一次提完**（单 commit 含 package.json+lockfile），避免并发期间 lockfile 漂移。
2. **只加不改**：`downloader.ts` / `engine.ts` / `fallback.ts` / `core-adapter/*` 的逻辑一律不动；新数据只加**可选字段**或**新 channel**，`DEFAULT_SETTINGS` 兜底旧档。
3. **保留现有选择器名**：`.page / .card / .chip / .table / .field` 原地换 Token，不重命名，把 diff 压最小（蓝图 §4.0）。
4. **契约变更照抄清单**：`types/ipc.ts` → `preload/index.ts` → `main/ipc.ts`(zod) → `renderer/lib/bridge.ts` → 测试，五步一个不落（蓝图 §4.2）。三个已验证的坑：`SettingsPatchSchema.strict()` 拒未知键；`settings:set` 传全量；Cookie 掩码 `"***"`=不改、`""`=清除。
5. **每阶段验收门**：`npm run typecheck && npm run lint && npm run test`（含 `boundaries.test.ts` 铁律 1：renderer 不得 import `@/lib`）。P5 附加核心验收：下载中点 ✕ → 进程存活、任务继续、托盘恢复后队列与 `.part` 完好。

## 3. 直接执行的素材

- **可粘贴 CSS**：蓝图 §5.2 是完整 Design Token 总表（三层：原始色板 → 语义角色 → 组件级），明暗双主题全量色值**已经过 60+ 配对对比度实测**，含 3 处 AA 违规的修复值（主按钮 `#3b82f6`→`#2f6fed`、错误文字 `#ef4444`→`#f87171`、链接 `#3b82f6`→`#7cb3ff`；`--line` 与控件描边 `--line-control` 必须拆两个 Token）。
- **不要凭"看起来够"调对比度**——正文 ≥4.5:1、控件边界 ≥3:1 是硬门，蓝图已证明直觉值 `#5a6577` 实测仅 2.74。
- **状态×动作矩阵**（下载任务 6 态各显示哪些按钮）见蓝图 §3.2/§5.3；四页布局图见 §2.1–2.4；快捷键两级表见 §3.4；空态/加载/错误/成功分离规范见 §3.1。

## 4. 明确不做（减法清单，蓝图 §4.4 全文 9 条）

换风格栈、侧边栏导航、首屏 hero 化、图标库依赖、打包 Web 字体、frameless 自绘标题栏、历史存直链/"一键重下"（违反 `docs/ARCHITECTURE.md` §3 隐私红线）、剪贴板静默监听、多窗口。**不要在这些方向上花时间。**

## 5. 施工须知

- 蓝图表述以**选择器 / 组件名 / IPC channel 名为准**，行号仅作参考（撰写期间仓库正被并发修改，已核对过一轮漂移）。动工前对每条先做现状复核。
- 附录 §5.1 有 28 条按严重度排序的现状问题清单（逐条带代码位置），可作为 P0–P3 期间的 checklist。
- 若发现蓝图与代码现状不符（例如字段已有人消费、选择器已重命名），**以代码为准并在本文件下方追加勘误**，不要静默偏离设计系统。

## 6. 勘误记录（施工方追加）

- **2026-10-14 · 业主决策修订 C4**：依赖基线从"零新增"放宽为 headless 白名单（Radix dialog/select/switch/toast + lucide-react），蓝图 §0 C4、§4.0 原则表、§4.4 图标行与本文件铁律 1 已同步修订；本文件头部"合并策略"与 §3 素材表不受影响。安装须单 commit 完成（package.json + lockfile 一起提交），由施工方在干净工作区执行并跑 §2 铁律 5 验收门。
- （其余待施工方追加）

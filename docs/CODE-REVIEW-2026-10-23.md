# 全仓代码 Review（2026-10-23）

> 范围：`electron/`（主进程 + preload）、`renderer/src/`、`shared/`、`types/`、`core-adapter/`、`tests/`、`landing/src/`、`scripts/`、`.github/`
> 基线：`main @ 2857be2`，约 42.8k 行（electron 8.6k / renderer 14.4k / shared 1.7k / types 1.5k / tests 11.5k / landing 2.6k / scripts 1.8k / .github 0.5k / core-adapter 0.26k）
> 方法：按 [CODE-REVIEW.md](CODE-REVIEW.md) §2 的深度分配通读全部生产文件（契约/闸门/注册表 D3，下载器/引擎/主进程 D2，页面/落地页 D1–D2），三道门实跑，P1-1/P1-2 用临时探针复现（探针已删除）。审查阶段未改任何代码、测试或配置；随后按 §5 顺序完成修复，落地情况与包体积数据见 §6。**未提交。**

---

## 0. 体检基线

| 门 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（0 错） |
| `pnpm lint` | 通过（0 错 0 警） |
| `pnpm test` | **57 文件 / 991 用例全绿**（24.2s，纯离线） |
| `any` / `@ts-ignore` / `eslint-disable` | **0 处** |
| TODO / FIXME / HACK | **0 处** |
| `dangerouslySetInnerHTML` / `eval` / renderer 内 `fetch` | **0 处**（`landing/src` 同样为 0） |

**P0：0 条。** 这是一份完成度很高的工程：契约单一真源（`types/ipc-contract.ts`）+ 六件套 + 守门测试（`contract` / `boundaries` / `platform-registry` / `readme-platforms` / `style-discipline`）把「静默漂移」这类最贵的缺陷挡在了 CI；注释带事故日期与「翻案记录」，是能当设计文档读的代码。下面的问题**不是**「这仓不行」，而是「这几处还能更稳」。

覆盖面与结论（按风险面，不按行数）：

| 面 | 深度 | 结论 |
|---|---|---|
| `types/**`、`preload`、`ipc.ts` 六件套 | D3 | 契约 29 键与 handler 29 分支逐键比对一致；六件套无缺口。新增 P2-1、P2-3 |
| `downloader` / `media-merge` / `link-renew` | D2 | 状态机、续传、看门狗、合流主路径扎实；P1-1、P1-2、P1-3、P1-4 都在此面 |
| `engine` / `engines` / `ytdlp-engine` / `amagi-engine` | D2 | 选路、供给闸门、回退原因、防御式取值均无 P0/P1；未发现新 P2 |
| `index.ts` 生命周期 / 窗口 / 日志 / 更新 / 缓存 / 存储 | D2 | 启动顺序、迁移容错、退场冻快照正确；P2-4、P3 若干 |
| `renderer/src` 页面 / store / lib | D1–D2 | 乐观置态有回滚、事件去重总体到位；P1-4（渲染侧目标集）与 P2-1（草稿） |
| `landing/src` / `scripts` / `.github` | D1–D2 | 无安全面问题；仅一处页数文案漂移（P3） |
| `tests/` | 清单 | 991 用例结构健康；缺两条守卫（P2-10、P2-11） |

---

## 1. P1：应当尽快修

### P1-1 下载侧的 SSRF 闸门可被 IPv6 字面量绕过（且是第二套判据）

**位置**：`electron/main/downloader.ts:130-150` `isSafeRemoteUrl`

**证据**（探针实测，Node 22）：

```
isSafeRemoteUrl("http://[::ffff:127.0.0.1]/x")  → true   ← 应为 false
isSafeRemoteUrl("http://[fd00::1]/x")           → true   ← 应为 false
isSafeRemoteUrl("http://100.64.0.1/x")          → true   ← 应为 false（CGNAT）
```

**根因**：WHATWG `URL` 给 IPv6 主机名**带方括号**（`new URL("http://[fd00::1]/").hostname === "[fd00::1]"`），而代码里的前缀判据是 `host.startsWith("fc") / startsWith("fd") / startsWith("fe80")`，永远匹配不上；只有 `host === "[::1]"` 这一条字面量侥幸命中。`100.64/10`（CGNAT）、`198.18/15`、`192.0.0/24` 也不在名单里。

**更值得注意的是结构问题**：本仓**已经有一份写得很细的同功能判据** —— `shared/preview-link.ts:58-181` 的 `isPublicHttpUrl`（IPv4 掩码表 + IPv6 八段展开 + 映射地址 + 单段名 + `.local/.internal/.test/.invalid` 全在，且拒 userinfo）。它把 `::ffff:7f00:1`、`::`、`fc00::/7`、`fe80::/10` 逐条处理并配了 40 条测试。下载器这份是**第二套更弱的实现**——正是 AGENTS.md「单一代码源」要消灭的形态。

**还有一条同源缺口**：两处取流都用 `redirect: "follow"`（`downloader.ts:900` 与 `preview-protocol.ts:176`），闸门只校验原始 URL；一个公网地址 302 到 `http://169.254.169.254/` 仍会被跟随。修单源时应一起补「跟随后的 `resp.url` 再过一次闸」。

**建议**：把 `isPublicHttpUrl` 提到 `shared/net-guard.ts` 导出（现在它没有 `export`），下载器 `enqueue()` 与 `downloadTrack()` 改调它；`isSafeRemoteUrl` 只留一个 `export const isSafeRemoteUrl = isPublicHttpUrl` 的别名（既有测试不动）。`fetch` 之后加一条 `if (!isPublicHttpUrl(resp.url)) throw new Error("重定向到非公网地址")`。补 8 条用例（`[::1]`、`[::ffff:7f00:1]`、`[fd00::1]`、`[fe80::1]`、`100.64.0.1`、`198.18.0.1`、带 userinfo、302 到私网）。

---

### P1-2 `.part` 已下满时重试必死：416 被当成失败，真实原因被覆盖

**位置**：`electron/main/downloader.ts:900-904`（主链），对照 `downloadTrack()` 的 `:697`（音频轨**有**这条处理）

**证据**（探针实测）：一条 DASH 任务（`audioUrl` + `mergeLocal` 返回 false）——

```
第一次：视频 4 字节 200 → 合流失败 → 自动重试
重试：  Range: bytes=4- → 上游 416 → 任务 error = "HTTP 416"
```

预期是「合流失败」或「已完成」，实际是 `HTTP 416`：**真正的失败原因（ffmpeg 不可用/音频轨 403）被一句协议码盖掉，而且这条任务此后永远重试不成功**。同一个坑还覆盖：暂停在 100% 后继续、合并成功前的进程崩溃、任何「下完但没落地」的路径。

**建议**（与音频轨同一条判据，见 `:697`）：

```ts
// runOne()，紧跟 fetch 之后
if (resp.status === 416 && start > 0) {
  // start 已到/超过资源长度 = 上一轮其实下完了。meta 里有总长且 start < total 时，
  // 说明 .part 与上游不是同一份，清档重下一次（只此一次），别把它改名成正式文件。
  if (t.total > 0 && start < t.total) { this.removePartFiles(part); /* 重置后重试 */ }
  else { clearStall(); return this.finishDownload(t, part, /* ... */); }
}
```

抽 `finishDownload(t, part)` 复用「完整性闸门 + 合流 + 落地」那段（`:980-1015`），顺带把 `mergeAudioTrack` 抛出的错误保留（不要被 416 覆盖）。补一条回归用例：`.part` 长度 = 总长 + 上游 416 → 任务 done。

---

### P1-3 403 续链提示会变成 toast 风暴

**位置**：`electron/main/downloader.ts:1062`（写 `t.note`）、`:1115`（`toView` 无条件带上）、`renderer/src/App.tsx:158-160`（每次进度都 toast）

**机制**：`note` 一旦写入**永不清除**（`resume()` 也不清，见 `downloader.ts:384-407`），而 `toView()` 在每个进度事件里都带上它；`onProgress` 每 ~200ms 一发，处理函数是：

```ts
if (t.note && t.status === "downloading") toast.info(t.note);
```

于是续链成功后的一次下载会**每秒弹 5 条同样的 toast**，直到下完；用户按「继续」还会重演一遍。`note` 本该是「一行即时说明」，现在成了粘在任务上的常驻字段。

**建议**（两处都改，防回归）：
1. 主进程：`note` 只随**那一次** `progress` 发出——在 `runOne` 开头与 `resume()` 里 `t.note = undefined`（或改用一次性字段，发出后清）。
2. 渲染层：按 `taskId + note` 去重（`useRef<Set<string>>`），同一句只 toast 一次。

`DownloadsPage` 的 `HintInfo` 想长期显示那句话是合理的，可以保留——那是**行内静态提示**，不该再驱动 toast。

---

### P1-4 组操作「全部暂停」不会暂停排队中的成员

**位置**：`renderer/src/pages/DownloadsPage.tsx:542`（`activeIds` 含 `queued`）、`:631-638`（组动作拿它去 pause）、`electron/main/downloader.ts:372-374`（`pause` 只接受 `downloading`）、`:755-775`（`pump` 会在槽位释放后继续拉起 queued）

**机制**：一个 20 张图的组、并发 3，点「全部暂停」时只有 3 条是 `downloading`，其余 17 条是 `queued`。`pause()` 对 queued 一律返回 false，于是前 3 条暂停后 `pump()` 立刻把第 4–6 条拉起来——**用户以为整组停了，实际会一直下到结束**。按钮文案是「全部暂停」，判定条件 `a.running > 0` 又保证它只在这时出现，属于真实路径上的必然降级。

**建议**：让 `pause()` 接受 queued（状态置 `paused`、照常 `persist()`；queued 没有 signal，不需要 abort）：

```ts
if (!t || (t.status !== "downloading" && t.status !== "queued")) return false;
```

`runOne()` 同步段第一行就置 `downloading`，单线程下不存在「已 pause 又被拉起」的窗口；pump 只看 `queued`，天然跳过。补一条用例：并发 1、三条任务，pause 第 2 条 → 第 1 条完成后第 2 条仍为 paused。

---

## 2. P2：该修，但不紧急

### P2-1 设置页「保存」会把即时开关打回打开设置时的旧值
**位置**：`renderer/src/pages/SettingsPage.tsx:300-309`（进页时 `setDraft(structuredClone(s))`）、`:284-298`（开关读 store）、`:605`（保存时 `{ ...draft, cookies }` 整份提交）；`electron/main/ipc.ts:438-443`（四张开关表整表替换）；`renderer/src/store/platforms.ts:42-69`、`store/engines.ts:36-62`（开关即时落盘）。
**复现**：打开设置 → 关掉某平台（已即时落盘）→ 去外观页改字号 → 点「保存」。`draft` 里的 `platformSwitches` 仍是进页时的快照，整表替换后开关被静默打回打开。引擎开关、主引擎、失败回退同理。开关本身不进脏计数，所以「保存」看起来与它们无关，更隐蔽。
**建议**：提交前把四个 store 管理的字段从载荷里剔除（它们只走各自的即时通道），例如 `const { platformSwitches, engineSwitches, platformEngines, engineFallback, cookies: _masked, ...rest } = draft; api.settings.set({ ...rest, cookies })`；`setSaved` 后也按 store 现值回填这四项。把「草稿 → patch」抽成纯函数并补一条单测，防止下次新增 store 字段又混进草稿。

### P2-2 DASH 合流任务的字节账偏大（历史/统计的 `bytes` 不是文件大小）
**位置**：`downloader.ts:737-738`（音频轨 `t.received += ...`）、`index.ts:397`（`bytes: groupTask.received`）、`index.ts:407`（`stats.done({ bytes: ... })`）。
**机制**：合流任务里 `received` = 视频轨 + 音频轨字节数，而落地文件是合流后的 MP4（≈视频轨 + 少量容器开销）。B站登录态（最常见的 DASH 场景）每一条记录的大小都会**多出音频轨那几 MB**；统计页「已下载字节」「按类型/平台/作者」全部跟着偏大。
**建议**：`landAndFinish()` 落地后按 `statSync(target).size` 回写 `t.received`（`copyCached` 分支已经是这么做的，见 `:827-830`），或单独存 `fileBytes` 供历史/统计用，`received` 只服务进度。补一条用例：`audioUrl` 任务完成后 `history.bytes === 实际文件大小`。

### P2-3 任意 Cookie 键会被写进 `kernel_config`，最终可指向任意可执行文件
**位置**：`types/ipc-contract.ts:270`（`cookies: z.record(STR, STR)` 键不受限）、`electron/main/ipc.ts:444-455`（每个非掩码键同时写 `settings.cookies[k]` 与 `next.kernel[k]`）、`electron/main/index.ts:188-194`（用户 kernel 值优先）、`resources.ts:198-203`（用户自备路径**按设计不校验哈希**）、`engine.ts:219-220`（yt-dlp/ffmpeg 从这里取路径并 spawn）。
**机制**：`settings:cookieLogin` 已经示范了正确做法（`ipc-contract.ts:354-356` 用枚举只认登记过的键），但 `settings:set` 的 `cookies` 是自由 record。渲染层提交 `cookies: { "YTDLP_BIN": "C:\\evil.exe" }`，返回值照常显示 `***`，而下一轮解析就会 spawn 它。需要渲染层先被攻破，故按 P2；但这是「桥的能力面」问题，不是 UI 问题。
**建议**：契约层把 `cookies` 的键收窄为 `SECRET_CONFIG_KEYS` 同源的白名单；`ipc.ts` 写 `kernel` 前再判一次 `isSecretKey(k)`（双保险，与 env 侧 `publishKernelEnv` 同源）。顺带修正 `engine.ts:217-218` 的注释「二进制全部经 SHA-256 校验」——用户自备路径并不校验。

### P2-4 主窗口没有 `will-navigate` 守卫
**位置**：`index.ts:687-690` 只装了 `setWindowOpenHandler`（新窗口 → 系统浏览器）。`cookie-login.ts:205` 那份反而装了 `will-navigate`。缺这条意味着：页面内一次 `target="_self"` 的同页跳转（或 renderer 被攻破后主动 `location.href=...`）会把主窗口导航到远程页面，而 **preload 会随导航重新注入**，`window.mg` 就此交到远程内容手里——虽然还有 `sandbox/contextIsolation/CSP` 兜底，但这是唯一一条「把桥交出去」的路径。
**建议**：`mainWindow.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(devUrl || "file://")) { e.preventDefault(); void shell.openExternal(url); } })`；并按 [CODE-REVIEW.md](CODE-REVIEW.md) §7 第 2 条加源码扫描守卫。

### P2-5 历史列表一行坏数据会打死整页
**位置**：`repositories.ts:621` 直接 `JSON.parse(row.payload_json)`（无 try/catch），而队列侧 `parseQueuePayload()`（`:168-176`）是 `safeParse` + 跳过坏行。一条被截断/手改过的历史行 → `history:list` 抛 internal → 历史页整页空态。
**建议**：照队列那份写：`safeParse` 失败跳过并计一条 warn；补「一好一坏两行 → 返回一行」的用例。

### P2-6 `buildImageSrc` 的回落分支对「被闸门拒掉」的地址也原样放行
**位置**：`shared/preview-link.ts:218-232`。函数注释（`:202-203`）写的是「只有浏览器自己也能安全发的地址才原样回落」，但实际逻辑是：代理建不出来（**必然**是 `isPublicHttpUrl` 失败：回环/私网/`.local`/`.invalid`）→ 只要是 http(s) 就返回原链。`https://192.168.x.x/a.png` 因此会进 `<img src>`，由渲染进程直接发起请求（盲探内网）。
`tests/preview-link.test.ts:184-189` 正是用 `.invalid` 与 `.local` 断言的「原样回落」，说明这条语义被当成了预期。
**建议**：回落只保留 `data:`；http(s) 原链先过闸再放行。若确有「图床不吃 Referer 少一跳」的需求，正确做法是给代理链加 `?noref=1` 让主进程不带 Referer，而不是绕过闸门。同步改掉那条测试的输入（用真实公网图床）。

### P2-7 `claimedTargets` 是只写不读的死状态
**位置**：`downloader.ts:196` 定义、`:287 / :456 / :502` 三处 `add`，但 `isTargetClaimed()`（`:328-337`）只遍历 `this.tasks`，**从不读这个 Set**（`:334` 的注释还写着它有用）。
**后果**：Set 随入队/恢复无界增长（长会话内存泄漏），并且让人误以为有第二层占位保护。
**建议**：删掉 Set；或让 `isTargetClaimed` 先查它，并在 `retire()`/`cancel()` 里 `delete`。

### P2-8 `queue.json` 迁移不去重 `taskId`，重复 id 会让首启迁移永久失败
**位置**：`storage-migration.ts:142-179` 直接按数组逐条 `INSERT`（`task_id` 是主键），而 history 那份（`:205-213`）专门做了 `seenIds` 去重并留了注释说明为什么必须去重。队列侧一旦有重复 id（手改过、或两次导出拼接），`migrateJsonStore` 抛错 → **每次启动都弹「本地数据迁移未完成」**，且永远不会自愈。
**建议**：照 history 的写法加 `Set` 去重（保留最新一条），`rows` 用去重后的数量。

### P2-9 同名冲突落地后留下孤儿 `.part.meta`
**位置**：`downloader.ts:609-617` `landFile()` 冲突时把 `t.filePath` 改成 `name (2).mp4`，随后 `:623-628` 用 `metaPathFor(this.partPath(t))` 删 meta —— 算的是**新名**的 meta，真正存在的是旧名的 `<原名>.part.meta`。
**影响**：磁盘卫生（`cache.ts` 的 partials 清理能扫到），但会让「清理缓存」的可清理量多出几 KB。
**建议**：`landFile` 改名之前先记下 `const part = this.partPath(t)`，之后按旧路径删 meta。

### P2-10 `settings:set` 的 29 条手写分支没有守门测试
**位置**：`ipc.ts:412-443` 是 29 个 `if (patch.x !== undefined)`，与 `AppSettingsSchema` 的 29 个键**当前逐键一致**（本次用脚本比对过）。但这是「新增一个设置项、忘写一行 → 校验通过、界面显示已保存、实际不落盘」的典型静默缺陷，六件套里唯独这一处没被测试钉住。
**建议**：加一条源码扫描型守卫——`Object.keys(AppSettingsSchema.shape)` 去掉 `cookies`（特殊处理）必须等于 `ipc.ts` 中出现的 `patch.*` 集合。已登记在 [CODE-REVIEW.md](CODE-REVIEW.md) §6。

### P2-11 `fetch-binaries.cjs` 的 `--soft` / 严格退出码分界没有守卫（已在文档登记）
**事实**：原 `tests/binaries-watch.test.ts`（含真子进程验退出码那组）在 `962a3c8` 随「清冗余测试」删除；`docs/ARCHITECTURE.md:165` 已在 2026-10-23 勘误并承认「这条分界当前没有守卫」，[CODE-REVIEW.md](CODE-REVIEW.md) §6 已登记为待修。
**建议**：补真子进程退出码用例（软失败=0、manifest 残缺≠0），或把 `pnpm dev` 前置改成不依赖未守卫的语义。**不要**只把文档改软了事。

---

## 3. P3：可维护性与行为小疵（不改也能跑）

### 3.1 行为小疵

| 位置 | 观察 | 建议 |
|---|---|---|
| `SettingsPage.tsx:582-589` | `doExit()` 回落 `theme/themeSize/fontFamily`，漏了 `themeStyle`；预览 effect（`:316-318`）已把它改到草稿值，放弃后界面停在被放弃的风格上 | 补 `setThemeStyle(saved.themeStyle)` |
| `SettingsPage.tsx:895` | 日志卡片写着「不写入 Cookie 与媒体直链」，与 `logger.ts:6-7`（2026-10-21 业主定调：直链照原样进档）相反 | 文案改成「不写 Cookie；失败现场可含媒体直链，仅存本机」 |
| `HistoryPage.tsx:254-261` | `loadMore` 无 generation 守卫：翻页请求在途时改筛选，旧页行会追加进新列表 | 与首屏 effect 同款 `active`/seq 校验，或在 `serverFilter` 变化时作废在途请求 |
| `HistoryPage.tsx:265-284` | `selectAllFiltered` 捕获调用瞬间的 `serverFilter/list`；遍历期间改筛选会混页 | 捕获 `serverFilter` 快照并在每次返回后比对当前值，不一致即中止 |
| `DownloadsPage.tsx:247-258` | 同上，`loadMore` 无筛选代次校验 | 同 History |
| `HistoryPage.tsx:379-386` | `saveBlob` 在 `a.click()` 后立刻 `revokeObjectURL`；慢盘/杀软扫描下有概率取消下载 | 改为 `setTimeout(() => revokeObjectURL(url), 0)`（或 `requestAnimationFrame`） |
| `HomePage.tsx:200-205 / 209-246` | 手动解析不清 600ms 防抖定时器；若手动解析在缓存命中下先完成，定时器随后会再跑一轮 parse | `parseManual` 里 `clearTimeout(debounceRef.current)`；`runBatch` 的 busy 守卫已挡住大部分场景 |
| `index.ts:752 / 608-611` | `second-instance` 在模块作用域注册，热路径下可能在 `app.whenReady()` 前调用 `createWindow()`（`showMainWindow` 会新建窗口） | 注册移到 `whenReady` 内，或 `showMainWindow` 里先判 `app.isReady()` |
| `index.ts:214-220` | 二进制 env 只在「为空」时写入；用户改 `YTDLP_BIN` 后内核模块作用域仍是旧值直到重启（Cookie 那段有 `publishedCookieKeys` 回收，两条路不对称） | 照 Cookie 记「我们铺过的键」，值变了就覆盖 |
| `repositories.ts:63-67` | `loadConfig` 对 `app_settings.value` 直接 `JSON.parse`；库文件损坏会让启动期读设置抛错（队列/历史都做了兜底） | 加 try/catch，坏档回默认值并记一条 error |
| `database.ts:143-151` | `run/get/all` 每次 `native.prepare(sql)`；`saveMany` 每 2s 全量 upsert、统计聚合都是热路径 | `Map<string, Statement>` 缓存，`close()` 时清空 |
| `.github/workflows/landing.yml:58` | 步骤名写「five pages」，`scripts/verify-landing.cjs:35-45` 实际要求 7 页 + 404（8 个产物）；脚本自己的失败文案（`:57`）也还写着「五页」 | 页数从 `PAGES.length` 推导，文案统一为「七页 + 404」；AGENTS.md 里的「六页」一并勘误 |

### 3.2 可维护性

| 位置 | 观察 | 建议 |
|---|---|---|
| `renderer/src/pages/SettingsPage.tsx`（1829 行） | 单组件内含 9 个 `useEffect` + `renderSection()` 巨型 switch + 7 个内联子组件 | 按分类拆成 `sections/*.tsx`，`renderSection` 变 `Record<catId, ComponentType>`；脏计数与草稿模型抽 hook |
| `ResultCard.tsx`（1137）/ `HistoryPage`（1044）/ `DownloadsPage`（951） | 三个千行级页面组件 | 优先拆「纯展示子块」，逻辑已在 `lib/` 里的部分（`download-plan`、`history-selection`）保持不动 |
| `renderer/src/dev/mock-bridge.ts`（1355） | 六件套里唯一靠手工同步的一件 | 已由 `contract.test` 部分兜住；可考虑用 `MgBridge` 类型驱动生成骨架，只留数据假体 |
| `repositories.ts:448` | `aggregateSql().slice(indexOf("SUM("), lastIndexOf(" FROM ..."))` 拼 SQL | 抽 `AGGREGATE_COLUMNS` 常量两处共用；字符串切片在改 SQL 时会静默切错 |
| `App.tsx:152-166` | `tasks` 数组只增不减（完成/取消的行永不淘汰） | 保留最近 N 条终态行；长会话下 `filter/find` 会越来越慢 |
| `link-renew.ts:10-13` | 同一段话重复了两遍（「再解析必须绕开结果缓存…」） | 删重复段 |
| `download-plan` / `downloader` 的 `.part.meta` 语义 | 身份文件规则散在下载器与缓存清理两处 | 抽 `partMetaPath()` 单一出口 |

---

## 4. 值得保留的做法（别在重构里弄丢）

1. **契约单一真源 + 三道守门**：`CONTRACT`/`EVENTS` 一张表，`contract.test` 把「漏登记 / 多注册（=校验旁路）/ 出参漂移」都变成当天红叉。这是本仓最值钱的资产。
2. **注释即事故档案**：每条反直觉的判据都带日期、现象、翻案记录（如 `restore()` 的「v4 定过、2026-10-17 业主推翻」），未来的人不会照着旧注释改回去。
3. **引擎与供给解耦**：`covers()` 报能力、`run()` 用 `ok:false` 说「换下一个」，加引擎不用动选路；`attempts` 让「回退」有原因而不只是结论。
4. **隐私红线落到实现**：done 行剥 `url/audioUrl/headers` 在仓储口兜底（不信任调用方）、cookiefile 用完即删、剪贴板文本不落盘、日志与 config 同处 userData。
5. **预览侧 SSRF 判据**：`shared/preview-link.ts` 那份是全仓安全写法的样板——P1-1 的正确修法就是让它成为唯一实现。
6. **渲染层乐观置态**：`store/platforms.ts` / `store/engines.ts` 都是「先置态、失败回滚、以主进程回读为准」，开关不靠草稿——P2-1 修的是保存载荷，不是这套机制。

---

## 5. 建议的修复顺序

| 顺序 | 项 | 工作量 | 收益 |
|---|---|---|---|
| 1 | P1-2 416 收尾 + 抽 `finishDownload` | 小（~40 行 + 1 用例） | 让「下完了但失败」的任务真的能救回来 |
| 2 | P1-3 note 一次性化 + 渲染层去重 | 小（~10 行） | 去掉每秒 5 条的 toast 风暴 |
| 3 | P1-4 `pause()` 接受 queued | 小（~3 行 + 1 用例） | 「全部暂停」真的能停 |
| 4 | P1-1 合并 SSRF 判据 + 重定向复检 | 中（抽文件 + 改两处 + 8 用例） | 关掉一条内网可达路径，顺带消灭第二份判据 |
| 5 | P2-1 保存载荷剔除开关表 | 小（~10 行 + 1 纯函数用例） | 止住「保存一次、开关悄悄回滚」 |
| 6 | P2-2 落地后回写真实大小 | 小（~5 行 + 1 用例） | 统计/导出数字与实际文件对齐 |
| 7 | P2-3 Cookie 键白名单 | 小（契约 + handler 两处） | 收窄渲染层到原生的能力面 |
| 8 | P2-4 / P2-5 / P2-6 | 小 | 三个「一行守卫」级别的稳健性缺口 |
| 9 | 其余 P2 + P3 | 分批 | 卫生与可维护性 |

> 前七项都是「小改动 + 一条回归用例」，互不冲突，可以一个 PR 收掉（`fix(download)` + `fix(security)` + `fix(settings)` 三条提交）。
> 新发现且尚未进 [CODE-REVIEW.md](CODE-REVIEW.md) §6 登记表的：P1-4、P2-1、P2-3、P2-6、P2-7、P2-8、P2-9——合并修复 PR 时请同步补进去。

---

## 6. 修复落地（2026-10-23 续）

按 §5 顺序全部落地，未提交。收尾门禁：`pnpm typecheck` / `pnpm lint` 通过；`pnpm test` **59 文件 / 1020 用例全绿**；`pnpm verify:binaries:release` 通过；打包版实机启动并落库（见 §6.2）。

### 6.1 缺陷修复与守卫

| 项 | 修法 | 守卫 |
|---|---|---|
| P1-1 SSRF 双判据 | 判据合并到 `shared/net-guard.ts`（`isPublicHttpUrl` / `isPublicFinalUrl`）；预览、下载、重定向复检共用一份，`preview-link.ts` 删掉本地那套 | `tests/preview-link.test.ts` 扩 IPv6 / v4-mapped / CGNAT；`tests/downloader.test.ts`「跟随重定向到私网 → 落点复检」；`tests/boundaries.test.ts` 禁止第二份私网段判据 |
| P1-2 416 | `.part` 已满或上游对 Range 回 416 → 走 `finishDownload()` 按完成收尾；断点不可信则清掉重下 | `tests/downloader.test.ts`「.part 已完整 + 上游 416 → 按完成收尾」 |
| P1-3 note 风暴 | 主进程 `note` 一次性化；渲染层 `App.tsx` 再按 `taskId + 文案` 去重 | `tests/downloader.test.ts` 断言续链成功只发一条 note |
| P1-4 全部暂停 | `pause()` 接受 `queued` | `tests/downloader.test.ts`「pause 接受 queued」 |
| P2-1 设置草稿回滚开关 | 新增 `renderer/src/lib/settings-patch.ts`，保存载荷剥掉开关表与 Cookie 草稿 | `tests/settings-patch.test.ts` |
| P2-2 字节账 | 落地后把 `bytes` 回写为真实文件大小（合流后） | `tests/downloader.test.ts` 断言 done 行 `bytes` = 落盘大小 |
| P2-3 Cookie 键越权 | 新增 `shared/secret-keys.ts`；契约 `SecretCookieMapSchema` 收窄写入口，handler 再按同一张表判一次 | `tests/contract.test.ts`：`YTDLP_BIN` / `FFMPEG_BIN` 被拒 |
| P2-4 导航守卫 | 窗口工厂补 `will-navigate` + `setWindowOpenHandler` | `tests/boundaries.test.ts` 源码扫描每个 `new BrowserWindow` |
| P2-5 坏历史行 | 逐行 `safeParse`，坏行跳过并 warn，其余照常返回 | `tests/history-pagination.test.ts` |
| P2-6 图片回落 | 代理建不出来时只放行 `data:`，其余返回 `null` | `tests/preview-link.test.ts` 「闸门判不过的 http(s) 不回落原链」 |
| P2-7 `claimedTargets` | 死状态删除 | 无（代码已不存在） |
| P2-8 队列迁移重复 id | 按 `taskId` 保留最新一条后再 INSERT，计数用去重后的数量 | `tests/storage-migration.test.ts`「duplicate task ids collapse」 |
| P2-9 孤儿 `.part.meta` | 落地改名前清旧名 meta | `tests/ipc.test.ts`（孤儿 meta 清理） |
| P2-10 `settings:set` 无守门 | schema 键集合与 handler `patch.*` 分支源码比对 | `tests/contract.test.ts`「settings:set 字段覆盖守卫」 |
| P2-11 `fetch-binaries` 退出码 | 真子进程用例（临时树 + 不可达 URL）：soft 失败 = 0、严格 ≠ 0、残缺 manifest 仍 ≠ 0 | `tests/binaries-fetch.test.ts`（7 例） |

P3 已顺手落地：`doExit` 补 `themeStyle`、日志文案与隐私口径对齐、历史/下载翻页加代次守卫、`selectAllFiltered` 期间改筛选即中止、`saveBlob` 延迟 revoke、手动解析清防抖、`second-instance` 前判 `app.isReady()`、二进制 env 记「已铺过的键」（值变即覆盖、移除即删除）、坏设置档回落默认值并记 error、prepared statement 缓存、`link-renew` 重复段删除、落地页步骤名与「七页 + 404」文案统一。

P3 未做（可维护性大改，单独排期）：四个千行级页面组件的拆分、`mock-bridge` 生成化、`aggregateSql` 字符串切片、`App.tsx` 终态行淘汰、`partMetaPath()` 单出口。

### 6.2 包体积

`app.asar` 里曾装着**渲染层的整棵依赖树**：electron-builder 会把 `dependencies` 全量复制进包，而 Vite 早已把渲染层依赖打进 `dist-renderer`。修法是按「主进程运行时才留 `dependencies`」重分类，再加四项构建裁剪：

| 措施 | 效果 |
|---|---|
| 渲染层 / build-only 依赖移入 `devDependencies`（React、Radix、echarts、exceljs、lucide、motion、sonner、zustand…） | app.asar **176 MB → 28.6 MB** |
| `dist-electron/**/*.map` 不进包 | 同上 |
| `electronLanguages: ["zh-CN","en-US"]` | locales **49 MB（55 个 pak）→ 1.2 MB（2 个）** |
| better-sqlite3 只留 `win32-x64` 预编译件，排除 `deps/`、`src/`、`build/` | asar 内约 **1.9 MB** |
| `compression: "maximum"` | portable 单文件 **128 MB** |

整体：win-unpacked **666 MB → 446 MB（−33%）**。`resources/bin` 的 96 MB 未动（yt-dlp + ffmpeg 是功能本体）。

**验证**：出包到工作区外，用隔离 `--user-data-dir` 启动打包版，日志落到 `[app] 启动 v0.2.1 packaged · 内核 local · 队列恢复 0 项`——parse-core、better-sqlite3（原生 addon）与 asar 完整性在裁剪后都成立。

> 新规矩：**`dependencies` 只放主进程运行时**。渲染层依赖由 Vite 打进 bundle（放 `devDependencies`），留在 `dependencies` 只会让 electron-builder 再复制一份进 asar；反过来主进程 `require` 的包必须在 `dependencies`，挪到 devDependencies 会让打包版启动即 `MODULE_NOT_FOUND`。

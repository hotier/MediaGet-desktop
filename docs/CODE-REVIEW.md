# 代码审查标准与流程

> 本文件是**长期标准**。`docs/CODE-REVIEW-<日期>.md` 是**一次性快照报告**（例：`CODE-REVIEW-2026-10-23.md`），
> 里面的 P1/P2 编号只在那一份内有效，不要跨文件引用编号，引用请引本文件的分级定义。

## 0. 定位：审查管什么，不管什么

| 关注点 | 归属 |
|---|---|
| 这个改动**该不该存在**、设计对不对、边界在哪 | 本文件（审查） |
| 这个改动**验没验过**、跑哪一档 | [TESTING.md](TESTING.md)（验收档位 L0–L5） |
| 进程边界、IPC 契约、安全红线 13 条 | [ARCHITECTURE.md](ARCHITECTURE.md) §1 / §6 |
| Token、视觉语义、像素与几何 | [UIUX-DESIGN.md](UIUX-DESIGN.md) |
| 施工方（含 agent）的动手规矩 | [AGENTS.md](../AGENTS.md) |

**一条主干原则：审查深度跟着风险面走，不跟着行数走。**

全仓通读既不可能也不必要——4 万行代码逐行读一遍，注意力会在第 3 千行耗尽，剩下的部分等于没读，而且会给出一份"我看过了"的虚假安全感。正确的做法是：**先判这个 diff 落在哪个风险面，再决定读到多深**（§2）。深度是资源，不是态度。

**第二条：机制不是文档，是钩子。**

只写标准不配钩子的结局是确定的——三个月后没人记得有这份文件。本文件的每个"必须"都对应一个可执行落点：PR 模板的勾选项、CI 的一道断言、或 `tests/` 里的一条用例。**加一条规矩时，必须同时说清它由谁执行**；说不清的就别写进来。

---

## 1. 问题分级（P0–P3）

分级的唯一目的是**决定它能不能合并、多久必须修**，不是给作者打分。所以每条判据都必须可判定——能举出一个具体受损场景，而不是"感觉不好"。

| 级 | 定义 | 合并前必须 | 处置时限 |
|---|---|---|---|
| **P0 阻断** | 用户会**实际受损**：数据丢失/损坏、凭据外泄、越权访问、隐私红线（ARCHITECTURE §6 任一条）出现破口 | 修完才能合，不接受"下个 PR 修" | 当次 |
| **P1 必修** | 真实路径上**必然失败或必然降级**；安全闸门可被一个已知输入绕过；错误信息**掩盖真因**导致不可诊断 | 修完才能合；确实要分批则必须在 PR 里写明遗留项与负责人 | 当次或紧邻 PR |
| **P2 应修** | 结构性问题（同一语义有两份实现、缺守卫、单点故障无兜底）；数据口径偏差；资源泄漏但影响有限 | 可以合并，但必须**当场建 issue 或进 §6 登记表** | 本迭代 |
| **P3 建议** | 可读性、命名、注释、测试补强、性能微优化 | 不阻塞 | 排期或不做 |

### 判级不要凭直觉：三个反问

1. **能写出受害场景吗？** "用户在某平台点了下载，文件下到 99% 后永远失败"——这是 P1。"这个函数有点长"——P3。写不出场景就往下掉一级。
2. **它在真实路径上，还是在理论路径上？** B站登录态返回 DASH 是本仓最常见路径（`ARCHITECTURE §6.13`），所以 DASH 分支的缺陷一律按 P1 起算；`[fd00::1]` 这种输入要攻击者主动构造，SSRF 闸门绕过按 P1 算而不是 P0——**除非闸门背后是凭据或本机服务**，那就是 P0。
3. **它会让下一个 bug 更难查吗？** 错误码盖住真因（`HTTP 416` 盖住"ffmpeg 不可用"）是 P1 而不是 P2：它本身不丢数据，但它让每一次同类故障都变成一次考古。

### 锚例：本仓已确认的缺陷如何分级

| 缺陷 | 级 | 落在哪条判据 |
|---|---|---|
| 下载侧 SSRF 闸门被 IPv6 字面量绕过，且是第二套判据 | **P1** | 闸门可被已知输入绕过 + 结构性重复真源（若闸门后是凭据则是 P0） |
| `.part` 已下满时重试必死，`HTTP 416` 盖住真因 | **P1** | 真实路径必然失败 + 错误掩盖真因 |
| `t.note` 永不清除，续链提示退化成每秒数条的 toast | **P1** | 真实路径必然降级（用户被淹没后关掉提示，等于功能失效） |
| DASH 合流任务字节账偏大，历史与统计跟着偏 | **P2** | 数据口径偏差，不影响功能可用性 |
| 主窗口缺 `will-navigate` 守卫 | **P2** | 安全面缺口，但需要恶意内容先进入页面 |
| `history:list` 直接 `JSON.parse` 无兜底 | **P2** | 单点故障：一行坏数据打死整页 |

> 这张表的作用是**校准**：以后判"这算 P1 还是 P2"时，先找最像的一行对齐。新增锚例请追加，不要覆盖。

---

## 2. 审查深度（D0–D3）

**先判面，再定深度。** 深度定义的是"审阅者必须打开多少上下文"，不是"花多少时间"。

| 深度 | 审阅者必须看的范围 | 典型改动 |
|---|---|---|
| **D0 只看 diff** | 变更本身 + 它是否触碰 §5 红线 | 文案、纯 className/样式、文档、`renovate` 依赖升级、格式化产物 |
| **D1 diff + 邻接上下文** | diff + 同文件上下游 50 行 + 被改函数的所有调用点 | 单文件逻辑、纯函数、`lib/**` 工具、新测试 |
| **D2 diff + 整个模块 + 调用链** | 被改模块全文 + 它的入口（IPC handler / 页面）+ 它的守卫测试 | `downloader` / `engine` / `media-merge` / `ipc.ts` / 页面级状态 |
| **D3 模块 + 真源 + 守卫** | D2 + 该语义的**唯一真源**（`shared/platforms.ts`、`types/ipc-contract.ts`、`brand/`）+ 钉着它的测试 | 契约变更、平台注册表、品牌资产、新增判据/枚举 |

### 改动面 → 深度 → 谁审

| 改动面 | 深度 | 审阅者 | 必跑的守卫 |
|---|---|---|---|
| `types/**`、`electron/main/ipc.ts`、`electron/preload/**` | **D3** | 契约负责人 | `contract` / `boundaries` / `ipc` |
| `electron/main/downloader.ts`、`media-merge.ts`、`engines.ts`、`ytdlp-engine.ts`、`amagi-engine.ts` | **D2** | 主进程负责人 | 对应 `*.test.ts` |
| `electron/main/index.ts`（窗口/生命周期/安全钩子） | **D2** | 主进程负责人 | `boundaries` + L5 人工 |
| `shared/platforms.ts` | **D3** | 注册表负责人 | `platform-registry` / `readme-platforms` |
| `shared/preview-link.ts`（URL 闸门） | **D3** | 安全面负责人 | `preview-link` |
| `renderer/src/pages/**`、`components/**` | **D1–D2**（带状态机/事件的按 D2） | 界面负责人 | `style-discipline` / `toast-sonner` |
| `scripts/**`、`resources/**`、打包链路 | **D2** | 发版负责人 | `installer` + `verify:binaries` + L4 |
| `landing/**` | **D1** | 界面负责人 | `landing` 构建自检 |
| 纯文档 / 注释 / 勘误 | **D0** | 作者自审即可 | 无 |

**单人期怎么办**：一个人写的仓，强制第二人 approve 是形式主义，会立刻退化成自己点通过。替代做法是**冷却期自审**：写完先不看，隔 ≥30 分钟（或换一个任务回来）再只看 diff，按 §3 清单逐条问"如果这是别人写的，我会挑出什么"。冷却期自审抓得住 D0/D1 的绝大多数问题；**D2/D3 的改动不允许纯自审通过**——至少要把 §3 对应那组清单逐条写进 PR 描述，把结论外化，让下一个人能复核。

---

## 3. 检查清单（按改动面分组）

**不要通读这张表。** 只勾这个 diff 实际触碰的组；全勾等于全不勾。每组的"查法"是可执行的，不是提醒。

### A. IPC 契约面（深度 D3）

- [ ] **六件套齐全**：`types/ipc.ts` / `ipc-contract.ts` / `ipc.ts` / `preload` / `lib/bridge.ts` / `dev/mock-bridge.ts` 六处同时改了。少一处是**静默少字段**，不是编译错误。
- [ ] **`CONTRACT_VERSION` 已升**，且新版本能读旧存档（旧形状按新版本解释 = 用户把过期数据当合法）。
- [ ] **事件通道只进 `EVENTS`**，没有混进 `CONTRACT` 的请求/响应表。
- [ ] **入参校验在 `CONTRACT` 表里**，没有 handler 内部手写第二套校验（= 校验旁路）。
- 查法：`npx vitest run tests/contract.test.ts tests/boundaries.test.ts tests/ipc.test.ts`

### B. 安全面（深度 D2–D3，命中即升 P1 起算）

- [ ] **新增/修改的 URL 闸门全仓只有一份**。本仓已有 `shared/preview-link.ts` 的 `isPublicHttpUrl`；再写一个 `isSafeRemoteUrl` 式的平行实现就是缺陷，不是"各管一段"。
- [ ] **攻击输入有对应用例**，不只是"合法输入能过"。至少覆盖：`[::1]`、`[::ffff:7f00:1]`、`[fd00::1]`、`[fe80::1]`、`100.64.0.1`、`198.18.0.1`、`2130706433`、`0x7f.1`、带 userinfo、单标签名。
- [ ] **新增窗口/`webContents` 都有 `will-navigate` + `setWindowOpenHandler`**。`cookie-login.ts` 有而主窗口漏过——这类守卫必须逐个窗口点名，不能假设"全局配了"。
- [ ] **凭据不出主进程**：Cookie 值、`headers` 不进日志、不进渲染层、不进 `stats_events`。
- [ ] **`nodeIntegration: false` / `contextIsolation: true` / `webSecurity` 未关闭**；renderer 不加载远程内容、不新增 `fetch` / `dangerouslySetInnerHTML` / `eval`。
- 查法：
  ```bash
  grep -rn "will-navigate\|setWindowOpenHandler\|setPermissionRequestHandler" electron/
  grep -rn "startsWith(\"fc\")\|startsWith(\"fd\")\|isSafeRemoteUrl\|isPublicHttpUrl" electron/ shared/
  grep -rn "fetch(\|dangerouslySetInnerHTML\|innerHTML\|eval(" renderer/src/
  ```

### C. 单一真源面（深度 D3）

这是本仓最贵的缺陷类型——它不报错，只让两份实现慢慢漂移，直到某天其中一份被改。

- [ ] **同一语义没有第二份实现**：判据、枚举、映射表、平台名、图标路径、品牌色。
- [ ] **新增真源已登记**：`shared/platforms.ts`（平台）/ `types/ipc-contract.ts`（载荷）/ `brand/`（资产）/ `ENGINE_INFO`（引擎名与说明）。写进别处就是缺陷。
- [ ] **生成物没有被手改**：`build/installer*.bmp`、`landing/public/**`、`dist-*` 都是产出物，改母版重跑脚本。
- [ ] **别名归一**：上游路由名只活在 `legacyKeys`，写库前过 `resolveKey()`。

### D. 错误处理面（深度 D1–D2）

- [ ] **失败原因没被协议码掩盖**。`HTTP 416` / `HTTP 403` 这类状态码是**症状**，"合流失败""签名过期"才是原因；两者都要留。
- [ ] **静默 `catch {}` 有正当理由**。`allowEmptyCatch: true` 是 lint 的宽容，不是审查的宽容——吞掉错误的地方必须能说出"吞了会怎样、谁会发现"。
- [ ] **外部数据有兜底 parse**。队列侧有 `safeParse` 而历史侧直接 `JSON.parse` 就是漏；一行坏数据不该打死整页。
- [ ] **重试幂等**：同一输入重复执行会不会累积状态、会不会因为"已经做过了"而失败（`.part` 已满 + `Range` 请求 = 416 必死）。
- 查法：
  ```bash
  grep -rn "catch {" electron/main/ renderer/src/
  grep -rn "JSON.parse" electron/main/ | grep -v "safeParse"
  ```

### E. 资源生命周期（深度 D1–D2）

- [ ] **每个新建的临时文件/子进程/监听器，在每条退出路径上都清理**：成功、失败、取消、进程崩溃。
- [ ] **失败分支不留半成品**（`.part.audio` / `.part.merged` / cookiefile / ffmpeg 进程）。
- [ ] **TTL 清理存在且启动时执行**（`temp/mediaget-media` 24h 是既有范式）。
- [ ] **持久化新字段说明生命周期**：谁写、谁清、什么时候清。`t.note` 永不清除就是反例——一次性说明挂成了永久状态。

### F. 状态与并发（深度 D2）

- [ ] **一次性字段不会变成永久状态**（`note`、`error`、`lastAttempt`）。
- [ ] **乐观置态有失败回滚**（`store/platforms.ts` 的整表提交是范式）。
- [ ] **开关在主进程生效**，不只是 UI 隐藏。"只在界面藏起来 = 假开关"。
- [ ] **同一资源并发只做一次**（同档预览合流只跑一次 ffmpeg）。
- [ ] **字节/计数账口径单一**：DASH 任务把音频轨字节加进 `received`，历史与统计就跟着偏——账要按"落盘的那一个文件"算。

### G. 渲染层（深度 D1–D2）

- [ ] **只经 IPC 拿数据**，无 `fetch` / 无直连外部。
- [ ] **依赖边界**：不 import 主进程模块、不 import route 层/Next 运行时。
- [ ] **`echarts` 只在 `components/charts/echarts-core.ts` 注册一次**；`exceljs` 只在 `buildWorksXlsx()` 动态 import。
- [ ] **`navigator.clipboard` 不出现**（走 `app:copyText`）。
- [ ] **事件驱动不放大**：progress 类高频事件里的 toast / 写盘 / 重渲染要有节流或去重。

### H. 测试面（深度 D1–D3）

- [ ] **测试不是"跑过了"，是"钉住了"**。断言的是行为还是实现细节？改实现会不会假红？
- [ ] **事故已钉成断言**：每个 P0/P1 修复必须附一条会因回退而红的用例（见 §6）。
- [ ] **没有为覆盖率写的 UI 快照**、没有依赖真网络的用例、没有为 DOM 冒烟引入 jsdom。
- [ ] **源码扫描型守卫的断言面没被绕过**（改 `styles.css` / 加 `.tsx` 文件会动用例数）。
- [ ] **删除或弱化守卫测试必须给出理由，并同步清掉引用它的文档**。反例已发生：`tests/binaries-watch.test.ts`（236 行，含用真子进程验 `--soft` 退出码那组）在 `962a3c8` 以"清冗余测试"删除，但 `ARCHITECTURE.md §7` 至今仍宣称"这条分界由它锁住"——**文档声称有保护、实际没有，比没写更坏**，因为它让后来的人不再自己核。
- 查法：`git diff --stat main...HEAD -- tests/ | grep -E "deleted|-\d{2,}"`，删了测试就追问"它钉的是什么，谁接住了"。

---

## 4. 流程

### 4.1 作者侧（提交前）

1. **按 [TESTING.md](TESTING.md) 选档并实跑**，记下跑了什么、没跑什么、为什么。
2. **自审 diff**：`git diff main...HEAD` 通读一遍。这一步能抓掉 30% 的低级问题，成本最低。
3. **填 PR 模板**（`.github/pull_request_template.md`）。模板里的"自验档位"和"审查重点"是**必填**，空着等于声明"我没验"。
4. **声明风险面**：动没动契约、安全面、真源、持久化。作者最清楚自己碰了什么，让审阅者去猜是最浪费的环节。

### 4.2 审阅者侧

1. **先按 §2 定深度**，再看代码。定错深度的代价是双向的：D0 的改动按 D3 审是浪费，D3 的改动按 D0 审是漏检。
2. **按 §3 对应组逐条过**，只过相关的组。
3. **每条意见带级别**（P0–P3）+ **可执行动作**。"这里不太好"不是意见。
4. **区分"必须改"与"可以聊"**：P0/P1 是前者，P2/P3 是后者。混在一起会让作者无法判断哪些是合并条件。
5. **轮次上限 2 轮**。第 3 轮还在来回，说明分歧在**设计**而不是实现——停下来对齐方案（必要时写一份 `docs/superpowers/specs/`），别在 diff 里辩论。

### 4.3 合并条件（全部满足）

- [ ] CI 绿（`_verify.yml`：typecheck + lint + test），PR 上不需要 `_build-win`
- [ ] 无 P0 / P1 遗留
- [ ] P2 已进 issue 或 §6 登记表（"回头再修"不算处置）
- [ ] PR 描述的"自验档位"与实际改动面匹配（动了契约却没勾 L2 = 打回）
- [ ] 事故类修复附了守卫断言
- [ ] `package.json` 与 `pnpm-lock.yaml` 同 commit（新增依赖时）

### 4.4 什么时候可以不进 PR

单人期允许直接推 `main` 的：文档、注释、纯文案、`renovate` 自动 PR 的 patch 级（CI 绿即可合）。**其余一律走 PR**——不是为了流程好看，是为了让"这次改了什么、验了什么"在事后可查。历史里 `fix(downloader): ...` 这种提交，半年后要查"当时为什么这么改"，PR 描述是唯一入口。

---

## 5. 一票否决（不讨论，直接打回）

这些不是"建议修改"，是"改完再来"：

1. 触碰 `ARCHITECTURE §6` 红线任一条，且没有说明为什么安全。
2. 新增 `any` / `@ts-ignore` / `@ts-expect-error` / `eslint-disable`（本仓当前 0 处，是资产不是巧合）。
3. 改了 IPC 契约但没升 `CONTRACT_VERSION`，或六件套没改齐。
4. 引入第二份真源（平台表、载荷形状、URL 闸门、品牌资产、引擎清单）。
5. 声称"已验证"但给不出输出；或勾了档位但实际没跑。
6. 新增依赖没同时改 `pnpm-lock.yaml`。
7. 把凭据写进代码、日志、渲染层或提交历史。
8. 测试被改成"迁就实现"（改断言让红变绿，而不是修实现）。
9. **删除守卫测试却不说明它钉的是什么、由谁接住**；或留下"文档声称有守卫、实际已删"的状态。

---

## 6. 反哺闭环：每个 P0/P1 必须变成一道守卫

**同一个坑犯两次，是机制问题不是人的问题。**

每次审查出 P0/P1，修复 PR 必须**二选一**，并在 PR 描述里写明选了哪个：

- **A. 补一条守卫断言** —— 优先。`tests/` 里一条"回退就红"的用例，成本最低、寿命最长。
- **B. 补一条清单条目** —— 断言写不出来时（如"主窗口必须有 `will-navigate`"，静态扫描勉强能做；"错误信息不能掩盖真因"，只能靠人看），加进 §3 对应组，并在条目里写上事故日期。

### 已发生 → 守卫 登记表

| 事故 / 缺陷 | 级别 | 守卫化方式 | 状态 |
|---|---|---|---|
| 下载侧 SSRF 闸门被 IPv6 绕过（第二套判据） | P1 | 合并为 `isPublicHttpUrl` 单源 + 6 条 IPv6/CGNAT 用例 | 已守卫（`tests/preview-link.test.ts` + `tests/downloader.test.ts` 重定向复检 + `tests/boundaries.test.ts` 禁止第二份判据） |
| `.part` 已满 + `Range` → 416 必死 | P1 | `tests/downloader.test.ts`：part 长度=总长 + 上游 416 → 任务 done | 已守卫（`tests/downloader.test.ts`「.part 已完整 + 上游 416 → 按完成收尾」） |
| `t.note` 永不清除 → toast 风暴 | P1 | 断言"`resume()` 后 `note` 为空" + 渲染侧同 note 去重 | 已守卫（`tests/downloader.test.ts` 续链成功只发一条 note） |
| `pause()` 不接受 `queued` → 「全部暂停」暂停不了排队任务 | P1 | `tests/downloader.test.ts`：pause 一行 queued | 已守卫（`tests/downloader.test.ts`「pause 接受 queued」） |
| DASH 字节账把音频轨算进 `received` | P2 | 断言 `done` 行 `bytes` = 落盘文件大小 | 已守卫（`tests/downloader.test.ts`） |
| 主窗口缺 `will-navigate` | P2 | 源码扫描：每个 `new BrowserWindow` 附近必须有导航守卫 | 已守卫（`tests/boundaries.test.ts`「窗口导航守卫」） |
| `history:list` 无兜底 parse | P2 | 坏 JSON 行 → 返回其余行而非整页失败 | 已守卫（`tests/history-pagination.test.ts`） |
| `settings:set` 29 条分支无守门测试 | P2 | 比对 schema 键集合 ⊇ handler 分支集合 | 已守卫（`tests/contract.test.ts`「settings:set 字段覆盖守卫」） |
| `fetch-binaries.cjs` 的 `--soft` / 严格退出码分界无守卫（原测试于 `962a3c8` 删除，ARCHITECTURE §7 仍宣称有） | P2 | 补真子进程退出码用例，或改掉文档那句声明 | 已守卫（`tests/binaries-fetch.test.ts`，7 例） |
| 设置页「保存」把即时开关打回旧值 | P2 | 保存载荷剔除开关表与 Cookie 草稿 | 已守卫（`tests/settings-patch.test.ts`） |
| 任意 Cookie 键可经 `kernel_config` 指向 `YTDLP_BIN` / `FFMPEG_BIN` | P2 | 契约只认 `shared/secret-keys.ts` 登记键 + handler 二次判定 | 已守卫（`tests/contract.test.ts`） |
| `buildImageSrc` 回落放行内网 http(s) | P2 | 只放行 `data:`，其余交代理或返回 `null` | 已守卫（`tests/preview-link.test.ts`） |
| `queue.json` 重复 `taskId` 让首启迁移永久失败 | P2 | 迁移前按 `taskId` 去重（保留最新） | 已守卫（`tests/storage-migration.test.ts`） |
| 续链提示重复弹 | P1 | 同 §3-G「事件驱动不放大」 | 已登记 |

> 状态只有三种：**待修 / 已守卫（附测试文件与用例名）/ 接受风险（写明理由与复审日期）**。不许留"以后再说"。

---

## 7. 能自动化的不要靠人眼

人眼应该花在"该不该这么做"上，而不是"有没有漏一行"。以下按性价比排序，前三条建议尽快落地：

1. **`settings:set` 键集合守门** —— 比对 `ipc-contract.ts` 的 schema 键与 `ipc.ts` 的 `patch.*` 分支。当前 29 条一个不缺，但新增设置项漏写一行会"校验通过、界面显示已保存、实际不落盘"。
2. **`will-navigate` 扫描守卫** —— 本仓已有 `boundaries.test.ts` 这种按文件生成用例的范式，加一条"含 `new BrowserWindow` 的文件必须出现导航守卫"。
3. **URL 闸门单源断言** —— `tests/boundaries.test.ts` 里禁止 `electron/` 出现第二份私网判据（`startsWith("fc")` 之类字面量）。
4. **PR 模板必填校验** —— 用 `actions/github-script` 检查 PR 描述里"自验档位"至少勾一项；不勾则 fail。防止模板退化成装饰。
5. **commit 前缀校验** —— 已有 commitlint；可加一条"`fix`/`feat` 类提交必须关联 issue 或 PR"。

**不要做的自动化**：按评论条数、按审查时长、按"P1 数量"考核任何人。指标一旦成为目标就不再是指标——结果是审查变成走过场，问题被降级成 P3。

---

## 8. 度量（只测三件事）

| 指标 | 怎么算 | 健康信号 |
|---|---|---|
| **P1 逃逸数** | 合并后才发现、且本可被 §3 清单抓住的 P0/P1 | 趋近 0；连续两次同类逃逸 = 清单缺条目，回 §6 |
| **回退率** | 合并后 7 天内被 revert 或热修的比例 | <5% |
| **审查滞后** | PR 打开到首次实质性意见的时长 | 单人期 <1 天，多人期 <4 小时 |

**不测**：评论数量、代码行数、审查轮次（轮次多往往是设计没对齐，该测的是设计阶段，不是审查阶段）。

---

## 9. 落地清单（这份标准要生效，还缺这些）

| 项 | 状态 | 说明 |
|---|---|---|
| 本文档 | ✅ | 标准与流程 |
| `.github/pull_request_template.md` | ✅ | 作者自验 + 审查重点，必填 |
| `docs/TESTING.md` 交叉引用 | ✅ | 档位定义留在那边，不复制 |
| `AGENTS.md` 索引 | ✅ | 入口可达，否则文档会腐烂 |
| `.github/CODEOWNERS` | ⬜ | 多人期再建；按 §2 的"改动面 → 审阅者"填，示例见下 |
| PR 模板必填校验（CI） | ⬜ | §7 第 4 条 |
| 三条新守卫测试 | ✅ | §7 第 1–3 条：`contract.test.ts` 字段覆盖、`boundaries.test.ts` 导航守卫与 URL 闸门单源 |

CODEOWNERS 示例（把人名换成实际 GitHub 账号）：

```
# 契约与边界：改动需契约负责人复核
/types/                    @contract-owner
/electron/main/ipc.ts      @contract-owner
/electron/preload/         @contract-owner

# 安全面
/shared/preview-link.ts    @security-owner
/electron/main/index.ts    @security-owner
/electron/main/cookie-login.ts @security-owner

# 真源
/shared/platforms.ts       @registry-owner
/brand/                    @brand-owner
```

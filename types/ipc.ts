/**
 * IPC 契约 —— renderer 与 main 的唯一共享类型真源。
 *
 * 依据 docs/ARCHITECTURE.md §1 硬约束 3 与 §8：跨进程类型放这里（types/ipc.ts），
 * `ParseResult` 结构镜像 mediaGet `normalize-result` 的输出契约
 * （源：mediaGet/src/types/api.ts 的 ApiResponse/ParseData，此处注明镜像来源，
 * 不 import Next 工程）。
 *
 * 2026-10-14 单一真源改造（对标 Motrix v2 的 Zod 契约层）：payload 的**形状**只在
 * `types/ipc-contract.ts` 用 zod 声明一次，本文件以 `import type` + `z.infer` 派生。
 * 「加一个字段」由此前四处联动（interface + 主进程 schema + preload + bridge，
 * 且两份描述会各自漂移）收敛成改 ipc-contract 一处。
 *
 * `import type` 是硬要求，不是风格：本文件必须零运行时，否则 zod 会被卷进 renderer 包。
 */
import type { z } from "zod";
import type {
  AppMetaSchema,
  AppSettingsSchema,
  AuthorSnapshotSchema,
  BinaryStatusReportSchema,
  BinaryStatusViewSchema,
  CacheClearResultSchema,
  CacheItemSchema,
  CacheStatusSchema,
  ClearTasksInputSchema,
  ClearTasksResultSchema,
  CookieLoginInputSchema,
  CookieLoginResultSchema,
  DownloadItemSchema,
  DownloadTaskViewSchema,
  EngineHealthSchema,
  EnqueueInputSchema,
  EnqueueOutcomeSchema,
  HistoryEntrySchema,
  HistoryFilterSchema,
  HistoryKeysInputSchema,
  HistoryKeysPageSchema,
  HistoryPageSchema,
  HistoryCursorSchema,
  HistoryRemoveResultSchema,
  HistoryRemoveInputSchema,
  IdentifyInputSchema,
  IdentifyOutcomeSchema,
  ParseDataSchema,
  ParseInputSchema,
  ParseResultSchema,
  ParseRunOutcomeSchema,
  ParsedVideoItemSchema,
  ParsedVideoQualitySchema,
  PersistedQueueTaskSchema,
  QueueCursorSchema,
  QueueFilterSchema,
  QueuePageSchema,
  StatsDateRangeSchema,
  StatsQueryResultSchema,
  UpdateStateSchema,
  WorkStatSchema,
} from "./ipc-contract";

// ————————————————————————————————————————————————
// 镜像自 mediaGet src/types/api.ts（单一真源在上游，此处仅镜像消费）
// ————————————————————————————————————————————————

/** 单个清晰度直链（bilibili / youtube 等） */
export type ParsedVideoQuality = z.infer<typeof ParsedVideoQualitySchema>;

/** 多分P / 多清晰度视频项 */
export type ParsedVideoItem = z.infer<typeof ParsedVideoItemSchema>;

/** 统一解析数据结构（normalize-result 归一化后的 data 契约） */
export type ParseData = z.infer<typeof ParseDataSchema>;

/** 统一解析响应（IPC `parse:run` 的 data 载荷，与解析内核输出同构） */
export type ParseResult = z.infer<typeof ParseResultSchema>;

// ————————————————————————————————————————————————
// IPC 信封（ARCHITECTURE §3：所有 invoke 返回统一信封）
// ————————————————————————————————————————————————

export type InvokeOk<T> = { ok: true; data: T };
export type InvokeErr = {
  ok: false;
  error: { code: string; message: string; failType?: string };
};
export type InvokeResult<T> = InvokeOk<T> | InvokeErr;

// ————————————————————————————————————————————————
// 架构版本：跨进程契约的演进号（设置→关于 展示）。
// 通道集合增删或载荷形状不兼容变更时递增；纯新增可选字段不升。
// v2：新增 app:listFonts 通道；fontFamily 由枚举改为自由字体名（旧枚举值仍为合法字符串，
//     但不保证本机存在 → 回落，故按不兼容载荷形状变更升版）。
// v3：新增 app:cacheStatus / app:cacheClear / app:openLogDir / app:log 四条通道
//     （设置字段 logLevel、logRetentionDays 是纯新增可选键，不额外构成不兼容）。
// v4：新增 download:clear 通道（队列卫生：把终态行移出队列与落盘档），并改判重启恢复
//     语义 —— canceled 不再复活。落盘队列由此前的「只增不减」变成有上限、可清空。
// v5：新增 stats:get 通道（统计页：生命周期计数器快照，来自 userData/stats.json）。
//     同时 history 窗口 500 → 5000（`history:list` 的 limit 上界随之放宽，载荷形状不变）。
//     升号的理由是**通道集合增了**，不是存档形状变了：旧 stats.json 读不进来时按空档起算。
// v6：平台清单的真源从内核 PLATFORM_INFO 移到本仓 `shared/platforms.ts`（业主定调：parse-core 只是
//     引擎之一，「有哪些平台、提不提供」归本仓注册表 + 开关决定）。载荷侧两条不兼容变更：
//     `app:getMeta` 去掉 `platforms`（两进程改为 import 同一模块，不再过 IPC 复制一张表），
//     `settings` 新增 `platformSwitches`（每平台 enabled 覆盖，缺省跟随注册表默认）。
// v7：新增两条通道 `history:remove`（历史多选删除：行键 = 条目 id 或 groupId，出参直接回剩余列表）与
//     `app:openExternal`（结果卡「在浏览器打开」，scheme 白名单只放 http/https）。
//     `settings` 另加两键 `filenamePreset` / `filenameExtra`（下载文件名主体与追加开关）。
//     升号理由与 v5 同一条：通道集合增了。两把新键都有缺省值，旧存档读进来按 v7 解释不会缺字段。
// v8：`HistoryEntry` 的含义从「一次落地文件」变成「一条解析记录」（业主指令 2026-10-17）。
//     zod 形状一个字没改（`files` 一直是数组、可为空），改的是谁在写它：主进程在 parse:run
//     成功时就写一行，`files: []` = 解析过但没下载；`groupId` 现在是可复算的作品键
//     （`shared/history.ts` 的 workKeyOf），同一作品的解析行与下载行靠它聚成历史页的一行。
//     形状兼容但口径变了，所以必须升号：拿 v7 的解释读 v8 的档，统计页的「文件数」会把
//     0 文件的解析行也数成一个文件 —— 数值错，界面上没有任何异常。旧档（每行都有文件）反过来读
//     成新口径不受影响，不需要迁移。
// v9：删掉 `history:clear` 整条通道（业主指令 2026-10-17：历史页不再有「清空历史」按钮）。
//     全清改走 `history:remove`（表头全选 → 移除记录），它的 `keys` 上限 5000 = `HISTORY_MAX`，
//     一次点得掉整张表，不必留第二条语义重复的通道。升号理由与 v5/v7 同一条：**通道集合变了**
//     （存档形状没变，清空与移除落到的结果本来一样，旧档不需要迁移）。
// v10：`HistoryEntry` 新增三个可选键 `publishedAt` / `stat` / `author.videoCount`（业主指令
//     2026-10-17：导出的信息要完整——发布时间、点赞评论收藏、作者主页与粉丝量）。通道集合没变，
//     但载荷形状变了，按 v6/v7 那条口径必须升号：不升号就等于让「有没有这列数据」变成不可见的
//     运气。旧记录三个键都缺 → 导出这几格留空（`loadHistory` 没有迁移机制，缺字段在契约层合法），
//     想要就把那几条选中点「重新解析」，解析行按作品键覆盖那一条，字段自己就补上了。
// v11：新增 `app:copyText`（复制动作改由主进程代发）。**这条通道的存在本身就是一处修复**：
//     主进程 `index.ts` 装了「所有权限请求一律拒」的 `setPermissionRequestHandler`，而 Chromium 的
//     `navigator.clipboard.writeText` 要过那条钩子（Electron 把写也报成 `clipboard-read`），
//     于是渲染层三处复制在真应用里**全部** reject NotAllowedError —— 队列页与结果卡那两处连
//     catch 都没有，就成了「点了没反应」。实机探针证据、两条路线的取舍与「为什么不能只放行写」
//     记在 docs/UIUX-HANDOFF.md §6。升号理由与 v5/v7/v9 同一条：通道集合变了。存档形状没动，
//     旧档不需要迁移。
// v12：`DownloadTaskView` 新增可选键 `note`（业主指令 2026-10-17：直链过期这类情况静默重试）。
//     下载遇到 HTTP 403 时主进程自动重新取一次链并就地重试，`note` 就是队列那一行给出的
//     「已自动重新取链」说明——它是**解释**而不是状态，成功与否照旧走 `status`/`error`。
//     通道集合没变，但出参形状变了，按 v6/v7/v10 那条口径必须升号：不升号，旧版界面读到
//     带 `note` 的载荷时既不会显示也不会报错，用户永远不知道这一行为什么自己动过。
//     旧档不受影响（队列快照 `PersistedQueueTask` 没带这个键，重启后说明自然消失）。
// v13：队列快照 `PersistedQueueTask` 新增三个可选键 `filePath` / `error` / `finishedAt`，语义从
//     「只记没干完的活」改成**进过队列的行全部留档**（业主指令 2026-10-17：重启开发服务器之后
//     之前的下载队列记录消失了）。旧实现 `snapshot()` 滤掉 done、`restore()` 跳过 done 与
//     canceled（v4 定的「落地目录才是真源」「作废行不该每次回来占位」），两条一并推翻并就地标注。
//     没有这三个键，重启后的「已完成」行是**坏的**而不是少一列：「打开所在文件夹」「复制文件路径」
//     都按 `status === "done" && filePath` 渲染，缺 filePath 就整项消失；缺 error 则是一条不知道为什么
//     失败的「失败」。通道集合没变，但档内形状变了，按 v6/v7/v10/v12 同一条口径升号。
//     旧档不需要迁移（三个键都可选，缺就是空）；done 行的 `url` 落盘时剥成空串，见契约注释。
// v14：`ParseData` 镜像随内核 1.0.0 补齐 14 个字段（`source` / `favorite` / `reply` / `share` /
//     `playCount` / `likeCount` / `commentCount` / `shareCount` / `collectionCount` / `durationFormat` /
//     `noteId` / `ipRegion` / `verifiedReason` / `statusesCount`），`ParsedVideoItem` 补 3 个
//     （`qualityLabel` / `video_url` / `pic`）。通道集合没变、线形也没变（ParseData 是 passthrough，
//     这些键本来就在内核载荷里），但**声明面**变了：引擎出口的类型收拢从此把它们当契约字段处理。
//     按 v6/v7/v10/v12 那条口径升号，别让「收没收到类型」变成不可见的运气。
// v15：移除线上回落（业主指令 2026-10-18）。设置里删 `fallbackOnline` / `onlineApiBase`，
//     `ParseRunOutcome` 删 `fallbackReason`、`via` 收窄成 local|mock，`ParseInput.forceOnline`
//     改成语义更准的 `skipCache`（它此前一半职责是「别选本地引擎」，线上引擎没了只剩跳缓存）。
//     通道集合没变、载荷形状变了，按 v6/v7/v10/v12/v13 同一条口径升号。旧 config.json 里那两个
//     键会被 zod 丢键忽略，不需要迁移；旧 stats.json 的 `parse.online` 保留原值、不再增长。
// v16：`ParseRunOutcome` 新增可选键 `sourceUrl`（业主指令 2026-10-18：来源应当是真实资源链接，
//     不是分享短链）。主进程在解析成功后把短链跟到最终页面（或由作品 ID 拼官方页），首页拿它
//     写下载 meta、主进程拿它写历史，三处从同一条真实链接算作品键。通道集合没变，载荷形状变了，
//     按 v6/v7/v10/v12/v13 同一条口径升号；旧历史行里的短链不回溯改写（跟跳要联网，读档时不做）。
// v17：队列快照 `PersistedQueueTask` 新增可选键 `speed`（业主指令 2026-10-18：暂停时保留当时的速度
//     与剩余时间）。`DownloadTaskView.speed` 的语义就地扩一档：paused 行里它是**暂停那一刻的快照**，
//     主进程 `pause()` 不再清、`resume()` 才清；只有 paused 行把它写进 queue.json，重启后照样说得清
//     「当时多快」。完成行的平均速度没有占这个键（界面按 `received ÷ (finishedAt − createdAt)` 算，
//     与统计页 `elapsedMs` 同一把尺），所以 done 行仍是 0。通道集合没变，档内形状变了，
//     按 v6/v7/v10/v12/v13 同一条口径升号；旧档缺这个键 → 暂停行显示「—」，不需要迁移。
// v18：完成行的平均速度改口径（业主追问 2026-10-18「暂停一段时间再下载，计算速度的逻辑就有问题」）。
//     `DownloadTaskView` / `PersistedQueueTask` 新增 `transferMs`（实际传输时长）与 `transferBytes`
//     （这段时长里收到的字节），平均速度 = transferBytes ÷ transferMs；暂停、排队、重试退避、
//     首字节等待都不进分母。**v17 那条「按 received ÷ (finishedAt − createdAt) 算」作废** ——
//     分母是墙钟时间，暂停一小时就把速度稀释成另一个数。旧档缺这两个键 → 完成行显示「—」。
//     同一口径同步给统计：`stats.done` 的 elapsedMs 改传 transferMs（只有整段都被测到的下载才进样本）。
//     通道集合没变，载荷形状变了，按 v6/v7/v10/v12/v13/v17 同一条口径升号。
// v19：新增 `settings:cookieLogin`（设置页打开登录页、登录后自动抓 Cookie，业主指令 2026-10-19）。
//     入参只收四个受支持的键，出参只有 `{ captured, reason }`——**值不回渲染层**，
//     与 settings:get 的 "***" 掩码同一条隐私契约。通道集合变了，按 v6 起同一条口径升号。
// v20：统一 SQLite 存储（2026-10-20）。`stats:get` 新增可选日期区间入参，带区间时出参是
//     `StatsQueryResult`（事件账本聚合），不带时仍是旧 `StatsSnapshot`（兼容旧 UI，Task 7 后移除）。
//     通道集合没变、载荷形状新增一档，按 v6 起同一条口径升号。
// v21：历史改为服务端分页（2026-10-21）。`history:list` 出参由 `HistoryEntry[]` 变成
//     `HistoryPage { rows, nextCursor }`（按作品分组、组不跨页）；新增 `history:keys` 供
//     跨页选择；`history:remove` 出参由「剩余列表」变成 `{ removed }`。通道集合增了一条，
//     两条既有通道载荷形状不兼容，升号。
// v22：队列改为服务端分页（2026-10-21）。`download:list` 入参新增状态/平台/搜索/日期/游标，
//     出参由 `DownloadTaskView[]` 变成 `QueuePage { rows, nextCursor }`。分页单位是作品组：
//     组行的聚合必须由整组算出，页边界不允许切开一个作品。通道集合没变，载荷形状不兼容，升号。
// v23：统计只认事件账本（2026-10-21）。`stats:get` 的日期区间由可选改为**必填**，出参固定为
//     `StatsQueryResult`；v20 的兼容分支（无区间 → `StatsSnapshot`）删除。`StatsSnapshot` 与
//     三个桶 schema 一并下线 —— 它们描述的是 stats.json 的落盘形状，而该文件已只由迁移读取。
//     通道集合没变，载荷形状收窄，按 v6 起同一条口径升号；旧 UI 拿不到快照会显式报 bad-input，
//     这正是想要的失败方式（不再两条口径并存、各算一套数）。
// v24：统计作者榜带头像（业主指令 2026-10-21「作者 · 解析与下载前加上作者的头像」）。
//     `StatsQueryResult.authors` 行新增可选键 `avatar`——主进程聚合作者时本来就 join 了
//     `history_entries` 的作者快照，顺带取出即可；旧档无此键（可选，缺就是首字占位）。
//     通道集合没变，载荷形状变了，按 v6 起同一条口径升号。
// ————————————————————————————————————————————————

// v25：文件命名预设加两档（业主指令 2026-10-21「文件命名能加更多组合选项吗」）。
//     `filenamePreset` 枚举新增 `titleAuthorUnderscore`（标题_作者）与 `authorTitleDate`
//     （作者 - 标题_日期）。通道集合没变、枚举收宽，按 v6 起同一条口径升号；
//     旧档里的旧值仍是合法枚举成员，读进来不需要迁移。
// v26：命名预设的连接符统一为下划线（业主指令 2026-10-21「中间的连加符统一用 _」）。
//     `authorTitle` / `titleAuthor` / `authorTitleDate` 的空格连字符一律改 `_`；
//     v25 的 `titleAuthorUnderscore` 因此与 `titleAuthor` 重复，枚举收窄删档（未随任何发布出去）。
//     存过该值的 dev 档由仓储读档口归一到 `titleAuthor`（repositories.ts），不会卡死设置加载。
// v27：体检行报「实际用的引擎」（业主指令 2026-10-21「通道内改为实际使用的解析引擎，如
//     mediaget，dlp 等」）。`EngineHealth` 新增必填 `engines: string[]`——选路顺序下真正能解
//     该平台的引擎名（mediaget / yt-dlp…），空数组 = 今天没有引擎声明可解。通道集合没变，
//     载荷形状变了，按 v6 起同一条口径升号；界面与 mock 桥同步消费该字段。
// v28：解析出参报引擎归属（业主指令 2026-10-21，引擎注册制铺垫，第二个引擎接入当天生效）。
//     `ParseRunOutcome` 新增可选 `viaEngine`（parseCore / ytdlp / mock），与选路注册表
//     （平台 `enginePriority` 覆盖全局声明顺序）、stats_events 的 engine 列（DB 迁移 v4）
//     同一套口径。通道集合没变、载荷形状收宽（可选键），按 v6 起同一条口径升号；
//     旧档与旧调用方缺该键按「未知引擎」处理，不需要迁移。
// v29：`ParseRunOutcome.viaEngine` 枚举补登记 `amagi`。v28 落枚举时 amagi 已在场却没进
//     去（parseCore / ytdlp / mock），dev 档 validateOutputs 会把 amagi 解出的答复判成
//     contract-drift。枚举收宽（多收一个值），通道集合与既有载荷不变，按 v6 起同一条
//     口径升号；旧档缺该键按「未知引擎」处理，不需要迁移。
// v30：`settings` 新增 `engineSwitches`（2026-10-21 业主指令「设置-引擎页加引擎开关」）：
//     引擎这一层的「供不供」，与 `platformSwitches` 同一套语义（缺键 = 开，关掉的引擎
//     在主进程选路与体检里都不再出现）。载荷形状变了（新增必填键，旧档由 DEFAULT_SETTINGS
//     兜底为空表），按 v6/v7 同一条口径升号。
// v32：`ParseRunOutcome` 新增 `attempts`（2026-10-21 业主指令「你需要知道各个引擎的失败原因」）：
//     按顺序记录这一轮真调用过的引擎与各自答复（成功/失败码、失败原因、failType）。
//     回退不再只有一个结论，用户与排查都能看到「amagi 为什么没解出来」。新增可选键，
//     旧渲染层忽略即可；缓存命中/mock 兜底没有进选路，该键缺省。
// v31：通道改「主引擎」下拉（2026-10-21 业主指令）——`settings` 新增 `platformEngines`
//     （每平台先试哪个引擎，缺键 = mediaget）与 `engineFallback`（主引擎失败是否回退，
//     缺省 true）；`EngineHealth` 新增 `engineIds`（与 `engines` 一一对应，下拉的选项值）。
//     载荷形状变了（设置两把必填键 + 体检行一把必填键），按 v6/v7 同一条口径升号；
//     旧档由 DEFAULT_SETTINGS 兜底，不需要迁移。
// v33：DASH 双轨一律合流（业主指令 2026-10-21「预览和下载都是需要完整的视频，保证视频和
//     音频都是融合的」）：`DownloadItem` 与队列快照行新增可选 `audioUrl`——主链是 DASH 视频轨
//     时，下载器必须把音频轨并进来再落盘，交付的本身就是音画完整的文件（不再额外产「仅音频」
//     那条独立下载项）。预览侧已按同一条规则合流（`electron/main/media-merge.ts`，两处共用
//     同一份 ffmpeg 内核）。新增可选键，旧的单流行缺它按「无音轨」处理，不需要迁移；但渲染层
//     与主进程必须是同一版，否则会退回无声视频，所以照 v6 起的同一条口径升号。
// v34：新增 `app:readClipboard`（2026-10-21 业主指令「首页清除按钮：有内容时是清除，无内容时是
//     粘贴」）：渲染层的 `navigator.clipboard.readText` 与 `writeText` 被主进程那条「所有权限
//     一律拒」同时挡死（Electron 把读写都报成 `clipboard-read`），要读剪贴板只能由主进程代读。
//     新增通道 + 出参 `{ text }`，通道集合变了，按 v6 起同一条口径升号。
// v35：双轨 DASH 预览改「边缓存边播」（2026-10-23 业主定调「凡是 dash 流都需要做到一边缓存
//     一边播放，而不是等到全部合流完」）：`ParseData` 新增 `videoCodecs`/`videoMimeType`
//     （主链）、`audioCodecs`/`audioMimeType`（音轨），`ParsedVideoQuality` 新增
//     `codecs`/`mimeType`——渲染层建 MSE SourceBuffer 需要精确的 codec 串。全部可选，缺键
//     （内核、单文件源）按「预览走合流回退」处理，不需要迁移；但渲染层/主进程必须同版，
//     否则新的预览入口拿不到 codec 会静默退回慢路径，照 v6 起同一条口径升号。
// v36：一个分 P 就是一份独立资源（业主指令 2026-10-23「对于分p的应该是一个分p就是一个资源」）：
//     `ParsedVideoItem` 新增 `audioUrl` 与 `videoCodecs`/`videoMimeType`/`audioCodecs`/`audioMimeType`
//     ——DASH 引擎的分 P 条目此前只有视频轨，下载器拿不到这一 P 自己的音轨，交付的就是无声文件
//     （v33「一律合流」的前提是音画出自同一次取流，顶层那条音轨配到别的 P 上更糟）；
//     `ParsedVideoItem` 与 `ParseData` 各新增 `page`（第几 P）：某一 P 取流失败会整条缺席，
//     数组下标随之前移，靠下标报「分 P 2」会把名字贴到第三 P 上，主链不带 P 号则 P1/P2 同名。
//     全部可选，内核（渐进式单文件）与单 P 稿件缺键按旧行为处理，不需要迁移；但渲染层与主进程
//     必须同版——旧渲染层读不到 `page` 会把分 P 编号写错，照 v6 起同一条口径升号。
export const CONTRACT_VERSION = 36;

// ————————————————————————————————————————————————
// channel 常量（preload/main/renderer 三方共用字面量，禁止散落拼写）
// ————————————————————————————————————————————————

export const IPC = {
  appGetMeta: "app:getMeta",
  parseIdentify: "parse:identify",
  parseRun: "parse:run",
  downloadEnqueue: "download:enqueue",
  downloadCancel: "download:cancel",
  downloadPause: "download:pause",
  downloadResume: "download:resume",
  downloadList: "download:list",
  downloadClear: "download:clear",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsCookieLogin: "settings:cookieLogin",
  historyList: "history:list",
  historyKeys: "history:keys",
  historyRemove: "history:remove",
  probeEngines: "probe:engines",
  appGetBinaryStatus: "app:getBinaryStatus",
  appPickDownloadDir: "app:pickDownloadDir",
  appShowInFolder: "app:showInFolder",
  appListFonts: "app:listFonts",
  appCacheStatus: "app:cacheStatus",
  appCacheClear: "app:cacheClear",
  appOpenLogDir: "app:openLogDir",
  appLog: "app:log",
  appOpenExternal: "app:openExternal",
  appCopyText: "app:copyText",
  appReadClipboard: "app:readClipboard",
  statsGet: "stats:get",
  updateGetState: "update:state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updatePause: "update:pause",
  updateResume: "update:resume",
  updateCancel: "update:cancel",
  updateInstall: "update:install",
  // main → renderer 事件
  evDownloadProgress: "download:progress",
  evDownloadDone: "download:done",
  evDownloadError: "download:error",
  evUpdateState: "app:updateState",
  evClipboardLink: "app:clipboardLink",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ————————————————————————————————————————————————
// 各 channel 的入参 / 出参（形状真源 = types/ipc-contract.ts）
// ————————————————————————————————————————————————

/** app:getMeta */
export type AppMeta = z.infer<typeof AppMetaSchema>;

/** parse:identify */
export type IdentifyInput = z.infer<typeof IdentifyInputSchema>;
export type IdentifyOutcome = z.infer<typeof IdentifyOutcomeSchema>;

/** parse:run */
export type ParseInput = z.infer<typeof ParseInputSchema>;
/** parse:run 返回：归一化结果 + 来源标记（本地内核 / mock） */
export type ParseRunOutcome = z.infer<typeof ParseRunOutcomeSchema>;

/** download:enqueue */
export type DownloadItem = z.infer<typeof DownloadItemSchema>;
export type EnqueueInput = z.infer<typeof EnqueueInputSchema>;
export type EnqueueOutcome = z.infer<typeof EnqueueOutcomeSchema>;

/** 作者快照（解析那一刻的公开信息，随任务/历史透传） */
export type AuthorSnapshot = z.infer<typeof AuthorSnapshotSchema>;

/** 作品计数快照（解析那一刻的公开互动数；档位与来源归一见 shared/work-stat.ts） */
export type WorkStat = z.infer<typeof WorkStatSchema>;

export type DownloadStatus = z.infer<typeof PersistedQueueTaskSchema>["status"];

/** 队列持久化条目（重启恢复；queueRepository 与 downloader.ts 共用） */
export type PersistedQueueTask = z.infer<typeof PersistedQueueTaskSchema>;

/** download:progress 事件 / download:list 项 */
export type DownloadTaskView = z.infer<typeof DownloadTaskViewSchema>;

/** download:list —— 服务端筛选 + 按作品组游标分页 */
export type QueueFilter = z.infer<typeof QueueFilterSchema>;
export type QueueCursor = z.infer<typeof QueueCursorSchema>;
export type QueuePage = z.infer<typeof QueuePageSchema>;

/** download:clear —— 点名移除 + 实际移除条数 */
export type ClearTasksInput = z.infer<typeof ClearTasksInputSchema>;
export type ClearTasksResult = z.infer<typeof ClearTasksResultSchema>;

/** settings:get / settings:set —— 部分字段 set，返回全量生效配置 */
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/** settings:cookieLogin —— 入参只有键名，出参只有「抓到没有」；值留在主进程 */
export type CookieLoginInput = z.infer<typeof CookieLoginInputSchema>;
export type CookieLoginResult = z.infer<typeof CookieLoginResultSchema>;

/** 文件日志级别（写 userData/logs/app.log 的门槛）；off = 一行都不落 */
export type LogLevel = AppSettings["logLevel"];

/** 日志写入等级（渲染层转发用）：off 不是「写一条」而是「不写」，故不在候选里 */
export type LogSeverity = Exclude<LogLevel, "off">;

export const DEFAULT_SETTINGS: AppSettings = {
  downloadDir: "",
  maxConcurrent: 3,
  cookies: {},
  throttleMs: 0,
  minimizeToTray: true,
  launchAtLogin: false,
  proxyMode: "system",
  proxyUrl: "",
  theme: "system",
  themeStyle: "azure",
  fontSizePx: 13,
  fontFamily: "system",
  openFolderOnDone: false,
  retryTimes: 1,
  defaultQuality: "main",
  filenamePreset: "title",
  filenameExtra: { quality: true, index: true },
  keepPartials: false,
  notifyOnDone: true,
  notifyOnError: true,
  clipboardWatch: false,
  logLevel: "info",
  logRetentionDays: 30,
  updateOnStartup: true,
  updateAutoDownload: false,
  // 只存用户改过的平台；没改过的跟随注册表 enabledByDefault，
  // 于是内核加一个平台不需要写迁移就能出现在界面上
  platformSwitches: {},
  // 引擎开关：缺省全开；只存用户关掉的那几项（与平台开关同一套「缺键 = 默认」语义）
  engineSwitches: {},
  // 平台主引擎：只存用户改过的平台；缺键 = mediaget（DEFAULT_PRIMARY_ENGINE）
  platformEngines: {},
  // 主引擎失败后是否回退其余可用引擎（缺省开：多一个引擎多一次机会）
  engineFallback: true,
};

/** history:list */
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryFilter = z.infer<typeof HistoryFilterSchema>;
export type HistoryCursor = z.infer<typeof HistoryCursorSchema>;
export type HistoryPage = z.infer<typeof HistoryPageSchema>;
export type HistoryKeysFilter = z.infer<typeof HistoryKeysInputSchema>;
export type HistoryKeysPage = z.infer<typeof HistoryKeysPageSchema>;
export type HistoryRemoveResult = z.infer<typeof HistoryRemoveResultSchema>;
/** history:remove */
export type HistoryRemoveInput = z.infer<typeof HistoryRemoveInputSchema>;

/** probe:engines —— 本地版体检 */
export type EngineHealth = z.infer<typeof EngineHealthSchema>;

// ————————————————————————————————————————————————
// 随包二进制（yt-dlp / ffmpeg）完整性汇报
// ————————————————————————————————————————————————

/**
 * 单个二进制的运行时状态。
 *
 * `integrity` 是「降级可见」的关键字段：`degraded` 表示**没有**完整性基线
 * （dev 自备 / 旧包未带 manifest），此时只定位不校验 —— 不假装有防护。
 * 设置页应把它如实展示，而不是只显示「可用」。
 */
export type BinaryStatusView = z.infer<typeof BinaryStatusViewSchema>;

/** app:getBinaryStatus 返回 */
export type BinaryStatusReport = z.infer<typeof BinaryStatusReportSchema>;

// ————————————————————————————————————————————————
// 本地缓存 / 日志占用（设置→通用）
// ————————————————————————————————————————————————

/** 占用项键：net=内核 HTTP 缓存 / update=更新包缓存 / partials=断点文件 / junk=残档 / logs=日志 / records=本机记录 */
export type CacheItemKey = z.infer<typeof CacheItemSchema>["key"];

/** 单项占用（键 → 中文文案的映射在渲染层，主进程只出数字） */
export type CacheItem = z.infer<typeof CacheItemSchema>;

/** app:cacheStatus 返回：扫描当下的字节快照（按项拆分，renderer 只做展示与键→文案映射） */
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

/** app:cacheClear 返回：释放字节数 + 被拒的项 + 清理后的快照 */
export type CacheClearResult = z.infer<typeof CacheClearResultSchema>;

// ————————————————————————————————————————————————
// 自动更新（P6）—— 主进程状态机收敛成一个可渲染快照
// ————————————————————————————————————————————————

export type UpdatePhase = z.infer<typeof UpdateStateSchema>["phase"];

/** update:state / update:check / update:download 返回，亦是 app:updateState 事件载荷 */
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export type StatsDateRange = z.infer<typeof StatsDateRangeSchema>;
export type StatsQueryResult = z.infer<typeof StatsQueryResultSchema>;

// ————————————————————————————————————————————————
// preload 暴露给 window.mg 的 API 面（contextBridge 白名单）
// ————————————————————————————————————————————————

export interface MgBridge {
  getMeta(): Promise<InvokeResult<AppMeta>>;
  identify(input: IdentifyInput): Promise<InvokeResult<IdentifyOutcome>>;
  parse(input: ParseInput): Promise<InvokeResult<ParseRunOutcome>>;
  download: {
    enqueue(input: EnqueueInput): Promise<InvokeResult<EnqueueOutcome>>;
    cancel(taskId: string): Promise<InvokeResult<{ ok: boolean }>>;
    pause(taskId: string): Promise<InvokeResult<{ ok: boolean }>>;
    resume(taskId: string): Promise<InvokeResult<{ ok: boolean }>>;
    list(filter?: QueueFilter): Promise<InvokeResult<QueuePage>>;
    /** 把终态行移出队列（活跃任务不会被删）：返回实际移除条数 */
    clear(taskIds: string[]): Promise<InvokeResult<ClearTasksResult>>;
    onProgress(cb: (t: DownloadTaskView) => void): () => void;
    onDone(cb: (t: DownloadTaskView) => void): () => void;
    onError(cb: (t: DownloadTaskView) => void): () => void;
  };
  settings: {
    get(): Promise<InvokeResult<AppSettings>>;
    set(patch: Partial<AppSettings>): Promise<InvokeResult<AppSettings>>;
    /** 打开登录窗口，登录后自动抓取并**在主进程落档**；值不回渲染层，只说抓到没有 */
    cookieLogin(input: CookieLoginInput): Promise<InvokeResult<CookieLoginResult>>;
  };
  history: {
    list(filter?: HistoryFilter): Promise<InvokeResult<HistoryPage>>;
    listKeys(filter?: HistoryKeysFilter): Promise<InvokeResult<HistoryKeysPage>>;
    /** 删除选中行键（id 或 work/group key），上限 5000 并由 UI 分批提交。 */
    remove(keys: string[]): Promise<InvokeResult<HistoryRemoveResult>>;
  };
  probe: {
    engines(): Promise<InvokeResult<EngineHealth[]>>;
  };
  /** 统计查询：事件账本按本机自然日范围聚合（首尾都含）。 */
  stats: {
    get(range: StatsDateRange): Promise<InvokeResult<StatsQueryResult>>;
  };
  app: {
    pickDownloadDir(): Promise<InvokeResult<string | null>>;
    showInFolder(path: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 随包二进制完整性状态（降级可见：degraded/rejected 要能被用户看到） */
    getBinaryStatus(): Promise<InvokeResult<BinaryStatusReport>>;
    /** 本机已安装字体 family 名（设置→外观→界面字体 可搜索下拉的数据源；主进程 font-list 枚举 + 缓存） */
    listFonts(): Promise<InvokeResult<string[]>>;
    /** 本地缓存/日志占用快照（扫描在用户点开「通用」时按需进行，不在启动时抢时间） */
    cacheStatus(): Promise<InvokeResult<CacheStatus>>;
    /** 只接受 clearable 的键；被拒的项（如已下载待安装的更新包）在 skipped 里如实返回 */
    clearCache(keys: CacheItemKey[]): Promise<InvokeResult<CacheClearResult>>;
    /** 在资源管理器打开日志目录（userData/logs） */
    openLogDir(): Promise<InvokeResult<{ ok: boolean }>>;
    /** 用系统默认浏览器打开外链（scheme 白名单 http/https；不抢焦点） */
    openExternal(url: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 复制文本到系统剪贴板（主进程代发：renderer 的 navigator.clipboard 被「所有权限一律拒」那条钩子挡死，见 CONTRACT_VERSION v11 注） */
    copyText(text: string): Promise<InvokeResult<{ ok: boolean }>>;
    /**
     * 读系统剪贴板文本（首页「粘贴」按钮用；同一条 deny-all 钩子也挡着 `readText`，理由见 v34 注）。
     * 没内容回空串——「剪贴板里没有东西」不是错误。
     */
    readClipboard(): Promise<InvokeResult<{ text: string }>>;
    /** 渲染层异常转发到文件日志（窗口崩溃外的另一条线索；级别不含 off） */
    log(level: LogSeverity, message: string): Promise<InvokeResult<{ ok: boolean }>>;
    /** 剪贴板监听命中分享链接（main 端已识别：url 有值时可直接填入输入面） */
    onClipboardLink(cb: (o: IdentifyOutcome) => void): () => void;
    /** 自动更新（P6）：state 是快照，check/download 返回迁移后的快照 */
    update: {
      state(): Promise<InvokeResult<UpdateState>>;
      check(): Promise<InvokeResult<UpdateState>>;
      download(): Promise<InvokeResult<UpdateState>>;
      /** 暂停进行中的更新包下载（cancel 传输令牌，进度冻结在弹窗显示值；恢复会从头重下）；返回迁移后快照 */
      pause(): Promise<InvokeResult<UpdateState>>;
      /** 继续下载：electron-updater 无断点续传，实为从头重下 */
      resume(): Promise<InvokeResult<UpdateState>>;
      /** 取消下载：cancel 令牌中断传输并清掉已下的 part，状态回落 available（可重新下载） */
      cancel(): Promise<InvokeResult<UpdateState>>;
      install(): Promise<InvokeResult<{ ok: boolean }>>;
      onState(cb: (s: UpdateState) => void): () => void;
    };
  };
}

declare global {
  interface Window {
    /** preload contextBridge 白名单 API（唯一渲染层入口） */
    mg?: MgBridge;
  }
}

# 更新日志

本文件由 `pnpm release` 按 commit 前缀生成；用户可见的变化请在此基础上补一句人话。

## [0.2.1](https://github.com/hotier/mediaGet-desktop/compare/v0.2.0...v0.2.1) (2026-10-21)

### 新增

* **build:** 发布产物增加 7z 绿色归档 ([398f99d](https://github.com/hotier/mediaGet-desktop/commit/398f99dd47a33667b5536d22e2b64ed7e40b3a57))

### 修复

* **build:** 补 app-builder-lib 在 pnpm 11 hoisted 布局下的依赖收集错误 ([2a32fda](https://github.com/hotier/mediaGet-desktop/commit/2a32fda84193b521969c9550ede887b0fac42991))
* **installer:** 安装日志只进细节列表，进度条下方留白，完成页去掉日志按钮 ([c251aec](https://github.com/hotier/mediaGet-desktop/commit/c251aec108a1a2d7f673052182f5527c1246b0e0))
* **settings:** 下线随包二进制状态区，精简各卡冗余说明与文案 ([886f3d2](https://github.com/hotier/mediaGet-desktop/commit/886f3d22399e1432afd9e98e28cdb8cf40417a47))
* **updater:** 打包后取不到 autoUpdater 导致永远无更新源 ([2ae47b7](https://github.com/hotier/mediaGet-desktop/commit/2ae47b79da414cf51faa0a0f21de02a932531e45))

## [0.2.0](https://github.com/hotier/mediaGet-desktop/compare/v0.1.0...v0.2.0) (2026-10-21)

### 新增

* **app:** 多引擎解析与下载预览链路，配置历史统计落 sqlite ([fad2601](https://github.com/hotier/mediaGet-desktop/commit/fad26017b489ce29d8b9b735f0f0ae0058ce0894))
* **brand:** 品牌母版入库，应用图标与字标统一由 make-icons 生成 ([44ed6e4](https://github.com/hotier/mediaGet-desktop/commit/44ed6e4483dbbbb9fc8c024fdfdb277742eb948e))
* **build:** 安装器可选目录/安装日志/品牌图，CI 收拢为可复用工作流 ([3b21457](https://github.com/hotier/mediaGet-desktop/commit/3b214576a0a829754bd10507786a29ff3a04348c))
* **landing:** 落地页重做版式并补齐用户协议/隐私政策/权利通知 ([2c0dd1f](https://github.com/hotier/mediaGet-desktop/commit/2c0dd1f869c7b37c99b8b2f5cfafc9a4110f6686))
* **landing:** 新增 Astro 落地页与 Pages 发布链——两档构建、产物自检、描线字标 ([2907681](https://github.com/hotier/mediaGet-desktop/commit/290768148c0ad00da834a19c0d740739b312ed69))
* **landing:** add changelog page generated from CHANGELOG.md, upgrade astro to 7 ([d4750d9](https://github.com/hotier/mediaGet-desktop/commit/d4750d929e57cceb9ebebddb51288cb537284e21))
* **shell:** 侧栏收起偏好的持久化纯函数 ([052d2f9](https://github.com/hotier/mediaGet-desktop/commit/052d2f93e809cea2918eb4280b09428e250c72bd))
* **shell:** 侧栏收起状态与品牌行切换按钮 ([4b95436](https://github.com/hotier/mediaGet-desktop/commit/4b95436e9fdac1865369ef9e23ec37cee64bf775))
* **shell:** 导航项与设置钮的收起态渲染 ([109b0e9](https://github.com/hotier/mediaGet-desktop/commit/109b0e9457f45dd4647fc0ea0ecd8d6d5ac199ab))
* **stats:** persist queryable statistical events ([6ff7198](https://github.com/hotier/mediaGet-desktop/commit/6ff7198282990c0b2ad1e505bcb10770baa2c5b3))
* **storage:** add sqlite database foundation ([f09a4f1](https://github.com/hotier/mediaGet-desktop/commit/f09a4f178506857d72249c1223591c7930896b88))
* **storage:** migrate json state into sqlite ([5796446](https://github.com/hotier/mediaGet-desktop/commit/579644650dc8f463527878fab1ec62b5ed7bb8ae))
* **storage:** page unlimited queue and history, scope stats by date range ([e386625](https://github.com/hotier/mediaGet-desktop/commit/e38662591c2bc71566d77d26e9bdc2180f246b06))

### 修复

* **shell:** 收起态品牌行按钮压缩与宽度过渡溢出 ([8bfcf91](https://github.com/hotier/mediaGet-desktop/commit/8bfcf91e504a01dcb50c201337e15da626a8a1d1))
* **shell:** start nav glyph animation on click, restore default icon motion, move settings back button down ([1036745](https://github.com/hotier/mediaGet-desktop/commit/10367458cc1de8798bc0e193a56268a130642dd3))

## 0.1.0 (2026-10-19)

首个版本：粘贴即解析 → 结果卡 → 一键入队下载 → 队列/历史/统计三页闭环。

### 新增

* **app:** 契约 v13→v19——移除线上回落、快手全链路、Cookie 登录、预览代理与作者卡片统一 ([b703434](https://github.com/hotier/mediaGet-desktop/commit/b7034348714f187431693a1602e8af42622f2ccd))
* **brand:** 品牌名统一改为 MediaGet ([51934b3](https://github.com/hotier/mediaGet-desktop/commit/51934b3bd34538c22bf26bbed90960cebf20cbf8))
* **engine:** 引擎 runner 化——关掉的平台在引擎被调用之前就回绝 ([fcfd821](https://github.com/hotier/mediaGet-desktop/commit/fcfd821b8caeff0c61e2d56f477a2a210b2bdc80))
* **kernel:** 解析内核改由 @mediaget/parse-core 工件消费——物理链接整桥拆除 ([2982811](https://github.com/hotier/mediaGet-desktop/commit/298281171dfb7ae3f2f66eaa221ebe3acc12a892))
* **main:** 应用图标资产 + 中文应用菜单 + Ctrl+Alt+V 全局唤起 ([1f82bdb](https://github.com/hotier/mediaGet-desktop/commit/1f82bdbe43eb10de8b4c563119803233217a8ed3))
* **P1:** Electron 骨架落地——main/preload/renderer + core-adapter + IPC 契约 + 下载器 + 线上回落 + 边界 CI ([9253222](https://github.com/hotier/mediaGet-desktop/commit/9253222119cc1b7c47e397da4583d532c519ef4f))
* **platforms:** 平台注册表接管「有哪些平台」——名称/图标/开关一处真源（契约 v6） ([8b5f121](https://github.com/hotier/mediaGet-desktop/commit/8b5f121ec6a4b6cd07bea40c39e2043790a8673f))
* **queue:** 队列卫生——download:clear 通道 + 取消不再复活 + 落盘条数上限（契约 v4） ([5dabe75](https://github.com/hotier/mediaGet-desktop/commit/5dabe75caefc7fb4abc7e7d11d7fb81c59847e9a))
* **settings:** 设置项两批落地 + 主进程文件日志与缓存占用清理 + 关于页更新卡片 + 契约 v3 ([9da8eab](https://github.com/hotier/mediaGet-desktop/commit/9da8eab9bc3d117c3bd0c67d5c6d7c8c03163375))
* **settings:** 体检表加「提供」列——开关即时切断解析，界面与路由同一真相 ([e24603d](https://github.com/hotier/mediaGet-desktop/commit/e24603d22fbdc733be7ccb6612ef2d650c2b195e))
* **stats:** 契约 v5 stats:get + 主进程生命周期计数器，历史窗口提到 5000 ([a6f2177](https://github.com/hotier/mediaGet-desktop/commit/a6f217788835be61a816df8745a2c1d3ce49bdc2))
* **stats:** 统计页落地——裸 ECharts 摇树 + CSS Token 探针取色 ([8b6986a](https://github.com/hotier/mediaGet-desktop/commit/8b6986a891e661fbc99050baf8a36c46ab0e53c3))
* **ui:** 队列页工具栏重构——搜索左置 + 三筛下拉 + 清冗余测试 ([962a3c8](https://github.com/hotier/mediaGet-desktop/commit/962a3c89642249ad146546a3103a4270817ed36f))
* **ui:** 结果卡统计改用图标展示——点赞/评论/收藏/转发用 heart/message-circle/star-check/share-2 ([deeb63c](https://github.com/hotier/mediaGet-desktop/commit/deeb63c780db7eab2cd91f34fc53965f982f40a9))
* **ui:** 结果卡统计与时长全面图标化——播放/弹幕/点赞/转发/评论/收藏/投币/分享/时长 ([861b9cf](https://github.com/hotier/mediaGet-desktop/commit/861b9cff8b8abaa4814575177fd2047d521ef97f))
* **ui:** 历史多选与结果卡外链落仓——与远端 24 提交并车，契约升 v7 ([c31071f](https://github.com/hotier/mediaGet-desktop/commit/c31071f4bd387bb7a197f4b130c62f90266af0b7))
* **ui:** 历史页多选可见入口与底部浮窗、解析即落历史、契约升 v8 ([fde6592](https://github.com/hotier/mediaGet-desktop/commit/fde6592f1b236478d25cf4441832e8d89277a4ee))
* **ui:** 首页批量导入 + 队列与历史筛选 + 导航去掉 ⌃ 标记 + 主题 token 收尾 ([467b106](https://github.com/hotier/mediaGet-desktop/commit/467b10654ba48eaf419ad8809c2aa08317af9a36))
* **ui:** 图标动效九枚入仓、统计页默认只留图、日志默认留 30 天 ([a37e926](https://github.com/hotier/mediaGet-desktop/commit/a37e926f72179706f405e6af47ee9a5a6c93e56e))
* **ui:** Air 风格迁移全量落地——Token 换血/四区骨架/魔法色动效 + 历史表格页/结果卡补全/底条精简 + pnpm 锁对齐 ([f5017d8](https://github.com/hotier/mediaGet-desktop/commit/f5017d89c1b395b88e85ecc26cfdcd7c27a9452b))
* **ui:** shadcn/ui + Tailwind v4 全量落地 + 队列页重做（九列单行/主线程聚合行/状态徽标即动作按钮） ([0534c79](https://github.com/hotier/mediaGet-desktop/commit/0534c79fe63f14d70d92c75c1a57ae821ec0b232))
* **window:** 自定义顶栏走 Window Controls Overlay，原生标题条没了 ([aa33882](https://github.com/hotier/mediaGet-desktop/commit/aa338822fb39402d385bb3b0df4c79a4b918af0f))

### 修复

* **ci:** build-win 显式 --publish never——push 触发的构建不该尝试上传 Release ([b2f9fa7](https://github.com/hotier/mediaGet-desktop/commit/b2f9fa773a96b42d2f038daf55b6ef506e6bf4d1))
* **ci:** HISTORY_MAX 截断用例显式给 30s 超时——CI runner 上撞默认 5s 假红 ([5360a01](https://github.com/hotier/mediaGet-desktop/commit/5360a0121d6d9a5f21a4dadccdeb7460d1e90fe2))
* **dev:** renderer 端口 5432→5433——本机 PostgreSQL 占 5432，vite 撞端口报 EACCES 假象、wait-on 会误判就绪过早拉起 electron（实测发现） ([3a1cbca](https://github.com/hotier/mediaGet-desktop/commit/3a1cbca3a9ddb3ccb055795a3bf3deb2d657186d))
* **downloader:** 半个文件不许冒充成品、写盘失败不许带走整个应用 ([3091d25](https://github.com/hotier/mediaGet-desktop/commit/3091d25e3243f7826c0ef4ce452cf03aa2419746))
* **home:** 重试带 forceOnline——过期直链不再让用户怎么点都是同一个错 ([7fc4437](https://github.com/hotier/mediaGet-desktop/commit/7fc44379743dadc91f51651a174b127eb9f870aa))
* **home:** sourceUrl 改用用户输入的原始分享链接——续链才能重新解析 ([9d9b27c](https://github.com/hotier/mediaGet-desktop/commit/9d9b27c59ef6b8707344f632fcfe8be71325d951))
* **shared:** toCount 把 0 视为"无统计" ([1b473d5](https://github.com/hotier/mediaGet-desktop/commit/1b473d53314ff1244652db3a748fa220e86e9946))
* **ui:** 侧栏底部版本信息移除——版本号只在设置·关于呈现 ([2f0ef4a](https://github.com/hotier/mediaGet-desktop/commit/2f0ef4ab66a4c09e7eb1f29c92dc002262a0e02a))
* **ui:** 侧栏首项与右区内容同线——品牌行下补 12px ([8c2a566](https://github.com/hotier/mediaGet-desktop/commit/8c2a56649270a5af748b3ceaa9f73442870d5193))
* **ui:** 队列页工具栏布局对齐历史页——筛选左置 + 搜索右置 ([58b9591](https://github.com/hotier/mediaGet-desktop/commit/58b9591a9291e62c3371e9cbd4608a1f580e6aa7))
* **ui:** 队列页状态筛选「全部」改为「全部状态」 ([6cdbb46](https://github.com/hotier/mediaGet-desktop/commit/6cdbb46dadea66af02d114dbf273e6cfd545689c))
* **ui:** 结果卡统计图标键名对齐 WorkStat —— like/reply/favorite/share/retweet ([27c52e9](https://github.com/hotier/mediaGet-desktop/commit/27c52e98c7a316eb06e85374dc595fc7917ccc5d))
* **ui:** 历史页表头多选框应用行悬停加深 ([288e2d9](https://github.com/hotier/mediaGet-desktop/commit/288e2d9431b6e3bf8c756faf9f9934cb6b06e524))
* **ui:** 历史页多选框 hover 边框加深 ([ded396b](https://github.com/hotier/mediaGet-desktop/commit/ded396b4bc1dbd8698cc4af72b81c0712942163b))
* **ui:** 历史页多选框行悬停加深边框 ([d6fb844](https://github.com/hotier/mediaGet-desktop/commit/d6fb8442ee6e5312969f278f8fa5bc64eeae84a7))
* **ui:** 历史页工具栏布局调整——筛选左置 + 搜索右置 ([e46b5c9](https://github.com/hotier/mediaGet-desktop/commit/e46b5c9473aa0bce2e43cb91dbb2aa83c89c1943))
* **ui:** 历史页作者列加宽 ([ce72e5c](https://github.com/hotier/mediaGet-desktop/commit/ce72e5cd9cb3dee867b07bb4896391f5887f12b2))
* **ui:** 历史页作者列去掉 @ 前缀 ([083d6ac](https://github.com/hotier/mediaGet-desktop/commit/083d6acc636d0b4865d4173ddf69284045e77761))
* **ui:** 评论图标改为 MessageCircle（非 MessageCircleText） ([0c997d4](https://github.com/hotier/mediaGet-desktop/commit/0c997d4428c6b9cd63134cf17cf2069f1d9733fa))
* **ui:** 筛选 Select 宽度统一为 w-28 ([b21b346](https://github.com/hotier/mediaGet-desktop/commit/b21b34621c45c49dc707a7b8246e86c13a21ee4e))
* **ui:** ResultCard 时长移到最后并加标签 ([2362e2b](https://github.com/hotier/mediaGet-desktop/commit/2362e2ba0df83724a1d1b8d04b937a8e42a8b4d4))
* **ui:** ResultCard 显示全部统计项 ([7ff0475](https://github.com/hotier/mediaGet-desktop/commit/7ff047511f14267959e252ebbdfd4028402a8dfe))

### 性能

* **main:** 二进制校验加跨进程记忆——每次启动白付的 135 ms 只付一遍 ([10f5fb4](https://github.com/hotier/mediaGet-desktop/commit/10f5fb4e51ca6f038e7d85dff8ed43a9f14eced8))
* **store:** 历史落盘并进 1 s 窗口——批量下载收尾不再逐条重写整本 history.json ([fef73e1](https://github.com/hotier/mediaGet-desktop/commit/fef73e18626fba7ccb580e8c70f4a0e786396183))
* **ui:** 队列行上 memo + 组视图复用——每个进度事件 15.8 ms → 3.85 ms ([3dc448d](https://github.com/hotier/mediaGet-desktop/commit/3dc448d57fe4195e33d5d9f214beadd8cf635ba0))

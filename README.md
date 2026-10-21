# MediaGet Desktop

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="renderer/public/brand/logo-lockup-on-dark.png" />
  <img src="renderer/public/brand/logo-lockup-on-light.png" alt="MediaGet" height="72" />
</picture>

**粘贴一条链接，解析、预览与下载都在你自己的电脑上完成。**

Windows 10 / 11 · 安装版与免安装版 · [**下载**](https://github.com/hotier/mediaGet-desktop/releases/latest) · [界面预览](https://hotier.github.io/mediaGet-desktop/) · [参与开发](#参与开发)

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 它解决什么问题

在线解析站要把你的链接交给它的服务器排队；拿到的直链往往几分钟就过期，复制出去还得再下一遍。

MediaGet 把这两步搬回本机：粘贴链接 → 本机解析出无水印直链 → 直接落盘。链接不经过任何第三方服务器，也没有「复制出去就过期」这一步。

## 能做什么

**解析**

- 粘贴一条链接、一整段分享文案，或多条混排；识别出平台会照实写出来
- 结果给可选画质、图集缩略预览、作者与播放/点赞等元数据，并标明解析来源与耗时
- 逐条勾选这次要落盘哪些文件，每一行都能就地预览（音视频在弹窗里流式播放，不暴露直链）
- 支持 13 个平台（清单与各自要不要 Cookie 见下方[平台支持](#平台支持)）
- 按平台开关：关掉的平台在解析这一步就被回绝，不是只在界面上藏起来

**下载**

- 断点续传、失败自动重试；关掉窗口不杀任务（缩到托盘继续），重启后未完成的任务自动续上
- 直链中途过期不用你管：应用会认出同一份资源的新链接，接着把这一条下完
- 队列是跨重启的完整台账：按作品聚合、可展开到每个文件，暂停/继续/重试/取消逐任务进行
- 下载目录、并发数、文件名组合都可调；系统通知按作品合并，图集不会逐张弹

**记录与统计**

- 解析成功就记一条历史，没下载也留着（「未下载」是一个正常状态），支持多选删除
- 多选导出四档：`xlsx` / `csv` / `json`（同一张表）、`txt`（完整作品信息）
- 统计页：成功率、累计体积、平均速度、平台与类型排行、活跃时段热力、解析通道

**用起来的样子**

- 五页：首页 / 队列 / 历史 / 统计 / 设置，快捷键 `Ctrl+1–4`、`Ctrl+K` 聚焦粘贴、`Ctrl+,` 设置、`Esc` 返回
- 明暗两套 × 五套配色 × 可调字号，字体从本机已装字体里选
- 应用内检查更新；关闭窗口缩到托盘、可开机自启

## 平台支持

13 个平台，解析全部在本机完成。**Cookie 只影响能不能过登录态与风控，不影响隐私**——它只写进你电脑上的配置文件，界面和日志里永远是掩码。

<!-- 维护提示：平台清单真源 = shared/platforms.ts；Cookie 档位真源 = renderer/src/pages/SettingsPage.tsx 的 COOKIE_ROWS；
     应用内自动获取的四个键 = shared/cookie-login.ts 的 COOKIE_LOGIN_KEYS。改任一处时同步本表。 -->

| 平台 | 作品数据 | 作者信息 | Cookie |
| --- | --- | --- | --- |
| 哔哩哔哩 | 视频（分P · 多清晰度）· 图文动态 · 纯文字动态 · 分区 · 版权标识 | 昵称 · 头像 · 主页 · 签名 | **强烈建议** |
| Instagram | 视频 · 图片 / 图集 | 昵称 · 头像 | **强烈建议** |
| 小红书 | 视频 · 图文（图集） | 昵称 · 头像 · 主页 · 简介 | 可选 |
| 抖音 | 视频 · 图文 | 昵称 · 头像 · 主页 · 简介 | 可选 |
| 快手 | 视频 | 昵称 · 头像（简介 / 获赞 / 粉丝数需配 Cookie） | 可选 |
| 西瓜视频 | 视频 | 昵称 · 头像 | 不需要 |
| 最右 | 视频 | 昵称 · 头像 | 不需要 |
| 微博 | 视频 · 图文 · 纯文字 | 昵称 · 头像（部分字段取自桌面接口） | 不需要 |
| AcFun | 视频 | 昵称 · 头像 | 不需要 |
| Twitter/X | 视频 · 图片 · 纯文字 | 昵称 · 头像 | 不需要 |
| TikTok | 视频 | 昵称 · 头像（经随包 yt-dlp） | 不需要 |
| YouTube | 视频 · 多清晰度（经随包 yt-dlp） | 频道名 · 频道主页 · 订阅数 | 可选 |
| 汽水音乐 | 音乐（音频直链） | 昵称 · 头像 | 不需要 |

**关于这两列**：昵称是所有平台都返回的；头像、主页链接、签名这些附加项按上表，个别作品仍可能为空。**互动数据**（播放 / 点赞 / 评论 / 收藏 / 投币 / 分享 / 弹幕）随平台接口返回，齐全度不一：哔哩哔哩最全（含弹幕与投币），小红书在未登录时可能被平台脱敏（界面会标「统计不可靠」），微博部分计数只在桌面接口存在。**缺的字段内核不补值、界面也不显示**——解析不到就是空，不会拿 0 冒充。

- 填 Cookie 的入口只有一个：**设置 → 引擎**，逐平台一行，标着当前是「已配置 / 未配置 / 待保存」。
- **哔哩哔哩、小红书、抖音、快手**可以在这一行点「登录获取」：登录窗口由应用自己加载，只抓登录动作之后才会出现的会话 cookie。
- **Instagram 与 YouTube 目前只能手动粘贴**：Instagram 没有内置登录窗口；YouTube 的登录在 Google 账号域，跨域跳转会离开应用内窗口，抓不到 Cookie。
- 没有 Cookie 也能用大部分平台；两家标「强烈建议」的，不配时失败率明显更高（哔哩哔哩大会员清晰度、Instagram 匿名访问普遍撞登录墙）。

## 界面

界面预览见落地页：**[hotier.github.io/mediaGet-desktop](https://hotier.github.io/mediaGet-desktop/)**

不联网、不拿真链接也想看全部五页，本地一条命令（走演示数据）：

```bash
pnpm install
pnpm dev
```

## 下载与安装

到 [Releases](https://github.com/hotier/mediaGet-desktop/releases/latest) 取一个：

- `MediaGet-Setup-x.y.z.exe` —— 安装版（写入开始菜单、可开机自启）
- `MediaGet-Portable-x.y.z.exe` —— 免安装版，双击即用
- `MediaGet-x.y.z.7z` —— 绿色归档，用 7-Zip 解压后跑 `MediaGet.exe`

安装版是向导式的：可以选「仅当前用户 / 所有用户」，也可以**自选安装位置**；装完的界面里有「显示详细信息」面板，安装目录下另有一份 `install.log`（完成页勾选「查看安装日志」直接打开）。卸载时会问一次是否同时删除本地数据，默认保留，重装后设置与历史还在。

首次运行 Windows 可能提示「未知发布者」——安装包未做代码签名，选择「仍要运行」即可。更新包不会静默安装，需你在应用内点确认。

## 隐私

- **不需要注册**，也不收集任何使用数据
- **Cookie 只存本机**：写进你的用户目录配置，界面与日志里一律以掩码出现；获取它的登录窗口也由应用自己加载
- **直链不入库**：历史与队列只留标题、作者与文件信息，媒体直链不显示也不保存
- **不碰不该碰的**：不解析微信视频号与付费/DRM 内容，不做反检测加码

## 常见问题

<details>
<summary>和在线解析网站有什么区别？</summary>

在线站点要先把链接提交给它的服务器排队解析；MediaGet 在本机直接跑对应平台的解析器，链接不经过第三方队列，直链拿到就落盘，不会出现「复制出去就过期」。
</details>

<details>
<summary>需要登录吗？</summary>

不需要注册账号。抖音、小红书、Instagram 等需要登录态的平台，可以在设置里用内置窗口登录，也可以手动粘贴 Cookie，两条路都只保存在本机。
</details>

<details>
<summary>解析失败怎么办？</summary>

先看设置里的「引擎体检」：它逐平台标注由谁解析、当前是否被关掉、Cookie 是什么状态。需要登录态的平台，补上 Cookie 往往就能过。
</details>

## 参与开发

本仓只是桌面客户端：解析逻辑在上游 [mediaGet](https://github.com/hotier/mediaGet) 仓的 `packages/parse-core/` 维护一份，本仓以版本化工件 `@mediaget/parse-core` 消费，不复制、不挖内部实现。

```bash
pnpm install                  # 前置只有本仓 + pnpm（corepack enable pnpm）
pnpm dev                      # vite + tsup --watch + Electron 联调
pnpm run build:app            # 只出 dist-electron/ + dist-renderer/
pnpm run typecheck && pnpm run lint && pnpm run test
```

- 动手前读 [AGENTS.md](AGENTS.md)：三条硬约束、改 IPC 的联动清单、本机的坑、提交与发版格式
- 架构与安全：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 验证档位：[docs/TESTING.md](docs/TESTING.md) · 界面决策沿革：[docs/UIUX-HANDOFF.md](docs/UIUX-HANDOFF.md)
- 品牌资产：`brand/` 是母版，`pnpm brand:assets` 从它重出图标与应用内字标

## 许可

MIT。工具只提供解析与下载能力，内容版权与使用授权归原平台与作者——请只保存你有权保存的内容，并遵守各平台服务条款与当地法律。本项目与所列平台无隶属关系。

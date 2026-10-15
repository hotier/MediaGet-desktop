# resources/ — 第三方二进制（不入库）

`yt-dlp.exe`、`ffmpeg.exe` 由 CI 下载或用户自备（docs/ARCHITECTURE.md §7：
`extraResources` 随包、**不打进 asar**、首启校验 SHA-256 释放到 `userData/bin/`）。

本地开发想让 TikTok（yt-dlp 链路）跑起来：

```powershell
# 1. 下载并校验二进制到 resources/bin/（.gitignore 已排除 *.exe）
node scripts/fetch-binaries.cjs
# 2. 直接启动 —— dev 默认就把 resources/bin 当随包目录（MG_BIN_DIR 可覆盖）
npm run dev
```

或在设置页之外直接写 `userData/config.json`：

```json
{ "kernel": { "YTDLP_BIN": "D:\\tools\\yt-dlp.exe", "FFMPEG_BIN": "D:\\tools\\ffmpeg.exe" } }
```

发布 CI 会生成 `resources/bin/manifest.json`（SHA-256 清单）供首启校验。

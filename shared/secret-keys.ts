/**
 * 机密配置键（Cookie 类）的唯一真源。
 *
 * 三处用途共用这一张表：导出配置时剔除（ARCHITECTURE §6.2）、settings:get 掩码、
 * settings:set 的 Cookie 键白名单。最后一条是能力面问题而不只是展示问题——
 * `settings:set` 会把每个非掩码 Cookie 键同时写进 `settings.cookies` 与 `kernel_config`，
 * 而 `kernel_config` 里的 `YTDLP_BIN` / `FFMPEG_BIN` 会被当成可执行文件路径 spawn。
 * 键名不受限就等于「渲染层被攻破后可以直接指定下一个要运行的程序」。
 *
 * 放手写进 shared 而不是 core-adapter：契约层（types/ipc-contract.ts）要用它收窄入参，
 * 而 types 不该反向依赖 adapter。core-adapter/config.ts 只做 re-export，既有 import 不动。
 */
export const SECRET_CONFIG_KEYS = [
  "DOUYIN_COOKIE",
  "BILIBILI_COOKIE",
  "XHS_COOKIE",
  "IG_COOKIE",
  "KUAISHOU_COOKIE",
  // 内核 1.0.0 删了 QQ 音乐，但旧版本用户盘上可能还留着这颗值：
  // 继续按机密剔除，导出配置不会把它吐出去（保留比移除安全）
  "QQMUSIC_COOKIE",
  "YOUTUBE_API_KEY",
  // 2026-10-21：YouTube 改由 yt-dlp 主解，可以配 Cookie（年龄限制 / 登录墙内容）。
  // 内核自己不读它，但「导出配置须剔除」与「掩码」两条按同一张表走，不在这里登记
  // 就等于让这颗值明文进导出文件。
  "YOUTUBE_COOKIE",
] as const;

export function isSecretKey(key: string): boolean {
  return (SECRET_CONFIG_KEYS as readonly string[]).includes(key);
}

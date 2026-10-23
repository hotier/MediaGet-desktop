/**
 * beta 通道的构建身份覆盖（`electron-builder --config electron-builder.beta.cjs`）。
 *
 * 与正式版必须差在「Windows 认应用」的每一个字段上：appId 决定卸载项与快捷方式 AUMID，
 * productName 决定显示名与 userData 目录，executableName 决定安装目录/可执行文件名。
 * 任何一个漏掉，两个安装包就会互相覆盖或共用数据。
 *
 * `extraMetadata` 不能省：Electron 的 `app.getName()` 读的是**打包进 asar 的 package.json**，
 * 不是 electron-builder 的配置对象。不写它，beta 的 userData 仍是 `%APPDATA%\MediaGet`，
 * 单实例锁与设置库会和正式版撞在一起。name 一并改掉是为了让 app-update.yml 的
 * `updaterCacheDirName`（由包名派生）也分开，两通道不共用更新下载缓存。
 *
 * 版本号必须是 `X.Y.Z-beta.N`：运行时按它判定通道（electron/main/release-channel.ts），
 * CI 的 tag 断言会核对两者一致。
 */
const pkg = require("./package.json");
const base = pkg.build;

const BETA_PRODUCT_NAME = "MediaGet (Beta)";
const BETA_APP_ID = "cc.hotier.mediaget.desktop.beta";
// 括号过不了 electron-builder 的安装目录白名单（/^[-_+0-9a-zA-Z .]+$/），
// 不显式指定 executableName 时 APP_FILENAME 会退化成包名，安装目录变成 mediaget-desktop。
const BETA_EXECUTABLE_NAME = "MediaGet Beta";

module.exports = {
  ...base,
  appId: BETA_APP_ID,
  productName: BETA_PRODUCT_NAME,
  executableName: BETA_EXECUTABLE_NAME,
  extraMetadata: {
    productName: BETA_PRODUCT_NAME,
    name: "mediaget-desktop-beta",
  },
  win: {
    ...base.win,
    artifactName: "MediaGet-Beta-${version}.${ext}",
  },
  nsis: {
    ...base.nsis,
    artifactName: "MediaGet-Beta-Setup-${version}.${ext}",
  },
  portable: {
    ...base.portable,
    artifactName: "MediaGet-Beta-Portable-${version}.${ext}",
  },
  publish: {
    ...base.publish,
    channel: "beta",
  },
};

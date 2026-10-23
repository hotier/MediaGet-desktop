/**
 * 发布通道（stable / beta）只有一个判据：版本号的预发布标识。
 *
 * 不用构建期环境变量：打包后的主进程没有构建环境可读，而版本号在 package.json 里、
 * 由 `app.getVersion()` 带进运行时。beta 发版必须把 package.json 版本写成
 * `X.Y.Z-beta.N`（CI 的 tag 断言会核对），身份覆盖则由 electron-builder.beta.cjs 完成；
 * 两边的 appId 一致性由 tests/installer.test.ts 钉住。
 */
export type ReleaseChannel = "stable" | "beta";

const APP_USER_MODEL_IDS: Record<ReleaseChannel, string> = {
  stable: "cc.hotier.mediaget.desktop",
  beta: "cc.hotier.mediaget.desktop.beta",
};

export function releaseChannelOf(version: string): ReleaseChannel {
  return /-beta(?:\.|$)/i.test(version) ? "beta" : "stable";
}

/**
 * Windows 快捷方式按 appId 写 AUMID；运行时对不上时任务栏分组与通知都会错位。
 * 这个值必须与 electron-builder.beta.cjs 的 appId 逐字一致。
 */
export function appUserModelIdOf(channel: ReleaseChannel): string {
  return APP_USER_MODEL_IDS[channel];
}

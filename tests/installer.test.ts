/**
 * Windows 安装器体验的回归守卫（业主 2026-10-21：「安装时不能选择安装位置 /
 * 不能显示安装日志」）。
 *
 * 为什么用源码扫描而不是构建产物断言：安装包只有 CI 打得出来（本机 `pnpm run build`
 * 在 electron-builder 解包卸载器那步被环境拦下，见 AGENTS「本机的坑」），而这两条体验
 * 恰好都是**默认关闭**的——目录页要 `allowToChangeInstallationDirectory`，细节面板被
 * 模板的 `ShowInstDetails nevershow` 关死，只有我们自己写的 `customHeader` 能盖回来。
 * 掉一条的后果不是编译错误，而是「安装包照出，用户装的时候既不能选目录也看不到日志」，
 * 所以把它钉在这里。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PKG = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as {
  build: { nsis: Record<string, unknown> };
};
const NSIS = PKG.build.nsis;
const INCLUDE = readFileSync(`${ROOT}build/installer.nsh`, "utf8");

describe("NSIS 安装器：安装位置与安装日志", () => {
  it("assisted 安装（不是 one-click），且目录页打开", () => {
    expect(NSIS.oneClick).toBe(false);
    expect(NSIS.allowToChangeInstallationDirectory).toBe(true);
  });

  it("细节面板被重新打开（模板默认 nevershow，唯有 customHeader 能覆盖）", () => {
    expect(INCLUDE).toMatch(/!macro customHeader[\s\S]*?ShowInstDetails show[\s\S]*?!macroend/);
    // 卸载页同理：BUILD_UNINSTALLER 分支里叫 ShowUninstDetails
    expect(INCLUDE).toMatch(/ShowUninstDetails show/);
  });

  it("安装日志落盘，且完成页能一键打开", () => {
    expect(INCLUDE).toContain("MUI_FINISHPAGE_SHOWREADME");
    expect(INCLUDE).toContain("install.log");
    expect(INCLUDE).toMatch(/!macro customInstall[\s\S]*?FileWriteUTF16LE[\s\S]*?!macroend/);
  });

  it("卸载改数据去留时只在非静默路径弹框（静默=/S，升级跑的就是它）", () => {
    const uninstall = INCLUDE.match(/!macro customUnInstall([\s\S]*?)!macroend/);
    if (!uninstall) throw new Error("build/installer.nsh 里找不到 customUnInstall");
    expect(uninstall[1]).toContain("${IfNot} ${Silent}");
    expect(uninstall[1]).toContain("MB_DEFBUTTON2"); // 默认「保留数据」
  });

  it("安装器语言里必须有简体中文（否则中文系统也看到英文向导）", () => {
    expect(NSIS.installerLanguages).toContain("zh_CN");
  });

  it("安装器两图在、且尺寸精确（MUI 写死，错一个像素就糊）", () => {
    // 文件名就是 electron-builder 的默认落点，删了会静默退回 NSIS 自带的 metro 位图
    for (const [file, w, h] of [
      ["installerSidebar.bmp", 164, 314],
      ["installerHeader.bmp", 150, 57],
    ] as const) {
      const bmp = readFileSync(`${ROOT}build/${file}`);
      expect(bmp.toString("ascii", 0, 2)).toBe("BM");
      expect(bmp.readInt32LE(18), `${file} 宽度`).toBe(w);
      expect(bmp.readInt32LE(22), `${file} 高度`).toBe(h);
      expect(bmp.readUInt16LE(28), `${file} 位深`).toBe(24);
    }
  });
});

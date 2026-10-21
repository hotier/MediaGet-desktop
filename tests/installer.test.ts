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
  build: {
    nsis: Record<string, unknown>;
    win: { target: string[] };
    "7z": { artifactName: string };
  };
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

  it("安装日志落盘，但完成页不放日志按钮（业主 2026-10-21 二次定调）", () => {
    expect(INCLUDE).not.toContain("MUI_FINISHPAGE_SHOWREADME");
    expect(INCLUDE).toContain("install.log");
    expect(INCLUDE).toMatch(/!macro customInstall[\s\S]*?FileWriteUTF16LE[\s\S]*?!macroend/);
  });

  it("日志只进进度条上方的细节列表，下方彻底留白（listonly + 品牌文字置空）", () => {
    const install = INCLUDE.match(/!macro customInstall([\s\S]*?)!macroend/);
    if (!install) throw new Error("build/installer.nsh 里找不到 customInstall");
    expect(install[1]).toContain("SetDetailsPrint listonly");
    expect(install[1]).not.toContain("SetDetailsPrint both");
    expect(INCLUDE).toMatch(/!macro customHeader[\s\S]*?BrandingText " "[\s\S]*?!macroend/);
  });

  it("解包期的空白段由隐藏区段补一行状态（必须声明在 customHeader 里才排得到主安装段之前）", () => {
    const header = INCLUDE.match(/!macro customHeader([\s\S]*?)!macroend/);
    if (!header) throw new Error("build/installer.nsh 里找不到 customHeader");
    // 区段名以 - 开头 = 组件页看不见但照样执行；掉到 customInstall 里就晚了（那时已经装完）
    expect(header[1]).toMatch(/Section "-/);
    expect(header[1]).toMatch(/Section "-[\s\S]*?\$\{IfNot\} \$\{Silent\}[\s\S]*?SetDetailsPrint listonly[\s\S]*?DetailPrint/);
    expect(header[1]).not.toContain("SetDetailsPrint both");
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

/**
 * 事故回归（2026-10-21 首次加 7z target）：`"7z": { artifactName }` 曾被写成
 * build 顶层的裸 `"artifactName"`——JSON 依然合法、typecheck/lint/vitest 全绿，
 * 但 7z 吃的是全局默认名、且日后任何 target 都会继承它。编译器管不到配置结构，
 * 只能钉在这里。
 */
describe("发布产物：7z 绿色归档", () => {
  it("win.target 含 7z，且 7z 有自己的 artifactName 而不是 build 顶层默认值", () => {
    expect(PKG.build.win.target).toContain("7z");
    expect(PKG.build["7z"].artifactName).toBe("${productName}-${version}.${ext}");
  });
});

/**
 * 发布通道判据：稳定版与 beta 的运行时身份必须同源，否则会出现
 * 「安装器按 .beta 装了、任务栏/通知却归到正式版」或「beta 去读正式版更新」。
 */
import { describe, expect, it } from "vitest";
import { appUserModelIdOf, releaseChannelOf } from "../electron/main/release-channel";
import { profileSuffixFor } from "../electron/main/profile";

describe("releaseChannelOf", () => {
  it("只看版本号的预发布标识", () => {
    expect(releaseChannelOf("0.2.1")).toBe("stable");
    expect(releaseChannelOf("0.3.0-beta.1")).toBe("beta");
    expect(releaseChannelOf("0.3.0-BETA.2")).toBe("beta");
    expect(releaseChannelOf("0.3.0-rc.1")).toBe("stable");
  });
});

describe("appUserModelIdOf", () => {
  it("beta 与稳定版是两套 AUMID（任务栏/通知不归组）", () => {
    expect(appUserModelIdOf("stable")).toBe("cc.hotier.mediaget.desktop");
    expect(appUserModelIdOf("beta")).toBe("cc.hotier.mediaget.desktop.beta");
  });
});

describe("profileSuffixFor", () => {
  it("未打包一律 dev；打包后 beta 与稳定版各用各的 temp 派生目录", () => {
    expect(profileSuffixFor(false, "0.3.0-beta.1")).toBe("-dev");
    expect(profileSuffixFor(true, "0.3.0-beta.1")).toBe("-beta");
    expect(profileSuffixFor(true, "0.3.0")).toBe("");
  });
});

/**
 * 防盗链 Referer 的组装（下载与预览共用这一处）。
 *
 * 钉住 2026-10-19 那次事故：小红书图床对**裸域名** Referer 直接 403，只认带 `www` 的站点源。
 * 同一个路径三种 Referer 的实测（无 / `https://xiaohongshu.com/` / `https://www.xiaohongshu.com/`
 * → 404 / 403 / 404）说明这不是「链过期」，而是 Referer 被白名单拒——症状与过期同形，
 * 所以只留一条断言在这里，防止有人把覆盖表当冗余删掉。
 */
import { describe, expect, it } from "vitest";
import { refererFor } from "../electron/main/hotlink";

describe("refererFor（域名真源 = 内核 PLATFORM_INFO，站点源差异走覆盖表）", () => {
  it("小红书发 www 站点源，不是内核域名首项的裸域名", () => {
    expect(refererFor("redbook")).toBe("https://www.xiaohongshu.com/");
  });

  it("别名键归一到契约键（`xhs` 不能静默变成「不带 Referer」）", () => {
    expect(refererFor("xhs")).toBe("https://www.xiaohongshu.com/");
  });

  it("其余平台照旧取内核域名首项；未登记键不带 Referer", () => {
    expect(refererFor("weibo")).toBe("https://weibo.com/");
    expect(refererFor("douyin")).toBe("https://douyin.com/");
    expect(refererFor("bilibili")).toBe("https://bilibili.com/");
    expect(refererFor("nope")).toBeUndefined();
    expect(refererFor(undefined)).toBeUndefined();
  });
});

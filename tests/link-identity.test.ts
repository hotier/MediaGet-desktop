/**
 * 直链身份判据（契约 v12 的续链环节）。
 *
 * 钉住的风险：续链拿回的是**整份**新解析结果，认错一条就是把 P2 的链挂到 P1 的任务上——
 * 文件照常下完、内容却是另一段，界面上不会有任何异常。所以「认不出」必须是正常结局，
 * 而「认得出」必须严格到路径 + 全部非时效参数。
 */
import { describe, expect, it } from "vitest";
import { collectMediaUrls, pickRenewedUrl } from "../shared/link-identity";
import type { ParseData } from "../types/ipc";

const OLD = "https://v26.douyinvod.com/a/b.mp4?video_id=v1&ratio=720p&sign=S1&expires=100";
const NEW = "https://v26.douyinvod.com/a/b.mp4?video_id=v1&ratio=720p&sign=S2&expires=200";

describe("pickRenewedUrl（认对象）", () => {
  it("同一条资源换了签名 → 认出新的", () => {
    expect(pickRenewedUrl(OLD, ["https://other.example.com/x.mp4", NEW])).toBe(NEW);
  });

  it("别的清晰度不是这一份（ratio 参与身份）", () => {
    const higher = "https://v26.douyinvod.com/a/b.mp4?video_id=v1&ratio=1080p&sign=S2&expires=200";
    expect(pickRenewedUrl(OLD, [higher])).toBeNull();
  });

  it("别的分 P 不是这一份（路径不同）", () => {
    const p2 = "https://v26.douyinvod.com/a/c.mp4?video_id=v1&ratio=720p&sign=S2&expires=200";
    expect(pickRenewedUrl(OLD, [p2])).toBeNull();
  });

  it("身份参数多一个也认不出（宁可少续，不可续错）", () => {
    const extra = `${NEW}&cid=9`;
    expect(pickRenewedUrl(OLD, [extra])).toBeNull();
  });

  it("整串一模一样 = 平台没换签名 → null，否则 403 重试会变成死循环", () => {
    expect(pickRenewedUrl(OLD, [OLD])).toBeNull();
  });

  it("各家时效/签名叫法都不参与身份", () => {
    const biliOld = "https://xy.mipush.com/x.m4s?btag=a_1&uid=7&pn=300&fnval=16&platform=pc&m=1&l=2&s=abc&buvid=x";
    const biliNew = biliOld.replace("s=abc", "s=def").replace("m=1", "m=2");
    expect(pickRenewedUrl(biliOld, [biliNew])).toBe(biliNew);
  });

  it("设备标识留在身份里：两边 uid 不同就不认", () => {
    const other = NEW.replace("video_id=v1", "video_id=v1&uid=other");
    expect(pickRenewedUrl(OLD, [other])).toBeNull();
  });

  it("坏输入不炸：非 URL、空候选、缺参都返回 null", () => {
    expect(pickRenewedUrl("not-a-url", [NEW])).toBeNull();
    expect(pickRenewedUrl(OLD, [])).toBeNull();
    expect(pickRenewedUrl("", [NEW])).toBeNull();
  });

  it("参数顺序不影响身份（比的是集合，不是串）", () => {
    const shuffled = "https://v26.douyinvod.com/a/b.mp4?ratio=720p&video_id=v1&expires=200&sign=S2";
    expect(pickRenewedUrl(OLD, [shuffled])).toBe(shuffled);
  });
});

describe("collectMediaUrls（一份结果里所有可下载直链）", () => {
  it("按主媒体 → 音频 → 图集 → 清晰度 → 多 P 收集并去重", () => {
    const data = {
      url: "A",
      audioUrl: "B",
      images: ["C", "D", "C"],
      qualities: [{ quality: 320, label: "1080P", url: "E" }],
      videos: [
        { url: "F", qualities: [{ quality: 16, label: "360P", url: "G" }] },
        { url: "A" },
      ],
    } as unknown as ParseData;
    expect(collectMediaUrls(data)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("空结果与缺字段返回空表（解析失败时不该假装有任何链）", () => {
    expect(collectMediaUrls(undefined)).toEqual([]);
    expect(collectMediaUrls({})).toEqual([]);
  });
});

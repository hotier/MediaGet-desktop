/**
 * 直链身份判据（契约 v12 的续链环节）。
 *
 * 钉住的风险：续链拿回的是**整份**新解析结果，认错一条就是把 P2 的链挂到 P1 的任务上——
 * 文件照常下完、内容却是另一段，界面上不会有任何异常。所以「认不出」必须是正常结局，
 * 而「认得出」必须严格到路径 + 全部非时效参数。
 */
import { describe, expect, it } from "vitest";
import { collectMediaUrls, isSameResource, pickRenewedUrl } from "../shared/link-identity";
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

/**
 * 2026-10-18 线上事故回归：B 站 403 续链永远「无结果」（真实日志：
 * `[download] 续链无结果: …mp4, sourceUrl=https://www.bilibili.com/video/BV1…` + 一路 403）。
 *
 * 实测（同一作品连续解析两次，走 unifiedParseLocal → normalizeResult）：
 * - 两条清晰度分别落在 `cn-sh-cc-01-08.bilivideo.com` 与 `cn-sh-cc-01-15.bilivideo.com`
 *   —— **host 是 CDN 节点，不是资源**；
 * - 只有 `deadline` / `trid` / `uparams` / `upsig` 变值，而旧名单只认得 `deadline`
 *   —— 另外三个进了身份参数，于是「同一条资源换了签名」被判成「认不出」。
 *
 * 这两条一起钉住：host 不参与身份、B 站签名块不参与身份，而清晰度仍然靠路径分辨。
 */
describe("B 站直链：CDN 节点与签名每次换，仍然认出同一份资源", () => {
  const PATH_1080 = "/upgcxcode/93/13/42702671393/42702671393-1-192.mp4";
  const PATH_360 = "/upgcxcode/93/13/42702671393/42702671393-1-16.mp4";
  /** 按实测参数表拼一条 playurl 直链；签名块（e/deadline/trid/uparams/upsig）与节点号可替换 */
  const bili = (host: string, path: string, sig: string, cdnid = "8"): string =>
    `https://${host}${path}?e=1760${sig}&uipk=5&nbs=1&deadline=1760${sig}&os=windows&oi=1` +
    `&trid=${sig}trace&mid=0&platform=pc&upsig=SIG${sig}&uparams=e,uipk,nbs,deadline,trid` +
    `&bvc=vod&bw=1000&cdnid=${cdnid}&og=cos&build=1&f=x&agrr=1&orderid=0,3&lrs=1`;

  it("换节点 + 换签名 → 认出新的那一条", () => {
    const old = bili("cn-sh-cc-01-08.bilivideo.com", PATH_1080, "1", "8");
    const next = bili("cn-sh-cc-01-15.bilivideo.com", PATH_1080, "2", "15");
    expect(pickRenewedUrl(old, [next])).toBe(next);
  });

  it("只有节点换了（参数完全一样）也算新链：403 的正是原来那个节点", () => {
    const old = bili("cn-sh-cc-01-08.bilivideo.com", PATH_1080, "1", "8");
    const next = bili("cn-sh-cc-01-15.bilivideo.com", PATH_1080, "1", "8");
    expect(pickRenewedUrl(old, [next])).toBe(next);
  });

  it("同一作品的另一档清晰度（路径里是另一个 qn）不认", () => {
    const old = bili("cn-sh-cc-01-08.bilivideo.com", PATH_1080, "1", "8");
    const lower = bili("cn-sh-cc-01-08.bilivideo.com", PATH_360, "2", "8");
    expect(pickRenewedUrl(old, [lower])).toBeNull();
  });

  it("同节点 + 整串参数一模一样（只差顺序）→ null，否则 403 重试变成死循环", () => {
    const old = bili("cn-sh-cc-01-08.bilivideo.com", PATH_1080, "1", "8");
    const shuffled = `${bili("cn-sh-cc-01-08.bilivideo.com", PATH_1080, "1", "8")
      .split("?")[1]
      .split("&")
      .reverse()
      .join("&")}`;
    const rearranged = `https://cn-sh-cc-01-08.bilivideo.com${PATH_1080}?${shuffled}`;
    expect(pickRenewedUrl(old, [rearranged])).toBeNull();
  });
});

/**
 * 续传身份（`isSameResource`）：盘上 `.part` 记的是上一次的签名链，这次可能是新签名链。
 * 判据与续链共用，但不要求「必须有东西变了」——换签名不是换资源。
 */
describe("isSameResource（.part 还能不能接着写）", () => {
  it("换了签名/到期 = 同一份资源（能续）", () => {
    expect(isSameResource(OLD, NEW)).toBe(true);
    expect(isSameResource(OLD, OLD)).toBe(true);
  });

  it("换了清晰度/分 P（路径不同）= 不是同一份（不能续）", () => {
    expect(isSameResource(OLD, "https://v26.douyinvod.com/a/c.mp4?video_id=v1&ratio=720p&sign=S2")).toBe(false);
  });

  it("身份参数不同（别的清晰度档）= 不是同一份", () => {
    const higher = "https://v26.douyinvod.com/a/b.mp4?video_id=v1&ratio=1080p&sign=S2&expires=200";
    expect(isSameResource(OLD, higher)).toBe(false);
  });

  it("B 站换了 CDN 节点 + 换了签名 = 同一份资源", () => {
    const path = "/upgcxcode/93/13/42702671393/42702671393-1-192.mp4";
    const a = `https://cn-sh-cc-01-08.bilivideo.com${path}?e=17601&trid=1&upsig=A&uparams=e,trid&cdnid=8&bw=1000`;
    const b = `https://cn-sh-cc-01-15.bilivideo.com${path}?e=17602&trid=2&upsig=B&uparams=e,trid&cdnid=15&bw=1000`;
    expect(isSameResource(a, b)).toBe(true);
  });

  it("坏输入不炸：非 URL 一律不是同一份", () => {
    expect(isSameResource("not-a-url", NEW)).toBe(false);
    expect(isSameResource(NEW, "")).toBe(false);
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

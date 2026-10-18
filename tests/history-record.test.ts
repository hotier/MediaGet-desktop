/**
 * 历史身份规则（`shared/history.ts`）—— v8「历史页 = 解析历史」的地基。
 *
 * 这里钉的是三件不能各自发挥的事：
 * 1. 作品键必须由链接**可复算**：解析侧（主进程 parse:run）与下载侧（index.ts 的落盘事件）
 *    分别造行，算不出同一个键就聚不成一行，历史页会出现「同一个作品两条记录」；
 * 2. 解析行的 files 必须是空数组，因为「未下载」这一列就是靠它表达的（不另设标志位）；
 * 3. 直链不许进档（隐私红线：files 之外只有 sourceUrl 是用户自己的输入）。
 * 零依赖纯函数，所以不需要 DOM 也不需要临时目录。
 */
import { describe, expect, it } from "vitest";
import {
  canonicalSourceUrl,
  isLanded,
  normalizeHistoryKeys,
  parseHistoryEntry,
  workKeyOf,
} from "../shared/history";
import type { HistoryEntry } from "../types/ipc";

const SHARE = "https://v.kuaishou.com/abc";

describe("workKeyOf：链接 → 作品键", () => {
  it("可复算且形状稳定：两侧各自调用必然对得上", () => {
    const a = workKeyOf(SHARE);
    expect(a).toBe(workKeyOf(SHARE));
    expect(a).toMatch(/^w-[0-9a-f]{16}$/);
  });

  it("两端空白不影响键值（分享链接常混在文案里带出空格）", () => {
    expect(workKeyOf(`  ${SHARE}\n`)).toBe(workKeyOf(SHARE));
  });

  it("键宽在 history:remove 的 64 字符上限内（它是当 id/groupId 用的）", () => {
    const long = `https://example.com/${"x".repeat(300)}?a=1`;
    expect(workKeyOf(long)?.length).toBeLessThanOrEqual(64);
  });

  it("无链接一律返回 undefined：让调用方的一次性 id 接管", () => {
    expect(workKeyOf(undefined)).toBeUndefined();
    expect(workKeyOf(null)).toBeUndefined();
    expect(workKeyOf("")).toBeUndefined();
    expect(workKeyOf("   ")).toBeUndefined();
  });

  it("不同链接给不同键 —— 撞键会让两个作品在历史页合成一行，界面上查不出来", () => {
    const keys = new Set([
      workKeyOf("https://v.kuaishou.com/abc"),
      workKeyOf("https://v.kuaishou.com/xyz"), // 只差尾号
      workKeyOf("https://v.kuaishou.com/abc?extra=1"), // 认不出的参数仍参与身份
      workKeyOf("https://www.bilibili.com/video/BV1xx"),
      // 长 URL 也不能把差异挤出摘要：截断式 key 会在 200 字符后全部相同
      workKeyOf(`https://v.douyin.com/${"a".repeat(400)}`),
      workKeyOf(`https://v.douyin.com/${"a".repeat(400)}b`),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("canonicalSourceUrl：同一条作品的不同复制形态归到同一个键", () => {
  it("尾部斜杠不算另一个作品（本机真实重复行就是这一对）", () => {
    expect(workKeyOf("https://www.bilibili.com/video/BV1VTYT6tEV2/")).toBe(
      workKeyOf("https://www.bilibili.com/video/BV1VTYT6tEV2")
    );
  });

  it("分享追踪参数被剔除，且不影响路径里的作品 ID", () => {
    expect(canonicalSourceUrl("https://www.bilibili.com/video/BV1xx/?share_source=copy_web&vd_source=38f9d9e5bde97cc452a9493c3d2ec9b5")).toBe(
      "bilibili.com/video/BV1xx"
    );
    expect(canonicalSourceUrl("https://www.xiaohongshu.com/explore/abc?xsec_token=x&xsec_source=pc_share&utm_source=wx")).toBe(
      "xiaohongshu.com/explore/abc"
    );
    expect(canonicalSourceUrl("https://www.youtube.com/watch?v=abc&si=xyz&feature=share&t=30")).toBe(
      "youtube.com/watch?v=abc"
    );
    expect(canonicalSourceUrl("https://www.instagram.com/p/abc/?igsh=zzz&img_index=1")).toBe(
      "instagram.com/p/abc"
    );
  });

  it("查询参数顺序、片段、协议、www/移动前缀都不进身份", () => {
    expect(canonicalSourceUrl("https://weibo.com/a?b=2&a=1#comment")).toBe(
      canonicalSourceUrl("http://m.weibo.com/a?a=1&b=2")
    );
    expect(canonicalSourceUrl("https://www.bilibili.com/video/BV1xx?p=2&vd_source=x")).toBe(
      "bilibili.com/video/BV1xx?p=2"
    );
    // p=1 是默认分 P，与不带 p 等价
    expect(workKeyOf("https://www.bilibili.com/video/BV1xx?p=1")).toBe(
      workKeyOf("https://www.bilibili.com/video/BV1xx")
    );
  });

  it("大小写敏感的作品 ID、YouTube 的 v、非默认分 P 仍算不同作品", () => {
    expect(workKeyOf("https://www.bilibili.com/video/BV1xx")).not.toBe(
      workKeyOf("https://www.bilibili.com/video/bv1xx")
    );
    expect(workKeyOf("https://www.youtube.com/watch?v=abc")).not.toBe(
      workKeyOf("https://www.youtube.com/watch?v=xyz")
    );
    expect(workKeyOf("https://www.bilibili.com/video/BV1xx?p=2")).not.toBe(
      workKeyOf("https://www.bilibili.com/video/BV1xx?p=3")
    );
  });

  it("两端空白与零宽字符不影响键", () => {
    expect(workKeyOf("\u200b  https://v.douyin.com/abc/ \n\ufeff")).toBe(
      workKeyOf("https://v.douyin.com/abc")
    );
  });

  it("认不出的查询参数保守保留：宁可多一行，不可合错一行", () => {
    expect(canonicalSourceUrl("https://example.com/watch?id=7&utm_source=x")).toBe(
      "example.com/watch?id=7"
    );
    expect(workKeyOf("https://example.com/watch?id=7&foo=1")).not.toBe(
      workKeyOf("https://example.com/watch?id=7&foo=2")
    );
  });
});

describe("normalizeHistoryKeys：读侧给旧行补算键", () => {
  const parseRow = (id: string, sourceUrl: string, at: number): HistoryEntry => ({
    id,
    groupId: id,
    platform: "bilibili",
    title: "同一个作品",
    files: [],
    sourceUrl,
    createdAt: at,
  });
  const fileRow = (id: string, groupId: string, sourceUrl: string): HistoryEntry => ({
    id,
    groupId,
    platform: "bilibili",
    title: "同一个作品",
    kind: "video",
    files: [`/tmp/${id}.mp4`],
    sourceUrl,
    createdAt: 10,
  });

  it("旧解析行按归一后的键合并，只留最新一条", () => {
    const key = workKeyOf("https://www.bilibili.com/video/BV1VTYT6tEV2") ?? "w-broken";
    const list = normalizeHistoryKeys([
      parseRow("w-newish", "https://www.bilibili.com/video/BV1VTYT6tEV2/", 300),
      parseRow("w-old", "https://www.bilibili.com/video/BV1VTYT6tEV2", 100),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: key, groupId: key, createdAt: 300 });
  });

  it("下载行只换 groupId，任务 id 与文件一条不少", () => {
    const key = workKeyOf("https://www.bilibili.com/video/BV1xx/?vd_source=x") ?? "w-broken";
    const list = normalizeHistoryKeys([
      fileRow("dl-1", "w-stale-a", "https://www.bilibili.com/video/BV1xx"),
      fileRow("dl-2", "w-stale-b", "https://www.bilibili.com/video/BV1xx/"),
    ]);
    expect(list.map((e) => e.id)).toEqual(["dl-1", "dl-2"]);
    expect(list.map((e) => e.groupId)).toEqual([key, key]);
  });

  it("算不出键与本来就没键的行原样返回", () => {
    const entry: HistoryEntry = {
      id: "p-fallback",
      platform: "bilibili",
      title: "ID 直解",
      files: [],
      createdAt: 1,
    };
    expect(normalizeHistoryKeys([entry])).toEqual([entry]);
  });
});

describe("parseHistoryEntry：解析成功 → 未下载态的历史行", () => {
  const base = {
    sourceUrl: SHARE,
    platform: "kuaishou",
    title: "秋日通勤穿搭",
    author: { name: "胶片修复所", id: "19324001" },
    fallbackId: "p-fallback",
    at: 1730000000000,
  };

  it("有链接：id 与 groupId 同指作品键，files 为空 = 未下载", () => {
    const row = parseHistoryEntry(base);
    const key = workKeyOf(SHARE);
    expect(row).toMatchObject({
      id: key,
      groupId: key,
      platform: "kuaishou",
      title: "秋日通勤穿搭",
      sourceUrl: SHARE,
      createdAt: 1730000000000,
    });
    expect(row.files).toEqual([]);
    expect(isLanded(row)).toBe(false);
  });

  it("ID 直解模式（链接抽不出来）：退回一次性 id，且不冒充分组", () => {
    const row = parseHistoryEntry({ ...base, sourceUrl: undefined });
    expect(row.id).toBe("p-fallback");
    expect(row.groupId).toBeUndefined();
  });

  it("字段是封闭集：新增键要过这条用例，直链想搭车必须先被看见", () => {
    const row = parseHistoryEntry(base);
    // v10 加的 `publishedAt` / `stat` 是这一条显式放行的：只有公开数字与时刻，
    // 直链（`data.url` / `images[]` / `qualities[].url`）依旧无处搭车 —— 见下面那条用例。
    expect(Object.keys(row).sort()).toEqual([
      "author",
      "createdAt",
      "files",
      "groupId",
      "id",
      "platform",
      "publishedAt",
      "sourceUrl",
      "stat",
      "title",
    ]);
  });

  it("行里唯一的链接就是用户自己那条分享链接（直链无处搭车）", () => {
    // 内核结果里的 data.url / images[] / qualities[].url 都是带签名的直链，
    // 这个函数的入参表根本不收它们 —— 断言的是「造出来的行里不含第二条 URL」。
    const json = JSON.stringify(parseHistoryEntry(base));
    const links = json.match(/https?:\/\/[^"]+/g) ?? [];
    expect(links).toEqual([SHARE]);
  });
});

describe("isLanded：有没有落地文件", () => {
  it("files 非空才算落地（统计页只数落地行）", () => {
    expect(isLanded({ files: [] })).toBe(false);
    expect(isLanded({ files: ["/tmp/a.mp4"] })).toBe(true);
  });
});

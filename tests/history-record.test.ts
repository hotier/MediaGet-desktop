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
import { isLanded, parseHistoryEntry, workKeyOf } from "../shared/history";

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
      workKeyOf("https://v.kuaishou.com/abc?extra=1"), // 只差查询参数
      workKeyOf("https://www.bilibili.com/video/BV1xx"),
      // 长 URL 也不能把差异挤出摘要：截断式 key 会在 200 字符后全部相同
      workKeyOf(`https://v.douyin.com/${"a".repeat(400)}`),
      workKeyOf(`https://v.douyin.com/${"a".repeat(400)}b`),
    ]);
    expect(keys.size).toBe(6);
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
    expect(Object.keys(row).sort()).toEqual([
      "author",
      "createdAt",
      "files",
      "groupId",
      "id",
      "platform",
      "sourceUrl",
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

/**
 * 续链合并器（契约 v12）。
 *
 * 钉住的风险是请求风暴：一次图集有 20 张、多 P 有若干部，它们的直链是同一次解析发的、
 * 也会一起过期。逐任务各解析一次等于在用户已经等了一会儿之后，再拿 N 倍请求去打平台
 * （抖音那类还会因高频返回 -412 风控）。所以「同一作品短时间只再解析一次」必须有守卫。
 */
import { describe, expect, it } from "vitest";
import { createLinkRenewer } from "../electron/main/link-renew";
import type { ParseData } from "../types/ipc";

const SOURCE = "https://v.douyin.com/abc/";
const OLD = "https://v26.douyinvod.com/a/b.mp4?video_id=v1&sign=S1&expires=100";
const NEW = "https://v26.douyinvod.com/a/b.mp4?video_id=v1&sign=S2&expires=200";

function harness(opts: {
  data?: ParseData | undefined;
  throws?: boolean;
  ttlMs?: number;
  now?: () => number;
}) {
  let calls = 0;
  let clock = 1_000;
  const renew = createLinkRenewer({
    ttlMs: opts.ttlMs ?? 60_000,
    now: opts.now ?? (() => clock),
    reparse: async (sourceUrl) => {
      calls++;
      expect(sourceUrl).toBe(SOURCE);
      if (opts.throws) throw new Error("解析失败");
      return opts.data ?? { url: NEW };
    },
  });
  return { renew, calls: () => calls, advance: (ms: number) => (clock += ms) };
}

describe("createLinkRenewer", () => {
  it("并发任务共用同一次再解析（图集连环 403 只打平台一次）", async () => {
    const h = harness({});
    const [a, b, c] = await Promise.all([
      h.renew(OLD, SOURCE),
      h.renew(OLD.replace("b.mp4", "c.mp4"), SOURCE),
      h.renew(OLD, SOURCE),
    ]);
    expect(a).toBe(NEW);
    expect(h.calls()).toBe(1);
    // 认不出对象的那条（另一份资源）如实返回 null，但同样不触发第二次解析
    expect(b).toBeNull();
    expect(c).toBe(NEW);
  });

  it("TTL 内复用，过 TTL 才再解析一次", async () => {
    const h = harness({});
    expect(await h.renew(OLD, SOURCE)).toBe(NEW);
    h.advance(59_000);
    expect(await h.renew(OLD, SOURCE)).toBe(NEW);
    expect(h.calls()).toBe(1);
    h.advance(2_000);
    expect(await h.renew(OLD, SOURCE)).toBe(NEW);
    expect(h.calls()).toBe(2);
  });

  it("再解析失败也进表：TTL 内不再重复捶平台，答复是 null", async () => {
    const h = harness({ throws: true });
    expect(await h.renew(OLD, SOURCE)).toBeNull();
    expect(await h.renew(OLD, SOURCE)).toBeNull();
    expect(h.calls()).toBe(1);
  });

  it("新结果里没有同一条资源 → null（交回原来的重试与报错）", async () => {
    const h = harness({ data: { url: "https://other.example.com/z.mp4" } });
    expect(await h.renew(OLD, SOURCE)).toBeNull();
  });

  it("没有分享链接就不续：任务不知道自己属于哪个作品，无法再解析", async () => {
    const h = harness({});
    expect(await h.renew(OLD, undefined)).toBeNull();
    expect(await h.renew(OLD, "   ")).toBeNull();
    expect(h.calls()).toBe(0);
  });

  it("不同作品各算各的合并槽", async () => {
    let calls = 0;
    const renew = createLinkRenewer({
      reparse: async () => {
        calls++;
        return { url: NEW };
      },
    });
    await Promise.all([renew(OLD, SOURCE), renew(OLD, "https://v.douyin.com/other/")]);
    expect(calls).toBe(2);
  });
});

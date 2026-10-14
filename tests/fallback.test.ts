/**
 * 线上回落测试：URL 组装、failType 归类、非 JSON 容错。零外网。
 */
import { describe, expect, it } from "vitest";
import { createOnlineFallback } from "../electron/main/fallback";

function makeFallback(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fb = createOnlineFallback({
    getBase: () => "https://api.example.test",
    timeoutMs: 5000,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return handler(String(input), init);
    }) as typeof fetch,
  });
  return { fb, seen };
}

describe("createOnlineFallback", () => {
  it("组装 GET {base}/api/parse?url= 并透传 JSON 契约", async () => {
    const { fb, seen } = makeFallback(async () =>
      Response.json({ code: 200, msg: "ok", data: { url: "https://cdn/x.mp4" }, platform: "douyin" })
    );
    const r = await fb("https://v.douyin.com/abc/");
    expect(seen[0].url).toBe("https://api.example.test/api/parse?url=https%3A%2F%2Fv.douyin.com%2Fabc%2F");
    expect(r?.code).toBe(200);
    expect(r?.data?.url).toBe("https://cdn/x.mp4");
  });

  it("429 → sources-down；500 → source-unavailable", async () => {
    const a = makeFallback(async () => new Response("", { status: 429 }));
    expect((await a.fb("https://x.test/v"))?.failType).toBe("sources-down");
    const b = makeFallback(async () => new Response("", { status: 500 }));
    expect((await b.fb("https://x.test/v"))?.failType).toBe("source-unavailable");
  });

  it("非 JSON 响应 → script-error 不抛", async () => {
    const { fb } = makeFallback(async () => new Response("<html>blocked</html>", { status: 200 }));
    const r = await fb("https://x.test/v");
    expect(r?.code).toBe(502);
    expect(r?.failType).toBe("script-error");
  });

  it("网络异常 → 抛出带 failType", async () => {
    const { fb } = makeFallback(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(fb("https://x.test/v")).rejects.toThrow(/线上回落网络错误/);
  });

  it("base 为空（用户清空设置）→ 直接 null，不发请求", async () => {
    let called = 0;
    const fb = createOnlineFallback({
      getBase: () => "",
      fetchImpl: (async () => {
        called++;
        return Response.json({});
      }) as typeof fetch,
    });
    expect(await fb("https://x.test/v")).toBeNull();
    expect(called).toBe(0);
  });

  it("Cookie 透传（用户自配增强）", async () => {
    const { fb, seen } = makeFallback(async () => Response.json({ code: 200, msg: "ok" }));
    await fb("https://x.test/v", { cookie: "SESSDATA=fake" });
    const headers = new Headers(seen[0].init?.headers);
    expect(headers.get("cookie")).toBe("SESSDATA=fake");
  });
});

import { describe, expect, it } from "vitest";
import { createAmagiEngine, type AmagiFetchers } from "../electron/main/amagi-engine";
import type { EngineOutcome } from "../electron/main/engines";

/**
 * amagi 引擎（v28 注册制的第二个引擎）单测：假客户端 + 假短链展开，零真网。
 * 响应形状按 amagi-response-types 的实测快照手写最小样本——多出来的字段靠索引签名
 * 兜着，引擎必须只挑契约需要的键。
 */

type Envelope = Record<string, unknown>;

/** 成功/失败出参的判空收口：断言集中在两个助手，用例里不再各自 non-null */
function okRes(o: EngineOutcome) {
  if (!o.ok || !o.result) throw new Error("期望成功结局且带 result");
  return o.result;
}
function failRes(o: EngineOutcome) {
  if (o.ok || !o.result) throw new Error("期望失败结局且带 result");
  return o.result;
}

const ok = (data: unknown): Envelope => ({ success: true, data });

/** 记录调用并返回给定信封的假客户端 */
function fakeClient(handlers: {
  douyinParseWork?: Envelope;
  biliInfo?: Envelope;
  /**
   * 取流答复。给函数就按 `cid` 各回一份——「一个分 P 一份资源」的用例必须能区分
   * 每一 P 的流，全 P 返回同一份会让「P2 用的是 P2 的 cid」这条断言失去意义。
   */
  biliStream?: Envelope | ((cid: number) => Envelope);
  biliAv2Bv?: Envelope;
  biliUserCard?: Envelope;
  ksWork?: Envelope;
  xhsNote?: Envelope;
}): { client: AmagiFetchers; calls: string[] } {
  const calls: string[] = [];
  const streamEnvelope = (cid: number): Envelope | undefined =>
    typeof handlers.biliStream === "function" ? handlers.biliStream(cid) : handlers.biliStream;
  return {
    calls,
    client: {
      douyin: {
        parseWork: async (req) => {
          calls.push(`douyin.parseWork:${req.aweme_id}`);
          return handlers.douyinParseWork ?? { success: false, error: { kind: "network", message: "stub" } };
        },
      },
      bilibili: {
        fetchVideoInfo: async (req) => {
          calls.push(`bilibili.fetchVideoInfo:${req.bvid}`);
          return handlers.biliInfo ?? { success: false, error: { kind: "network", message: "stub" } };
        },
        fetchVideoStreamUrl: async (req) => {
          calls.push(`bilibili.stream:${req.avid}/${req.cid}`);
          return (
            streamEnvelope(req.cid) ?? { success: false, error: { kind: "network", message: "stub" } }
          );
        },
        convertAvToBv: async (req) => {
          calls.push(`bilibili.convertAvToBv:${req.avid}`);
          return handlers.biliAv2Bv ?? { success: false, error: { kind: "network", message: "stub" } };
        },
        fetchUserCard: async (req) => {
          calls.push(`bilibili.fetchUserCard:${req.host_mid}`);
          return handlers.biliUserCard ?? { success: false, error: { kind: "network", message: "stub" } };
        },
      },
      kuaishou: {
        fetchVideoWork: async (req) => {
          calls.push(`kuaishou.fetchVideoWork:${req.photoId}`);
          return handlers.ksWork ?? { success: false, error: { kind: "network", message: "stub" } };
        },
      },
      xiaohongshu: {
        fetchNoteDetail: async (req) => {
          calls.push(`xiaohongshu.fetchNoteDetail:${req.note_id}:${req.xsec_token ?? ""}`);
          return handlers.xhsNote ?? { success: false, error: { kind: "network", message: "stub" } };
        },
      },
    },
  };
}

/** 测试默认不给网络：CDN 探测一律失败 → 维持主链，余下断言与真实情形一致 */
const offlineFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

function makeEngine(
  client: AmagiFetchers,
  expandUrl?: (url: string) => Promise<string | null>,
  fetchImpl: typeof fetch = offlineFetch
) {
  return createAmagiEngine({
    getCookie: () => "",
    makeClient: () => client,
    expandUrl,
    fetchImpl,
  });
}

describe("amagi 引擎：抖音映射", () => {
  it("视频作品：playwm 换 play 去水印，计数进 stat，作者信息齐", async () => {
    const { client } = fakeClient({
      douyinParseWork: ok({
        aweme_detail: {
          aweme_id: "7401234567890123456",
          desc: "秋日通勤穿搭",
          author: {
            nickname: "小明",
            signature: "每周三更新",
            uid: "10086",
            sec_uid: "MS4wLjABAAA",
            avatar_thumb: { url_list: ["https://p.douyinpic.com/ava.jpg"] },
          },
          statistics: { digg_count: 12000, comment_count: 340, collect_count: 500, share_count: 60, play_count: 900000 },
          video: {
            duration: 43210,
            cover: { url_list: ["https://p.douyinpic.com/cover.jpeg"] },
            play_addr: { url_list: ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00fg"] },
          },
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "douyin", url: "https://www.douyin.com/video/7401234567890123456" })
    );
    expect(r.code).toBe(200);
    expect(r.data?.type).toBe("video");
    expect(r.data?.url).toContain("/aweme/v1/play/?video_id=");
    expect(r.data?.author).toBe("小明");
    expect(r.data?.authorUrl).toBe("https://www.douyin.com/user/MS4wLjABAAA");
    expect(r.data?.stat).toEqual({ like: 12000, reply: 340, favorite: 500, share: 60, view: 900000 });
    expect(r.data?.duration).toBe(43210);
  });

  it("图集作品：images 取 url_list 末位（最高清），url 让位", async () => {
    const { client } = fakeClient({
      douyinParseWork: ok({
        aweme_detail: {
          aweme_id: "7401234567890123457",
          desc: "图集分享",
          images: [
            { url_list: ["https://p.douyinpic.com/img-1-low.jpeg", "https://p.douyinpic.com/img-1.jpeg"] },
            { url_list: ["https://p.douyinpic.com/img-2.jpeg"] },
          ],
          video: { duration: 0 },
          author: { nickname: "图集作者" },
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "douyin", url: "https://www.douyin.com/note/7401234567890123457" })
    );
    expect(r.data?.type).toBe("image");
    expect(r.data?.images).toEqual(["https://p.douyinpic.com/img-1.jpeg", "https://p.douyinpic.com/img-2.jpeg"]);
    expect(r.data?.url).toBeUndefined();
  });

  it("失败信封：kind 归因到 code/failType（risk → bot-gated）", async () => {
    const { client } = fakeClient({
      douyinParseWork: { success: false, error: { kind: "risk", code: "CAPTCHA_REQUIRED", message: "请完成验证" } },
    });
    const r = failRes(
      await makeEngine(client).run({ platform: "douyin", url: "https://www.douyin.com/video/7401234567890123456" })
    );
    expect(r.code).toBe(403);
    expect(r.failType).toBe("bot-gated");
    // 上游原文优先，但细码不许丢：只有 CAPTCHA_REQUIRED / LOGIN_REQUIRED 这类细码
    // 才分得开「该去完成验证」与「该去补 Cookie」，拼接格式本身不作断言
    expect(r.msg).toContain("请完成验证");
    expect(r.msg).toContain("CAPTCHA_REQUIRED");
  });
});

describe("amagi 引擎：B站映射", () => {
  it("取流成功：dash 首档为主链，accept_quality 对齐 support_formats 出档位表，毫秒换算", async () => {
    const { client, calls } = fakeClient({
      biliInfo: ok({
        aid: 170001,
        bvid: "BV1xx411c7mD",
        cid: 279786,
        title: "测试视频",
        desc: "简介",
        duration: 300,
        pic: "https://i0.hdslb.com/cover.jpg",
        owner: { mid: 123, name: "UP主", face: "https://i0.hdslb.com/face.jpg" },
        stat: { view: 1000, danmaku: 10, reply: 20, favorite: 30, coin: 40, share: 50, like: 60 },
      }),
      biliStream: ok({
        accept_quality: [116, 80],
        support_formats: [{ quality: 116, display_desc: "高清 1080P60" }, { quality: 80, display_desc: "高清 1080P" }],
        dash: {
          video: [
            { id: 116, baseUrl: "https://upos.hdslb.com/116.m4s", backup_url: ["https://upos.hdslb.com/116-b.m4s"] },
            { id: 80, baseUrl: "https://upos.hdslb.com/80.m4s" },
          ],
          audio: [{ baseUrl: "https://upos.hdslb.com/audio.m4s" }],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(calls).toContain("bilibili.stream:170001/279786");
    expect(r.data?.duration).toBe(300000);
    expect(r.data?.url).toBe("https://upos.hdslb.com/116.m4s");
    expect(r.data?.qualities).toEqual([
      { quality: 116, label: "高清 1080P60", url: "https://upos.hdslb.com/116.m4s" },
      { quality: 80, label: "高清 1080P", url: "https://upos.hdslb.com/80.m4s" },
    ]);
    expect(r.data?.audioUrl).toBe("https://upos.hdslb.com/audio.m4s");
  });

  it("dash 档位的 codecs/mimeType 一路带到契约（MSE 预览建 SourceBuffer 用）", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "MSE", duration: 60 }),
      biliStream: ok({
        accept_quality: [80, 64],
        support_formats: [{ quality: 80, display_desc: "高清 1080P" }],
        dash: {
          video: [
            { id: 80, baseUrl: "https://upos.hdslb.com/80.m4s", codecs: "avc1.64001f", mimeType: "video/mp4" },
            { id: 64, baseUrl: "https://upos.hdslb.com/64.m4s", codecs: "hev1.1.6.L120.90", mimeType: "video/mp4" },
          ],
          audio: [{ baseUrl: "https://upos.hdslb.com/a.m4s", codecs: "mp4a.40.2", mimeType: "audio/mp4" }],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.qualities).toEqual([
      { quality: 80, label: "高清 1080P", url: "https://upos.hdslb.com/80.m4s", codecs: "avc1.64001f", mimeType: "video/mp4" },
      { quality: 64, label: "64", url: "https://upos.hdslb.com/64.m4s", codecs: "hev1.1.6.L120.90", mimeType: "video/mp4" },
    ]);
    expect(r.data?.videoCodecs).toBe("avc1.64001f");
    expect(r.data?.videoMimeType).toBe("video/mp4");
    expect(r.data?.audioCodecs).toBe("mp4a.40.2");
    expect(r.data?.audioMimeType).toBe("audio/mp4");
  });

  it("CDN 探测：PCDN 主链更慢时，档位与音轨一并切到镜像；缺镜像位的档位退回主链", async () => {
    const { client } = fakeClient({
      biliInfo: ok({
        aid: 170001,
        bvid: "BV1xx411c7mD",
        cid: 279786,
        title: "镜像探测",
        duration: 60,
        owner: { mid: 123, name: "UP主" },
      }),
      biliStream: ok({
        accept_quality: [80, 64],
        support_formats: [{ quality: 80, display_desc: "高清 1080P" }],
        dash: {
          video: [
            {
              id: 80,
              baseUrl: "https://xy1.mcdn.bilivideo.cn:8082/80.m4s",
              backup_url: ["https://fast.example/80.m4s"],
            },
            // 这一档只有主链：槽位不存在时必须退回主链，不能张冠李戴
            { id: 64, baseUrl: "https://xy1.mcdn.bilivideo.cn:8082/64.m4s" },
          ],
          audio: [
            {
              baseUrl: "https://xy1.mcdn.bilivideo.cn:8082/a.m4s",
              backup_url: ["https://fast.example/a.m4s"],
            },
          ],
        },
      }),
    });
    const probed: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      probed.push(new URL(url).hostname);
      if (url.includes("mcdn.bilivideo.cn")) {
        // 慢主链：先拖 40ms，再给 4KB —— 有数据但明显慢于镜像
        await new Promise((res) => setTimeout(res, 40));
        return new Response(
          new ReadableStream({
            start: (c) => {
              c.enqueue(new Uint8Array(4096));
              c.close();
            },
          }),
          { status: 206 }
        );
      }
      return new Response(
        new ReadableStream({
          start: (c) => {
            c.enqueue(new Uint8Array(64 * 1024));
            c.close();
          },
        }),
        { status: 206 }
      );
    }) as unknown as typeof fetch;

    const r = okRes(
      await makeEngine(
        client,
        undefined,
        fakeFetch
      ).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(probed).toContain("xy1.mcdn.bilivideo.cn");
    expect(probed).toContain("fast.example");
    expect(r.data?.url).toBe("https://fast.example/80.m4s");
    expect(r.data?.qualities).toEqual([
      { quality: 80, label: "高清 1080P", url: "https://fast.example/80.m4s" },
      { quality: 64, label: "64", url: "https://xy1.mcdn.bilivideo.cn:8082/64.m4s" },
    ]);
    expect(r.data?.audioUrl).toBe("https://fast.example/a.m4s");
  });

  it("CDN 探测全部失败：维持主链，解析照常成功", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "离线", duration: 60 }),
      biliStream: ok({
        dash: {
          video: [
            {
              id: 80,
              baseUrl: "https://xy1.mcdn.bilivideo.cn:8082/80.m4s",
              backup_url: ["https://fast.example/80.m4s"],
            },
          ],
          audio: [{ baseUrl: "https://xy1.mcdn.bilivideo.cn:8082/a.m4s" }],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.url).toBe("https://xy1.mcdn.bilivideo.cn:8082/80.m4s");
    expect(r.data?.audioUrl).toBe("https://xy1.mcdn.bilivideo.cn:8082/a.m4s");
  });

  it("取流失败仍交出稿件元数据（ok=true，无直链）", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "测试", duration: 60 }),
      biliStream: { success: false, error: { kind: "forbidden", message: "需要登录" } },
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.title).toBe("测试");
    expect(r.data?.url).toBeUndefined();
    expect(r.data?.qualities).toBeUndefined();
  });

  it("双层信封 + 未登录 durl：下钻 data.data、cid 取 pages[0]，标签按 quality 对齐（不许虚标 720P）", async () => {
    const { client, calls } = fakeClient({
      biliInfo: ok({
        code: 0,
        message: "OK",
        ttl: 1,
        data: {
          aid: 80433022,
          bvid: "BV1GJ411x7h7",
          title: "嵌套稿件",
          duration: 213,
          pic: "https://i0.hdslb.com/c.jpg",
          owner: { mid: 9, name: "UP" },
          stat: { view: 1 },
          // 正片分 P：顶层没有 cid，只有 pages[]
          pages: [{ cid: 137649199, page: 1 }],
        },
      }),
      // 2026-10-21 真机实测的未登录形状：html5 通道只给 qn=16（360P），
      // 而 accept_description 的**第一项**是 720P —— 取 [0] 就会把 360P 标成 720P
      biliStream: ok({
        code: 0,
        message: "OK",
        ttl: 1,
        data: {
          quality: 16,
          format: "mp4",
          accept_quality: [64, 16],
          accept_description: ["高清 720P", "流畅 360P"],
          durl: [{ order: 1, url: "https://upos.hdslb.com/single.mp4", length: 212394 }],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1GJ411x7h7" })
    );
    expect(r.data?.title).toBe("嵌套稿件");
    expect(r.data?.bvid).toBe("BV1GJ411x7h7");
    // durl 是渐进式单文件：主链与唯一档位都取它，不许冒充「音频流」
    expect(r.data?.url).toBe("https://upos.hdslb.com/single.mp4");
    expect(r.data?.qualities).toEqual([
      { quality: 16, label: "流畅 360P", url: "https://upos.hdslb.com/single.mp4" },
    ]);
    expect(r.data?.audioUrl).toBeUndefined();
    // cid 从 pages[0].cid 取到才会去请求取流
    expect(calls).toContain("bilibili.stream:80433022/137649199");
  });

  it("durl 分段（旧式稿件）：不把第一段当整片——交元数据但不给直链", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "分段稿件", duration: 900 }),
      biliStream: ok({
        data: {
          quality: 16,
          accept_quality: [16],
          accept_description: ["流畅 360P"],
          durl: [
            { order: 1, url: "https://upos.hdslb.com/part-1.mp4" },
            { order: 2, url: "https://upos.hdslb.com/part-2.mp4" },
          ],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.title).toBe("分段稿件");
    // 只取第一段等于交付半截视频（预览也只播开头），宁可不出直链
    expect(r.data?.url).toBeUndefined();
    expect(r.data?.qualities).toBeUndefined();
  });

  it("av 号链接：convertAvToBv 换算 bvid 后走稿件通道", async () => {
    const { client, calls } = fakeClient({
      biliAv2Bv: ok({ bvid: "BV1xx411c7mD" }),
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "av 号视频", duration: 60 }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/av170001" })
    );
    expect(calls).toContain("bilibili.convertAvToBv:170001");
    expect(calls).toContain("bilibili.fetchVideoInfo:BV1xx411c7mD");
    expect(r.data?.title).toBe("av 号视频");
    expect(r.data?.bvid).toBe("BV1xx411c7mD");
  });

  it("同一个 qn 的 AVC/HEVC 双流归并成一档（优选 codecid 7），档位按清晰度降序、主链取最高", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "双编码", duration: 60 }),
      biliStream: ok({
        accept_quality: [80, 64],
        support_formats: [
          { quality: 80, display_desc: "高清 1080P" },
          { quality: 64, display_desc: "高清 720P" },
        ],
        dash: {
          // 服务端顺序不保证：低档在前、同档 HEVC 在前
          video: [
            { id: 64, baseUrl: "https://upos.hdslb.com/64-avc.m4s", codecid: 7, bandwidth: 900 },
            { id: 80, baseUrl: "https://upos.hdslb.com/80-hevc.m4s", codecid: 12, bandwidth: 2000 },
            { id: 80, baseUrl: "https://upos.hdslb.com/80-avc.m4s", codecid: 7, bandwidth: 1800 },
          ],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    // 同一 1080P 只留一条，且是 AVC（HEVC 兼容性更差，哪怕带宽更高）
    expect(r.data?.qualities).toEqual([
      { quality: 80, label: "高清 1080P", url: "https://upos.hdslb.com/80-avc.m4s" },
      { quality: 64, label: "高清 720P", url: "https://upos.hdslb.com/64-avc.m4s" },
    ]);
    expect(r.data?.url).toBe("https://upos.hdslb.com/80-avc.m4s");
  });

  it("support_formats 与 accept_quality 顺序不一致时按 quality 对齐：不能出现两个 1080P", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "乱序清单", duration: 60 }),
      biliStream: ok({
        accept_quality: [112, 80, 64],
        // 真机上这两份清单的顺序不保证一致：按下标索引会把 112 取成 720P 的名字
        support_formats: [
          { quality: 64, display_desc: "高清 720P" },
          { quality: 112, display_desc: "高清 1080P+" },
          { quality: 80, display_desc: "高清 1080P" },
        ],
        dash: {
          video: [
            { id: 112, baseUrl: "https://upos.hdslb.com/112.m4s", codecid: 7 },
            { id: 80, baseUrl: "https://upos.hdslb.com/80.m4s", codecid: 7 },
          ],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    const labels = (r.data?.qualities ?? []).map((q) => q.label);
    expect(labels).toEqual(["高清 1080P+", "高清 1080P"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("B站作者资料：名片补粉丝/关注/投稿数/获赞，签名取稿件 owner", async () => {
    const { client, calls } = fakeClient({
      biliInfo: ok({
        aid: 170001,
        bvid: "BV1xx411c7mD",
        cid: 279786,
        title: "作者资料",
        duration: 10,
        owner: { mid: 546195, name: "老番茄", face: "https://i0.hdslb.com/f.jpg", sign: "稿件签名" },
      }),
      biliStream: ok({
        dash: { video: [{ id: 80, baseUrl: "https://upos.hdslb.com/80.m4s", codecid: 7 }] },
        accept_quality: [80],
        support_formats: [{ quality: 80, display_desc: "高清 1080P" }],
      }),
      biliUserCard: ok({
        card: { mid: 546195, fans: 20854339, attention: 7, sign: "名片签名" },
        archive_count: 682,
        like_num: 196353489,
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(calls).toContain("bilibili.fetchUserCard:546195");
    expect(r.data?.followerCount).toBe(20854339);
    expect(r.data?.followingCount).toBe(7);
    expect(r.data?.videoCount).toBe(682);
    expect(r.data?.totalFavorited).toBe(196353489);
    // 两处都有签名时以稿件详情为准，名片只补稿件侧没有的计数
    expect(r.data?.sign).toBe("稿件签名");
  });

  it("B站名片的双层信封要拆：真实返回是 { code, data: { card, archive_count… } }", async () => {
    // 2026-10-21 线上事故回归守卫：名片与稿件/取流同一个双层信封，只取 env.data 时
    // `card.fans` / `archive_count` 全读不到，界面上就是「作者卡片只有名字、没有统计」。
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "双层名片", duration: 10, owner: { mid: 546195, name: "老番茄" } }),
      biliStream: ok({ dash: { video: [{ id: 80, baseUrl: "https://upos.hdslb.com/80.m4s", codecid: 7 }] } }),
      biliUserCard: ok({
        code: 0,
        message: "0",
        ttl: 1,
        data: {
          card: { mid: "546195", fans: 20854339, attention: 7, sign: "名片签名" },
          archive_count: 682,
          like_num: 196353489,
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.followerCount).toBe(20854339);
    expect(r.data?.followingCount).toBe(7);
    expect(r.data?.videoCount).toBe(682);
    expect(r.data?.totalFavorited).toBe(196353489);
    // 稿件没给签名时退到名片那份，不能因为换了形状就丢
    expect(r.data?.sign).toBe("名片签名");
  });

  it("B站名片取不到时不拖垮解析：稿件照出，只是少了作者统计", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "无名片", duration: 10, owner: { mid: 5, name: "UP" } }),
      biliStream: ok({ dash: { video: [{ id: 80, baseUrl: "https://upos.hdslb.com/80.m4s", codecid: 7 }] } }),
      // 名片缺省 = 失败信封
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.author).toBe("UP");
    expect(r.data?.followerCount).toBeUndefined();
    expect(r.data?.url).toBe("https://upos.hdslb.com/80.m4s");
  });

  it("多音轨取带宽最高的一条（同带宽优先 mp4a），不赌数组顺序", async () => {
    const { client } = fakeClient({
      biliInfo: ok({ aid: 170001, bvid: "BV1xx411c7mD", cid: 279786, title: "多音轨", duration: 60 }),
      biliStream: ok({
        dash: {
          video: [{ id: 80, baseUrl: "https://upos.hdslb.com/80.m4s", codecid: 7 }],
          audio: [
            { id: 30216, baseUrl: "https://upos.hdslb.com/64k.m4s", bandwidth: 64000, mimeType: "audio/mp4" },
            { id: 30280, baseUrl: "https://upos.hdslb.com/192k.m4s", bandwidth: 192000, mimeType: "audio/mp4" },
            { id: 30232, baseUrl: "https://upos.hdslb.com/132k.m4s", bandwidth: 132000, mimeType: "audio/mp4" },
          ],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.audioUrl).toBe("https://upos.hdslb.com/192k.m4s");
  });

  it("分 P 链接 ?p=2：每一 P 各取一份流，主链是这一 P 的 DASH", async () => {
    const { client, calls } = fakeClient({
      biliInfo: ok({
        aid: 170001,
        bvid: "BV1xx411c7mD",
        // 合集信息：顶层没有 cid，duration 是**整合集总时长**
        title: "教程合集",
        duration: 6000,
        pic: "https://i0.hdslb.com/p1.jpg",
        pages: [
          { cid: 111, page: 1, part: "开场", duration: 100, pic: "https://i0.hdslb.com/p1.jpg" },
          { cid: 222, page: 2, part: "实操", duration: 300, pic: "https://i0.hdslb.com/p2.jpg" },
        ],
      }),
      // 每一 P 一份流：两条的直链、音轨、时长都不同，混用就会立刻在断言上露出来
      biliStream: (cid) =>
        ok(
          cid === 222
            ? {
                quality: 80,
                timelength: 300000,
                accept_quality: [80],
                support_formats: [{ quality: 80, display_desc: "高清 1080P" }],
                dash: {
                  video: [{ id: 80, baseUrl: "https://upos.hdslb.com/p2-80.m4s", codecid: 7, codecs: "avc1.640032", mimeType: "video/mp4" }],
                  audio: [{ id: 30280, baseUrl: "https://upos.hdslb.com/p2-a.m4s", bandwidth: 192000, codecs: "mp4a.40.2", mimeType: "audio/mp4" }],
                },
              }
            : {
                quality: 80,
                timelength: 100000,
                accept_quality: [80],
                support_formats: [{ quality: 80, display_desc: "高清 1080P" }],
                dash: {
                  video: [{ id: 80, baseUrl: "https://upos.hdslb.com/p1-80.m4s", codecid: 7, codecs: "avc1.640032", mimeType: "video/mp4" }],
                  audio: [{ id: 30280, baseUrl: "https://upos.hdslb.com/p1-a.m4s", bandwidth: 192000, codecs: "mp4a.40.2", mimeType: "audio/mp4" }],
                },
              }
        ),
    });
    const r = okRes(
      await makeEngine(client).run({
        platform: "bilibili",
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2&vd_source=abc",
      })
    );
    // 指哪一 P 就把主链落在哪一 P：拿 pages[0] 会把 P1 的流当 P2 交付
    expect(calls).toContain("bilibili.stream:170001/222");
    expect(r.data?.url).toBe("https://upos.hdslb.com/p2-80.m4s");
    expect(r.data?.audioUrl).toBe("https://upos.hdslb.com/p2-a.m4s");
    expect(r.data?.page).toBe(2);
    expect(r.data?.cover).toBe("https://i0.hdslb.com/p2.jpg");
    // 时长取这一 P（timelength 是这次取流的真实毫秒数），不是合集总时长
    expect(r.data?.duration).toBe(300000);
    // 「一个分 P 就是一份资源」：两条各带自己的音轨与身份，谁也不借谁的
    expect(r.data?.videos).toEqual([
      {
        page: 1,
        title: "开场",
        url: "https://upos.hdslb.com/p1-80.m4s",
        duration: 100000,
        cover: "https://i0.hdslb.com/p1.jpg",
        qualities: [{ quality: 80, label: "高清 1080P", url: "https://upos.hdslb.com/p1-80.m4s", codecs: "avc1.640032", mimeType: "video/mp4" }],
        audioUrl: "https://upos.hdslb.com/p1-a.m4s",
        videoCodecs: "avc1.640032",
        videoMimeType: "video/mp4",
        audioCodecs: "mp4a.40.2",
        audioMimeType: "audio/mp4",
      },
      {
        page: 2,
        title: "实操",
        url: "https://upos.hdslb.com/p2-80.m4s",
        duration: 300000,
        cover: "https://i0.hdslb.com/p2.jpg",
        qualities: [{ quality: 80, label: "高清 1080P", url: "https://upos.hdslb.com/p2-80.m4s", codecs: "avc1.640032", mimeType: "video/mp4" }],
        audioUrl: "https://upos.hdslb.com/p2-a.m4s",
        videoCodecs: "avc1.640032",
        videoMimeType: "video/mp4",
        audioCodecs: "mp4a.40.2",
        audioMimeType: "audio/mp4",
      },
    ]);
    // 标题是合集名：P 的区分由 `page`（渲染层落进文件名）承担，
    // 把 `P2 ·` 写进标题会跟着进每一条分 P 的文件名，名字与实际对不上
    expect(r.data?.title).toBe("教程合集");
  });

  it("某一 P 取流失败：这一 P 缺席，其余照常成资源且编号不错位", async () => {
    const { client } = fakeClient({
      biliInfo: ok({
        aid: 5,
        bvid: "BV1xx411c7mD",
        title: "三 P 稿件",
        duration: 90,
        pages: [
          { cid: 111, page: 1, part: "一", duration: 30 },
          { cid: 222, page: 2, part: "二", duration: 30 },
          { cid: 333, page: 3, part: "三", duration: 30 },
        ],
      }),
      // 中间那一 P 加密/风控拿不到流：不能把它硬凑成一条下不动的资源，也不能让整次解析白跑
      biliStream: (cid) =>
        cid === 222
          ? { success: false, error: { kind: "network", message: "stub" } }
          : ok({ dash: { video: [{ id: 16, baseUrl: `https://upos.hdslb.com/${cid}.m4s`, codecid: 7 }] } }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect((r.data?.videos ?? []).map((v) => v.page)).toEqual([1, 3]);
    // 编号认 `page` 不认下标：按数组下标报「分 P 2」就把名字贴到了真正的第三 P 上
    expect((r.data?.videos ?? []).map((v) => v.url)).toEqual([
      "https://upos.hdslb.com/111.m4s",
      "https://upos.hdslb.com/333.m4s",
    ]);
  });

  it("分 P 取流没回 timelength：时长退回 pages[].duration，仍不许用合集总时长", async () => {
    const { client } = fakeClient({
      biliInfo: ok({
        aid: 1,
        bvid: "BV1xx411c7mD",
        title: "合集",
        duration: 6000,
        pages: [
          { cid: 111, page: 1, part: "一", duration: 5000 },
          { cid: 222, page: 2, part: "二", duration: 1000 },
        ],
      }),
      biliStream: ok({
        dash: { video: [{ id: 80, baseUrl: "https://upos.hdslb.com/x.m4s", codecid: 7 }] },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2" })
    );
    // MSE 拿这个值写 MediaSource.duration：写成 6000s 会让进度条超出实际流，拖过去就永久转圈
    expect(r.data?.duration).toBe(1000000);
  });

  it("分 P 越界（?p=9 只有 2 P）：夹到最后一 P，不给一条解不出来的序号", async () => {
    const { client, calls } = fakeClient({
      biliInfo: ok({
        aid: 7,
        bvid: "BV1xx411c7mD",
        title: "两 P 稿件",
        duration: 60,
        pages: [
          { cid: 111, page: 1, part: "一", duration: 30 },
          { cid: 222, page: 2, part: "二", duration: 30 },
        ],
      }),
      biliStream: ok({ dash: { video: [{ id: 16, baseUrl: "https://upos.hdslb.com/f.m4s", codecid: 7 }] } }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD?p=9" })
    );
    expect(calls).toContain("bilibili.stream:7/222");
    expect(r.data?.page).toBe(2);
    // 夹到末位后标题仍是合集名，区分靠 `page`；`P2 ·` 写进标题会污染每一条分 P 的文件名
    expect(r.data?.title).toBe("两 P 稿件");
  });

  it("短链带的 ?p=3 在落点没写序号时接着用：不能悄悄退回 P1", async () => {
    const { client, calls } = fakeClient({
      biliInfo: ok({
        aid: 9,
        bvid: "BV1xx411c7mD",
        title: "短链合集",
        duration: 90,
        pages: [
          { cid: 111, page: 1, part: "一", duration: 30 },
          { cid: 222, page: 2, part: "二", duration: 30 },
          { cid: 333, page: 3, part: "三", duration: 30 },
        ],
      }),
      biliStream: ok({ dash: { video: [{ id: 16, baseUrl: "https://upos.hdslb.com/s.m4s", codecid: 7 }] } }),
    });
    const r = okRes(
      await makeEngine(client, async (u) =>
        u.includes("b23.tv") ? "https://www.bilibili.com/video/BV1xx411c7mD" : u
      ).run({ platform: "bilibili", url: "https://b23.tv/abcd?p=3" })
    );
    expect(calls).toContain("bilibili.stream:9/333");
    expect(r.data?.page).toBe(3);
  });

  it("单 P 稿件不加 P 标记、也不动时长口径：顶层 duration 就是这一条的长度", async () => {
    const { client } = fakeClient({
      biliInfo: ok({
        aid: 3,
        bvid: "BV1xx411c7mD",
        cid: 279786,
        title: "单 P 视频",
        duration: 213,
        pic: "https://i0.hdslb.com/one.jpg",
        pages: [{ cid: 279786, page: 1, part: "单 P 视频", duration: 213 }],
      }),
      biliStream: ok({ dash: { video: [{ id: 80, baseUrl: "https://upos.hdslb.com/one.m4s", codecid: 7 }] } }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" })
    );
    expect(r.data?.title).toBe("单 P 视频");
    expect(r.data?.duration).toBe(213000);
    expect(r.data?.cover).toBe("https://i0.hdslb.com/one.jpg");
    // 单 P 不标 P：文件名与标签里那个「P1」是白挂的区分位
    expect(r.data?.page).toBeUndefined();
    // 清单仍只有这一条，且与主链同一条直链（渲染层按 URL 去重，不会下两遍）
    expect((r.data?.videos ?? []).map((v) => v.url)).toEqual(["https://upos.hdslb.com/one.m4s"]);
  });
});

describe("amagi 引擎：快手与小红书映射", () => {
  it("快手图集：atlas.list 出图，mainMvUrls 让位", async () => {
    const { client } = fakeClient({
      ksWork: ok({
        result: 1,
        atlas: { type: 1, list: ["https://tx2.a.kwimgs.com/atlas-1.jpg", "https://tx2.a.kwimgs.com/atlas-2.jpg"] },
        photo: {
          photoId: "3xAbCdEf",
          photoType: "VERTICAL_ATLAS",
          singlePicture: true,
          caption: "图集作品",
          duration: 0,
          userName: "快手作者",
          userId: 666,
          userEid: "3xhm7mmxrcewj92",
          headUrl: "https://tx2.a.kwimgs.com/ava.jpg",
          likeCount: 11,
          commentCount: 2,
          viewCount: 300,
          forwardCount: 1,
          coverUrls: [{ url: "https://tx2.a.kwimgs.com/cover.jpg" }],
        },
      }),
    });
    const r = okRes(await makeEngine(client).run({ platform: "kuaishou", url: "https://www.kuaishou.com/short-video/3xAbCdEf" }));
    expect(r.data?.type).toBe("image");
    expect(r.data?.images).toHaveLength(2);
    expect(r.data?.authorUrl).toBe("https://www.kuaishou.com/profile/3xhm7mmxrcewj92");
    expect(r.data?.retweets).toBe(1);
  });

  it("小红书：note_id + xsec_token 透传给取数方法；视频笔记走 h264 主链", async () => {
    const { client, calls } = fakeClient({
      xhsNote: ok({
        items: [
          {
            note_card: {
              note_id: "aabbccddeeff001122334455",
              title: "笔记标题",
              desc: "笔记正文",
              type: "video",
              user: { userid: "5ff0e6410000000001008400", nickname: "薯队长", avatar: "https://sns-avatar.xhscdn.com/a.jpg" },
              interact_info: { liked_count: "1.2万" },
              video: {
                capa: { duration: 95400 },
                media: { stream: { h264: [{ master_url: "https://sns-video.xhscdn.com/master.mp4" }] } },
              },
              image_list: [{ url_default: "https://sns-img.xhscdn.com/cover.jpg" }],
            },
          },
        ],
      }),
    });
    const r = okRes(
      await makeEngine(client).run({
        platform: "redbook",
        url: "https://www.xiaohongshu.com/explore/aabbccddeeff001122334455?xsec_token=ABCd-_-123",
      })
    );
    expect(calls).toContain("xiaohongshu.fetchNoteDetail:aabbccddeeff001122334455:ABCd-_-123");
    expect(r.data?.type).toBe("video");
    expect(r.data?.url).toBe("https://sns-video.xhscdn.com/master.mp4");
    expect(r.data?.like).toBe(12000);
    expect(r.data?.cover).toBe("https://sns-img.xhscdn.com/cover.jpg");
  });

  it("小红书双层信封要拆：真实返回是 { code, data: { items }, msg, success }", async () => {
    // 与 B 站名片同族：body 的 `data` 之下才是 `items`，只读一层会走到「响应里没有笔记详情」
    const { client } = fakeClient({
      xhsNote: ok({
        code: 0,
        success: true,
        msg: "success",
        data: {
          cursor_score: "1.23",
          current_time: 1759000000,
          items: [
            {
              id: "aabbccddeeff001122334455",
              ignore: false,
              model_type: "note",
              note_card: {
                note_id: "aabbccddeeff001122334455",
                title: "双层笔记",
                desc: "正文",
                type: "normal",
                user: { userid: "5ff0e6410000000001008400", nickname: "薯队长", avatar: "https://sns-avatar.xhscdn.com/a.jpg" },
                interact_info: { liked_count: 42 },
                image_list: [{ url_default: "https://sns-img.xhscdn.com/cover.jpg" }],
              },
            },
          ],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({
        platform: "redbook",
        url: "https://www.xiaohongshu.com/explore/aabbccddeeff001122334455?xsec_token=ABCd-_-123",
      })
    );
    expect(r.data?.title).toBe("双层笔记");
    expect(r.data?.author).toBe("薯队长");
    expect(r.data?.cover).toBe("https://sns-img.xhscdn.com/cover.jpg");
    expect(r.data?.like).toBe(42);
  });

  it("快手作者统计：同一份载荷的 counts 直接进作者快照，不用另发请求", async () => {
    const { client } = fakeClient({
      ksWork: ok({
        result: 1,
        counts: { fanCount: 12345, followCount: 67, photoCount: 890, collectionCount: 12 },
        photo: {
          photoId: "3xCounts01",
          photoType: "VIDEO",
          caption: "作者统计",
          duration: 8000,
          userName: "快手作者",
          userId: 666,
          userEid: "3xhm7mmxrcewj92",
          mainMvUrls: [{ url: "https://tx2.a.kwimgs.com/v.mp4" }],
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "kuaishou", url: "https://www.kuaishou.com/short-video/3xCounts01" })
    );
    expect(r.data?.followerCount).toBe(12345);
    expect(r.data?.followingCount).toBe(67);
    expect(r.data?.videoCount).toBe(890);
  });

  it("快手视频：manifest 多档出 qualities，最高档作主链", async () => {
    const { client } = fakeClient({
      ksWork: ok({
        result: 1,
        photo: {
          photoId: "3xVideo01",
          photoType: "VIDEO",
          caption: "多档视频",
          duration: 15000,
          userName: "快手作者",
          userId: 666,
          userEid: "3xhm7mmxrcewj92",
          likeCount: 11,
          commentCount: 2,
          viewCount: 300,
          mainMvUrls: [{ url: "https://tx2.a.kwimgs.com/low.mp4" }],
          coverUrls: [{ url: "https://tx2.a.kwimgs.com/cover.jpg" }],
          manifest: {
            adaptationSet: [
              {
                representation: [
                  { url: "https://tx2.a.kwimgs.com/720p.mp4", height: 720, qualityLabel: "高清" },
                  { url: "https://tx2.a.kwimgs.com/1080p.mp4", height: 1080, qualityLabel: "超清" },
                  { url: "https://tx2.a.kwimgs.com/480p.mp4", height: 480, qualityLabel: "标清" },
                ],
              },
            ],
          },
        },
      }),
    });
    const r = okRes(
      await makeEngine(client).run({ platform: "kuaishou", url: "https://www.kuaishou.com/short-video/3xVideo01" })
    );
    expect(r.data?.type).toBe("video");
    expect(r.data?.url).toBe("https://tx2.a.kwimgs.com/1080p.mp4");
    expect(r.data?.qualities?.map((q) => q.quality)).toEqual([1080, 720, 480]);
    expect(r.data?.qualities?.[0].label).toBe("超清");
  });

  it("代理：manual 合法地址 → requestConfig.proxy；system / 非法地址 → 不下发", async () => {
    const base = fakeClient({}).client;
    const seen: Array<import("../electron/main/amagi-engine").AmagiRequestConfig | undefined> = [];
    const make = (proxy: () => { mode: "system" | "manual" | "direct"; url: string }) =>
      createAmagiEngine({
        getCookie: () => "",
        getProxyConfig: proxy,
        makeClient: (_cookies, requestConfig) => {
          seen.push(requestConfig);
          return base;
        },
      });
    const url = "https://www.douyin.com/video/7401234567890123456";
    await make(() => ({ mode: "manual", url: "127.0.0.1:7897" })).run({ platform: "douyin", url });
    await make(() => ({ mode: "manual", url: "http://127.0.0.1:8080" })).run({ platform: "douyin", url });
    await make(() => ({ mode: "manual", url: "不是地址" })).run({ platform: "douyin", url });
    await make(() => ({ mode: "system", url: "" })).run({ platform: "douyin", url });
    await make(() => ({ mode: "direct", url: "127.0.0.1:7897" })).run({ platform: "douyin", url });
    expect(seen).toEqual([
      { proxy: { host: "127.0.0.1", port: 7897 } },
      { proxy: { host: "127.0.0.1", port: 8080 } },
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("短链：先展开再抽 ID", async () => {
    const { client, calls } = fakeClient({
      douyinParseWork: ok({
        aweme_detail: {
          aweme_id: "7401234567890123456",
          desc: "短链解析",
          author: {},
          video: { play_addr: { url_list: ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00ff"] } },
        },
      }),
    });
    const r = okRes(
      await makeEngine(
        client,
        async (u) => (u.includes("v.douyin.com") ? "https://www.douyin.com/video/7401234567890123456" : u)
      ).run({ platform: "douyin", url: "https://v.douyin.com/iAbCdEf/" })
    );
    expect(r.data?.title).toBe("短链解析");
    expect(calls).toContain("douyin.parseWork:7401234567890123456");
  });
});

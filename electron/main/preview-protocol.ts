/**
 * 预览取流代理（业主定调 2026-10-18：放开 CSP + 主进程代理取流）。
 *
 * 结果卡的 `<video>` / `<audio>` 直接吃平台直链必失败，两层都堵着：渲染层 CSP 只放行
 * `'self'`（媒体外链违反 `default-src`，控制台里是策略拦截而不是网络错误），而防盗链要求
 * 的那对 `Referer` + 桌面 UA 只有主进程能带——媒体元素发出的请求改不了请求头。
 * 于是渲染层只拿到一条 `mgpreview://media/?u=<编码后的直链>`，真正去取流的是这里。
 *
 * 失败只回状态码、不写日志：这条处理器在每个 Range 请求上都会跑，逐条留档没有诊断价值
 * （真正的现场在下载侧的 `[download]` 行）；代理链里的地址在解链时再过一次
 * 安全闸（`shared/preview-link.ts`），所以这条处理器不构成「替渲染层访问任意地址」的通道。
 *
 * 取流用 Node `fetch`，不用 `net.fetch`：实测（electron 44.7.2 最小复现）在 `protocol.handle`
 * 内部调 `net.fetch` 会撞 `net::ERR_BLOCKED_BY_CLIENT`——同一条 URL 在主进程直接调是 200，
 * 换成由代理链发起就被 Chromium 的本机网络访问检查拦下（发起方是自定义 scheme，没有内网
 * 身份可核对）。Node 侧走 undici，不吃这套策略，而且与解析内核、下载器同一条栈，
 * 代理设置由 `applyProxy` 的全局 dispatcher 一并覆盖。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { isPublicFinalUrl } from "../../shared/net-guard";
import { PREVIEW_SCHEME, readPreviewTarget } from "../../shared/preview-link";
import { DESKTOP_USER_AGENT, refererFor } from "./hotlink";
import { createImageCache, imageCacheKey, type ImageCache } from "./image-cache";
import type { TrackMerger } from "./media-merge";

/** 协议只用到「远程合流」这一面：预览不该被合流器的下载侧能力牵进来 */
type PreviewMerger = Pick<TrackMerger, "ensureRemote">;

/**
 * 播放器要的事实：类型、总长、已给到哪段、能不能按字节请求。
 *
 * 只搬这几个，不把上游响应头整表透传——`set-cookie` 之类跟着进来等于把平台身份带进渲染层，
 * 而 `content-encoding` 一类在 fetch 层已被解码，原样回吐只会让长度对不上。
 */
const PASSTHROUGH_HEADER = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
] as const;

/**
 * 声明 scheme 特权。**必须在 `app.whenReady()` 之前**调用（Chromium 在就绪时固化协议分类）。
 *
 * - `standard`：按标准 URL 解析，`mgpreview://media/?u=…` 才有查询串可取；
 * - `secure`：算作潜在可信源，否则从可信页面里请求它会被当成混合内容挡掉；
 * - `stream`：允许响应体分块流出。没有这条，`protocol.handle` 会把整段媒体先攒进内存，
 *   `<video>` 的拖动（Range 请求）也就无从谈起——大文件预览会变成「先下完再看」。
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, stream: true },
    },
  ]);
}

/**
 * `Range: bytes=…` 的解析（本地文件分支用）。
 *
 * 返回 `null` 表示「没要求分段，给全量 200」；`"unsatisfiable"` 表示越界（回 416，
 * 播放器据此知道该重新拉元数据）；多段请求只认第一段——`<video>` 从不发多段，
 * 真发了也没必要在本地文件上做 multipart。
 */
export type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

export function parseByteRange(header: string | null, size: number): ByteRange {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // 多段/其它单位：按整段给，播放器能自己退回全量
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    // `bytes=-N` 的 N 是「末尾 N 字节」，不是结束偏移
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = Math.min(rawEnd ? Number(rawEnd) : size - 1, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "unsatisfiable";
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

const MP4_TYPE = "video/mp4";

/** 本地合流产物 → 支持 Range 的响应（可拖动进度条；元数据在文件头，时长能读出来） */
async function serveLocalFile(request: Request, path: string): Promise<Response> {
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) return new Response(null, { status: 404 });
    size = s.size;
  } catch {
    return new Response(null, { status: 404 });
  }

  const range = parseByteRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers = new Headers({
    "content-type": MP4_TYPE,
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    // 合流产物按哈希命名、内容不会变；但仍走 no-store —— temp 文件可能被 TTL 清掉，
    // 缓存住一条指向已删文件的响应只会演「点了没反应」
    "cache-control": "no-store",
  });
  if (range) headers.set("content-range", `bytes ${start}-${end}/${size}`);

  const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as BodyInit;
  return new Response(body, { status: range ? 206 : 200, headers });
}

/**
 * 装上代理：随 app ready 调一次，之后渲染层里指向 `mgpreview://` 的媒体都走这里。
 *
 * 两条分支：
 * - 链上带 `a=`（B站登录态 dash）：先用 ffmpeg 把音视频轨合到 temp，再按本地文件给
 *   Range 响应。合流失败回 502，渲染层显示「预览加载失败」，不假装能播。
 * - 没有 `a=`：原样转发上游（防盗链头 + Range 透传），未登录 B站的 durl 单文件走这条。
 *   其中的**小图**（作者头像、封面缩略图）会进内存 LRU 并当场回 Buffer：自定义 scheme
 *   不进 Chromium 的磁盘 HTTP 缓存，而页面容器 `key={page}` 每次切页都重建 `<img>`，
 *   不自己留一层就等于每切一次页都把上游图床重打一遍（见 `image-cache.ts` 头部）。
 */
export function installPreviewProtocol(deps: { merger?: PreviewMerger; images?: ImageCache } = {}): void {
  const images = deps.images ?? createImageCache();

  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const target = readPreviewTarget(request.url);
    if (!target) return new Response(null, { status: 400 });

    if (target.audioUrl) {
      if (!deps.merger) return new Response(null, { status: 502 });
      const merged = await deps.merger.ensureRemote(target.url, target.audioUrl, target.platform);
      // 失败原因可能是 ffmpeg 缺失、上游拒发或超时——都不带直链进日志
      return merged ? serveLocalFile(request, merged) : new Response(null, { status: 502 });
    }

    // 带 Range 的请求是播放器在拖进度条：要的是区间而不是整段，与「缓存整张小图」是两回事
    const range = request.headers.get("range");
    const cacheKey = range ? null : imageCacheKey(target.url);
    const cached = cacheKey ? images.get(cacheKey) : undefined;
    if (cached) {
      const headers = new Headers({
        "content-type": cached.contentType,
        "content-length": String(cached.body.length),
      });
      if (cached.cacheControl) headers.set("cache-control", cached.cacheControl);
      return new Response(cached.body as unknown as BodyInit, { status: 200, headers });
    }

    const headers: Record<string, string> = {
      "User-Agent": DESKTOP_USER_AGENT,
      Accept: "*/*",
    };
    const referer = refererFor(target.platform);
    if (referer) headers["Referer"] = referer;
    // 播放器拖动进度条就是换一段 Range：原样转给上游，别在这里假装支持断点
    if (range) headers["Range"] = range;

    let upstream: Response;
    try {
      upstream = await fetch(target.url, { headers });
      // 公网链 302 到内网仍会被 follow 打过去：解链时那道闸只盖住了发起地址
      if (!isPublicFinalUrl(upstream.url)) {
        await upstream.body?.cancel();
        return new Response(null, { status: 502 });
      }
      /**
       * 403 降一档重试：同一个图床对 Referer 的胃口并不统一——`weibo` 要站点域名那张，
       * `redbook` 有一档只认空 Referer（带了就 403），而我们只能发一个值。所以「带 Referer
       * 被拒」再试一次不带的，比在客户端猜每个域名的白名单可靠。
       *
       * 只在 403 上重试：它是防盗链拒发的唯一硬证据；404/5xx 重打一遍只是把失败翻倍。
       * 也只在**带了 Referer** 时才重试，没得降就没必要多一跳。
       */
      if (upstream.status === 403 && headers["Referer"]) {
        await upstream.body?.cancel();
        const withoutReferer = { ...headers };
        delete withoutReferer.Referer;
        upstream = await fetch(target.url, { headers: withoutReferer });
        if (!isPublicFinalUrl(upstream.url)) {
          await upstream.body?.cancel();
          return new Response(null, { status: 502 });
        }
      }
    } catch {
      // 失败原因可能是 DNS、TLS、也可能是链被平台掐了——都不带直链，日志里也无从归因
      return new Response(null, { status: 502 });
    }

    const out = new Headers();
    for (const key of PASSTHROUGH_HEADER) {
      const value = upstream.headers.get(key);
      if (value) out.set(key, value);
    }

    // 小图当场读成 Buffer：一是存进 LRU，二是让响应体与 `content-length` 一定对得上。
    // 只认「无 Range + 200 + image/* + 长度已知且不超单条上限」，任一不满足就照旧流式转发——
    // 视频/音频那条（Range、206、大体积）一次都不该在内存里攒起来。缺 `content-length`
    // 的分块响应同样走流式：攒之前不知道会有多大，这类通常也不是静态小图。
    const contentType = upstream.headers.get("content-type") ?? "";
    const declaredLength = Number(upstream.headers.get("content-length"));
    if (
      cacheKey &&
      upstream.status === 200 &&
      contentType.startsWith("image/") &&
      Number.isFinite(declaredLength) &&
      declaredLength > 0 &&
      declaredLength <= images.maxEntryBytes
    ) {
      try {
        const body = Buffer.from(await upstream.arrayBuffer());
        images.set(cacheKey, body, contentType, upstream.headers.get("cache-control") ?? undefined);
        // 上游声明的长度与真读到的字节数不一致时不改写这个头——让浏览器自己发现截断
        if (body.length === declaredLength) out.set("content-length", String(body.length));
        return new Response(body as unknown as BodyInit, { status: 200, headers: out });
      } catch {
        // 读体失败（上游中途断开）：已经消费了 body，只能如实报失败
        return new Response(null, { status: 502 });
      }
    }

    // accept-ranges 只照上游表态：这里替它写死 bytes，播放器就会拖到没支持的那一段黑屏
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  });
}

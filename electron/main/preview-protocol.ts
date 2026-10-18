/**
 * 预览取流代理（业主定调 2026-10-18：放开 CSP + 主进程代理取流）。
 *
 * 结果卡的 `<video>` / `<audio>` 直接吃平台直链必失败，两层都堵着：渲染层 CSP 只放行
 * `'self'`（媒体外链违反 `default-src`，控制台里是策略拦截而不是网络错误），而防盗链要求
 * 的那对 `Referer` + 桌面 UA 只有主进程能带——媒体元素发出的请求改不了请求头。
 * 于是渲染层只拿到一条 `mgpreview://media/?u=<编码后的直链>`，真正去取流的是这里。
 *
 * 隐私红线同下载侧：**直链不写日志**，失败也只回状态码；代理链里的地址在解链时再过一次
 * 安全闸（`shared/preview-link.ts`），所以这条处理器不构成「替渲染层访问任意地址」的通道。
 *
 * 取流用 Node `fetch`，不用 `net.fetch`：实测（electron 44.7.2 最小复现）在 `protocol.handle`
 * 内部调 `net.fetch` 会撞 `net::ERR_BLOCKED_BY_CLIENT`——同一条 URL 在主进程直接调是 200，
 * 换成由代理链发起就被 Chromium 的本机网络访问检查拦下（发起方是自定义 scheme，没有内网
 * 身份可核对）。Node 侧走 undici，不吃这套策略，而且与解析内核、下载器同一条栈，
 * 代理设置由 `applyProxy` 的全局 dispatcher 一并覆盖。
 */
import { protocol } from "electron";
import { PREVIEW_SCHEME, readPreviewTarget } from "../../shared/preview-link";
import { DESKTOP_USER_AGENT, refererFor } from "./hotlink";

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

/** 装上代理：随 app ready 调一次，之后渲染层里指向 `mgpreview://` 的媒体都走这里。 */
export function installPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const target = readPreviewTarget(request.url);
    if (!target) return new Response(null, { status: 400 });

    const headers: Record<string, string> = {
      "User-Agent": DESKTOP_USER_AGENT,
      Accept: "*/*",
    };
    const referer = refererFor(target.platform);
    if (referer) headers["Referer"] = referer;
    // 播放器拖动进度条就是换一段 Range：原样转给上游，别在这里假装支持断点
    const range = request.headers.get("range");
    if (range) headers["Range"] = range;

    let upstream: Response;
    try {
      upstream = await fetch(target.url, { headers });
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
    // accept-ranges 只照上游表态：这里替它写死 bytes，播放器就会拖到没支持的那一段黑屏
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  });
}

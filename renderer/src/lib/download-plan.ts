/**
 * 下载计划（结果卡第三层的数据源）：把 ParseData + 清晰度选择展开成
 * 「将要落盘的每一项」。
 *
 * 为什么单独成模块：这段展开逻辑决定了按钮文案与用户「点了会得到什么」，
 * 是结果卡里唯一有正确性风险的纯函数（多 P 的清晰度回落尤其容易静默出错），
 * 抽出来才能用纯 Node 测试覆盖，不必拉起 DOM。
 */
import { isDashSegment } from "../../../shared/preview-link";
import type { DownloadItem, ParseData, ParsedVideoQuality } from "../../../types/ipc";

/** 一个可选清晰度（null url = 用内核给的主 data.url） */
export interface QualityOption {
  label: string;
  url: string | null;
  /** 文件名后缀（'' = 不加） */
  suffix: string;
  /** 音频项：并入下载而非替代主视频 */
  audio?: boolean;
  /** 内核画质档位数值（越大越清晰）；音频/默认项无数值 */
  tier?: number;
  /** 单轨视频的 MSE 身份（契约 v35）；渐进式档位没有，预览走 `<video>` 或合流回退 */
  codecs?: string;
  mimeType?: string;
}

/** 计划里的一项 */
export interface PlanEntry {
  /** 稳定 id（勾选态按它记，重新展开计划不丢选择） */
  id: string;
  /** 展示标签：视频 · 1080P / 图 3/12 / 音频 */
  label: string;
  kind: DownloadItem["kind"];
  url: string;
  /** DASH 音频轨：有它下载器就必须合流（交付音画完整的一个文件，见 `media-merge`） */
  audioUrl?: string;
  /** 双轨 MSE 预览所需的轨道身份（契约 v35）：视频轨 + 音轨各一组 */
  videoCodecs?: string;
  videoMimeType?: string;
  audioCodecs?: string;
  audioMimeType?: string;
  filename: string;
  /** 请求的清晰度在该项上不存在、实际用默认 —— 必须显式说出来，不能静默降级 */
  fallbackNote?: string;
}

/**
 * 这一项要不要带音频轨。
 *
 * 两条判据，缺一个就会有「下得下来但没声音」的档：
 * ① 直链是 DASH 视频分片（B站未登录以外的 `.m4s`）——单放没有音轨；
 * ② **不是主链**的档位。YouTube 的 DASH 链长在 `googlevideo.com/videoplayback` 上，
 *    pathname 里没有 `.m4s`，扩展名认不出来，而它同样没有音轨（2026-10-21 用户报
 *    「YouTube 视频在预览页调不了音量」就是这条：选了高于主链的档 → 无声 → Chromium
 *    干脆不画音量按钮）。主链是渐进式（`progressive[0]`，自带音轨），所以「非主链」
 *    这个条件只在用户真的换了档时才成立，主链那条不会被白合一次。
 *
 * 渐进式单文件（B站未登录的 durl、抖音/快手的 mp4）本身带声音，多叠一条只会浪费一次合流，
 * 但不会出错——`-map 0:v:0 / 1:a:0` 取的是同一条视频的音频，不是别处的。`audioUrl`
 * 缺省 = 单流，老路径不变。
 */
function dashAudioFor(url: string, audioUrl?: string, isMain = true): string | undefined {
  if (!audioUrl) return undefined;
  return isDashSegment(url) || !isMain ? audioUrl : undefined;
}

function qualityLabel(q: ParsedVideoQuality): string {
  return q.label || `${q.quality}P`;
}

/** 内核没给多清晰度时的默认项：用主 data.url */
function defaultOption(data: ParseData): QualityOption {
  return {
    label: data.qualityLabel || "默认",
    url: null,
    suffix: "",
    codecs: data.videoCodecs,
    mimeType: data.videoMimeType,
  };
}

/** 清晰度选择器的完整形态：芯片列表 + 内核主直链落在第几个 */
export interface QualityPlan {
  options: QualityOption[];
  /** 默认选中项 = 内核主 `data.url` 对应的那一档（不是「列表第一个」） */
  primaryIndex: number;
}

/**
 * 展开清晰度芯片。
 *
 * 内核常把主直链同时写成 `data.url` 和 `qualities[i].url`：这一档只出现一次，
 * 且默认选中它 —— 出现两个同名芯片等于把「你现在拿到的是哪一档」说糊了。
 *
 * strategy 只移动默认选中项（用户仍可手选覆盖）：main=内核主直链档，
 * highest/lowest=按内核 tier 数值取极值；单档或无 tier 时维持 main。
 */
export type QualityStrategy = "main" | "highest" | "lowest";

export function buildQualityPlan(data?: ParseData, strategy: QualityStrategy = "main"): QualityPlan {
  if (!data) return { options: [], primaryIndex: 0 };
  // B站只把档位挂在分 P 上（`data.qualities` 为空，顶层也没有 qualityLabel）：
  // 拿主视频那组当可选项，否则选择器永远只有「默认」一项、整块被隐藏。
  const source = data.qualities?.length ? data.qualities : (data.videos?.[0]?.qualities ?? []);
  /**
   * 同名档位只留一条，且**主链那条优先占位**。
   *
   * 两件事绑在一起，因为它们是同一个坑的两面：
   * 1) 上游把不同 qn / 不同编码标成同一句话时（2026-10-21 用户报「2 个 1080P」），
   *    两个芯片只会让用户分不清该选哪个，所以同名只留一条；
   * 2) YouTube 的 360P 同时存在渐进式（含音轨，正好是主链）与 DASH video-only 两条，
   *    单纯「先出现的留下」会把主链那条挤掉，于是 `findIndex` 找不到主链，兜底塞进一个
   *    叫「默认」的档位——用户既不知道它是什么清晰度，也不知道它和 360P 是同一档
   *    （2026-10-21 用户报）。所以主链出现时就顶掉同名的旧项，位置不变。
   */
  const byLabel = new Map<string, QualityOption>();
  for (const q of source) {
    const label = qualityLabel(q);
    const option: QualityOption = {
      label,
      url: q.url,
      suffix: `-${label}`,
      tier: q.quality,
      codecs: q.codecs,
      mimeType: q.mimeType,
    };
    const prev = byLabel.get(label);
    if (!prev || (data.url && q.url === data.url)) byLabel.set(label, option);
  }
  const options: QualityOption[] = [...byLabel.values()];
  let primaryIndex = data.url ? options.findIndex((o) => o.url === data.url) : -1;
  if (data.url && primaryIndex < 0) {
    // 主链压根不在档位表里（内核只给了主链、没给多档）：补一条，名字取内核给的档位名。
    // 名字撞车时加后缀区分——两个一模一样的芯片比一个「默认」更让人没法选。
    const base = defaultOption(data);
    const label = options.some((o) => o.label === base.label) ? `${base.label}（当前）` : base.label;
    options.unshift({ ...base, label });
    primaryIndex = 0;
  }
  if (data.audioUrl) options.push({ label: "仅音频", url: data.audioUrl, suffix: "", audio: true });
  if (primaryIndex < 0) primaryIndex = 0;
  if (strategy !== "main") {
    const video = options
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => !o.audio && o.tier !== undefined);
    if (video.length > 1) {
      const best = video.reduce((a, b) =>
        strategy === "highest" ? (b.o.tier! > a.o.tier! ? b : a) : b.o.tier! < a.o.tier! ? b : a
      );
      primaryIndex = best.i;
    }
  }
  return { options, primaryIndex };
}

/** 兼容只关心芯片文案的调用点 */
export function buildQualityOptions(data?: ParseData): QualityOption[] {
  return buildQualityPlan(data).options;
}

/**
 * 命名规则（设置 → 下载 → 文件命名）。
 *
 * 拆成「主体预设 + 追加开关」两段而不是一整个模板串：预设是有限枚举（可下拉、可
 * 在设置里给出人话示例），开关是独立布尔（可开关、可单独预览）。日期归入 titleDate 预设
 * 而非开关 —— 否则「加日期」与「标题_日期」两个概念会打架。
 */
export type FilenamePreset =
  | "title"
  | "authorTitle"
  | "titleAuthor"
  | "titleDate"
  | "authorTitleDate";

export interface FilenameExtra {
  /** 清晰度后缀（如 `-1080P`）；默认开 —— 现状主视频文件名就带该后缀，关掉才是行为变更 */
  quality: boolean;
  /** 多文件序号（图集 `-3`、分P `-P2`）；默认开，与现状一致 */
  index: boolean;
}

export const DEFAULT_FILENAME_EXTRA: FilenameExtra = { quality: true, index: true };

/**
 * 标题限长上限（占整个文件名长度的部分）。
 *
 * 只管标题：作者、后缀、扩展名不参与这个预算 —— 它们是「附加信息」，砍标题能解决
 * 「名字长得没法看」的问题，砍附加信息反而丢关键上下文（清晰度、期数）。
 */
export const TITLE_MAX_LEN = 15;

/** 超长时的省略标记：1 个字符，计入长度预算 */
const ELLIPSIS = "…";

/**
 * 超长限长：保留前后、中间省略。
 *
 * 为什么不用尾部硬砍：标题的开头通常是主题（「秋日通勤穿搭…），结尾常有信息量
 * （清晰度、期数、关键结论）。砍尾会把结尾一起丢掉，而且砍掉的量不可控。
 *
 * 切点可能落在代理对中间（emoji 占两个 UTF-16 码元），半个高/低代理会显示成乱码，
 * 所以两侧都要 trimLoneSurrogate —— 净化阶段虽会删掉 emoji，但预览与结果卡先显示着。
 */
export function ellipsizeMiddle(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const budget = maxLen - ELLIPSIS.length;
  if (budget < 2) {
    // 连省略号都放不下（极端 maxLen），退化为纯截断，别在这里抛错
    return s.slice(0, Math.max(0, maxLen));
  }
  // 尾部略多于头部：结尾的信息通常更关键（清晰度/期数/年份）
  const tail = Math.ceil(budget / 2);
  const head = budget - tail;
  return `${trimLoneSurrogate(s.slice(0, head), "end")}${ELLIPSIS}${trimLoneSurrogate(
    s.slice(s.length - tail),
    "start"
  )}`;
}

/**
 * 切点可能落在代理对中间（emoji 占两个 UTF-16 码元），半个高/低代理会显示成乱码。
 * 净化阶段会删掉 emoji，但预览与结果卡先显示着，不能等 sanitize 兜底。
 */
function trimLoneSurrogate(chunk: string, edge: "start" | "end"): string {
  if (!chunk) return chunk;
  if (edge === "end") {
    const code = chunk.charCodeAt(chunk.length - 1);
    // 结尾落在一个高代理（emoji 的前半）上 → 去掉它
    if (code >= 0xd800 && code <= 0xdbff) return chunk.slice(0, -1);
    return chunk;
  }
  const code = chunk.charCodeAt(0);
  // 开头是一个低代理（说明切开了它前面那个高代理）→ 连它一起去掉
  if (code >= 0xdc00 && code <= 0xdfff) return chunk.slice(1);
  return chunk;
}

/** 标题超长时压到 TITLE_MAX_LEN 之内（保留前后、中间省略）；未超长原样返回 */
export function clampTitle(title: string): string {
  return ellipsizeMiddle(title, TITLE_MAX_LEN);
}

/** 标题与作者都缺时的兜底主体（现状 buildPlan 里的 "media"） */
const FALLBACK_TITLE = "media";

/** 日期取本地日历日，不带时分秒：文件名里的日期只需要到天 */
function yyyymmdd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 拼接下载文件名。
 *
 * 只负责「拼」，不负责「洗」：Windows 非法字符 / 表情 / 保留名一律由主进程入队时的
 * `sanitizeWithExt` 兜底（净化规则单一真源在 mediaGet 内核的 utils/filename.ts，
 * 勿在客户端复制那套规则）。
 *
 * 限长也在这里做掉，但**只限标题**（clampTitle，15 字）：结果卡要显示「用户最终会看到的
 * 名字」，若留到主进程再砍，显示名就会和落盘名对不上（docs/UIUX-DESIGN.md 记过这个坑）。
 */
export function buildFilename(
  ctx: {
    /** 标题（可空，走了 PADDING_FALLBACK 的值） */
    title: string;
    /** 作者（可空：部分平台不返回，退化成仅标题而不是留一个空 ` - `） */
    author?: string;
    /** 清晰度后缀，形如 `-1080P`；由调用方决定是否附加 */
    qualitySuffix?: string;
    /** 序号后缀，形如 `-3` / `-P2`；多文件项才有 */
    indexSuffix?: string;
    /** 扩展名，含点，如 `.mp4` */
    ext: string;
  },
  rule: { preset: FilenamePreset; extra: FilenameExtra },
  /** 日期注入点：便于测试固定值，缺省取当前时刻（入队时刻） */
  now: Date = new Date()
): string {
  // 标题先压到 15 字再参与拼接：主体里出现的每一处标题都该同样限长，
  // 否则「作者 - 长标题」里的长标题会把整体重新撑长
  const title = clampTitle(ctx.title.trim() || FALLBACK_TITLE);
  const author = ctx.author?.trim() ?? "";

  let stem: string;
  switch (rule.preset) {
    // 连接符统一为下划线（v26）：作者缺失时退化为仅标题，不留尾部空档或孤立连接符
    case "authorTitle":
      stem = author ? `${author}_${title}` : title;
      break;
    case "titleAuthor":
      stem = author ? `${title}_${author}` : title;
      break;
    case "authorTitleDate":
      // 三要素全上；作者缺失时就是 titleDate
      stem = author ? `${author}_${title}_${yyyymmdd(now)}` : `${title}_${yyyymmdd(now)}`;
      break;
    case "titleDate":
      stem = `${title}_${yyyymmdd(now)}`;
      break;
    case "title":
    default:
      stem = title;
      break;
  }

  if (rule.extra.quality && ctx.qualitySuffix) stem += ctx.qualitySuffix;
  if (rule.extra.index && ctx.indexSuffix) stem += ctx.indexSuffix;

  return `${stem}${ctx.ext}`;
}

/**
 * 内容构成：结果卡按「手上实际有哪些东西」叠加区块，而不是给每个平台猜一个互斥形态。
 *
 * 旧 `deriveShape` 是单选枚举：一条结果同时有视频和图片时只能归到一边，于是「单视频 + 图集」
 * 会被判成图集、视频主视觉直接消失。这里把三样媒体分开数，卡片按构成叠图集条 / 多 P 清单 /
 * 音频行 / 纯文字块 —— 同一套骨架因此能接住所有平台与组合。
 *
 * 不读契约的 `data.type`：那是平台各自填的，同一形态在不同平台会填出不同值
 * （抖音图集见过返回 `text`），只有 `url` / `videos` / `images` / `audioUrl` 是实打实的。
 */
export interface ResourceMix {
  /** 去重后的视频条目数（主直链 + `videos[]`，同一条只算一次；主直链是图集首图时不算视频） */
  videoCount: number;
  imageCount: number;
  hasAudio: boolean;
  /** 没有任何可下载媒体（embedOnly 也归这一类，由卡片另走「去浏览器播放」） */
  textOnly: boolean;
  /** 主视频：`videos[0]`，没有则主直链；主视觉的预览入口与多 P 清单都从它开始 */
  primaryVideo?: { title?: string; url: string; durationFormat?: string; duration?: number };
  /** 主视觉：平台封面 → 首张图 → 首个分 P 封面 → 音乐封面 */
  cover?: string;
}

export function describeResourceMix(data?: ParseData): ResourceMix {
  if (!data) return { videoCount: 0, imageCount: 0, hasAudio: false, textOnly: true };
  const videos = (data.videos ?? []).filter((v) => Boolean(v.url));
  const images = (data.images ?? []).filter(Boolean);
  // 图集帖子把首张图同时写成主直链（内核微博分支 `url = images[0]`）：那条不是视频。
  // 判据只看「这条 url 在不在 images 里」，不按平台或 `type` 猜——契约的 type 各平台填法不一。
  const mainIsImage = isGalleryMain(data);
  const videoUrls = new Set<string>();
  if (data.url && !mainIsImage) videoUrls.add(data.url);
  for (const v of videos) videoUrls.add(v.url);
  return {
    videoCount: videoUrls.size,
    imageCount: images.length,
    hasAudio: Boolean(data.audioUrl),
    textOnly: videoUrls.size === 0 && images.length === 0 && !data.audioUrl,
    primaryVideo: videos[0] ?? (data.url && !mainIsImage ? { url: data.url } : undefined),
    cover: data.cover ?? images[0] ?? videos[0]?.cover ?? videos[0]?.pic ?? data.music?.avatar,
  };
}

/**
 * 主直链是不是「图集的第一张图」：真就代表这份结果没有主视频，只有图。
 *
 * `buildPlan` 与 `describeResourceMix` 必须同一条判据 —— 一边算视频、另一边照样下成 `.mp4`
 * 的话，图集的第一张会以一个打不开的文件进队列，比显示错更难被发现。
 */
function isGalleryMain(data: ParseData): boolean {
  return Boolean(data.url) && (data.images ?? []).includes(data.url as string);
}

/**
 * 展开下载计划。未指定清晰度 = 用默认项（而不是「什么都不下」）。
 *
 * 多 P（bilibili 等）按选中清晰度在同 label 的 qualities 里取；取不到不静默：
 * 回落默认并写 fallbackNote。
 */
export function buildPlan(
  data: ParseData | undefined,
  sel?: QualityOption,
  rule?: { preset: FilenamePreset; extra: FilenameExtra }
): PlanEntry[] {
  if (!data) return [];
  const chosen = sel ?? defaultOption(data);
  const title = data.title || data.desc || data.name || FALLBACK_TITLE;
  // 规则缺省 = 现状行为（仅标题 + 清晰度档位后缀 + 多文件序号），保证旧调用点与旧测试不变
  const naming = rule ?? { preset: "title" as FilenamePreset, extra: DEFAULT_FILENAME_EXTRA };
  const author = data.author;
  const out: PlanEntry[] = [];

  const mainUrl = chosen.url ?? data.url;
  // 选中档位的 MSE 身份：选了具体档位就跟档位走，默认项才回落到主链自己的 codec
  const videoMeta = chosen.url
    ? { codecs: chosen.codecs, mimeType: chosen.mimeType }
    : { codecs: data.videoCodecs, mimeType: data.videoMimeType };
  // 图集帖的主直链就是首张图：它由下面的 images 循环以 `.jpg` 落盘，这里再当视频展开，
  // 第一张图就会变成一个打不开的 `.mp4`（判据与 describeResourceMix 同一份）
  if (!chosen.audio && mainUrl && !isGalleryMain(data)) {
    // 已知是分离视频轨（有 codecs）就必须配音频：主链也可能落到 video-only，
    // 旧判据只认 `.m4s`，YouTube 那种无扩展名的分离链会被漏掉（预览无声）。
    const audio = dashAudioFor(mainUrl, data.audioUrl, mainUrl === data.url) ??
      (videoMeta.codecs ? data.audioUrl : undefined);
    out.push({
      id: "main",
      // 合集里主链只是其中一 P（引擎用 `data.page` 说清是第几 P）：标签与文件名都要带上这一位，
      // 否则「解析 P1 下一次、解析 P2 再下一次」落成同一个名字，第二遍覆盖第一遍。
      label: `视频${data.page ? ` · P${data.page}` : ""} · ${chosen.label}`,
      kind: "video",
      url: mainUrl,
      // 主链判定按「选中的档位是不是主链那条」：选了更高档就是非主链，得配音轨
      audioUrl: audio,
      videoCodecs: videoMeta.codecs,
      videoMimeType: videoMeta.mimeType,
      audioCodecs: audio ? data.audioCodecs : undefined,
      audioMimeType: audio ? data.audioMimeType : undefined,
      filename: buildFilename(
        {
          title,
          author,
          qualitySuffix: chosen.suffix,
          indexSuffix: data.page ? `-P${data.page}` : undefined,
          ext: ".mp4",
        },
        naming
      ),
    });
  }

  // 「仅音频」是排他档：只有用户明确选了它才单独产音频项。默认下载时音频已并入主视频
  // （dash 双轨一律合流），再产一条就是让用户白下一个重复的音频文件。
  const wantAudio = Boolean(data.audioUrl) && Boolean(chosen.audio);
  if (wantAudio) {
    out.push({
      id: "audio",
      label: "音频",
      kind: "audio",
      url: data.audioUrl as string,
      filename: buildFilename({ title, author, ext: ".mp3" }, naming),
    });
  }

  // 「仅音频」是排他档：主视频已跳过，分 P 的视频也不能再进来（否则按钮上会写 4 项）
  if (!chosen.audio) {
    (data.videos ?? []).forEach((v, i) => {
      // 编号认契约的 `page`（第几 P），下标只在引擎没报这一位时兜底：某一 P 取流失败会整条
      // 缺席、数组下标随之前移，用下标报「分 P 2」就把名字贴到了真正的第三 P 上。
      const no = v.page ?? i + 1;
      // 想要哪一档写在 suffix 上（默认项也可能带档位，例如主 url 就是 1080P）
      const wanted = chosen.suffix ? chosen.suffix.slice(1) : undefined;
      const hit = wanted ? v.qualities?.find((q) => qualityLabel(q) === wanted) : undefined;
      const url = hit?.url ?? v.url;
      if (!url) return;
      // 这一 P 的视频轨身份跟着选中的档位走（与主链那条同一规则）
      const track = hit
        ? { codecs: hit.codecs, mimeType: hit.mimeType }
        : { codecs: v.videoCodecs, mimeType: v.videoMimeType };
      out.push({
        id: `p-${i}`,
        label: `分 P ${no}${v.title ? ` · ${v.title}` : ""}`,
        kind: "video",
        url,
        // 一条分 P 就是一份独立资源（v36）：音轨只认这一 P 自己带的那条。拿顶层 `data.audioUrl`
        // 硬配等于交付「画面是 P3、声音是 P2」——音轨配错比无声更难发现。缺键就是渐进式单文件
        // （内核未登录的 durl 分支），照常单流下载。
        audioUrl: v.audioUrl,
        videoCodecs: track.codecs,
        videoMimeType: track.mimeType,
        audioCodecs: v.audioUrl ? v.audioCodecs : undefined,
        audioMimeType: v.audioUrl ? v.audioMimeType : undefined,
        filename: buildFilename(
          {
            title,
            author,
            qualitySuffix: hit ? chosen.suffix : undefined,
            indexSuffix: `-P${no}`,
            ext: ".mp4",
          },
          naming
        ),
        fallbackNote: wanted && !hit ? `无 ${wanted}，用默认清晰度` : undefined,
      });
    });
  }

  (data.images ?? []).forEach((img, i) => {
    if (!img) return;
    out.push({
      id: `img-${i}`,
      label: `图 ${i + 1}/${(data.images ?? []).length}`,
      kind: "image",
      url: img,
      filename: buildFilename(
        { title, author, indexSuffix: `-${i + 1}`, ext: ".jpg" },
        naming
      ),
    });
  });

  return dedupeByUrl(out);
}

/** 同一一直链只下一份（内核把主视频同时放进 url 与 videos[0].url 的形态真实存在） */
function dedupeByUrl(entries: PlanEntry[]): PlanEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}

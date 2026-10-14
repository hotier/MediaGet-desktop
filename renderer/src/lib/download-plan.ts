/**
 * 下载计划（结果卡第三层的数据源）：把 ParseData + 清晰度选择展开成
 * 「将要落盘的每一项」。
 *
 * 为什么单独成模块：这段展开逻辑决定了按钮文案与用户「点了会得到什么」，
 * 是结果卡里唯一有正确性风险的纯函数（多 P 的清晰度回落尤其容易静默出错），
 * 抽出来才能用纯 Node 测试覆盖，不必拉起 DOM。
 */
import type { DownloadItem, ParseData, ParsedVideoQuality } from "../../../types/ipc";

/** 一个可选清晰度（null url = 用内核给的主 data.url） */
export interface QualityOption {
  label: string;
  url: string | null;
  /** 文件名后缀（'' = 不加） */
  suffix: string;
  /** 音频项：并入下载而非替代主视频 */
  audio?: boolean;
}

/** 计划里的一项 */
export interface PlanEntry {
  /** 稳定 id（勾选态按它记，重新展开计划不丢选择） */
  id: string;
  /** 展示标签：视频 · 1080P / 图 3/12 / 音频 */
  label: string;
  kind: DownloadItem["kind"];
  url: string;
  filename: string;
  /** 请求的清晰度在该项上不存在、实际用默认 —— 必须显式说出来，不能静默降级 */
  fallbackNote?: string;
}

function qualityLabel(q: ParsedVideoQuality): string {
  return q.label || `${q.quality}P`;
}

/** 内核没给多清晰度时的默认项：用主 data.url */
function defaultOption(data: ParseData): QualityOption {
  return { label: data.qualityLabel || "默认", url: null, suffix: "" };
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
 */
export function buildQualityPlan(data?: ParseData): QualityPlan {
  if (!data) return { options: [], primaryIndex: 0 };
  const options: QualityOption[] = (data.qualities ?? []).map((q) => ({
    label: qualityLabel(q),
    url: q.url,
    suffix: `-${qualityLabel(q)}`,
  }));
  const primaryIndex = data.url ? options.findIndex((o) => o.url === data.url) : -1;
  if (data.url && primaryIndex < 0) options.unshift(defaultOption(data));
  if (data.audioUrl) options.push({ label: "仅音频", url: data.audioUrl, suffix: "", audio: true });
  return { options, primaryIndex: primaryIndex < 0 ? 0 : primaryIndex };
}

/** 兼容只关心芯片文案的调用点 */
export function buildQualityOptions(data?: ParseData): QualityOption[] {
  return buildQualityPlan(data).options;
}

/**
 * 展开下载计划。未指定清晰度 = 用默认项（而不是「什么都不下」）。
 *
 * 多 P（bilibili 等）按选中清晰度在同 label 的 qualities 里取；取不到不静默：
 * 回落默认并写 fallbackNote。
 */
export function buildPlan(data: ParseData | undefined, sel?: QualityOption): PlanEntry[] {
  if (!data) return [];
  const chosen = sel ?? defaultOption(data);
  const title = data.title || data.desc || data.name || "media";
  const out: PlanEntry[] = [];

  const mainUrl = chosen.url ?? data.url;
  if (!chosen.audio && mainUrl) {
    out.push({
      id: "main",
      label: `视频 · ${chosen.label}`,
      kind: "video",
      url: mainUrl,
      filename: `${title}${chosen.suffix}.mp4`,
    });
  }

  const wantAudio = Boolean(data.audioUrl) && (chosen.audio || !sel);
  if (wantAudio) {
    out.push({
      id: "audio",
      label: "音频",
      kind: "audio",
      url: data.audioUrl as string,
      filename: `${title}.mp3`,
    });
  }

  (data.videos ?? []).forEach((v, i) => {
    // 想要哪一档写在 suffix 上（默认项也可能带档位，例如主 url 就是 1080P）
    const wanted = chosen.suffix ? chosen.suffix.slice(1) : undefined;
    const hit = wanted ? v.qualities?.find((q) => qualityLabel(q) === wanted) : undefined;
    const url = hit?.url ?? v.url;
    if (!url) return;
    out.push({
      id: `p-${i}`,
      label: `分 P ${i + 1}${v.title ? ` · ${v.title}` : ""}`,
      kind: "video",
      url,
      filename: `${title}-P${i + 1}${hit ? chosen.suffix : ""}.mp4`,
      fallbackNote: wanted && !hit ? `无 ${wanted}，用默认清晰度` : undefined,
    });
  });

  (data.images ?? []).forEach((img, i) => {
    if (!img) return;
    out.push({
      id: `img-${i}`,
      label: `图 ${i + 1}/${(data.images ?? []).length}`,
      kind: "image",
      url: img,
      filename: `${title}-${i + 1}.jpg`,
    });
  });

  return dedupeByUrl(out);
}

/** 同一一直链只下一份（内核把主视频同时放进 url 与 videos[0].url 的形态真实存在） */
function dedupeByUrl(entries: PlanEntry[]): PlanEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}

/** 计划摘要：视频 3 · 图 12 · 音频 */
export function summarize(entries: PlanEntry[]): string {
  const counts = { video: 0, image: 0, audio: 0, file: 0 };
  for (const e of entries) counts[e.kind]++;
  const parts: string[] = [];
  if (counts.video) parts.push(`视频 ${counts.video}`);
  if (counts.image) parts.push(`图 ${counts.image}`);
  if (counts.audio) parts.push(`音频 ${counts.audio}`);
  if (counts.file) parts.push(`文件 ${counts.file}`);
  return parts.join(" · ");
}

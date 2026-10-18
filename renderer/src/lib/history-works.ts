/**
 * 历史页的聚合纯函数：history.json 的行 → 界面上的「作品」行。
 *
 * 为什么单独成文件（业主指令 2026-10-17 之后）：历史从下载台账变成**解析历史**，
 * 同一个作品在档里必然存在两类行 —— 解析行（files 空）与下载行（每个落地文件一行）。
 * 「哪一行的字段说了算」从这天起变成了有语义的规则，而不是一句 `g[0]`：
 * 拿组头当代表会让重新解析过的作品显示成「类型 —」，而这种错在界面上看起来完全正常。
 * 提到纯函数就是为了这条规则可测（tests/history-works.test.ts），手法与
 * renderer/src/lib/history-selection.ts 同一档。
 */
import type { AuthorSnapshot, HistoryEntry, WorkStat } from "../../../types/ipc";

/** 界面里的一行 = 一个作品（同作品键的解析行与下载行聚合成它） */
export interface WorkRow {
  key: string;
  platform?: string;
  title: string;
  kind?: string;
  /** 落地文件总数；0 = 只解析没下载（这一列在界面上写「未下载」） */
  count: number;
  createdAt: number;
  sourceUrl?: string;
  author?: AuthorSnapshot;
  /** 昵称优先，缺昵称退回 ID；两者都没有则不渲染作者单元格 */
  authorName?: string;
  /** 落地文件路径（底部详情浮层逐条列出） */
  files: string[];
  /** 文件字节总数（历史无 records 时 undefined，浮层不显示大小行） */
  bytes?: number;
  /**
   * 作品在平台上的发布时刻（本地毫秒）。界面不显示它（业主 2026-10-17 定「只在导出里」），
   * 但必须穿过聚合层到 `WorkRow` —— 导出吃的就是这一行。
   */
  publishedAt?: number;
  /** 解析那一刻的公开互动数快照；同样只进导出与复制文本，不进表格 */
  stat?: WorkStat;
}

/**
 * 按作品键聚合，保持入参顺序（store 返回新在前，故结果也是新在前）。
 *
 * 每个字段各取「组里最新那条有值的行」：解析行不带 kind/bytes，下载行都带；
 * 而再解析一次会把解析行顶到组首。逐字段找有值的行，两组行谁在前都不影响显示。
 */
export function groupWorks(list: HistoryEntry[]): WorkRow[] {
  const byGroup = new Map<string, HistoryEntry[]>();
  for (const h of list) {
    const key = h.groupId ?? h.id;
    const g = byGroup.get(key);
    if (g) g.push(h);
    else byGroup.set(key, [h]);
  }
  return [...byGroup.entries()].map(([key, g]) => {
    const author = g.find((e) => e.author)?.author;
    const bytesList = g.map((e) => e.bytes).filter((b): b is number => b != null);
    return {
      key,
      platform: g.find((e) => e.platform)?.platform,
      title: g.find((e) => e.title)?.title ?? "（未命名）",
      kind: g.find((e) => e.kind)?.kind,
      count: g.reduce((s, e) => s + e.files.length, 0),
      createdAt: Math.max(...g.map((e) => e.createdAt)),
      sourceUrl: g.find((e) => e.sourceUrl)?.sourceUrl,
      author,
      authorName: author?.name || author?.id || undefined,
      files: g.flatMap((e) => e.files),
      bytes: bytesList.length > 0 ? bytesList.reduce((s, b) => s + b, 0) : undefined,
      // 发布时间与计数只有解析行有（下载行不带平台元数据），同一条「逐字段取有值的行」规则
      publishedAt: g.find((e) => e.publishedAt != null)?.publishedAt,
      stat: g.find((e) => e.stat)?.stat,
    };
  });
}

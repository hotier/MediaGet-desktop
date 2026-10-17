/**
 * 统计页（⌃4）。两本账各有各的口径，页面把它们分得很清：
 * - **计数档**（stats.json，自 `since` 累加、不随行数窗口截断）出趋势、成功率、平台榜、类型榜、热力、解析。
 *   失败与取消只活在这里。
 * - **历史明细**（最近 HISTORY_WINDOW 行、逐文件）只出体积分布与作者榜。
 *   明细里没有失败记录（只有成功才追加），所以任何比率都不从它算 —— 从它算出来的是假数。
 * 卡片标题右边那句就是这一张图的合计：数值常显，不做「悬浮才知道」。
 * 图表走 ECharts + 本仓适配器：色值由 `charts/palette.ts` 从 CSS Token 探针取（代码里一个色值都不写），
 * option 全部来自 `lib/stats.ts` 的纯聚合 + `charts/options.ts` 的纯构造器，可在 node 环境整份测掉。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ScanSearch } from "lucide-react";
import { api, BridgeError } from "../lib/bridge";
import { HISTORY_WINDOW } from "../lib/local-limits";
import { fmtBytes, fmtCount, fmtDuration, fmtPercent, fmtSpeed } from "../lib/format";
import {
  TREND_WINDOWS,
  authorTop,
  downloadHealth,
  heat,
  heatSlotLabel,
  historyScope,
  isEmptyStats,
  kindRank,
  parseStats,
  platformRank,
  sinceLabel,
  sizeHistogram,
  speedStats,
  trendByDay,
  trendTotal,
  type RankMetric,
  type TrendWindow,
} from "../lib/stats";
import type { HistoryEntry, StatsSnapshot } from "../../../types/ipc";
import { displayName } from "../../../shared/platforms";
import { isLanded } from "../../../shared/history";
import { EChart } from "../components/charts/EChart";
import { rankHeight, rankOption, trendOption, histogramOption, heatOption, type RankDatum, type TrendMetric } from "../components/charts/options";
import { useChartPalette } from "../components/charts/palette";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Skeleton } from "../components/ui/skeleton";

/** 榜单口径按钮：顺序即展示顺序，标签短到能并排 */
const RANK_METRICS: Array<{ key: RankMetric; label: string }> = [
  { key: "downloads", label: "次数" },
  { key: "bytes", label: "字节" },
  { key: "failures", label: "失败" },
  { key: "parses", label: "解析" },
];

/** 同一个词表的取用面：卡片副标题要它，用 find 取会把「一定找得到」写成断言 */
const RANK_LABEL: Record<RankMetric, string> = {
  downloads: "次数",
  bytes: "字节",
  failures: "失败",
  parses: "解析",
};

const TREND_METRICS: Array<{ key: TrendMetric; label: string }> = [
  { key: "downloads", label: "次数" },
  { key: "bytes", label: "字节" },
];

const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/**
 * 快照未到时给一份全零档：让所有派生值天生非空。
 * 页面在快照到达前只渲染骨架，这些数不会被看到；但少了这份兜底，下面每一处都得写 `!` ——
 * 空值断言是把「这里不可能为空」的责任推给读代码的人，兜住一次就少九处问号。
 */
const ZERO_SNAPSHOT: StatsSnapshot = {
  schema: 1,
  since: 0,
  updatedAt: 0,
  totals: { downloads: 0, failures: 0, canceled: 0, bytes: 0, elapsedMs: 0, elapsedCount: 0, elapsedBytes: 0 },
  parse: { total: 0, failures: 0, local: 0, online: 0, mock: 0, durationMs: 0 },
  byDay: {},
  byPlatform: {},
  byKind: {},
  byHour: new Array(168).fill(0),
};

function Panel({
  title,
  desc,
  end,
  children,
}: {
  title: string;
  desc?: string;
  end?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5">
        <span className="font-medium">{title}</span>
        {desc && <span className="text-xs text-muted-foreground tabular-nums">{desc}</span>}
        {end && <div className="ms-auto flex items-center gap-1">{end}</div>}
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </Card>
  );
}

function Segment<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ key: T; label: string }>;
  onChange: (next: T) => void;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-1">
      {options.map((o) => (
        <Button
          key={o.key}
          type="button"
          size="sm"
          variant={o.key === value ? "default" : "ghost"}
          aria-pressed={o.key === value}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** 概览里的一行：标签在左、数在右，同一档位不分级（与队列/历史页同口径） */
/** 页头读数：标签与数值同排，图之外唯一的读数出口 */
function Figure({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default function StatsPage({
  onNavPlatform,
}: {
  /** 点平台榜的一行 → 历史页只看这个平台 */
  onNavPlatform: (platform: string) => void;
}): React.ReactElement {
  const [snap, setSnap] = useState<StatsSnapshot | null>(null);
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState<TrendWindow>(30);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("downloads");
  const [rankMetric, setRankMetric] = useState<RankMetric>("downloads");
  const palette = useChartPalette();

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const [s, rows] = await Promise.all([api.stats.get(), api.history.list({ limit: HISTORY_WINDOW })]);
      setSnap(s);
      setList(rows);
      setError("");
    } catch (e) {
      setError(e instanceof BridgeError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // —— 计数档口径 ——
  const base = snap ?? ZERO_SNAPSHOT;
  const points = useMemo(() => trendByDay(base, win), [base, win]);
  const total = useMemo(() => trendTotal(points), [points]);
  const platformRows = useMemo(() => platformRank(base, rankMetric), [base, rankMetric]);
  const kindRows = useMemo(() => kindRank(base, rankMetric), [base, rankMetric]);
  const health = useMemo(() => downloadHealth(base), [base]);
  const speed = useMemo(() => speedStats(base), [base]);
  const parse = useMemo(() => parseStats(base), [base]);
  const heatData = useMemo(() => heat(base), [base]);
  const since = useMemo(() => (snap ? sinceLabel(snap) : null), [snap]);

  // —— 历史明细口径（只有这两张卡用它）——
  // 明细档从 v8 起是**解析**历史：一条没下载的记录也占一行。作者榜、单文件大小分布算的是
  // 「文件」，所以只数落地行 —— 这两张卡的口径没变，变的是档里多了不算文件的行。
  const landed = useMemo(() => list.filter(isLanded), [list]);
  const hist = useMemo(() => sizeHistogram(landed), [landed]);
  const scope = useMemo(() => historyScope(landed), [landed]);
  const authors = useMemo(() => authorTop(landed, 10), [landed]);

  const platformData = useMemo<RankDatum[]>(
    () =>
      platformRows.map((r) => ({
        label: displayName(r.key),
        value: r[rankMetric],
        share:
          rankMetric === "bytes"
            ? r.byteShare
            : rankMetric === "failures"
              ? ratio(r.failures, base.totals.failures)
              : rankMetric === "parses"
                ? ratio(r.parses, base.parse.total)
                : r.downloadShare,
        note: `失败 ${fmtCount(r.failures)} · 失败率 ${fmtPercent(r.failureRate, 1)}`,
      })),
    [platformRows, rankMetric, base]
  );
  const kindData = useMemo<RankDatum[]>(
    () =>
      kindRows.map((r) => ({
        label: r.key,
        value: r[rankMetric],
        share:
          rankMetric === "bytes"
            ? r.byteShare
            : rankMetric === "parses"
              ? ratio(r.parses, base.parse.total)
              : r.downloadShare,
        // 类型桶不记失败（口径不成立，不是缺数据），所以这里不给失败率
        note: rankMetric === "failures" ? undefined : `占全部下载 ${fmtPercent(r.downloadShare, 1)}`,
      })),
    [kindRows, rankMetric, base]
  );
  const viaData = useMemo<RankDatum[]>(
    () => [
      { label: "本地内核", value: parse.byVia.local, share: parse.viaShare.local },
      { label: "线上回落", value: parse.byVia.online, share: parse.viaShare.online },
      { label: "mock 骨架", value: parse.byVia.mock, share: parse.viaShare.mock },
    ],
    [parse]
  );
  const authorData = useMemo<RankDatum[]>(
    () => authors.list.map((a) => ({ label: a.name, value: a.files, share: ratio(a.files, scope.files), note: `${a.works} 个作品 · ${fmtBytes(a.bytes)}` })),
    [authors, scope.files]
  );

  const rankFmt = rankMetric === "bytes" ? fmtBytes : fmtCount;
  const trendOpt = useMemo(() => trendOption(points, palette, trendMetric), [points, palette, trendMetric]);
  const platformOpt = useMemo(() => rankOption(platformData, palette, rankFmt), [platformData, palette, rankFmt]);
  const kindOpt = useMemo(() => rankOption(kindData, palette, rankFmt), [kindData, palette, rankFmt]);
  const viaOpt = useMemo(() => rankOption(viaData, palette, fmtCount), [viaData, palette]);
  const authorOpt = useMemo(() => rankOption(authorData, palette, fmtCount), [authorData, palette]);
  const heatOpt = useMemo(() => heatOption(heatData.cells, palette), [heatData, palette]);
  const histOpt = useMemo(() => histogramOption(hist.buckets, palette), [hist, palette]);

  if (snap === null) {
    return (
      <section className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>统计读不出来：{error}</AlertDescription>
          </Alert>
        )}
        <Skeleton className="h-28" />
        <Skeleton className="h-56" />
        <Skeleton className="h-44" />
      </section>
    );
  }

  if (isEmptyStats(snap)) {
    return (
      <section className="flex flex-col gap-3">
        <Card className="gap-0 py-0">
          <div className="flex flex-col items-center gap-2 px-3 py-12 text-center">
            <ScanSearch className="size-11 text-faint" strokeWidth={1.5} aria-hidden="true" />
            <div className="font-medium">还没有可统计的记录</div>
            <p className="max-w-md text-sm text-muted-foreground">
              计数从安装这一刻起算，解析与下载都会累计 —— 去首页贴一条链接，回来这里就有形状了。
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
              <RefreshCw />
              重新读取
            </Button>
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>统计刷新失败：{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Figure label="成功率" value={fmtPercent(health.successRate, 1)} />
          <Figure label="累计字节" value={fmtBytes(health.bytes)} />
          <Figure label="平均速度" value={fmtSpeed(speed.avgBytesPerSec)} />
          <Figure label="解析" value={`${fmtCount(parse.total)} 次`} />
          <Figure label="计数" value={since ? `自 ${since.date} · 第 ${since.days} 天` : "—"} />
          <Button size="sm" variant="outline" className="ms-auto" disabled={busy} onClick={() => void load()}>
            <RefreshCw />
            刷新
          </Button>
        </div>
        {speed.sampled === 0 && (
          <p className="text-xs text-muted-foreground">
            平均速度与耗时还没有可比的样本：需要至少一条带耗时的完成记录（老记录不补这维度，不会追溯）。
          </p>
        )}
      </div>

      <Panel
        title="趋势"
        desc={`近 ${win} 天 · ${fmtCount(total.downloads)} 次 / ${fmtBytes(total.bytes)} / 失败 ${fmtCount(total.failures)}`}
        end={
          <>
            <Segment value={trendMetric} options={TREND_METRICS} onChange={setTrendMetric} ariaLabel="趋势口径" />
            <Segment
              value={win}
              options={TREND_WINDOWS.map((d) => ({ key: d, label: `${d} 天` }))}
              onChange={setWin}
              ariaLabel="趋势窗口"
            />
          </>
        }
      >
        <EChart option={trendOpt} height={222} ariaLabel={`近 ${win} 天逐日下载与失败趋势`} />
      </Panel>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel
          title="平台"
          desc={`按${RANK_LABEL[rankMetric]}排 · 点一条在历史页只看它`}
          end={<Segment value={rankMetric} options={RANK_METRICS} onChange={setRankMetric} ariaLabel="榜单口径" />}
        >
          {platformData.length ? (
            <EChart
              option={platformOpt}
              height={rankHeight(platformData.length)}
              ariaLabel="平台排行条形图"
              onSelect={(i) => {
                const key = platformRows[i]?.key;
                if (key) onNavPlatform(key);
              }}
            />
          ) : (
            <Empty />
          )}
        </Panel>

        <Panel title="类型" desc={`按${RANK_LABEL[rankMetric]}排`}>
          {kindData.length ? <EChart option={kindOpt} height={rankHeight(kindData.length)} ariaLabel="媒体类型排行" /> : <Empty />}
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="单文件体积" desc={`${fmtCount(hist.counted)} 个文件计入${hist.skipped > 0 ? ` · ${fmtCount(hist.skipped)} 条无字节记录未计` : ""}`}>
          <EChart option={histOpt} height={182} ariaLabel="单文件体积分布直方图" />
        </Panel>

        <Panel title="解析" desc={`均耗时 ${fmtDuration(parse.avgDurationMs)}`}>
          {viaData.some((v) => v.value > 0) ? (
            <EChart option={viaOpt} height={rankHeight(viaData.length)} ariaLabel="解析通道占比" />
          ) : (
            <Empty />
          )}
        </Panel>
      </div>

      <Panel
        title="活跃"
        desc={heatData.peak ? `高峰 ${heatSlotLabel(heatData.peak.weekday, heatData.peak.hour)} · ${fmtCount(heatData.peak.value)} 次` : "尚无时段记录"}
      >
        <EChart option={heatOpt} height={172} ariaLabel="星期与小时的活跃热力图" />
      </Panel>

      <Panel
        title="常看作者"
        desc={`明细窗口 ${fmtCount(scope.files)} 个文件${scope.span ? ` · 跨度 ${fmtCount(Math.round((scope.span.to - scope.span.from) / 86_400_000) + 1)} 天` : ""}${authors.anonymous > 0 ? ` · ${fmtCount(authors.anonymous)} 条匿名未计` : ""}`}
      >
        {authorData.length ? <EChart option={authorOpt} height={rankHeight(authorData.length)} ariaLabel="作者文件数排行" /> : <Empty />}
      </Panel>
    </section>
  );
}

function Empty(): React.ReactElement {
  return <p className="py-4 text-center text-sm text-muted-foreground">这一档还没有记录。</p>;
}

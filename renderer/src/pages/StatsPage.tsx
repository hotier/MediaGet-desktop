/**
 * 统计页（⌃4）。顶部只有一个日期范围：预设 7 / 30 / 90 天或自定义起止日，
 * 指标卡、趋势、平台、资源类型、作者从同一个 `StatsQueryResult` 取数 ——
 * 页面不再有第二套日期控件，也不并行读第二本账。每日热力是唯一例外：
 * 它始终是年视图（近一年至今天），不随日期范围联动，自己单独查一份数据。
 *
 * 范围是本机自然日、首尾都含。所选范围跨过统计数据覆盖起点时，覆盖起点之前不补零：
 * 那段日期没有事件可查，画成 0 会变成「那天没人用」的假结论。
 *
 * 图表走 ECharts + 本仓适配器：色值由 `charts/palette.ts` 从 CSS Token 探针取（代码里一个色值都不写），
 * option 全部来自 `lib/stats.ts` 的纯聚合 + `charts/options.ts` 的纯构造器，可在 node 环境整份测掉。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleX, Download, File, HardDriveDownload, Image, Music2, Percent, RefreshCw, ScanSearch, Video, type LucideIcon } from "lucide-react";
import { api, BridgeError } from "../lib/bridge";
import { fmtBytes, fmtCount, fmtPercent, fmtSpeed } from "../lib/format";
import {
  STATS_RANGE_PRESETS,
  activePreset,
  addDays,
  downloadHealth,
  kindRank,
  platformRank,
  presetRange,
  queryAuthors,
  queryTrend,
  queryTrendYear,
  speedStats,
  todayKey,
  type StatsRangePreset,
} from "../lib/stats";
import type { StatsDateRange, StatsQueryResult } from "../../../types/ipc";
import { displayName } from "../../../shared/platforms";
import { DateRangePicker } from "../components/DateRangePicker";
import { EChart } from "../components/charts/EChart";
import { dayHeatOption, donutOption, trendOption, type RankDatum, type TrendMetric } from "../components/charts/options";
import { useChartPalette } from "../components/charts/palette";
import { PlatformIcon } from "../components/PlatformIcon";
import { AuthorAvatar } from "../components/AuthorAvatar";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Skeleton } from "../components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const KIND_RANK_METRICS: Array<{ key: "downloads" | "bytes"; label: string }> = [
  { key: "downloads", label: "次数" },
  { key: "bytes", label: "字节" },
];
const TREND_METRICS: Array<{ key: TrendMetric; label: string }> = [
  { key: "downloads", label: "下载结果" },
  { key: "bytes", label: "传输字节" },
  { key: "parses", label: "解析请求" },
];
const PLATFORM_METRICS: Array<{ key: "parses" | "downloads"; label: string }> = [
  { key: "parses", label: "解析请求" },
  { key: "downloads", label: "下载结果" },
];
const HEAT_METRICS: Array<{ key: TrendMetric; label: string }> = [
  { key: "downloads", label: "下载" },
  { key: "parses", label: "解析" },
  { key: "bytes", label: "字节" },
];

type KindMetric = "downloads" | "bytes";
type PlatformMetric = "parses" | "downloads";

const ZERO_TOTALS: StatsQueryResult["totals"] = {
  downloads: 0,
  failures: 0,
  canceled: 0,
  bytes: 0,
  elapsedMs: 0,
  elapsedCount: 0,
  elapsedBytes: 0,
  parses: 0,
  parseFailures: 0,
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <span className="font-medium leading-5">{title}</span>
        {desc && <span className="text-xs text-muted-foreground tabular-nums">{desc}</span>}
        {end && <div className="ms-auto flex items-center gap-1">{end}</div>}
      </div>
      <div className="px-4 py-4">{children}</div>
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

function PeriodFact({
  icon: Icon,
  tone,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  /** 图标语义色：与全站 ok/info/err/warn 同一套 token */
  tone: string;
  label: string;
  value: string;
  detail: string;
}): React.ReactElement {
  return (
    <Card className="gap-0 py-0">
      <div className="flex min-w-0 flex-col px-4 py-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className={`size-3.5 shrink-0 ${tone}`} aria-hidden="true" />
          {label}
        </div>
        <div className="mt-1.5 truncate text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        <div className="mt-1 text-xs leading-snug text-muted-foreground">{detail}</div>
      </div>
    </Card>
  );
}

export default function StatsPage({
  onNavPlatform,
}: {
  /** 点平台榜的一行 → 历史页只看这个平台 */
  onNavPlatform: (platform: string) => void;
}): React.ReactElement {
  const [range, setRange] = useState<StatsDateRange>(() => presetRange(30));
  const [result, setResult] = useState<StatsQueryResult | null>(null);
  // 热力图的年视图数据：近一年（含今天），与所选范围无关，进页查一次
  const [yearResult, setYearResult] = useState<StatsQueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("downloads");
  const [heatMetric, setHeatMetric] = useState<TrendMetric>("downloads");
  const [platformMetric, setPlatformMetric] = useState<PlatformMetric>("parses");
  const [kindMetric, setKindMetric] = useState<KindMetric>("downloads");
  // 「自定义」是显式档位：选了它才亮出日历入口；回到任一预设档就收起
  const [customMode, setCustomMode] = useState(false);
  const [pickerMounted, setPickerMounted] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const requestId = useRef(0);
  const palette = useChartPalette();

  const today = todayKey();
  const appliedPreset = customMode ? null : activePreset(range);

  const load = useCallback(async (target: StatsDateRange): Promise<void> => {
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const next = await api.stats.get(target);
      if (id !== requestId.current) return;
      setResult(next);
    } catch (e) {
      if (id !== requestId.current) return;
      setResult(null);
      setError(e instanceof BridgeError ? e.message : String(e));
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  // 范围一变就整页只查一次；切档期间收起旧范围的数据，避免标签与数字对不上
  useEffect(() => {
    setResult(null);
    void load(range);
  }, [load, range]);

  // 热力图年视图：滚动窗口（近 365 天至今天），不随范围联动；失败就空着，不挡整页
  useEffect(() => {
    let alive = true;
    setYearResult(null);
    void api.stats
      .get({ from: addDays(today, -364) ?? today, to: today })
      .then((next) => {
        if (alive) setYearResult(next);
      })
      .catch(() => {
        if (alive) setYearResult(null);
      });
    return () => {
      alive = false;
    };
  }, [today]);

  // 日历的出现/收起动画：挂载后下一帧才置可见（让 0fr→1fr 过渡生效），收起播完再卸载
  useEffect(() => {
    if (appliedPreset === null) {
      setPickerMounted(true);
      const raf = requestAnimationFrame(() => setPickerVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setPickerVisible(false);
    const timer = setTimeout(() => setPickerMounted(false), 200);
    return () => clearTimeout(timer);
  }, [appliedPreset]);

  const applyPreset = (days: StatsRangePreset): void => {
    setCustomMode(false);
    const next = presetRange(days);
    setRange((current) =>
      current.from === next.from && current.to === next.to ? current : next
    );
  };

  const applyRange = (from: string, to: string): void => {
    setRange((current) => (current.from === from && current.to === to ? current : { from, to }));
  };

  const points = useMemo(() => (result ? queryTrend(result) : []), [result]);
  const yearPoints = useMemo(() => (yearResult ? queryTrendYear(yearResult) : []), [yearResult]);
  const platformRows = useMemo(
    () =>
      result
        ? platformRank(result, platformMetric)
            .filter((row) =>
              platformMetric === "parses"
                ? row.parses > 0
                : row.downloads > 0 || row.failures > 0
            )
            .sort(
              (a, b) =>
                (platformMetric === "parses"
                  ? b.parses - a.parses
                  : b.downloads + b.failures - a.downloads - a.failures) ||
                a.key.localeCompare(b.key)
            )
        : [],
    [result, platformMetric]
  );
  const kindRows = useMemo(
    () => (result ? kindRank(result, kindMetric).filter((row) => row[kindMetric] > 0) : []),
    [result, kindMetric]
  );
  const authors = useMemo(() => (result ? queryAuthors(result, 10) : []), [result]);

  const kindData = useMemo<RankDatum[]>(
    () =>
      kindRows.map((row) => ({
        label: row.key,
        value: row[kindMetric],
        share: kindMetric === "bytes" ? row.byteShare : row.downloadShare,
      })),
    [kindRows, kindMetric]
  );
  const kindFmt = kindMetric === "bytes" ? fmtBytes : fmtCount;
  const kindOpt = useMemo(() => donutOption(kindData, palette, kindFmt), [kindData, palette, kindFmt]);
  const kindTotal = useMemo(() => kindData.reduce((sum, row) => sum + row.value, 0), [kindData]);
  const trendOpt = useMemo(() => trendOption(points, palette, trendMetric), [points, palette, trendMetric]);
  const dailyHeatOpt = useMemo(() => dayHeatOption(yearPoints, palette, heatMetric), [yearPoints, palette, heatMetric]);

  const totals = result?.totals ?? ZERO_TOTALS;
  const health = downloadHealth({ totals });
  const speed = speedStats({ totals });

  const beforeCoverage =
    result !== null && result.availableFrom !== null && result.range.to < result.availableFrom;
  const rangeEmpty = totals.downloads + totals.failures + totals.canceled + totals.parses === 0;

  // 一条事件都没有时日期控件无事可选：同队列页首次空态，整页只留图标 + 标题
  if (result?.availableFrom === null) {
    return (
      <section className="flex min-h-full flex-col gap-3">
        <PageEmpty title="暂无统计记录" />
      </section>
    );
  }

  return (
    <section className="flex min-h-full flex-col gap-5 pb-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {pickerMounted && (
          <div
            aria-hidden={!pickerVisible}
            className={`grid overflow-hidden transition-[grid-template-columns,margin,opacity] duration-200 ease-out ${
              pickerVisible
                ? "grid-cols-[1fr] opacity-100"
                : "pointer-events-none -me-2 grid-cols-[0fr] opacity-0"
            }`}
          >
            <div className="min-w-0 overflow-hidden">
              <DateRangePicker from={range.from} to={range.to} max={today} onChange={applyRange} />
            </div>
          </div>
        )}
        <Select
          value={appliedPreset === null ? "custom" : String(appliedPreset)}
          onValueChange={(v) => {
            if (v === "custom") {
              setCustomMode(true);
            } else {
              applyPreset(Number(v) as StatsRangePreset);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-28" aria-label="统计日期范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATS_RANGE_PRESETS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                近 {days} 天
              </SelectItem>
            ))}
            {/* 选中自定义才亮出左侧日历，区间在那里改 */}
            <SelectItem value="custom">自定义</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>统计读不出来：{error}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(range)}>
              <RefreshCw className={busy ? "animate-spin" : ""} />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : result === null ? (
        <>
          <Skeleton className="h-28" />
          <Skeleton className="h-56" />
          <Skeleton className="h-44" />
        </>
      ) : beforeCoverage ? (
        <PageEmpty title={`统计记录从 ${result.availableFrom} 开始`} />
      ) : rangeEmpty ? (
        <PageEmpty title="这个范围暂无记录" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <PeriodFact icon={Download} tone="text-ok" label="下载资源" value={fmtCount(health.done)} detail="成功完成" />
            <PeriodFact
              icon={HardDriveDownload}
              tone="text-info"
              label="传输数据"
              value={fmtBytes(health.bytes)}
              detail={speed.sampled > 0 ? `平均速度 ${fmtSpeed(speed.avgBytesPerSec)}` : "暂无速度样本"}
            />
            <PeriodFact
              icon={CircleX}
              tone="text-err"
              label="下载失败"
              value={fmtCount(health.failed)}
              detail={`取消 ${fmtCount(health.canceled)} 次`}
            />
            <PeriodFact
              icon={Percent}
              tone="text-warn"
              label="下载成功率"
              value={fmtPercent(health.successRate, 1)}
              detail={`${fmtCount(health.done)} / ${fmtCount(health.done + health.failed)} 次`}
            />
          </div>

          <Panel
            title="总体趋势"
            end={<Segment value={trendMetric} options={TREND_METRICS} onChange={setTrendMetric} ariaLabel="总体趋势数据类型" />}
          >
            {points.length ? (
              <EChart
                option={trendOpt}
                height={250}
                ariaLabel={`${range.from} 至 ${range.to} 总体${
                  trendMetric === "downloads" ? "完成与失败" : trendMetric === "bytes" ? "传输字节" : "解析请求"
                }趋势`}
              />
            ) : (
              <Empty />
            )}
          </Panel>

          <div className="grid items-start gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <Panel
              title="平台"
              end={<Segment value={platformMetric} options={PLATFORM_METRICS} onChange={setPlatformMetric} ariaLabel="平台统计类型" />}
            >
              {platformRows.length ? (
                <div>
                  <div className="grid grid-cols-[minmax(82px,1.1fr)_repeat(3,minmax(44px,0.7fr))] gap-2 border-b border-border pb-2 text-[11px] text-muted-foreground">
                    <span>平台</span>
                    {platformMetric === "parses" ? (
                      <>
                        <span className="text-right">请求</span>
                        <span className="text-right">成功</span>
                        <span className="text-right">失败</span>
                      </>
                    ) : (
                      <>
                        <span className="text-right">完成</span>
                        <span className="text-right">失败</span>
                        <span className="text-right">字节</span>
                      </>
                    )}
                  </div>
                  <ol aria-label={platformMetric === "parses" ? "各平台解析请求结果" : "各平台下载结果"}>
                    {platformRows.map((row) => (
                      <li key={row.key}>
                        <button
                          type="button"
                          aria-label={
                            platformMetric === "parses"
                              ? `${displayName(row.key)}：解析 ${fmtCount(row.parses)} 次，成功 ${fmtCount(
                                  row.parses - row.parseFailures
                                )} 次，失败 ${fmtCount(row.parseFailures)} 次；点击查看解析历史`
                              : `${displayName(row.key)}：下载完成 ${fmtCount(row.downloads)} 个，失败 ${fmtCount(
                                  row.failures
                                )} 个，${fmtBytes(row.bytes)}；点击查看解析历史`
                          }
                          className="grid w-full grid-cols-[minmax(82px,1.1fr)_repeat(3,minmax(44px,0.7fr))] items-center gap-2 border-b border-border/60 py-3 text-left last:border-0 hover:bg-muted/40"
                          onClick={() => onNavPlatform(row.key)}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <PlatformIcon platform={row.key} className="size-4 shrink-0" />
                            <span className="truncate text-sm font-medium">{displayName(row.key)}</span>
                          </span>
                          {platformMetric === "parses" ? (
                            <>
                              <span className="text-right text-sm font-semibold tabular-nums">{fmtCount(row.parses)}</span>
                              <span className="text-right text-sm font-semibold tabular-nums text-ok">
                                {fmtCount(row.parses - row.parseFailures)}
                              </span>
                              <span className="text-right text-sm font-semibold tabular-nums text-err">
                                {fmtCount(row.parseFailures)}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-right text-sm font-semibold tabular-nums text-ok">
                                {fmtCount(row.downloads)}
                              </span>
                              <span className="text-right text-sm font-semibold tabular-nums text-err">
                                {fmtCount(row.failures)}
                              </span>
                              <span className="text-right text-xs font-semibold tabular-nums">{fmtBytes(row.bytes)}</span>
                            </>
                          )}
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <Empty />
              )}
            </Panel>

            <Panel
              title="资源类型构成"
              end={<Segment value={kindMetric} options={KIND_RANK_METRICS} onChange={setKindMetric} ariaLabel="资源类型构成口径" />}
            >
              {kindData.length ? (
                <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[148px_minmax(0,1fr)]">
                  <div className="relative">
                    <EChart option={kindOpt} height={174} ariaLabel="资源类型占比空心环形图" />
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
                    >
                      <span className="max-w-[112px] truncate text-base font-semibold tracking-tight tabular-nums">
                        {kindFmt(kindTotal)}
                      </span>
                      <span className="mt-0.5 text-[10px] text-muted-foreground">
                        {kindMetric === "bytes" ? "累计体积" : "下载资源"}
                      </span>
                    </div>
                  </div>
                  <div className="divide-y divide-border/70">
                    {kindData.map((row, index) => {
                      const Icon = /视频/.test(row.label)
                        ? Video
                        : /图集|图片|图像|照片/.test(row.label)
                          ? Image
                          : /音频|音乐/.test(row.label)
                            ? Music2
                            : File;
                      const colors = [palette.primary, palette.ok, palette.info, palette.warn, palette.err];
                      return (
                        <div key={row.label} className="flex min-w-0 items-center gap-2 py-2.5 first:pt-1 last:pb-1">
                          <Icon className="size-4 shrink-0" style={{ color: colors[index % colors.length] }} aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row.label}</span>
                          <span className="text-sm font-semibold tabular-nums">{kindFmt(row.value)}</span>
                          <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
                            {fmtPercent(row.share)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <Empty />
              )}
            </Panel>
          </div>

          <Panel title="作者 · 解析与下载">
            {authors.length ? (
              <div className="overflow-x-auto">
                <div className="grid min-w-[580px] grid-cols-[minmax(160px,1fr)_110px_110px_120px] gap-3 border-b border-border pb-2 text-[11px] text-muted-foreground">
                  <span>作者</span>
                  <span className="text-right">解析作品</span>
                  <span className="text-right">下载文件</span>
                  <span className="text-right">下载体积</span>
                </div>
                <ol className="min-w-[580px] divide-y divide-border/60" aria-label="作者解析与下载统计">
                  {authors.map((author, index) => (
                    <li
                      key={author.name}
                      className="grid grid-cols-[minmax(160px,1fr)_110px_110px_120px] items-center gap-3 py-3"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="w-5 text-[11px] tabular-nums text-muted-foreground">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <AuthorAvatar
                          avatar={author.avatar}
                          name={author.name}
                          sizeClassName="size-7"
                          textClassName="text-xs"
                        />
                        <span className="truncate text-sm font-medium">{author.name}</span>
                      </span>
                      <span className="text-right text-sm font-semibold tabular-nums">{fmtCount(author.parsedWorks)}</span>
                      <span className="text-right text-sm font-semibold tabular-nums">{fmtCount(author.downloadedFiles)}</span>
                      <span className="text-right text-sm font-semibold tabular-nums">{fmtBytes(author.downloadedBytes)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <Empty />
            )}
          </Panel>

          <Panel
            title="每日热力"
            desc="近一年"
            end={<Segment value={heatMetric} options={HEAT_METRICS} onChange={setHeatMetric} ariaLabel="每日热力数据类型" />}
          >
            {yearPoints.length ? (
              <EChart
                option={dailyHeatOpt}
                height={180}
                ariaLabel={`近一年每日${
                  heatMetric === "downloads" ? "下载资源" : heatMetric === "parses" ? "解析请求" : "传输字节"
                }热力图`}
              />
            ) : (
              <Empty />
            )}
          </Panel>
        </>
      )}
    </section>
  );
}

/** 与队列页空态同形：无卡片、无说明段，图标 + 标题一行在剩余高度里垂直居中 */
function PageEmpty({ title }: { title: string }): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <ScanSearch className="size-11 text-faint" strokeWidth={1.5} aria-hidden="true" />
      <div className="font-medium">{title}</div>
    </div>
  );
}

function Empty(): React.ReactElement {
  return <p className="py-4 text-center text-sm text-muted-foreground">这个范围还没有记录。</p>;
}

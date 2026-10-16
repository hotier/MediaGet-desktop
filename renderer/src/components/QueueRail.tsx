/**
 * 首页右栏：常驻队列轨。
 *
 * 进度不靠底条常驻，而靠「做事时旁边那条线一直在动」：
 * 解析与下载在同一屏里完成，不需要跳页确认任务有没有进去。
 * 只消费 App 层已有的任务订阅（零新 IPC），断开/失败态都直接来自 DownloadTaskView。
 *
 * 两态设计（2026-10-15）：
 *  - 有任务：**下载中 / 暂停 / 失败**逐条展示（失败也需要用户处理，不能只给个计数），
 *    只有排队收成一行计数 —— 排队是最不需要逐条可见的状态；
 *  - 无任务：不给一句干巴巴的「暂无任务」，改放平台速查（消费平台注册表 × 用户开关）。
 *    这一栏是首页唯一长期空闲的可视区，空着等于浪费。
 */
import { useState } from "react";
import { PLATFORMS, isEnabled } from "../../../shared/platforms";
import type { DownloadTaskView } from "../../../types/ipc";
import { fmtBytes } from "../lib/format";
import { usePlatformStore } from "../store/platforms";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { TruncatedTooltip } from "./ui/tooltip";
import { PlatformIcon } from "./PlatformIcon";

const STATE_LABEL: Record<DownloadTaskView["status"], string> = {
  queued: "排队",
  downloading: "下载中",
  paused: "已暂停",
  done: "完成",
  error: "失败",
  canceled: "已取消",
};

/** 逐条展示的上限；超出的折成一句，排队只给计数（不占高度） */
const MAX_ROWS = 5;

/** 速度：字节/秒 → 人话。为 0 时不显示，避免闪一个假的 0 B/s */
function fmtSpeed(bps: number): string {
  return bps > 0 ? `${fmtBytes(bps)}/s` : "";
}

export function QueueRail({
  tasks,
  onShowAll,
  onUseExample,
}: {
  tasks: DownloadTaskView[];
  onShowAll: () => void;
  /** 空态平台速查：点某个平台 → 往输入框填一条该平台的示例链接 */
  onUseExample?: (url: string) => void;
}): React.ReactElement {
  // 需要用户看见的：正在动的 + 出错的（后者要用户决定重试还是放弃）
  const visible = tasks.filter((t) => t.status === "downloading" || t.status === "paused" || t.status === "error");
  const queued = tasks.filter((t) => t.status === "queued");
  const rows = visible.slice(0, MAX_ROWS);
  const totalPending = visible.length + queued.length;
  const [showAllPlatforms, setShowAllPlatforms] = useState(false);

  return (
    <aside
      className="sticky top-0 flex w-(--w-rail) shrink-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm"
      aria-label="下载队列"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">队列</h2>
        {totalPending > 0 && <span className="tabular-nums text-muted-foreground">{totalPending}</span>}
      </div>

      {rows.length === 0 && queued.length === 0 ? (
        <EmptySupport
          onUseExample={onUseExample}
          expanded={showAllPlatforms}
          onToggle={setShowAllPlatforms}
        />
      ) : (
        <>
          {rows.map((t) => {
            const pct = t.total > 0 ? Math.min(100, (t.received / t.total) * 100) : 0;
            const unknownTotal = t.total <= 0;
            const variant = t.status === "error" ? "warn" : "secondary";
            return (
              <div key={t.taskId} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <TruncatedTooltip label={t.error ?? t.filename}>
                    <span className="min-w-0 flex-1 truncate">{t.filename}</span>
                  </TruncatedTooltip>
                  <Badge variant={variant} data-status={t.status} className="shrink-0 text-sm tabular-nums">
                    {t.status === "downloading"
                      ? unknownTotal
                        ? fmtBytes(t.received)
                        : `${pct.toFixed(0)}%`
                      : STATE_LABEL[t.status]}
                  </Badge>
                </div>
                {t.status !== "error" && (
                  <div className="flex items-center gap-2">
                    <Progress value={unknownTotal ? 100 : pct} className="h-1 flex-1" />
                    {fmtSpeed(t.speed) && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtSpeed(t.speed)}</span>
                    )}
                  </div>
                )}
                {/* 失败原因直接可见：右栏是用户第一眼看到「为什么没下来」的地方，
                    只给个「失败」徽标等于让他去队列页翻 */}
                {t.status === "error" && t.error && (
                  <p className="min-w-0 truncate text-xs text-warn">{t.error}</p>
                )}
              </div>
            );
          })}

          {visible.length > MAX_ROWS && (
            <p className="text-xs text-muted-foreground">还有 {visible.length - MAX_ROWS} 个任务…</p>
          )}

          {queued.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <span className="tabular-nums">排队 {queued.length}</span>
            </div>
          )}
        </>
      )}

      <Button variant="ghost" size="sm" className="mt-auto justify-start px-0 text-sm" onClick={onShowAll}>
        打开完整队列
      </Button>
    </aside>
  );
}

/**
 * 空态：平台速查。
 *
 * 为什么不放「暂无任务」：这句等于什么都没说，而这一栏是首页唯一长期空闲的可视区。
 * 铺平台清单让用户「不用记支持哪些站」——meta.platforms 契约里早就有，此前只被用来
 * 数平台个数（docs/UIUX-DESIGN.md 的勘误里提过这个闲置）。
 */
function EmptySupport({
  onUseExample,
  expanded,
  onToggle,
}: {
  onUseExample?: (url: string) => void;
  expanded: boolean;
  onToggle: (v: boolean) => void;
}): React.ReactElement {
  const switches = usePlatformStore((s) => s.switches);
  const platforms = PLATFORMS.filter((p) => isEnabled(p.key, switches));
  if (platforms.length === 0) {
    return <p className="text-muted-foreground">暂无进行中的任务。解析成功后点「下载」，这里会实时滚动。</p>;
  }
  const shown = expanded ? platforms : platforms.slice(0, 8);
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-muted-foreground">
        暂无下载任务。支持的平台{onUseExample ? "（点一下填入示例链接）" : ""}：
      </p>
      <ul className="flex flex-wrap gap-1.5" aria-label="支持的平台">
        {shown.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              disabled={!onUseExample}
              onClick={() => onUseExample?.(exampleUrlFor(p.key))}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:border-ring hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:border-border disabled:hover:text-muted-foreground"
            >
              <PlatformIcon platform={p.key} />
              {p.name}
            </button>
          </li>
        ))}
      </ul>
      {platforms.length > 8 && (
        <button
          type="button"
          onClick={() => onToggle(!expanded)}
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {expanded ? "收起" : `全部 ${platforms.length} 个平台`}
        </button>
      )}
    </div>
  );
}

/**
 * 每个平台的示例链接：只为让用户看清「这个平台吃什么样的链接」，
 * 不保证该条内容长期有效（解析失败也算合理提示，比让用户空猜要好）。
 */
function exampleUrlFor(key: string): string {
  const map: Record<string, string> = {
    douyin: "https://v.douyin.com/xxxxxxx/",
    bilibili: "https://www.bilibili.com/video/BV1xx411c7mD",
    redbook: "https://www.xiaohongshu.com/explore/xxxxxxxx",
    kuaishou: "https://v.kuaishou.com/xxxxxxx",
    weibo: "https://weibo.com/xxxxxxxxx",
    instagram: "https://www.instagram.com/p/xxxxxxxxx/",
    youtube: "https://www.youtube.com/watch?v=xxxxxxxxxxx",
    twitter: "https://x.com/xxxxxxxxx/status/1234567890",
  };
  return map[key] ?? `https://example.com/${key}`;
}

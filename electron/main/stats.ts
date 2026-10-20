/**
 * 统计事件记录口（SQLite `stats_events`）。
 *
 * 统计页的唯一真源是事件账本：解析、下载成败、取消各落一行不可变事件，按日期范围聚合
 * 由 `statsRepository.query` 完成。这里只做「生命周期回调 → 事件」的翻译，不再维护内存
 * 累计快照 —— JSON 计数档已由迁移归档进 `legacy_stats`，两套账本并存只会越算越远。
 *
 * 隐私红线（AGENTS.md）：事件**只落计数、字节、时长、平台、类型与作品键**。
 * 不写 url、不写文件名、不写作者名、不写 Cookie；作者维度在查询侧关联历史快照。
 *
 * 写失败不向调用方抛：这是下载器/解析器的生命周期回调，账本故障不该反过来弄断传输，
 * 但必须经 `onEventError` 留痕（静默少一段统计同样是事故）。
 */
import type { HistoryEntry, StatsDateRange, StatsQueryResult } from "../../types/ipc";
import type { StatsEventInput } from "./repositories";

const nonNegativeInt = (n: number | undefined): number =>
  Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : 0;

export interface StatsDoneInput {
  at: number;
  platform?: string;
  kind?: string;
  bytes: number;
  /** 单任务**实际传输时长**（v18：`transferMs`，暂停/排队不计）；缺样本时只计字节不计耗时 */
  elapsedMs?: number;
  workKey?: string;
  historyEntry?: HistoryEntry;
}

export interface StatsFailureInput {
  at: number;
  platform?: string;
  kind?: string;
  workKey?: string;
}

export interface StatsCancelInput {
  at: number;
  platform?: string;
  kind?: string;
  workKey?: string;
}

export interface StatsParseInput {
  at: number;
  platform?: string;
  via: "local" | "mock";
  ok: boolean;
  durationMs: number;
  workKey?: string;
  historyEntry?: HistoryEntry;
}

export interface StatsRecorder {
  done(input: StatsDoneInput): void;
  failure(input: StatsFailureInput): void;
  cancel(input: StatsCancelInput): void;
  parse(input: StatsParseInput): void;
  query(range: StatsDateRange): StatsQueryResult;
}

export interface StatsOptions {
  recordEvent(event: StatsEventInput, historyEntry?: HistoryEntry): void;
  query(range: StatsDateRange): StatsQueryResult;
  /** 事件写失败的去处（主进程注入日志）；记录本身不向调用方抛 */
  onEventError?: () => void;
}

export function createStats(opts: StatsOptions): StatsRecorder {
  const recordEvent = (event: StatsEventInput, entry?: HistoryEntry): void => {
    try {
      opts.recordEvent(event, entry);
    } catch {
      // Storage errors must never bubble through downloader/parse lifecycle callbacks or expose secrets.
      opts.onEventError?.();
    }
  };

  return {
    done({ at, platform, kind, bytes, elapsedMs, workKey, historyEntry }) {
      recordEvent(
        {
          type: "download",
          at,
          platform,
          kind: kind || "unknown",
          outcome: "success",
          bytes: nonNegativeInt(bytes),
          transferMs: elapsedMs === undefined ? undefined : nonNegativeInt(elapsedMs),
          workKey,
        },
        historyEntry
      );
    },

    failure({ at, platform, kind, workKey }) {
      recordEvent({
        type: "download",
        at,
        platform,
        kind: kind ?? "unknown",
        outcome: "failure",
        bytes: 0,
        workKey,
      });
    },

    cancel(input) {
      recordEvent({ type: "cancel", ...input });
    },

    parse({ at, platform, via, ok, durationMs, workKey, historyEntry }) {
      recordEvent(
        { type: "parse", at, platform, via, ok, durationMs: nonNegativeInt(durationMs), workKey },
        historyEntry
      );
    },

    query(range) {
      return opts.query(range);
    },
  };
}

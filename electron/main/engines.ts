/**
 * 解析引擎 runner 层（docs/ARCHITECTURE.md §2 engine.ts 的引擎侧细节）。
 *
 * 为什么要这一层（2026-10-16 业主定调「引擎与供给解耦」）：parse-core 只是引擎之一，
 * 「谁能解这个平台」如果继续写死在 engine.ts 的 if-else 里，每加一个兜底引擎都要重排一次
 * 选路，注册表的 `engines` 能力位也会沦为装饰。收进接口之后：
 * - `covers()` = 引擎事实（注册表能力位 ∧ 引擎自报覆盖），不含产品开关；
 * - `run()` = 解一次，失败时如实说「换下一个引擎」还是「这就是最终答复」；
 * - 加引擎 = 往列表里加一项，选路与开关判定不动。
 *
 * 与注册表的分工：注册表说「供不供 + 谁号称能解」，runner 说「今天真的解不解得了」。
 * 两者不一致时以 runner 为准 —— 宁可少供，不许假装有能力。
 *
 * 2026-10-18 起线上回落引擎已移除；2026-10-21 注册制后列表是
 * parse-core（主）→ amagi → yt-dlp（回退），全部本地、失败就是最终答复。
 */
import { normalizeResult } from "@mediaget/parse-core";
import type { EngineHealth, ParseResult } from "../../types/ipc";
import {
  ENGINE_INFO,
  PLATFORMS,
  SWITCHABLE_ENGINE_IDS,
  type EngineId,
  type PlatformSwitch,
  type SwitchableEngineId,
  engineCoverage,
  isEnabled,
  platformDef,
  resolveKey,
} from "../../shared/platforms";

/**
 * 本地解析内核入口（parse-core 的统一入口 + 覆盖清单）。
 *
 * ⚠️ 惰性求值原样保留：内核多个模块在**模块作用域**读 process.env（ytDlpClient 的
 * `YTDLP_BIN`、instagram 的 `IG_COOKIE`、xhsCore 的 `XHS_COOKIE` …），只在模块首次
 * 求值那一刻固化。静态引满全部平台核会把它们定死在 require 瞬间 —— 那时资源定位与
 * 用户 Cookie 注入都还没铺进 process.env。所以覆盖清单第一次用到时才要。
 */
export type CoreEntry = {
  unifiedParseLocal: (input: string, options?: { source?: string; id?: string }) => Promise<object>;
  localParserKeys: () => string[];
};

export interface EngineRequest {
  /** 归一后的契约键（注册表不认识的原样传，引擎自己决定理不理） */
  platform: string;
  url: string;
  source?: string;
  id?: string;
}

/**
 * 引擎跑一次的结局。
 * `ok: false` 意味着**允许换引擎**，`result` 是没得换时给用户的最终答复（旧语义「本地失败」
 * 不能把 null 递给 renderer，这里把它显式带出来，而不是让调用方再猜一次）。
 */
export type EngineOutcome =
  | { ok: true; result: ParseResult }
  | { ok: false; reason: string; result?: ParseResult };

export interface ParseEngine {
  id: EngineId;
  /** 面向用户的引擎名（体检行「通道」用它，如 mediaget / yt-dlp；不出现「通道 1」这类内部编号） */
  label: string;
  covers(platform: string): Promise<boolean>;
  run(req: EngineRequest): Promise<EngineOutcome>;
}

/**
 * 契约 `via` 只剩 local/mock（线上回落在 2026-10-18 移除）。引擎 id 想进界面走 probe 的
 * 能力矩阵，不改这个枚举；将来接入远端引擎时再按「结果从哪来」补值。
 */
const VIA_OF: Record<EngineId, "local" | "mock"> = {
  parseCore: "local",
  ytdlp: "local",
  amagi: "local",
  mock: "mock",
};

export function viaOf(id: EngineId): "local" | "mock" {
  return VIA_OF[id];
}

/** 注册表能力位 + 引擎自报覆盖，两个条件缺一不可 */
export async function coveredBy(
  platform: string,
  engine: EngineId,
  selfReported: () => Promise<Set<string>>
): Promise<boolean> {
  if (engineCoverage(platform, engine) !== "ready") return false;
  return (await selfReported()).has(resolveKey(platform));
}

/**
 * 选路顺序（2026-10-21 注册制）：平台注册表的 `enginePriority` 覆盖引擎的全局声明顺序；
 * 优先表里没点名的引擎按原相对顺序垫底。纯函数，引擎注册表（engine.ts）与体检共用同一份排序。
 */
export function orderedFor(
  engines: ParseEngine[],
  priority?: readonly EngineId[]
): ParseEngine[] {
  if (!priority || priority.length === 0) return engines;
  const rank = new Map<string, number>(priority.map((id, i) => [id, i]));
  const bottom = priority.length;
  return [...engines].sort(
    (a, b) => (rank.get(a.id) ?? bottom) - (rank.get(b.id) ?? bottom)
  );
}

export function createParseCoreEngine(loadCore: () => Promise<CoreEntry>): ParseEngine {
  let keys: Promise<Set<string>> | null = null;
  const coverage = (): Promise<Set<string>> => {
    if (!keys) keys = loadCore().then((c) => new Set(c.localParserKeys()));
    return keys;
  };

  return {
    id: "parseCore",
    label: ENGINE_INFO.parseCore.label,
    async covers(platform) {
      return coveredBy(platform, "parseCore", coverage);
    },
    async run({ platform, url, source, id }) {
      const core = await loadCore();
      try {
        const raw = url
          ? await core.unifiedParseLocal(url)
          : await core.unifiedParseLocal("", { source, id });
        const result = normalizeResult(raw) as unknown as ParseResult;
        // 核心没给契约结果（解析器返回 undefined / 异形）= 本引擎这次不行，可以换人
        if (!result || typeof result.code !== "number") {
          return {
            ok: false,
            reason: "本地内核未返回有效解析结果",
            result: {
              code: 500,
              msg: `本地内核未返回有效解析结果（${platform}）`,
              platform,
              failType: "script-error",
            },
          };
        }
        // ID 模式未命中（解析器没挂 parseVideoId）= 这次没解出来，不是最终答复
        if (!url && result.code !== 200) {
          return { ok: false, reason: "本地内核 ID 解析未命中", result };
        }
        // 业务失败码（视频已删除 / 需登录）如实透传：换引擎也变不出这条内容
        return { ok: true, result };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          reason: msg,
          result: { code: 500, msg: `本地解析失败：${msg}`, platform, failType: "script-error" },
        };
      }
    },
  };
}

/**
 * 注册表 × 可用引擎 → 体检行（probe:engines 的真相来源，不再由内核自述清单决定）。
 *
 * `engines[]` / `engineIds[]` 按该平台的**生效选路顺序**排出：界面下拉的选项先后就是
 * 解析时试的先后（主引擎在第一项）。顺序由调用方注入（引擎宿主知道用户挑的主引擎），
 * 缺省 = 注册表 `enginePriority` 覆盖后的全局注册顺序。
 */
export async function buildHealth(
  engines: ParseEngine[],
  switches: Record<string, PlatformSwitch>,
  orderOf: (platform: string, engines: ParseEngine[]) => ParseEngine[] = (platform, list) =>
    orderedFor(list, platformDef(platform)?.enginePriority)
): Promise<EngineHealth[]> {
  const rows: EngineHealth[] = [];
  for (const p of PLATFORMS) {
    const able: string[] = [];
    const ableIds: SwitchableEngineId[] = [];
    for (const engine of orderOf(p.key, engines)) {
      if (!(await engine.covers(p.key))) continue;
      able.push(engine.label);
      // 引擎 runner 的 id 域比「可切换引擎」宽（含 mock）；这里只收可切换那几个
      if ((SWITCHABLE_ENGINE_IDS as readonly string[]).includes(engine.id)) {
        ableIds.push(engine.id as SwitchableEngineId);
      }
    }
    const supplied = isEnabled(p.key, switches);
    rows.push({
      platform: p.key,
      name: p.name,
      ok: supplied && able.length > 0,
      engines: able,
      engineIds: ableIds,
      detail: !supplied
        ? "注册表已关闭该平台（设置 → 引擎）"
        : able.length > 0
          ? `可解引擎：${able.join(" / ")}`
          : "无引擎今天声明可解",
    });
  }
  return rows;
}

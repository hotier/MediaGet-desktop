/**
 * 统计上报注入件（core-adapter/analytics）—— no-op。
 *
 * 线上 analytics 走 Turso（全站行为统计）。桌面版隐私边界（README 铁律 3 /
 * ARCHITECTURE §6）：不上报用户行为。保留同名接口便于内核装配时注入替换，
 * 调用点零改动。
 */
export interface AnalyticsSink {
  track(event: string, payload?: Record<string, unknown>): void;
}

export function createNoopAnalytics(): AnalyticsSink {
  return {
    track(_event, _payload) {
      /* 隐私红线：桌面客户端不向任何服务器上报用户行为 */
    },
  };
}

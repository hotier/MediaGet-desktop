/**
 * 限流注入件（core-adapter/ratelimit）—— 本地不限流 / 可配温和节流。
 *
 * 线上 api-middleware 的 IP 限流 / 蜜罐 / anti-bot 节流是公网多租户防护，
 * 单机自用属纯开销（docs/ARCHITECTURE.md §2），桌面不加载中间件链。
 * 但保留一个可选的「温和节流」闸门：住宅 IP 下高频打平台接口同样会触发风控，
 * 用户可在设置页配置 throttleMs（默认 0 = 不限）。
 */

export interface ThrottleOptions {
  /** 两次请求之间的最小间隔（毫秒），0 或负数 = 不节流 */
  getIntervalMs: () => number;
}

export interface ThrottleGate {
  /** 取得一次「可以发起请求」的许可（必要时等待） */
  acquire(): Promise<void>;
  /** 立即释放（测试/退出用） */
  reset(): void;
}

export function createThrottle(options: ThrottleOptions): ThrottleGate {
  let lastAt = 0;
  let chain: Promise<void> = Promise.resolve();

  return {
    async acquire() {
      const interval = Math.max(0, options.getIntervalMs() || 0);
      const prev = chain;
      let release: () => void = () => {};
      chain = new Promise<void>((resolve) => {
        release = resolve;
      });

      const wait = () => {
        if (interval <= 0) return 0;
        return Math.max(0, lastAt + interval - Date.now());
      };

      await prev;
      const ms = wait();
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      lastAt = Date.now();
      release();
    },
    reset() {
      chain = Promise.resolve();
      lastAt = 0;
    },
  };
}

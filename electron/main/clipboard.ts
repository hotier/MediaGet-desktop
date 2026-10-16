/**
 * 剪贴板监听（设置→通用→「复制链接自动填入」）。
 *
 * 开启后在主进程轮询剪贴板：文本变化 → 内核 identify 纯本地识别 → 命中分享链接
 * 才投 `app:clipboardLink` 事件给 renderer 填入首页输入框（是否覆盖、是否照常解析
 * 归 renderer 决定）。整串文本不落盘、不出进程之外的任何地方。
 *
 * 为什么开启时先「认账」当前内容：设置页点开开关的那一刻，剪贴板里往往还躺着
 * 与本次操作无关的旧内容 —— 只有开关之后的新复制才应触发。
 *
 * electron clipboard 由 index.ts 注入（readText；Electron 44 起该 API 是 Promise），
 * 本模块保持纯 Node 可测。
 */
import type { IdentifyOutcome } from "../../types/ipc";

export interface ClipboardWatcherDeps {
  /** 读当前剪贴板文本（index.ts 注入 electron clipboard.readText） */
  readText(): string | Promise<string>;
  /** 纯本地识别，不发起抓取（engine.identify） */
  identify(text: string): IdentifyOutcome;
  /** 命中分享链接（platform 非空且 url 有值） */
  onLink(link: IdentifyOutcome): void;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1000;
/** 与 parse:identify 入参上限对齐：超长文本（整篇富文本粘贴等）不识别 */
const MAX_TEXT = 4000;

export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  /** 上一次见过的剪贴板全文：变化才走识别，同一条复制两次只算一次 */
  private lastSeen = "";
  /** 读取在途：异步 readText 比轮询间隔慢时跳过本轮，避免并发读乱序 */
  private polling = false;
  private readonly intervalMs: number;

  constructor(private deps: ClipboardWatcherDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** 幂等；开关保存即热更（onSettingsChanged 调用） */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.stop();
      return;
    }
    void this.start();
  }

  dispose(): void {
    this.enabled = false;
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 认账当前内容后再起轮询；等待期间被关掉就直接放弃（快速开关不残留定时器） */
  private async start(): Promise<void> {
    const seed = await this.readNow();
    if (!this.enabled) return;
    this.stop();
    this.lastSeen = seed;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  private readNow(): Promise<string> {
    try {
      return Promise.resolve(this.deps.readText()).catch(() => "");
    } catch {
      return Promise.resolve("");
    }
  }

  private tick(): void {
    if (this.polling) return;
    this.polling = true;
    void this.readNow().then((text) => {
      this.polling = false;
      if (!this.enabled || text === this.lastSeen) return;
      this.lastSeen = text;
      this.emitIfLink(text);
    });
  }

  /**
   * 全局快捷键的手动触发（index.ts 的 Ctrl+Alt+V）：按下即用户意图，
   * 所以不看 `enabled`、不等「变化」——同一条链接连按两次都会再投一次。
   * 仍写 `lastSeen`：否则松手后的下一轮轮询会把同一条当成新复制补投。
   */
  checkNow(): void {
    void this.readNow().then((text) => {
      this.lastSeen = text;
      this.emitIfLink(text);
    });
  }

  /** 识别 → 命中才投递；异常一律吞掉（轮询与快捷键都不该被一次识别失败打断） */
  private emitIfLink(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_TEXT) return;
    try {
      const r = this.deps.identify(trimmed);
      if (r.platform && r.url) this.deps.onLink(r);
    } catch {
      /* 识别异常不能拖垮轮询 */
    }
  }
}

export function createClipboardWatcher(deps: ClipboardWatcherDeps): ClipboardWatcher {
  return new ClipboardWatcher(deps);
}

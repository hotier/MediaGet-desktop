/**
 * 设置页「打开登录页自动获取 Cookie」（业主指令 2026-10-19：Cookie 会过期，导入要顺手）。
 *
 * 边界：Cookie 值全程只在主进程里走一遍——渲染层拿到的是「已配置」这个事实，
 * 不是值本身（与 `settings:get` 的 `"***"` 掩码同一条隐私契约）。抓到后直接写档
 * （`settings.cookies` + `kernel` 双写，与 `settings:set` 同语义），再走
 * `onSettingsChanged` 铺进 `process.env`——内核在模块作用域读 env，改完不铺等于没改。
 *
 * 会话用**持久 partition**（`persist:` 前缀，业主指令 2026-10-19：登录一遍就够，别反复登）：
 * 上次登过的话，窗口一开就是已登录页，判据立刻命中、当场抓完关闭。代价要说清楚——
 * `userData/Partitions/cookie-login/` 里会多一份浏览器口径的会话罐，与本机设置里那份
 * Cookie 并列；但**业务真源仍只有本机设置**：这份罐只服务本流程，解析/下载一概不读它。
 * 换账号的出口是登录页自己的「退出登录」，不是删罐（不自动清，否则又回到"每次都要登"）。
 *
 * 判据为什么是「登录态标记」而不是「有 cookie 就算」：匿名访客也有 `ttwid`/`did` 一类，
 * 抓早了会把半份 Cookie 存成「已配置」，而它必然解析失败——比没配更难排查。
 *
 * 小红书还有更隐蔽的一层（2026-10-21 业主实测：没登录却显示已获取 13 条）：
 * 游客打开页面时前端就会注册一个 `web_session`，**名字与登录态那枚完全一样**。
 * 所以它的判据不是「有没有」，而是「值变没变」（`volatileMarkers` + 基线），见
 * `takeBaseline` 上方那段。
 */
import { BrowserWindow, session, shell, type Session } from "electron";
import { DESKTOP_USER_AGENT } from "./hotlink";
import {
  COOKIE_LOGIN_TARGETS,
  buildCookieHeader,
  filterCookies,
  hasLoginMarker,
  isAllowedNavigation,
  volatileMarkerChanged,
  type CookieLoginKey,
  type RawCookie,
} from "../../shared/cookie-login";

export interface CookieLoginResult {
  captured: boolean;
  reason: "captured" | "no-login" | "timeout" | "busy" | "error";
}

export interface CookieLoginDeps {
  /** 抓成功后写档（与 `settings:set` 同一条：settings.cookies + kernel 双写） */
  saveCookie: (key: CookieLoginKey, header: string) => void;
  /** 写档后的副作用（index.ts 注入 = onSettingsChanged → publishKernelEnv） */
  onCaptured: () => void;
  /** 登录窗口吃与主窗口同一份代理设置；manual 模式下不铺，登录页根本打不开 */
  prepareSession: (ses: Session) => Promise<void>;
  getParent: () => BrowserWindow | null;
  logger: { info(message: string): void; warn(message: string): void };
  /** 超时（毫秒）；缺省 3 分钟——够扫码/输密码，又不至于留一个窗口挂一整天 */
  timeoutMs?: number;
}

/** `persist:` 前缀 = 落盘会话：跨重启保留登录态（见文件头）。去掉前缀就退回「每次重登」 */
const PARTITION = "persist:cookie-login";
const POLL_MS = 800;
/** 判据出现后再等的这一拍：登录成功后 cookie 是分几次写的，立刻抓容易少一枚 */
const SETTLE_MS = 1_200;
/**
 * 「游客也会写」的键：页面加载完成后再等这么久才拍基线。
 * 小红书匿名打开时前端脚本会先注册一个游客 `web_session`，拍早了基线还是空，
 * 下一拍看到值出现就会误判成登录成功（2026-10-21 业主实测那条「没登录就显示已获取」）。
 */
const BASELINE_DELAY_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

export interface CookieLogin {
  run(key: CookieLoginKey): Promise<CookieLoginResult>;
}

export function createCookieLogin(deps: CookieLoginDeps): CookieLogin {
  /** 同一时刻只允许一个登录窗口：并发开两扇，用户会不知道该在哪个里登 */
  let running: BrowserWindow | null = null;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function run(key: CookieLoginKey): Promise<CookieLoginResult> {
    if (running && !running.isDestroyed()) {
      running.focus();
      return { captured: false, reason: "busy" };
    }

    const target = COOKIE_LOGIN_TARGETS[key];
    // 持久会话：**不清 storage**——清了就等于每次重登。HTTP 缓存关掉即可，
    // cookies / localStorage 照常落在分区目录里（登录态靠它们活着）
    const ses = session.fromPartition(PARTITION, { cache: false });
    try {
      // Electron 默认 UA 带 `Electron/44.x` 标记，快手首页据此直接回风控 JSON
      // （2026-10-19 实测：同一 URL，Chrome UA 是 /new-reco 的 HTML，Electron UA 是
      // `{"result":2,...}`）。登录窗口改用与下载/预览同一枚桌面 UA——不是伪装加码，
      // 是把「我们用的客户端」统一成同一个口径。
      ses.setUserAgent(DESKTOP_USER_AGENT);
      await deps.prepareSession(ses);
    } catch (e) {
      // 只记「哪一步失败」，不记任何 cookie/URL
      deps.logger.warn(`[cookie-login] 会话准备失败：${(e as Error).message}`);
      return { captured: false, reason: "error" };
    }

    const parent = deps.getParent();
    const win = new BrowserWindow({
      width: 460,
      height: 760,
      show: false,
      title: "登录后自动获取 Cookie",
      autoHideMenuBar: true,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    running = win;

    return new Promise<CookieLoginResult>((resolve) => {
      let settled = false;
      let settleTimer: NodeJS.Timeout | null = null;
      let deadline: NodeJS.Timeout | null = null;
      let pollTimer: NodeJS.Timeout | null = null;

      const volatileNames = target.volatileMarkers ?? [];
      /**
       * 「游客也会写」那些键开窗那一刻的取值。**不能开窗前取**——持久分区里可能还躺着
       * 上次的游客会话，页面一加载就会换成新的，那一换会被当成「登录成功」。
       * 所以基线在页面加载完成、且留出页面脚本写游客会话的时间之后再拍（见下方）。
       */
      const baseline = new Map<string, string>();
      /** 基线没拍到时不做「变化」判断：宁可不抓，也不能把匿名态存成已配置 */
      let baselineReady = volatileNames.length === 0;

      const finish = (result: CookieLoginResult): void => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (deadline) clearTimeout(deadline);
        if (settleTimer) clearTimeout(settleTimer);
        running = null;
        if (!win.isDestroyed()) win.destroy();
        resolve(result);
      };

      /** 读一次 cookie 并落档；拿到非空 Cookie 头才算成功 */
      const capture = async (): Promise<boolean> => {
        const all = (await ses.cookies.get({}).catch(() => [])) as RawCookie[];
        const mine = filterCookies(all, target.domains);
        // 排序优先级里把 volatile 也算进来：`web_session` 就是小红书最要紧那一枚，
        // 超长时必须先它留下，别被埋点 cookie 挤掉
        const header = buildCookieHeader(mine, [...target.markers, ...volatileNames]);
        if (!header) return false;
        deps.saveCookie(key, header);
        deps.onCaptured();
        // 条数与键名都不是秘密；值不进日志（隐私红线）
        deps.logger.info(`[cookie-login] ${key} 已捕获（${mine.length} 条）`);
        return true;
      };

      /** 拍一次基线：只记 volatile 那些键当时的取值 */
      const takeBaseline = async (): Promise<void> => {
        const all = (await ses.cookies.get({}).catch(() => [])) as RawCookie[];
        const mine = filterCookies(all, target.domains);
        baseline.clear();
        for (const c of mine) {
          if (c.value && volatileNames.includes(c.name)) baseline.set(c.name, c.value);
        }
        baselineReady = true;
      };

      if (volatileNames.length > 0) {
        win.webContents.once("did-finish-load", () => {
          // 游客会话是页面脚本写的，给它一点时间写定再拍基线（早一步就拍到空）
          setTimeout(() => void takeBaseline(), BASELINE_DELAY_MS);
        });
      }

      pollTimer = setInterval(() => {
        void (async () => {
          if (settled || win.isDestroyed() || settleTimer) return;
          const all = (await ses.cookies.get({}).catch(() => [])) as RawCookie[];
          const mine = filterCookies(all, target.domains);
          const loggedIn =
            hasLoginMarker(mine.map((c) => c.name), target.markers) ||
            (baselineReady && volatileMarkerChanged(mine, volatileNames, baseline));
          if (!loggedIn) return;
          // 判据已出现：等一拍让同一轮登录的其余 cookie 落齐，再一次性收
          settleTimer = setTimeout(() => {
            void (async () => {
              if (settled) return;
              const ok = await capture();
              finish(ok ? { captured: true, reason: "captured" } : { captured: false, reason: "no-login" });
            })();
          }, SETTLE_MS);
        })();
      }, POLL_MS);

      deadline = setTimeout(() => {
        deps.logger.warn(`[cookie-login] ${key} 超时未检测到登录态`);
        finish({ captured: false, reason: "timeout" });
      }, timeoutMs);

      // 用户自己关窗 = 放弃。判据没出现过的，说「没检测到登录态」比「已取消」有用
      win.on("closed", () => finish({ captured: false, reason: "no-login" }));

      // 登录完成后的「帮助中心 / 第三方授权」这类外链不许把窗口带出平台域
      win.webContents.on("will-navigate", (event, url) => {
        if (isAllowedNavigation(url, target.domains)) return;
        event.preventDefault();
        if (/^https?:/i.test(url)) void shell.openExternal(url);
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedNavigation(url, target.domains)) void win.loadURL(url);
        else if (/^https?:/i.test(url)) void shell.openExternal(url);
        return { action: "deny" };
      });

      win.once("ready-to-show", () => {
        if (!win.isDestroyed()) win.show();
      });
      void win.loadURL(target.url).catch((e: Error) => {
        /**
         * 抓完就 `destroy()`，而此刻导航往往还没走完（SPA 首屏之后仍在加载），
         * 被打断的那次 loadURL 会以 `ERR_FAILED (-2)` / `ERR_ABORTED` reject。
         * 那是**成功的收尾噪声**，不是「登录页打不开」——按失败处理只会让日志骗人，
         * 顺手把一个已经成功的结果盖成 error。
         */
        if (settled || win.isDestroyed()) return;
        deps.logger.warn(`[cookie-login] 登录页加载失败：${e.message}`);
        finish({ captured: false, reason: "error" });
      });
    });
  }

  return { run };
}

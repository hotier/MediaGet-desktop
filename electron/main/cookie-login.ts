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
 */
import { BrowserWindow, session, shell, type Session } from "electron";
import { DESKTOP_USER_AGENT } from "./hotlink";
import {
  COOKIE_LOGIN_TARGETS,
  buildCookieHeader,
  filterCookies,
  hasLoginMarker,
  isAllowedNavigation,
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
        const header = buildCookieHeader(mine, target.markers);
        if (!header) return false;
        deps.saveCookie(key, header);
        deps.onCaptured();
        // 条数与键名都不是秘密；值不进日志（隐私红线）
        deps.logger.info(`[cookie-login] ${key} 已捕获（${mine.length} 条）`);
        return true;
      };

      pollTimer = setInterval(() => {
        void (async () => {
          if (settled || win.isDestroyed() || settleTimer) return;
          const all = (await ses.cookies.get({}).catch(() => [])) as RawCookie[];
          const mine = filterCookies(all, target.domains);
          if (!hasLoginMarker(mine.map((c) => c.name), target.markers)) return;
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

      win.once("ready-to-show", () => win.show());
      void win.loadURL(target.url).catch((e: Error) => {
        deps.logger.warn(`[cookie-login] 登录页加载失败：${e.message}`);
        finish({ captured: false, reason: "error" });
      });
    });
  }

  return { run };
}

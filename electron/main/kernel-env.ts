/**
 * 内核 Cookie 的**前置**注入 —— 只有副作用，必须在 `./engine` 求值之前跑完。
 *
 * 为什么单独一个模块：parse-core 的 `xhsCore` / `bilibiliCore` / `instagram` 在**模块作用域**
 * 读 `getConfigOrEnv(...)`，值在模块首次求值那一刻就定死了（1.1.1 实测：
 * `var XHS_COOKIE = String(getConfigOrEnv("xhsCookie", "XHS_COOKIE", ""))`）。而
 * `publishKernelEnv()` 写在 index.ts 的函数体里，那时整张 import 图（含 parse-core）早已求值完 ——
 * 设置页配的 Cookie 永远进不了这几个 parser。
 *
 * **事故证据（2026-10-18）**：同一份 `probe_marker=1` 的 Cookie，「先 import 内核再设 env」
 * 时小红书请求头 `cookieLen=0`；「先设 env 再 import」时 `cookieLen=33`、标记命中。
 *
 * ESM 的求值顺序 = import 顺序，所以本模块在 index.ts 里排在 `./engine` 之前。douyin 那种
 * 「函数内 getConfigOrEnv」的 parser 本就在每次解析时重读，不受影响；反过来，作用域类型的
 * parser 换 Cookie **只能靠重启**（值已经进了常量），设置页那句「立即生效」对它们只到
 * douyin 这一档为止。
 */
import { SECRET_CONFIG_KEYS } from "../../core-adapter/config";
import { settingsRepository } from "./storage-runtime";

/**
 * 把本机设置（SQLite `app_settings`）里的用户 Cookie 铺进 `process.env`。
 * 只补「当前进程还没有」的键：dev 环境变量手写的 Cookie 优先（与 `publishKernelEnv` 同一条）。
 */
function primeKernelCookies(): void {
  try {
    const { settings } = settingsRepository.loadConfig();
    for (const key of SECRET_CONFIG_KEYS) {
      const value = settings.cookies?.[key];
      if (value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    // 读档失败不阻断启动：解析按「没配 Cookie」降级，设置页仍可写入
  }
}

primeKernelCookies();

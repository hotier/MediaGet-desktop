/**
 * 代理设置 → 网络栈的纯逻辑（无 electron / undici 依赖，便于单测）。
 *
 * 应用内全部出网有两套栈，都要吃同一份设置（胶水在 index.ts 的 applyProxy）：
 * - Node fetch（解析内核 / 下载器 / 线上回落）→ undici 全局 dispatcher
 * - Electron net（更新器）→ session 代理
 */

/** 手动模式归一：缺 scheme 按 http:// 补；只认 http/https；空/非法 → null（直连）。
 * userinfo 保留（带鉴权的代理），path/query 丢弃（代理连接只用 scheme+host+port）。 */
export function normalizeProxyUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
  return `${u.protocol}//${auth}${u.host}`;
}

/** Electron session.resolveProxy 的规则串 → http 代理 URL；DIRECT/SOCKS/空 → null。
 * 串形如 "PROXY 127.0.0.1:7897" 或 "DIRECT"；多条以 ; 分隔，取首个 PROXY/HTTPS。 */
export function proxyUrlFromRule(rule: string): string | null {
  for (const part of rule.split(";")) {
    const m = /^\s*(PROXY|HTTPS)\s+(\S+)\s*$/i.exec(part);
    if (m) return `http://${m[2]}`;
  }
  return null;
}

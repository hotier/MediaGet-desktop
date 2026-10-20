/**
 * 侧栏收起偏好的读写契约（规格 docs/superpowers/specs/2026-10-20-sidebar-collapse-design.md）。
 *
 * 为什么是 localStorage 而不是 AppSettings：收起是 UI chrome 不是用户数据——
 * 进设置要动 IPC 六件套（types/ipc、ipc-contract、handler、preload、bridge、mock-bridge），
 * 还会被设置页的草稿/脏计数/保存条语义裹挟。渲染层自管，一行读写。
 *
 * 值域刻意收窄成 "0"/"1"：解析器把缺 key 与任何脏值都折叠回展开（false），
 * 未来即便有人手改了 localStorage 也不会炸出半收起态。
 */
export const SIDEBAR_COLLAPSED_KEY = "mg.sidebar.collapsed";

/** localStorage 原始值 → 是否收起。缺 key/脏值一律展开 */
export function parseSidebarCollapsed(raw: string | null): boolean {
  return raw === "1";
}

/** 是否收起 → localStorage 原始值，与 parseSidebarCollapsed 互逆 */
export function serializeSidebarCollapsed(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

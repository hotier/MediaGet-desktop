/**
 * 侧栏收起偏好的读写守卫（L1，纯函数无 DOM）。
 * localStorage 里只允许两种值：缺 key/非 "1" = 展开，"1" = 收起——
 * 解析器把任何脏值都折叠回展开，序列化器只产出 "0"/"1"。
 */
import { describe, expect, it } from "vitest";
import { parseSidebarCollapsed, serializeSidebarCollapsed } from "../renderer/src/lib/sidebar-pref";

describe("parseSidebarCollapsed", () => {
  it("缺 key 与任意脏值都折叠回展开", () => {
    expect(parseSidebarCollapsed(null)).toBe(false);
    expect(parseSidebarCollapsed("")).toBe(false);
    expect(parseSidebarCollapsed("junk")).toBe(false);
    expect(parseSidebarCollapsed("0")).toBe(false);
  });

  it("「1」= 收起", () => {
    expect(parseSidebarCollapsed("1")).toBe(true);
  });
});

describe("serializeSidebarCollapsed", () => {
  it("布尔只产出 0/1，且与解析器往返一致", () => {
    expect(serializeSidebarCollapsed(false)).toBe("0");
    expect(serializeSidebarCollapsed(true)).toBe("1");
    expect(parseSidebarCollapsed(serializeSidebarCollapsed(true))).toBe(true);
    expect(parseSidebarCollapsed(serializeSidebarCollapsed(false))).toBe(false);
  });
});

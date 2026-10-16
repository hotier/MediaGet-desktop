/**
 * 字体族分组排序（electron/main/fonts.ts 的 orderFamilies / isChineseFamily）。
 * 业主指令 2026-10-15：设置→字体族「中文字体靠前、英文字体靠后」。
 *
 * 分类名单是这里唯一的正确性风险，故用 Windows 注册表里真实登记的族名取证：
 * 关键陷阱是中文系统字体大多登记为英文名（DengXian=等线、SimSun=宋体…），
 * 只按「名字含中文字符」判定会把主力中文字体错分到英文组。
 */
import { describe, expect, it } from "vitest";
import { isChineseFamily, orderFamilies } from "../electron/main/fonts";

describe("isChineseFamily", () => {
  it("中文字面族名判中文", () => {
    for (const n of ["微软雅黑", "宋体", "汉仪中黑 197", "楷体_GB2312"]) {
      expect(n, n).toBeTruthy();
      expect(isChineseFamily(n), n).toBe(true);
    }
  });

  it("英文登记的中文系统字体也判中文（这是名单存在的理由）", () => {
    for (const n of ["DengXian", "SimSun", "Microsoft YaHei", "NSimSun", "SimHei", "KaiTi"]) {
      expect(isChineseFamily(n), n).toBe(true);
    }
  });

  it("纯西文字体判非中文", () => {
    for (const n of ["Arial", "Segoe UI", "Consolas", "Calibri", "Times New Roman", "Bahnschrift"]) {
      expect(isChineseFamily(n), n).toBe(false);
    }
  });

  it("东亚（日/韩）系统字体归中文组（都属 CJK，靠前更合检索直觉）", () => {
    for (const n of ["Yu Gothic", "Malgun Gothic", "Meiryo"]) {
      expect(isChineseFamily(n), n).toBe(true);
    }
  });

  it("思源系 / Noto CJK 开源中文字体判中文", () => {
    for (const n of ["Source Han Sans SC", "Noto Sans CJK SC", "Sarasa Mono SC"]) {
      expect(isChineseFamily(n), n).toBe(true);
    }
  });

  it("易误伤的反例：西文里含相似前缀不误判（sim 只认 simsun 等整词、ms 只认 ms jhenghao）", () => {
    // "Simplex" 开头 "Sim" 但不是 simsun/simhei…；"MS Sans Serif" 不在中文名单
    expect(isChineseFamily("Simplex")).toBe(false);
    expect(isChineseFamily("MS Sans Serif")).toBe(false);
    // "STIX Two Text"（西文字体）不能因 "st" 前缀被吞进中文组
    expect(isChineseFamily("STIX Two Text")).toBe(false);
  });
});

describe("orderFamilies", () => {
  it("中文组整体排在英文组之前", () => {
    const input = ["Arial", "微软雅黑", "Segoe UI", "DengXian", "Consolas", "宋体"];
    const out = orderFamilies(input);
    const firstEnglish = out.findIndex((f) => !isChineseFamily(f));
    // 任一英文项之前不得再有中文项
    const lastChinese = out.map(isChineseFamily).lastIndexOf(true);
    expect(lastChinese).toBeLessThan(firstEnglish);
  });

  it("输出是输入的同一集合（不吞不增），组内按 locale 序稳定", () => {
    const input = ["Segoe UI", "宋体", "Arial"];
    const out = orderFamilies(input);
    expect([...out].sort()).toEqual([...input].sort());
    // 中文组只有一个「宋体」在最前；英文组 Segoe/Arial 由 locale 决定次序，这里只钉相对位置不钉绝对
    expect(out[0]).toBe("宋体");
    expect(out).not.toContain(undefined);
    expect(out.length).toBe(3);
  });

  it("全英文输入：保持原 locale 序，不产生空组错位", () => {
    const out = orderFamilies(["Segoe UI", "Arial", "Consolas"]);
    expect(out).toEqual(["Arial", "Consolas", "Segoe UI"]);
  });

  it("空输入安全", () => {
    expect(orderFamilies([])).toEqual([]);
  });
});

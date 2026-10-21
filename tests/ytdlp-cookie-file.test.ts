/**
 * Cookie 头 → Netscape cookiefile（2026-10-21 线上那条 "Sign in to confirm you're not a bot"）。
 *
 * 事故根因：`ytdlp-nodejs` 把 `InfoOptions.cookies` 原样塞进 `--cookies`，而 yt-dlp 这个参数
 * 只收**文件路径**。传头串不会报错，只会静默退回匿名请求——所以「配了 Cookie 还撞 bot 墙」
 * 必须由格式这一层钉死，而不是靠人记得。
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCookieFile, toNetscapeCookieFile } from "../electron/main/ytdlp-cookie-file";

const NOW = 1_760_000_000_000; // 固定时间：过期列要对得上，不能随跑测试的日期漂

const rowsOf = (text: string): string[][] =>
  text
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("\t"));

describe("toNetscapeCookieFile", () => {
  it("首行是 Netscape 表头，其余每条 cookie 一行、7 个制表符字段", () => {
    const text = toNetscapeCookieFile("SID=abc; HSID=def", "youtube.com", NOW);
    expect(text.startsWith("# Netscape HTTP Cookie File")).toBe(true);
    const rows = rowsOf(text);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveLength(7);
  });

  it("域补前导点、路径 /、过期在未来：yt-dlp 只按这几列认", () => {
    const [row] = rowsOf(toNetscapeCookieFile("SID=abc", "youtube.com", NOW));
    expect(row[0]).toBe(".youtube.com");
    expect(row[1]).toBe("TRUE"); // 含子域
    expect(row[2]).toBe("/");
    expect(Number(row[4])).toBeGreaterThan(Math.floor(NOW / 1000));
    expect(row[5]).toBe("SID");
    expect(row[6]).toBe("abc");
  });

  it("值里的等号原样保留（base64 尾巴常带 =）", () => {
    const [row] = rowsOf(toNetscapeCookieFile("SID=abc==; X=1", "youtube.com", NOW));
    expect(row[6]).toBe("abc==");
  });

  it("含制表符 / 换行的条目直接丢掉：硬塞会把后面的 cookie 挤到别的字段上", () => {
    const text = toNetscapeCookieFile("A=1; B\tC=2; D=3\nE=4", "youtube.com", NOW);
    const names = rowsOf(text).map((r) => r[5]);
    expect(names).toEqual(["A"]);
  });

  it("空输入只留注释行（调用方据此不乱写文件）", () => {
    const text = toNetscapeCookieFile("", "youtube.com", NOW);
    expect(rowsOf(text)).toEqual([]);
    expect(text.startsWith("# Netscape HTTP Cookie File")).toBe(true);
  });
});

describe("createCookieFile（临时文件，用完即删）", () => {
  it("写出来能读回同一份内容，cleanup 之后文件消失", async () => {
    const dir = join(tmpdir(), `mediaget-ytdlp-test-${process.pid}-${Date.now()}`);
    const handle = await createCookieFile(dir, "youtube", "SID=abc; HSID=def", "youtube.com");
    expect(handle).not.toBeNull();
    const body = readFileSync(handle!.path, "utf8");
    expect(body).toContain("\tSID\tabc");
    expect(body).toContain("\tHSID\tdef");
    // 文件名里不许出现 cookie 值（临时目录也可能被人看到）
    expect(handle!.path).not.toContain("abc");
    await handle!.cleanup();
    await expect(handle!.cleanup()).resolves.toBeUndefined(); // 幂等
    rmSync(dir, { recursive: true, force: true });
  });

  it("没有可用条目时返回 null：不拿一个空文件去糊弄 yt-dlp", async () => {
    const dir = join(tmpdir(), `mediaget-ytdlp-test-empty-${process.pid}`);
    await expect(createCookieFile(dir, "youtube", ";; ;", "youtube.com")).resolves.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

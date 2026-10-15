/**
 * 文件日志（electron/main/logger.ts）：级别门槛热生效、一行一条、按大小轮转、按天保留。
 *
 * 这里断言的都是「设置页承诺的行为」：级别下拉改完即生效（不重启）、
 * 保留天数按 mtime 删超期档、清理只删自己管辖的文件名 ——
 * 最后一项同时是隐私边界：日志目录里若混进别的应用文件，清理不许顺手删掉。
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../electron/main/logger";
import type { LogLevel } from "../types/ipc";

const MB = 1024 * 1024;
const DAY = 86_400_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mg-logger-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const exists = (name: string): boolean => {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
};
const size = (name: string): number => statSync(join(dir, name)).size;
const age = (name: string, days: number): void => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(join(dir, name), t, t);
};

function harness(level: LogLevel = "info", retentionDays = 7) {
  let gate = level;
  let retention = retentionDays;
  const logger = createLogger({
    logDir: () => dir,
    getLevel: () => gate,
    getRetentionDays: () => retention,
  });
  return {
    logger,
    setLevel: (v: LogLevel) => {
      gate = v;
    },
    setRetention: (v: number) => {
      retention = v;
    },
  };
}

/** 当前档按行读出（写入自带 ISO 时间戳前缀） */
const lines = (): string[] => readFileSync(join(dir, "app.log"), "utf8").replace(/\n$/, "").split("\n");

describe("级别门槛", () => {
  it("off 停写；warn 档留 error+warn、丢掉 info", () => {
    const { logger, setLevel } = harness("off");
    logger.error("不该写");
    expect(exists("app.log")).toBe(false); // 关日志 = 一行不落、目录也不建

    setLevel("warn");
    logger.error("e1");
    logger.warn("w1");
    logger.info("不该写");
    const t = lines();
    expect(t).toHaveLength(2);
    expect(t[0]).toContain("[error] e1");
    expect(t[1]).toContain("[warn] w1");
  });

  it("门槛每次写都重取：改完设置立刻生效，无需重启", () => {
    const { logger, setLevel } = harness("info");
    logger.info("i1");
    setLevel("error");
    logger.info("不该写");
    logger.error("e1");
    expect(lines()).toHaveLength(2);
  });
});

describe("行结构", () => {
  it("换行折成 | ，超长截断——多行堆栈不许破坏「一行一条」", () => {
    const { logger } = harness();
    logger.error("第一行\n第二行\r\n第三行");
    const t = lines();
    expect(t).toHaveLength(1);
    expect(t[0]).toContain("第一行 | 第二行 | 第三行");

    logger.error("x".repeat(5000));
    expect(lines()[1].split("[error] ")[1]).toHaveLength(2000);
  });
});

describe("按大小轮转", () => {
  it("当前档写满 2 MB 前整档降为 app.1.log，新行落在重建的当前档", () => {
    const { logger } = harness();
    writeFileSync(join(dir, "app.log"), "a".repeat(2 * MB));
    logger.warn("轮转后的第一行");
    expect(size("app.1.log")).toBe(2 * MB);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("轮转后的第一行");
  });

  it("轮转只留 5 档：app.5 被挤掉，app.1→2、当前档→1", () => {
    const { logger } = harness();
    writeFileSync(join(dir, "app.log"), "a".repeat(2 * MB));
    writeFileSync(join(dir, "app.1.log"), "one");
    writeFileSync(join(dir, "app.5.log"), "oldest");
    logger.warn("触发轮转");
    expect(readdirSync(dir).sort()).toEqual(["app.1.log", "app.2.log", "app.log"]);
    expect(size("app.1.log")).toBe(2 * MB);
    expect(readFileSync(join(dir, "app.2.log"), "utf8")).toBe("one");
  });
});

describe("占用 / 清理 / 保留", () => {
  it("sizeBytes 只统计托管文件名；clear 也只删这些", () => {
    const { logger } = harness();
    logger.warn("w");
    writeFileSync(join(dir, "app.1.log"), "12345");
    writeFileSync(join(dir, "notes.txt"), "别人的文件");
    writeFileSync(join(dir, "app.log.bak"), "不是托管名");
    const total = size("app.log") + 5;
    expect(logger.sizeBytes()).toBe(total);

    expect(logger.clear()).toBe(total);
    expect(readdirSync(dir).sort()).toEqual(["app.log.bak", "notes.txt"]);
  });

  it("clear 之后下次写入自动重建当前档", () => {
    const { logger } = harness();
    logger.warn("w1");
    logger.clear();
    logger.warn("w2");
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("w2");
  });

  it("pruneExpired 按 mtime 删超期档：未超期的留下，闲置的当前档同样按保留天数清", () => {
    const { logger, setRetention } = harness("info", 7);
    logger.warn("当前档");
    writeFileSync(join(dir, "app.1.log"), "recent");
    writeFileSync(join(dir, "app.2.log"), "stale");
    age("app.2.log", 30);
    expect(logger.pruneExpired()).toBe(5);
    expect(exists("app.2.log")).toBe(false);
    expect(exists("app.1.log")).toBe(true);
    expect(exists("app.log")).toBe(true);

    setRetention(1);
    age("app.log", 10);
    age("app.1.log", 10);
    const before = logger.sizeBytes();
    expect(logger.pruneExpired()).toBe(before);
    expect(readdirSync(dir)).toEqual([]);
  });
});

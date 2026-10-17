/**
 * 首页（工作台主场，2026-10-14 合并原解析页）：粘贴 → 识别 → 结果卡 → 一键下载，
 * 下方是最近解析；右栏常驻队列轨负责实时进度。
 * 首页即大粘贴区（主张句与顶栏入口已删），输入卡是第一视觉焦点。
 *
 * 交互（UIUX-DESIGN §2.1 / §3.4 L1）：粘贴后 600ms 自动识别并解析——支持批量，
 * 一段文本里的多条链接按输入顺序逐条串行解析、结果卡逐张落位；Ctrl+Enter 手动、
 * Esc 清空、解析中骨架占位；「导入文件」读本地文本文件（一行一条即可）走同一条流，
 * 旁挂 info 图标，弹窗说明格式并一键保存 txt / csv 模板（不做 hover tooltip——说明要承载动作）；
 * 本页 Textarea 是全应用唯一解析输入面，Ctrl+K 由 App 层跳来并聚焦（inputRef）。
 * 输入草稿与结果卡活在 `store/home-draft.ts` 而不是本页的 useState：切页即卸载重挂，
 * 回来要还是刚才那批结果（业主指令 2026-10-17）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUpRight, Download, FileUp, Info, Loader2 } from "lucide-react";
import { api, BridgeError } from "../lib/bridge";
import type { DownloadTaskView, HistoryEntry, IdentifyOutcome } from "../../../types/ipc";
import { ResultCard } from "../components/ResultCard";
import { PlatformIcon } from "../components/PlatformIcon";
import { QueueRail } from "../components/QueueRail";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { TruncatedTooltip } from "../components/ui/tooltip";
import { fmtCreated } from "../lib/format";
import { useHomeDraft } from "../store/home-draft";

type Page = "downloads" | "history";

/** 文件导入上限：超出部分诚实截断并 toast 告知，不做静默丢件 */
const IMPORT_MAX_ITEMS = 100;
const IMPORT_MAX_BYTES = 1024 * 1024;

/**
 * 一键保存的模板（txt / csv 两份，同一份说明文本）：全篇不含「http」字样——
 * 用户未编辑直接导入时走「无链接文件」分支，不会被示例链接误解析出假任务。
 */
const IMPORT_TEMPLATE =
  "# 批量导入模板\n" +
  "#\n" +
  "# 一行一条，支持两种写法：\n" +
  "#   1. 直接粘贴分享链接\n" +
  "#   2. 粘贴整段分享文案（链接会被自动提取）\n" +
  "#\n" +
  "# 最多 100 条；编辑并保存后，回到首页点「导入文件」选择本文件\n" +
  "#\n" +
  "# 在下面填入你的链接：\n";

/** 保存模板：Blob + a[download]，零 IPC（Electron 里落系统「另存为」）；前置 BOM 供记事本/Excel 识别 UTF-8 */
function saveImportTemplate(fileName: string, mime: string): void {
  const blob = new Blob([`\uFEFF${IMPORT_TEMPLATE}`], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

type ParsedHit = {
  token: string;
  url: string;
  platformName: string;
  kind: IdentifyOutcome["kind"];
};

/**
 * 一段粘贴文本 → 候选链接 token：按空白切分、取含 http 的段、去重。
 * URL 的精确边界（尾部中文标点、全角空格等）交给内核提取逻辑截断，渲染层不复制正则。
 */
function candidateTokens(text: string): string[] {
  return [...new Set(text.split(/\s+/).filter((tok) => tok.toLowerCase().includes("http")))];
}

/** 识别提示：单条沿用旧口径；多条给「N 条链接 + 平台计数」 */
function fmtHitHint(hits: ParsedHit[]): string {
  if (hits.length === 1) {
    const h = hits[0];
    return `识别为 ${h.platformName}${h.kind === "share-text" ? "（从分享文案提取链接）" : ""}`;
  }
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.platformName, (counts.get(h.platformName) ?? 0) + 1);
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return `识别到 ${hits.length} 条链接：${parts.join("、")}`;
}

export default function HomePage({
  tasks,
  inputRef,
  onNav,
  onOpenSettings,
  clipboardFill,
  onClipboardFillDone,
  reparseFill,
  onReparseFillDone,
}: {
  tasks: DownloadTaskView[];
  /** App 层 Ctrl+K 用的输入框 ref：聚焦首页工作台 */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onNav: (p: Page) => void;
  /**
   * 打开设置并直达某个分类（结果卡失败态的「去配置 Cookie」用）。
   * 设置是 App 层的独立模式（不是 Page），故不能走 onNav。
   */
  onOpenSettings?: (category: string) => void;
  /** 剪贴板监听命中的链接（main 端已识别）：填入输入框并照常解析 */
  clipboardFill: { url: string; platform: string; seq: number } | null;
  /** 消费后清账（App 层置空，避免重挂载时重放同一条） */
  onClipboardFillDone: () => void;
  /** 历史页多选「重新解析」送来的分享链接（逐行一条，与导入文件同一条流） */
  reparseFill: { links: string[]; seq: number } | null;
  /** 消费后清账，同 clipboardFill */
  onReparseFillDone: () => void;
}): React.ReactElement {
  // 工作台草稿（文本 / 提示 / 结果卡 / 进行态）在 store 里：见 store/home-draft.ts
  const { text, setText, hint: identifyHint, setHint: setIdentifyHint, items, busy, setBusy, startBatch, patchItem } =
    useHomeDraft();
  const [helpOpen, setHelpOpen] = useState(false);
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * 单条解析（批内逐条调用；结果卡与失败卡的 [重试] 都走它，`retry=true`）。
   * 重试必须带 `forceOnline`：主进程有 24h 结果缓存，而 CDN 直链 5 分钟就过期——
   * 不带的话重试永远拿回同一条过期直链，用户怎么点都是同一个错。
   * （契约字段自 v1 就有、主进程一直在听，此前缺的只是渲染层这一传。）
   */
  const parseOne = useCallback(
    async (id: number, source: string, retry = false) => {
      patchItem(id, { status: "pending", outcome: undefined, error: undefined, at: undefined });
      try {
        const r = await api.parse(retry ? { text: source, forceOnline: true } : { text: source });
        // at = 结果到手时刻：切页重挂载后卡片接着算直链年龄，不把过期的链显示成刚拿到
        // sourceUrl = 用户输入的原始分享链接/文案（续链要用它重新解析，不是 identify 提取的直链）
        patchItem(id, { status: "done", outcome: r, sourceUrl: source, at: Date.now() });
      } catch (e) {
        patchItem(id, {
          status: "error",
          sourceUrl: source,
          error:
            e instanceof BridgeError
              ? `${e.message}${e.failType ? `（${e.failType}）` : ""}`
              : String(e),
        });
      }
    },
    [patchItem]
  );

  /** 批量解析：串行执行（内核自带节流，串行=速率与进度都诚实），完成一张落一张 */
  const runBatch = useCallback(
    async (sources: string[]) => {
      const list = sources.map((s) => s.trim()).filter(Boolean);
      if (list.length === 0 || useHomeDraft.getState().busy) return;
      setBusy(true);
      const fresh = startBatch(list);
      for (const it of fresh) await parseOne(it.id, it.text);
      setBusy(false);
    },
    [parseOne, setBusy, startBatch]
  );

  /** 手动解析（按钮 / Ctrl+Enter）：没有可提取链接时把原文交给引擎如实报错 */
  const parseManual = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    const tokens = candidateTokens(t);
    void runBatch(tokens.length > 0 ? tokens : [t]);
  }, [text, runBatch]);

  // 粘贴即识别（纯本地、不发网络），停 600ms 自动解析；批量时逐 token 识别、
  // 按 URL 去重（同一链接粘两次只解析一次），识别清单即解析清单。
  const onInput = useCallback(
    (value: string) => {
      setText(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        const t = value.trim();
        if (!t) {
          setIdentifyHint("");
          return;
        }
        try {
          const tokens = candidateTokens(t);
          if (tokens.length === 0) {
            setIdentifyHint("未识别到支持的平台链接");
            return;
          }
          const identified = await Promise.all(tokens.map((tok) => api.identify(tok).catch(() => null)));
          const seen = new Set<string>();
          const hits: ParsedHit[] = [];
          identified.forEach((r, i) => {
            if (r?.platform && r.url && !seen.has(r.url)) {
              seen.add(r.url);
              hits.push({ token: tokens[i], url: r.url, platformName: r.platformName, kind: r.kind });
            }
          });
          if (hits.length === 0) {
            setIdentifyHint("未识别到支持的平台链接");
            return;
          }
          setIdentifyHint(fmtHitHint(hits));
          void runBatch(hits.map((h) => h.token));
        } catch {
          setIdentifyHint("");
        }
      }, 600);
    },
    [runBatch]
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  // 导入文件：读文本 → 与粘贴完全同一条 token → 识别 → 批量流（零 IPC：input file + File.text()）
  const onImportFile = useCallback(
    async (f: File) => {
      if (f.size > IMPORT_MAX_BYTES) {
        toast.error("文件超过 1MB，请精简后再导入");
        return;
      }
      let raw: string;
      try {
        raw = await f.text();
      } catch (e) {
        toast.error(`文件读取失败：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const all = candidateTokens(raw);
      if (all.length === 0) {
        toast.error("文件中未发现有效链接");
        return;
      }
      if (all.length > IMPORT_MAX_ITEMS) {
        toast.warning(`文件含 ${all.length} 条链接，本次仅解析前 ${IMPORT_MAX_ITEMS} 条`);
      }
      onInput(all.slice(0, IMPORT_MAX_ITEMS).join("\n"));
    },
    [onInput]
  );

  // 剪贴板填入：仅当输入框为空或仍是上一条剪贴板内容时才覆盖（不吞手输草稿）；
  // 走 onInput 同一条流——识别提示与 600ms 自动解析与手动粘贴完全一致。
  const textRef = useRef("");
  textRef.current = text;
  const autoFilledRef = useRef("");
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  useEffect(() => {
    if (!clipboardFill) return;
    onClipboardFillDone();
    const cur = textRef.current;
    if (cur.trim() !== "" && cur !== autoFilledRef.current) {
      toast.info("输入框有内容，剪贴板链接未填入");
      return;
    }
    autoFilledRef.current = clipboardFill.url;
    onInputRef.current(clipboardFill.url);
  }, [clipboardFill]);

  // 历史页「重新解析」送来的链接：走 onInput 同一条流（识别提示 + 600ms 自动批量解析），
  // 与 onImportFile 拼多行文本那句完全一致 —— 本页不另开一条解析编排。
  // 这里**不抄**上面那条「输入框有内容就不覆盖」的守卫：那条防的是被动监听吞掉手输草稿，
  // 而这是用户点了「重新解析」，覆盖草稿就是这次点击的语义（旧结果卡由 startBatch 整表替换）。
  useEffect(() => {
    if (!reparseFill) return;
    onReparseFillDone();
    const joined = reparseFill.links.join("\n");
    autoFilledRef.current = joined;
    onInputRef.current(joined);
  }, [reparseFill]);

  // 封面/主色上抛已移除（2026-10-15 蓝白指令）：焦点色由「主题风格」整带决定，
  // 不再随解析结果里的封面抽色漂移。

  // Esc：模态优先（ResultCard 的 Dialog 自己处理）→ 清输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[data-slot="dialog-content"]')) return;
      if (inputRef.current === document.activeElement && text) {
        setText("");
        setIdentifyHint("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [text]);

  // 最近解析 = 历史头五条。回读挂在「工作台没有待解析的卡片」这个条件上：
  // 空表时为真（首帧就要读一次），一批解析落位、一条重试完成时也落回真 ——
  // 不切页也能看见刚解析的那条进了历史。解析进行中不读，免得每张卡都打一次 IPC。
  const settled = items.every((it) => it.status !== "pending");
  useEffect(() => {
    if (!settled) return;
    void api.history.list({ limit: 5 }).then(setRecent).catch(() => {});
  }, [settled]);

  // 进行中任务不在首页做第二份展示：右栏队列轨已逐条实时显示，资源明细归队列页。

  const firstPendingIdx = items.findIndex((it) => it.status === "pending");

  return (
    <div className="flex min-h-full items-start gap-4">
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        {/* 卡片即输入面：focus-host 把聚焦高亮收在卡片这一个盒上（见 styles.css） */}
        <Card className="focus-host gap-0">
          <Textarea
            ref={inputRef}
            value={text}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) parseManual();
            }}
            placeholder="粘贴一条或多条分享链接、整段分享文案，Ctrl+K 任意页面直达…"
            className="min-h-28 resize-none rounded-none border-0 bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-relaxed shadow-none"
            spellCheck={false}
            aria-label="解析输入"
          />
          {identifyHint && (
            <p
              className={
                "px-4 pb-2 text-xs " +
                (identifyHint.startsWith("未识别") ? "text-warn" : "text-muted-foreground")
              }
            >
              {identifyHint}
            </p>
          )}
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <FileUp />
                导入文件
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-faint hover:text-muted-foreground"
                aria-label="批量导入说明"
                onClick={() => setHelpOpen(true)}
              >
                <Info className="size-3.5" />
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.csv,text/plain"
              className="hidden"
              aria-label="导入链接文件"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void onImportFile(f);
              }}
            />
            <Button size="sm" onClick={parseManual} disabled={busy || !text.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? "解析中…" : "解析"}
            </Button>
          </div>
        </Card>

        {/* 导入说明与模板收进弹窗（业主定稿 2026-10-15）：tooltip 放不了「保存模板」这类动作；
            该弹窗非模态（业主点名，页面照常可点），遮罩走「浅而不拦手」一档 */}
        <Dialog open={helpOpen} onOpenChange={setHelpOpen} modal={false}>
          <DialogContent showOverlay="light" className="max-w-sm" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>批量导入说明</DialogTitle>
            </DialogHeader>
            <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm text-muted-foreground">
              <li>支持 .txt / .md / .csv 文本文件</li>
              <li>每行一条：直接贴链接，或整段分享文案</li>
              <li>最多 100 条 / 1 MB，超出按前 100 条解析</li>
            </ul>
            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveImportTemplate("批量导入模板.txt", "text/plain")}
              >
                <Download />
                保存 txt 模板
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveImportTemplate("批量导入模板.csv", "text/csv")}
              >
                <Download />
                保存 csv 模板
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {items.map((item, i) => {
          if (item.status === "pending" && items.length === 1) {
            return (
              <Card key={item.id} aria-hidden="true">
                <CardContent className="flex flex-col gap-3 pb-4">
                  <div className="flex gap-3">
                    <Skeleton className="size-24 shrink-0 rounded-md" />
                    <div className="flex flex-1 flex-col gap-2 pt-1">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-4 w-2/5" />
                      <Skeleton className="h-4 w-1/2" />
                    </div>
                  </div>
                  <Skeleton className="h-4 w-[90%]" />
                  <Skeleton className="h-4 w-[30%]" />
                </CardContent>
              </Card>
            );
          }
          if (item.status === "pending") {
            return (
              <Card key={item.id}>
                <CardContent className="flex items-center gap-2 py-2.5 text-sm text-muted-foreground">
                  {i === firstPendingIdx && <Loader2 className="animate-spin" />}
                  <span>{i === firstPendingIdx ? "解析中…" : "排队中…"}</span>
                  <span className="ms-auto text-xs tabular-nums">
                    第 {i + 1}/{items.length} 条
                  </span>
                </CardContent>
              </Card>
            );
          }
          if (item.status === "error") {
            return (
              <Alert key={item.id} variant="destructive">
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">{item.error}</span>
                  <Button size="sm" variant="outline" onClick={() => void parseOne(item.id, item.text, true)}>
                    重试
                  </Button>
                </AlertDescription>
              </Alert>
            );
          }
          return item.outcome ? (
            <ResultCard
              key={item.id}
              outcome={item.outcome}
              sourceUrl={item.sourceUrl}
              parsedAt={item.at}
              onRetry={() => void parseOne(item.id, item.text, true)}
              onNavigate={onOpenSettings}
              onQueued={(count) =>
                count > 0
                  ? toast.success(`已加入下载队列（${count} 个文件），到「队列」页查看进度`)
                  : toast.warning("没有可下载的文件")
              }
            />
          ) : null;
        })}

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <CardTitle className="text-sm">最近解析</CardTitle>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onNav("history")}>
              全部历史
              <ArrowUpRight />
            </Button>
          </CardHeader>
          <CardContent className="pb-4">
            {recent.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没有解析记录。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {recent.map((h) => (
                  <li key={h.id} className="flex min-w-0 items-center gap-2 py-2 first:pt-0">
                    <PlatformIcon platform={h.platform} />
                    <TruncatedTooltip label={h.title ?? "（未命名）"}>
                      <span className="min-w-0 flex-1 truncate">{h.title ?? "（未命名）"}</span>
                    </TruncatedTooltip>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {fmtCreated(h.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <QueueRail
        tasks={tasks}
        onShowAll={() => onNav("downloads")}
        onUseExample={(url) => onInput(url)}
      />
    </div>
  );
}

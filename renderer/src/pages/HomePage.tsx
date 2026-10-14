/**
 * 首页（工作台主场，2026-10-14 合并原解析页）：粘贴 → 识别 → 结果卡 → 一键下载，
 * 下方是最近作品；右栏常驻队列轨负责实时进度。
 * 首页即大粘贴区（主张句与顶栏入口已删），输入卡是第一视觉焦点。
 *
 * 交互（UIUX-DESIGN §2.1 / §3.4 L1）：粘贴后 600ms 自动解析、Ctrl+Enter 手动、
 * 平台墙点选注入 platformHint、Esc 清空、解析中骨架占位；
 * 本页 Textarea 是全应用唯一解析输入面，Ctrl+K 由 App 层跳来并聚焦（inputRef）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { api, BridgeError } from "../lib/bridge";
import type { AppMeta, DownloadTaskView, HistoryEntry, ParseRunOutcome } from "../../../types/ipc";
import { ResultCard } from "../components/ResultCard";
import { PlatformIcon } from "../components/PlatformIcon";
import { QueueRail } from "../components/QueueRail";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { fmtCreated } from "../lib/format";

type Page = "downloads" | "history" | "settings";

export default function HomePage({
  tasks,
  meta,
  inputRef,
  onCover,
  onNav,
}: {
  tasks: DownloadTaskView[];
  meta: AppMeta | null;
  /** App 层 Ctrl+K 用的输入框 ref：聚焦首页工作台 */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 解析成功后上抛封面，驱动 --accent-color（选中态/主按钮/进度条三处） */
  onCover: (cover: string | null) => void;
  onNav: (p: Page) => void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [platformHint, setPlatformHint] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<ParseRunOutcome | null>(null);
  const [parsedFrom, setParsedFrom] = useState<string | undefined>(undefined);
  const [identifyHint, setIdentifyHint] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<string>("");
  const [showWall, setShowWall] = useState(false);
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 粘贴→自动解析防抖与 busy 竞争：用 ref 读最新值
  const busyRef = useRef(false);
  busyRef.current = busy;

  const doParse = useCallback(async (source: string) => {
    const t = source.trim();
    if (!t || busyRef.current) return;
    setBusy(true);
    setError("");
    setOutcome(null);
    try {
      const r = await api.parse({ text: t, platformHint });
      setOutcome(r);
      setParsedFrom(t.match(/https?:\/\/\S+/)?.[0]);
    } catch (e) {
      setError(
        e instanceof BridgeError
          ? `${e.message}${e.failType ? `（${e.failType}）` : ""}`
          : String(e)
      );
    } finally {
      setBusy(false);
    }
  }, [platformHint]);

  // 粘贴即识别（纯本地、不发网络），输入框内顶部实时提示平台；停 600ms 自动解析
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
          const r = await api.identify(t);
          setIdentifyHint(
            r.platform
              ? `识别为 ${r.platformName}${r.kind === "share-text" ? "（从分享文案提取链接）" : ""}`
              : "未识别到支持的平台链接"
          );
          if (r.platform) void doParse(t);
        } catch {
          setIdentifyHint("");
        }
      }, 600);
    },
    [doParse]
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  // 封面/主色上抛：任务条背景与 --accent 的驱动源
  useEffect(() => {
    const d = outcome?.result.code === 200 ? outcome.result.data : null;
    onCover(d?.cover ?? null);
  }, [outcome, onCover]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

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

  useEffect(() => {
    void api.history.list({ limit: 5 }).then(setRecent).catch(() => {});
  }, []);

  // 进行中任务不在首页做第二份展示：右栏队列轨已逐条实时显示，资源明细归队列页。

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
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void doParse(text);
            }}
            placeholder="粘贴一条分享链接或整段分享文案，Ctrl+K 任意页面直达…"
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
            <Button variant="link" size="sm" className="h-7 px-0 text-xs" onClick={() => setShowWall((v) => !v)}>
              {meta ? `${meta.platforms.length} 个平台 ${showWall ? "▴" : "▾"}` : "支持平台"}
            </Button>
            <Button size="sm" onClick={() => void doParse(text)} disabled={busy || !text.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? "解析中…" : "解析"}
            </Button>
          </div>
          {showWall && meta && (
            <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
              <div className="flex flex-wrap gap-1.5">
                {meta.platforms.map((p) => (
                  <Button
                    key={p.key}
                    size="sm"
                    variant={platformHint === p.key ? "default" : "outline"}
                    className="h-7 rounded-full ps-1"
                    title={
                      meta?.kernelMode === "local"
                        ? "本地内核直连解析（失败自动降级）"
                        : "经线上回落解析（失败自动降级）"
                    }
                    onClick={() => setPlatformHint(platformHint === p.key ? undefined : p.key)}
                  >
                    <PlatformIcon platform={p.key} />
                    {p.name}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                点选平台 = 只按该平台解析你的输入（再点取消）。
                {meta?.kernelMode === "local"
                  ? "本地内核直连全部平台，失败时才降级到线上回落。"
                  : "当前非本地内核模式，解析经线上回落通道。"}
              </p>
            </div>
          )}
        </Card>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {toast && (
          <Alert>
            <AlertDescription>{toast}</AlertDescription>
          </Alert>
        )}

        {busy && (
          <Card aria-hidden="true">
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
        )}

        {outcome && (
          <ResultCard
            outcome={outcome}
            meta={meta}
            sourceUrl={parsedFrom}
            onRetry={() => void doParse(text)}
            onQueued={(count) =>
              setToast(
                count > 0
                  ? `已加入下载队列（${count} 个文件），到「队列」页查看进度`
                  : "没有可下载的文件"
              )
            }
          />
        )}

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <CardTitle className="text-sm">最近下载</CardTitle>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onNav("history")}>
              全部历史
              <ArrowUpRight />
            </Button>
          </CardHeader>
          <CardContent className="pb-4">
            {recent.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没有记录。解析成功后点「下载」，完成的历史会出现在这里。</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {recent.map((h) => (
                  <li key={h.id} className="flex min-w-0 items-center gap-2 py-2 first:pt-0">
                    <PlatformIcon platform={h.platform} />
                    <span className="min-w-0 flex-1 truncate" title={h.title ?? ""}>
                      {h.title ?? "（未命名）"}
                    </span>
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

      <QueueRail tasks={tasks} onShowAll={() => onNav("downloads")} />
    </div>
  );
}

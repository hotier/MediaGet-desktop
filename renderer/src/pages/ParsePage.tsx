/**
 * 解析页：粘贴 → 识别 → 结果卡 → 一键下载（README 直链时效决策：
 * 「下载」按钮直接触发主进程流式落盘，不做二跳展示直链）
 *
 * 交互（UIUX-DESIGN §2.1 / §3.4 L1）：粘贴后 600ms 自动解析、Ctrl+Enter 手动、
 * 平台墙点选注入 platformHint、Esc 清空、解析中骨架占位。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, BridgeError } from "../lib/bridge";
import type { AppMeta, ParseRunOutcome } from "../../../types/ipc";
import { ResultCard } from "../components/ResultCard";
import { PlatformIcon } from "../components/PlatformIcon";

/** 本地解析面 = parse-core 统一入口注册表（全平台）；kernelMode 由主进程如实上报 */

export default function ParsePage({
  meta,
  seed,
  onCover,
  onGoSettings,
}: {
  meta: AppMeta | null;
  /** 顶栏全局粘贴入口送来的文本：变化即代填并解析 */
  seed: { text: string; nonce: number } | null;
  /** 解析成功后上抛封面，驱动底部任务条背景魔法色 */
  onCover: (cover: string | null) => void;
  onGoSettings: () => void;
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

  // 顶栏全局入口送来文本：代填 + 直接解析（不再等防抖识别）
  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    setIdentifyHint("");
    void doParse(seed.text);
  }, [seed, doParse]);

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

  // Esc：模态优先（ResultCard 自己处理）→ 清输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".img-modal")) return;
      if (inputRef.current === document.activeElement && text) {
        setText("");
        setIdentifyHint("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [text]);

  const idle = !outcome && !error && !busy && toast === "";

  return (
    <section className="page">
      <div className="paste-box">
        <div className="paste-frame">
          {identifyHint && (
            <div className={`paste-hint${identifyHint.startsWith("未识别") ? " warn" : ""}`}>
              {identifyHint}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void doParse(text);
            }}
            placeholder="粘贴分享链接或整段分享文案…"
            rows={4}
            spellCheck={false}
          />
        </div>
        <div className="paste-actions">
          <button className="linkish" onClick={() => setShowWall((v) => !v)}>
            {meta ? `${meta.platforms.length} 个平台 ${showWall ? "▴" : "▾"}` : "支持平台"}
          </button>
          <button className="primary" onClick={() => void doParse(text)} disabled={busy || !text.trim()}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "解析中…" : "解析"}
          </button>
        </div>
        {showWall && meta && (
          <div className="platform-wall">
            {meta.platforms.map((p) => (
              <button
                key={p.key}
                className={`p-chip${platformHint === p.key ? " on" : ""}`}
                title={
                  meta?.kernelMode === "local"
                    ? "本地内核直连解析"
                    : "经线上回落解析（失败自动降级）"
                }
                onClick={() => setPlatformHint(platformHint === p.key ? undefined : p.key)}
              >
                <PlatformIcon platform={p.key} />
                {p.name}
              </button>
            ))}
            <p className="hint">
              点选平台 = 只按该平台解析你的输入（再点取消）。
              {meta?.kernelMode === "local"
                ? "本地内核直连全部平台，失败时才降级到线上回落。"
                : "当前非本地内核模式，解析经线上回落通道。"}
            </p>
          </div>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
      {toast && <div className="banner info">{toast}</div>}

      {busy && (
        <div className="card skeleton" aria-hidden="true">
          <div className="skeleton-head">
            <div className="sk sk-cover" />
            <div className="sk-lines">
              <div className="sk sk-line w70" />
              <div className="sk sk-line w40" />
              <div className="sk sk-line w55" />
            </div>
          </div>
          <div className="sk sk-line w90" />
          <div className="sk sk-line w30" />
        </div>
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
                ? `已加入下载队列（${count} 个文件），到「下载」页查看进度`
                : "没有可下载的文件"
            )
          }
        />
      )}

      {idle && (
        <div className="empty">
          <div className="empty-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="44" height="44">
              <path
                fill="currentColor"
                d="M19 3h-4.2c-.7-1.2-2-2-3.3-2s-2.6.8-3.3 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-7.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM7 20H5v-2h2v2Zm0-4H5v-2h2v2Zm0-4H5V10h2v2Zm12 8h-8v-2h8v2Zm0-4h-8v-2h8v2Zm0-4h-8v-2h8v2Z"
              />
            </svg>
          </div>
          <p className="empty-title">粘贴一条分享链接，本机直连解析并下载</p>
          <div className="row">
            <button onClick={() => setShowWall(true)}>查看支持的 {meta?.platforms.length ?? ""} 个平台</button>
            <button onClick={onGoSettings}>配置 Cookie</button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 解析页：粘贴 → 识别 → 结果卡 → 一键下载（README 直链时效决策：
 * 「下载」按钮直接触发主进程流式落盘，不做二跳展示直链）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, BridgeError } from "../lib/bridge";
import type { AppMeta, ParseRunOutcome } from "../../../types/ipc";
import { ResultCard } from "../components/ResultCard";

export default function ParsePage({ meta }: { meta: AppMeta | null }): React.ReactElement {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<ParseRunOutcome | null>(null);
  const [identifyHint, setIdentifyHint] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 粘贴即识别（纯本地、不发网络），输入框下方实时提示平台
  const onInput = useCallback((value: string) => {
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
      } catch {
        setIdentifyHint("");
      }
    }, 250);
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function onParse(): Promise<void> {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    setOutcome(null);
    try {
      const r = await api.parse({ text: text.trim() });
      setOutcome(r);
    } catch (e) {
      setError(
        e instanceof BridgeError
          ? `${e.message}${e.failType ? `（${e.failType}）` : ""}`
          : String(e)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <div className="paste-box">
        <textarea
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void onParse();
          }}
          placeholder="粘贴分享链接或整段分享文案（Ctrl+Enter 解析）…"
          rows={4}
          spellCheck={false}
        />
        <div className="paste-actions">
          <span className="hint">{identifyHint}</span>
          <button className="primary" onClick={() => void onParse()} disabled={busy || !text.trim()}>
            {busy ? "解析中…" : "解析"}
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {toast && <div className="banner info">{toast}</div>}

      {outcome && (
        <ResultCard
          outcome={outcome}
          onQueued={(count) =>
            setToast(
              count > 0
                ? `已加入下载队列（${count} 个文件），到「下载」页查看进度`
                : "没有可下载的文件"
            )
          }
        />
      )}

      {!outcome && !error && !busy && toast === "" && (
        <div className="empty">
          <p>解析 + 下载闭环：本机住宅 IP 直连解析，拿到直链立刻落盘。</p>
          {meta && (
            <p className="hint">
              支持 {meta.platforms.length} 个平台 · 内核形态 {meta.kernelMode} · 失败自动回落线上
            </p>
          )}
        </div>
      )}
    </section>
  );
}

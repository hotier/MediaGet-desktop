/**
 * 设置页：下载目录 / 并发 / 回落开关 / 节流 / 用户 Cookie（键位沿用 mediaGet，
 * 语义 = 用户自配，明确标注「需自行申请，风险自负」—— §5）
 */
import { useEffect, useState } from "react";
import { api } from "../lib/bridge";
import type { AppMeta, AppSettings } from "../../../types/ipc";

const COOKIE_KEYS: Array<{ key: string; label: string; note?: string }> = [
  { key: "BILIBILI_COOKIE", label: "哔哩哔哩 Cookie", note: "强烈建议：提升大会员清晰度与风控通过率" },
  { key: "DOUYIN_COOKIE", label: "抖音 Cookie", note: "可选：仅增强" },
  { key: "XHS_COOKIE", label: "小红书 Cookie", note: "可选" },
  { key: "IG_COOKIE", label: "Instagram Cookie", note: "强烈建议：游客几乎必被风控" },
  { key: "QQMUSIC_COOKIE", label: "QQ音乐 Cookie", note: "可选：source+id 试听 vkey" },
];

export default function SettingsPage({ meta }: { meta: AppMeta | null }): React.ReactElement {
  const [s, setS] = useState<AppSettings | null>(null);
  const [cookieInputs, setCookieInputs] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [engines, setEngines] = useState<{ platform: string; name: string; ok: boolean; detail?: string }[]>([]);

  useEffect(() => {
    void api.settings.get().then(setS).catch(() => {});
    void api.probe.engines().then(setEngines).catch(() => {});
  }, []);

  if (!s) return <section className="page empty">加载设置…</section>;

  // 闭包内不继承上方 `if (!s) return` 的收窄：显式把当前值作参数传入
  async function save(current: AppSettings): Promise<void> {
    const cookies: Record<string, string> = {};
    for (const [k, v] of Object.entries(cookieInputs)) {
      if (v !== "" && v !== "***") cookies[k] = v;
    }
    const next = await api.settings.set({
      ...current,
      onlineApiBase: current.onlineApiBase.trim(),
      cookies,
    });
    setS(next);
    setCookieInputs({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <section className="page settings">
      <div className="card">
        <div className="card-title">下载</div>
        <Field label="下载目录">
          <div className="row">
            <input
              value={s.downloadDir}
              placeholder="默认：系统下载目录"
              onChange={(e) => setS({ ...s, downloadDir: e.target.value })}
            />
            <button
              onClick={() =>
                void api.app.pickDownloadDir().then((dir) => dir && setS({ ...s, downloadDir: dir }))
              }
            >
              浏览…
            </button>
          </div>
        </Field>
        <Field label="并发上限（1–10）">
          <input
            type="number"
            min={1}
            max={10}
            value={s.maxConcurrent}
            onChange={(e) => setS({ ...s, maxConcurrent: Number(e.target.value) || 3 })}
          />
        </Field>
        <Field label="温和节流（毫秒，0=不限）">
          <input
            type="number"
            min={0}
            max={60000}
            value={s.throttleMs}
            onChange={(e) => setS({ ...s, throttleMs: Number(e.target.value) || 0 })}
          />
          <p className="hint">住宅 IP 也怕高频：平台风控升级时用它降速，默认不限。</p>
        </Field>
      </div>

      <div className="card">
        <div className="card-title">解析</div>
        <Field label="本地失败回落线上 API">
          <label className="switch">
            <input
              type="checkbox"
              checked={s.fallbackOnline}
              onChange={(e) => setS({ ...s, fallbackOnline: e.target.checked })}
            />
            <span>{s.fallbackOnline ? "开（推荐）" : "关（纯本地）"}</span>
          </label>
          <p className="hint">
            骨架期 P0 未抽完，多数平台经线上兜底；上游改版坏消息先到不白屏（README 失败回落）。
          </p>
        </Field>
        <Field label="线上 API 基址">
          <input value={s.onlineApiBase} onChange={(e) => setS({ ...s, onlineApiBase: e.target.value })} />
        </Field>
      </div>

      <div className="card">
        <div className="card-title">Cookie（用户自配 · 存本机）</div>
        <p className="hint">
          需自行登录平台申请，风险自负；仅存本机 userData，不经过任何第三方服务器，导出默认脱敏。
        </p>
        {COOKIE_KEYS.map(({ key, label, note }) => (
          <Field key={key} label={label + (note ? ` — ${note}` : "")}>
            <input
              className="mono"
              placeholder={s.cookies[key] ? "已配置（留空不修改；输入空并保存=清除）" : "未配置"}
              value={cookieInputs[key] ?? ""}
              onChange={(e) => setCookieInputs({ ...cookieInputs, [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>

      <div className="card">
        <div className="card-title">解析通道体检（本地版 /api/engines）</div>
        {engines.length === 0 ? (
          <p className="hint">未获取到体检数据。</p>
        ) : (
          <div className="engines">
            {engines.map((e) => (
              <span key={e.platform} className={`chip ${e.ok ? "ok" : "warn"}`} title={e.detail}>
                {e.name}
              </span>
            ))}
          </div>
        )}
        {meta && (
          <p className="hint">
            版本 v{meta.version} · Electron {meta.electron} · 内核 {meta.kernelMode}
          </p>
        )}
      </div>

      <div className="save-bar">
        {saved && <span className="chip ok">已保存 ✓</span>}
        <button className="primary" onClick={() => void save(s)}>
          保存设置
        </button>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="field-body">{children}</div>
    </div>
  );
}

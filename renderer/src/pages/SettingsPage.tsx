/**
 * 设置页：下载目录 / 并发 / 回落开关 / 节流 / 用户 Cookie（键位沿用 mediaGet，
 * 语义 = 用户自配，明确标注「需自行申请，风险自负」—— §5）
 */
import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api } from "../lib/bridge";
import { setTheme } from "../lib/theme";
import type { AppMeta, AppSettings, BinaryStatusReport, UpdateState } from "../../../types/ipc";
import { PlatformIcon } from "../components/PlatformIcon";
import { UpdateCard } from "../components/Update";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

const COOKIE_KEYS: Array<{ key: string; label: string; note?: string }> = [
  { key: "BILIBILI_COOKIE", label: "哔哩哔哩 Cookie", note: "强烈建议：提升大会员清晰度与风控通过率" },
  { key: "DOUYIN_COOKIE", label: "抖音 Cookie", note: "可选：仅增强" },
  { key: "XHS_COOKIE", label: "小红书 Cookie", note: "可选" },
  { key: "IG_COOKIE", label: "Instagram Cookie", note: "强烈建议：游客几乎必被风控" },
  { key: "QQMUSIC_COOKIE", label: "QQ音乐 Cookie", note: "可选：source+id 试听 vkey" },
];

export default function SettingsPage({
  meta,
  update,
  onUpdateState,
}: {
  meta: AppMeta | null;
  update: UpdateState | null;
  onUpdateState: (s: UpdateState) => void;
}): React.ReactElement {
  const [s, setS] = useState<AppSettings | null>(null);
  const [cookieInputs, setCookieInputs] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [engines, setEngines] = useState<{ platform: string; name: string; ok: boolean; detail?: string }[]>([]);
  const [bins, setBins] = useState<BinaryStatusReport | null>(null);

  useEffect(() => {
    void api.settings.get().then(setS).catch(() => {});
    void api.probe.engines().then(setEngines).catch(() => {});
    void api.app.getBinaryStatus().then(setBins).catch(() => {});
  }, []);

  if (!s) return <section className="text-xs text-muted-foreground">加载设置…</section>;

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
    setTheme(next.theme);
    setCookieInputs({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">下载</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 pb-5">
          <Row label="下载目录">
            <div className="flex gap-2">
              <Input
                value={s.downloadDir}
                placeholder="默认：系统下载目录"
                onChange={(e) => setS({ ...s, downloadDir: e.target.value })}
              />
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void api.app.pickDownloadDir().then((dir) => dir && setS({ ...s, downloadDir: dir }))}
              >
                <FolderOpen />
                浏览…
              </Button>
            </div>
          </Row>
          <Row label="并发上限（1–10）">
            <Input
              type="number"
              min={1}
              max={10}
              className="w-28"
              value={s.maxConcurrent}
              onChange={(e) => setS({ ...s, maxConcurrent: Number(e.target.value) || 3 })}
            />
          </Row>
          <Row label="温和节流（毫秒，0=不限）" hint="住宅 IP 也怕高频：平台风控升级时用它降速，默认不限。">
            <Input
              type="number"
              min={0}
              max={60000}
              className="w-28"
              value={s.throttleMs}
              onChange={(e) => setS({ ...s, throttleMs: Number(e.target.value) || 0 })}
            />
          </Row>
          <Row label="关窗最小化到托盘" hint="开启后点 ✕ 只是隐藏窗口，下载继续；从托盘图标或再次启动应用恢复。">
            <div className="flex items-center gap-3">
              <Switch
                id="minimize-to-tray"
                checked={s.minimizeToTray}
                onCheckedChange={(v) => setS({ ...s, minimizeToTray: v })}
              />
              <Label htmlFor="minimize-to-tray" className="font-normal text-muted-foreground">
                {s.minimizeToTray ? "开（下载不中断）" : "关（关窗即退出）"}
              </Label>
            </div>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">外观</CardTitle>
        </CardHeader>
        <CardContent className="pb-5">
          <Row label="明暗主题" hint="选择后立即生效；「跟随系统」随 Windows 深浅色自动切换。">
            <RadioGroup
              orientation="horizontal"
              className="gap-5"
              value={s.theme}
              onValueChange={(v) => setS({ ...s, theme: v as AppSettings["theme"] })}
            >
              <Label htmlFor="theme-system" className="font-normal">
                <RadioGroupItem id="theme-system" value="system" />
                跟随系统
              </Label>
              <Label htmlFor="theme-dark" className="font-normal">
                <RadioGroupItem id="theme-dark" value="dark" />
                深色
              </Label>
              <Label htmlFor="theme-light" className="font-normal">
                <RadioGroupItem id="theme-light" value="light" />
                浅色
              </Label>
            </RadioGroup>
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">解析</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 pb-5">
          <Row label="本地失败回落线上 API" hint="骨架期 P0 未抽完，多数平台经线上兜底；上游改版坏消息先到不白屏（README 失败回落）。">
            <div className="flex items-center gap-3">
              <Switch
                id="fallback-online"
                checked={s.fallbackOnline}
                onCheckedChange={(v) => setS({ ...s, fallbackOnline: v })}
              />
              <Label htmlFor="fallback-online" className="font-normal text-muted-foreground">
                {s.fallbackOnline ? "开（推荐）" : "关（纯本地）"}
              </Label>
            </div>
          </Row>
          <Row label="线上 API 基址">
            <Input value={s.onlineApiBase} onChange={(e) => setS({ ...s, onlineApiBase: e.target.value })} />
          </Row>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Cookie（用户自配 · 存本机）</CardTitle>
          <CardDescription>
            需自行登录平台申请，风险自负；仅存本机 userData，不经过任何第三方服务器，导出默认脱敏。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pb-5">
          {COOKIE_KEYS.map(({ key, label, note }) => (
            <Row key={key} label={note ? `${label} — ${note}` : label}>
              <Input
                className="font-mono text-xs"
                placeholder={s.cookies[key] ? "已配置（留空不修改；输入空并保存=清除）" : "未配置"}
                value={cookieInputs[key] ?? ""}
                onChange={(e) => setCookieInputs({ ...cookieInputs, [key]: e.target.value })}
              />
            </Row>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">随包二进制（yt-dlp / ffmpeg）</CardTitle>
          <CardDescription>
            完整性档位如实展示：已校验=有 SHA-256 基线且匹配；降级=无基线（仅定位不校验）；已拒绝=哈希不符（不使用，该平台走线上回落）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pb-5">
          {!bins || bins.binaries.length === 0 ? (
            <p className="text-xs text-muted-foreground">未获取到二进制状态。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {bins.binaries.map((b) => (
                <li key={b.name} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs">{b.name}</span>
                  <IntegrityBadge integrity={b.integrity} />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default text-xs text-muted-foreground">
                        {b.origin ? `来源 ${b.origin}` : "未找到"}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{b.path ?? "无路径"}</TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
          {bins && !bins.manifestLoaded && (
            <Alert variant="warn">
              <AlertDescription>
                未加载到随包 manifest.json：本次不做完整性校验。开发环境可执行
                <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-xs">node scripts/fetch-binaries.cjs</code>
                生成。
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {update && <UpdateCard state={update} onState={onUpdateState} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">解析通道体检（本地版 /api/engines）</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pb-5">
          {engines.length === 0 ? (
            <p className="text-xs text-muted-foreground">未获取到体检数据。</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {engines.map((e) => (
                <Tooltip key={e.platform}>
                  <TooltipTrigger asChild>
                    <Badge variant={e.ok ? "ok" : "warn"} className="gap-1.5 ps-1">
                      <PlatformIcon platform={e.platform} />
                      {e.name}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{e.detail ?? (e.ok ? "可用" : "不可用")}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}
          {meta && (
            <p className="text-xs tabular-nums text-muted-foreground">
              版本 v{meta.version} · Electron {meta.electron} · 内核 {meta.kernelMode}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-background/85 px-4 py-3 backdrop-blur-sm">
        {saved && <Badge variant="ok">已保存 ✓</Badge>}
        <Button onClick={() => void save(s)}>保存设置</Button>
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-4">
      <div className="flex flex-col gap-1 pt-2">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

const INTEGRITY: Record<string, [string, "ok" | "warn" | "secondary"]> = {
  verified: ["已校验", "ok"],
  degraded: ["降级", "warn"],
  rejected: ["已拒绝", "warn"],
  missing: ["未找到", "secondary"],
};

function IntegrityBadge({
  integrity,
}: {
  integrity: BinaryStatusReport["binaries"][number]["integrity"];
}): React.ReactElement {
  const [label, variant] = INTEGRITY[integrity] ?? [integrity, "secondary"];
  return <Badge variant={variant}>{label}</Badge>;
}

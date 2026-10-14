/**
 * 自动更新 UI（P6）：同一份 UpdateState 渲染成两种形态 ——
 * 顶部横幅（需要用户动手时才出现）与设置页状态卡（含主动检查）。
 */
import { api } from "../lib/bridge";
import type { UpdateState } from "../../../types/ipc";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { Alert, AlertDescription } from "./ui/alert";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";

type Action = "check" | "download" | "install";

/**
 * 动作后一律以主进程回传的快照为准：状态机是唯一真源，
 * renderer 自行乐观改态会在事件回灌时出现闪回。
 */
async function act(action: Action, onState: (s: UpdateState) => void): Promise<void> {
  try {
    if (action === "check") onState(await api.app.update.check());
    else if (action === "download") onState(await api.app.update.download());
    else await api.app.update.install(); // 成功即退出重启，代码不会再走到下面
  } catch {
    /* check/download 的失败已在主进程收敛为 error 阶段并经事件送达，此处无需二次处理 */
  }
}

function phrase(s: UpdateState): string {
  const next = s.availableVersion ? ` v${s.availableVersion}` : "";
  switch (s.phase) {
    case "idle":
      return "尚未检查更新";
    case "checking":
      return "正在检查更新…";
    case "up-to-date":
      return `已是最新版本 v${s.currentVersion}`;
    case "available":
      return `发现新版本${next}（当前 v${s.currentVersion}）`;
    case "downloading":
      return `正在下载${next}… ${s.percent ?? 0}%`;
    case "downloaded":
      return `${next} 已下载完成，退出应用时自动安装`;
    case "error":
      return `更新失败：${s.error ?? "未知错误"}`;
    case "unsupported":
      return "当前运行环境没有更新源（开发模式或未配置发布通道）";
    default:
      return "";
  }
}

const BANNER_PHASES: UpdateState["phase"][] = ["available", "downloading", "downloaded", "error"];

export function UpdateBanner({
  state,
  onState,
}: {
  state: UpdateState;
  onState: (s: UpdateState) => void;
}): React.ReactElement | null {
  if (!BANNER_PHASES.includes(state.phase)) return null;
  const failed = state.phase === "error";
  return (
    <Alert variant={failed ? "destructive" : "default"} className="mb-3">
      <div className="col-start-2 flex flex-wrap items-center justify-between gap-3">
        <AlertDescription className="text-current">{phrase(state)}</AlertDescription>
        <span className="flex items-center gap-2">
          {state.phase === "available" && (
            <Button size="sm" onClick={() => void act("download", onState)}>
              下载更新
            </Button>
          )}
          {state.phase === "downloaded" && (
            <Button size="sm" onClick={() => void act("install", onState)}>
              立即重启
            </Button>
          )}
          {failed && state.canCheck && (
            <Button size="sm" variant="ghost" onClick={() => void act("check", onState)}>
              重试
            </Button>
          )}
        </span>
      </div>
      {state.phase === "downloading" && <Progress value={state.percent ?? 0} className="col-start-2 mt-2" />}
    </Alert>
  );
}

export function UpdateCard({
  state,
  onState,
}: {
  state: UpdateState;
  onState: (s: UpdateState) => void;
}): React.ReactElement {
  const busy = state.phase === "checking" || state.phase === "downloading";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">更新</CardTitle>
        <CardDescription>
          经 GitHub Releases 通道检查；下载与安装都在应用内进行，安装只在退出或点「立即重启」时发生。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">{phrase(state)}</span>
          <span className="flex items-center gap-2">
            {state.canCheck && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("check", onState)}>
                {busy ? "进行中…" : "检查更新"}
              </Button>
            )}
            {state.phase === "available" && (
              <Button size="sm" onClick={() => void act("download", onState)}>
                下载更新
              </Button>
            )}
            {state.phase === "downloaded" && (
              <Button size="sm" onClick={() => void act("install", onState)}>
                立即重启
              </Button>
            )}
          </span>
        </div>
        {state.phase === "downloading" && <Progress value={state.percent ?? 0} />}
        <p className="text-xs tabular-nums text-muted-foreground">当前版本 v{state.currentVersion}</p>
      </CardContent>
    </Card>
  );
}

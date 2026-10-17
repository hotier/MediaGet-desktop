/**
 * 自动更新 UI（P6）：更新信息只在设置→关于的「手动检测更新」行动作组里操作。
 * 「下载更新」起流并弹出**流式下载弹窗**——主体是本次版本的 changelog，进度条右侧显百分比，
 * 下方显下载速度与已下/总大小；底部按钮「暂停 / 取消」（暂停时「继续下载 / 取消」，完成时「立即重启」）。
 * 右上角 X 仅关弹窗、不停下载；关掉后重开「查看进度」仍见实时进度（下载在主进程后台跑）。
 * 结果阶段以浮空 toast 播报（撤掉了首页/队列/历史的「发现新版本」横幅；2026-10-15 改用 sonner，
 * 不再自绘右上角浮层）。播不播、用什么档由 renderer/src/lib/update-announce.ts 的决策表定：
 * 取消下载后状态回落 available 是「恢复可重下的入口」，不能再播一次「发现新版本」。
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/bridge";
import { updateNotice } from "../lib/update-announce";
import type { UpdateState } from "../../../types/ipc";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type Action = "check" | "download" | "pause" | "resume" | "cancel" | "install";

/**
 * 动作后一律以主进程回传的快照为准：状态机是唯一真源，
 * renderer 自行乐观改态会在事件回灌时出现闪回。
 */
async function act(action: Action, onState: (s: UpdateState) => void): Promise<void> {
  try {
    if (action === "check") onState(await api.app.update.check());
    else if (action === "download") onState(await api.app.update.download());
    else if (action === "pause") onState(await api.app.update.pause());
    else if (action === "resume") onState(await api.app.update.resume());
    else if (action === "cancel") onState(await api.app.update.cancel());
    else await api.app.update.install(); // 成功即退出重启，代码不会再走到下面
  } catch {
    /* check/download 的失败已在主进程收敛为 error 阶段并经事件送达，此处无需二次处理 */
  }
}

function mb(bytes?: number): string {
  if (bytes === undefined) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function speedText(s: UpdateState): string {
  if (s.phase !== "downloading" || s.bytesPerSecond === undefined) return "—";
  return `${mb(s.bytesPerSecond)}/s`;
}

function sizeText(s: UpdateState): string {
  if (s.totalBytes === undefined) return "—";
  return `${mb(s.transferredBytes)} / ${mb(s.totalBytes)}`;
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
      // 只报新版本号；「当前 v…」不上 toast（业主指令 2026-10-15）——
      // 当前版本在对话框与设置页都在，提示里它是噪声，播报的主角是「有了什么新东西」
      return `发现新版本${next}`;
    case "downloading":
      return `正在下载${next}… ${s.percent ?? 0}%`;
    case "paused":
      return `下载已暂停（${s.percent ?? 0}%），恢复会重新下载`;
    case "downloaded":
      return s.availableVersion
        ? `v${s.availableVersion} 已下载完成，点「立即重启」安装`
        : "更新已下载完成，点「立即重启」安装";
    case "error":
      return `更新失败：${s.error ?? "未知错误"}`;
    case "unsupported":
      return "当前运行环境没有更新源（开发模式或未配置发布通道）";
    default:
      return "";
  }
}

/**
 * 无更新源时点「检查更新」的回执文案（导出给单测）。主进程 `check()` 在这种环境原样回吐快照、
 * 阶段不迁移，toast 决策表永远不响——不自己说一句，这颗按钮就成了点了没反应的。
 * 环境说明不是故障，所以走 info 档而不是 error。
 */
export function noSourceNotice(s: UpdateState): string | null {
  return s.canCheck ? null : phrase(s);
}

function dialogTitle(s: UpdateState): string {
  const v = s.availableVersion ? ` v${s.availableVersion}` : "";
  switch (s.phase) {
    case "downloading":
      return `正在下载更新${v}`;
    case "paused":
      return "下载已暂停";
    case "downloaded":
      return "更新已下载完成";
    default:
      return `更新${v}`;
  }
}

export function UpdateActions({
  state,
  onState,
}: {
  state: UpdateState;
  onState: (s: UpdateState) => void;
}): React.ReactElement {
  const busy = state.phase === "checking" || state.phase === "downloading";
  const [dlOpen, setDlOpen] = useState(false);
  const prevPhase = useRef(state.phase);
  useEffect(() => {
    if (state.phase === prevPhase.current) return;
    const prev = prevPhase.current;
    prevPhase.current = state.phase;
    // 档位与「播不播」全走决策表 —— 取消下载后的 available 回落不播（业主报 2026-10-15），
    // error 走红档，其余中性 info（带档才渲染图标）
    const notice = updateNotice(prev, state.phase);
    if (notice === "error") toast.error(phrase(state));
    else if (notice === "info") toast.info(phrase(state));
  }, [state]);

  // 起流并打开弹窗；右上角 X 只 setDlOpen(false)，下载在主进程继续
  function startDownload(): void {
    setDlOpen(true);
    void act("download", onState);
  }

  const pct = state.phase === "downloaded" ? 100 : state.percent ?? 0;
  const version = state.availableVersion ? ` v${state.availableVersion}` : "";
  const active = state.phase === "downloading" || state.phase === "paused" || state.phase === "downloaded";

  return (
    <div className="flex flex-col items-end gap-2">
      <span className="flex flex-wrap items-center justify-end gap-2 pt-1.5">
        {/* 「检查更新」常驻（业主指令 2026-10-17）：环境只改变可用性，不改变存在性——
            按钮随运行环境消失会被读成缺陷。开发态照样可点，点了用 sonner 说清这儿为什么查不了。 */}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            const notice = noSourceNotice(state);
            if (notice) toast.info(notice);
            else void act("check", onState);
          }}
        >
          {state.phase === "checking" ? "检查中…" : "检查更新"}
        </Button>
        {state.phase === "available" && (
          <Button size="sm" onClick={startDownload}>
            下载更新
          </Button>
        )}
        {(state.phase === "downloading" || state.phase === "paused") && (
          <Button size="sm" variant="outline" onClick={() => setDlOpen(true)}>
            {state.phase === "paused" ? "已暂停 · 查看" : "查看进度"}
          </Button>
        )}
        {state.phase === "downloaded" && (
          <Button size="sm" onClick={() => void act("install", onState)}>
            立即重启
          </Button>
        )}
      </span>
      <Dialog open={dlOpen} onOpenChange={(v) => !v && setDlOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{dialogTitle(state)}</DialogTitle>
            <DialogDescription>
              {`新版本${version}（当前 v${state.currentVersion}）`}
              {state.totalBytes ? ` · 更新包约 ${mb(state.totalBytes)}` : ""}
              {" · 经 GitHub Releases 通道"}
            </DialogDescription>
          </DialogHeader>

          {/* 主体：本次版本的 changelog */}
          <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-foreground">
            {state.releaseNotes?.trim() || "（该版本暂无更新说明）"}
          </div>

          {active && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Progress value={pct} className="flex-1" />
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {pct}%
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
                <span>速度 {speedText(state)}</span>
                <span>{sizeText(state)}</span>
              </div>
            </div>
          )}

          <DialogFooter>
            {state.phase === "downloading" && (
              <>
                <Button variant="outline" onClick={() => void act("pause", onState)}>
                  暂停
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    void act("cancel", onState);
                    setDlOpen(false); // 取消即回落 available，收掉弹窗回到「下载更新」
                  }}
                >
                  取消
                </Button>
              </>
            )}
            {state.phase === "paused" && (
              <>
                <Button variant="outline" onClick={() => void act("resume", onState)}>
                  继续下载
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    void act("cancel", onState);
                    setDlOpen(false);
                  }}
                >
                  取消
                </Button>
              </>
            )}
            {state.phase === "downloaded" && (
              <Button onClick={() => void act("install", onState)}>立即重启</Button>
            )}
          </DialogFooter>
          {state.phase === "downloading" && (
            <p className="text-xs text-muted-foreground">右上角 X 仅关闭弹窗，下载会在后台继续。</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

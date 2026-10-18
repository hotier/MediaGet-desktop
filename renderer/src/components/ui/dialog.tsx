import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "~/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/**
 * 上下滑移的开合动效（进入上浮 2rem / 退场下沉 2rem）：作者卡片与预览弹窗共用同一套，
 * 别在两个调用点各写一遍曲线。基类退场用 ease、淡出被前置（实测 0.59@50ms），位移还没走完
 * 就先透明了，看着像「直接消失」——所以进入 ease-out / 退场 ease-in + 250ms，
 * 前半段留住不透明度，位移才看得见。
 */
export const dialogSlideMotion =
  "slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8 data-[state=open]:ease-out data-[state=closed]:ease-in data-[state=closed]:duration-250";

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.ReactElement {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // 浅遮罩 `--scrim`（业主指令 2026-10-17）：暗档 60% / 浅档 32%，把背景往后推一层但不抹成一块黑。
        // 浅档只到 32% 是因为页底 `#f5f6f7` 的通道值约为暗档 `#0f1113` 的 16 倍，同一个 alpha 在浅档会糊成不透明。
        // 遮罩变浅之后「卡片浮在内容之上」主要靠 blur，所以 blur 保留。
        // 结果卡「+N」角标那枚深遮罩仍用 `--overlay`——它压的是图，不是页面，两档不共用。
        "fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-sm",
        "animate-in fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  showOverlay = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  /**
   * 遮罩三档：`true` 浅遮罩 + 模态锁背景（默认）；`"light"` 同一枚浅遮罩但不拦手；`false` 完全不画。
   * `"light"` 只配 Root `modal={false}` 用（业主点名的两层：作者卡片、批量导入说明——要背景照常可点）。
   */
  showOverlay?: boolean | "light";
}): React.ReactElement {
  return (
    <DialogPortal>
      {showOverlay === "light" ? (
        // 这层只能自己画：Radix 的 `Dialog.Overlay` 在非模态下**直接返回 null**
        // （`context.modal ? <Presence>…</Presence> : null`），而非模态正是「背景照常可点」的前提。
        // 给模态 Overlay 加 `pointer-events-none` 也不行——模态锁是加在 `document.body` 上的。
        // 不叠 blur：这两层要的「照常可见」经不起糊一层。
        <div
          aria-hidden
          data-slot="dialog-scrim"
          className="pointer-events-none fixed inset-0 z-50 bg-[var(--scrim)] animate-in fade-in-0 duration-200"
        />
      ) : showOverlay ? (
        <DialogOverlay />
      ) : null}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // grid-cols-[minmax(0,1fr)]：隐式列是 auto，它的**下限 = 内容的 max-content**。
          // 卡里只要有一行 `truncate`（nowrap + overflow-hidden），那行全文的宽度就会把列撑到
          // 几百 px，整张卡溢出对话框、省略号根本不出现（作者卡简介实测撑到 896，框只有 365）。
          // min 归 0 之后列才真的等于框宽，截断才有可截断的盒。
          // left 偏移 = 侧栏宽的一半：弹窗的居中参照是**功能区**而不是整个视口（业主指令 2026-10-17，
          // 与底部浮层 `SheetContent` 的 `ms-(--w-side)` 同一条口径）。侧栏恒在，所以按 var 算不按断点算。
          // w 也得跟着让开侧栏：`w-full` 的 100% 是**视口**宽，参照系挪到功能区后它就不封顶了 ——
          // 820（minWidth）时 max-w-3xl 那张会算出 [130, 898]，左缘压到侧栏上、右缘出屏。
          // 这里减掉侧栏再留 2rem，配合上面的 left 可证：左缘 ≥ 侧栏宽 + 16、右缘 ≤ 视口 - 16。
          "fixed top-1/2 left-[calc(50%_+_var(--w-side)/2)] z-50 grid w-[calc(100%_-_var(--w-side)_-_2rem)] max-w-lg grid-cols-[minmax(0,1fr)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-card p-5 shadow-pop",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-200",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-sm opacity-60 outline-none transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none"
          >
            <X className="size-4" />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5 text-start", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>): React.ReactElement {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("font-semibold text-base", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>): React.ReactElement {
  return (
    <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-muted-foreground text-sm", className)} {...props} />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};

/**
 * 底部浮层（Radix Dialog 的形态变体）：**没有遮罩**，卡片让开侧栏停在内容区底部。
 * 用法必须配 `modal={false}` —— 否则模态锁会给背景加 pointer-events:none 并 aria-hidden，
 * 上方列表就只剩「看得见」而点不动了。收起只靠角落按钮 / Esc / 再次点行 ——
 * 角落那枚给的是 ChevronDown 不是 X：这层只会向下收，图标方向与退场方向一致（业主指令 2026-10-15）。
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronDown } from "lucide-react";
import { cn } from "~/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>): React.ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[70vh] flex-col rounded-t-xl border border-b-0 border-border bg-card shadow-pop",
          "ms-(--w-side)",
          "animate-in slide-in-from-bottom-full duration-250 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-full",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          data-slot="sheet-close"
          title="收起"
          className="absolute top-4 right-4 rounded-sm opacity-60 outline-none transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronDown className="size-4" />
          <span className="sr-only">收起</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return <div data-slot="sheet-header" className={cn("flex shrink-0 flex-col gap-0.5 p-4 pb-2", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>): React.ReactElement {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn("font-semibold text-base", className)} {...props} />;
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>): React.ReactElement {
  return (
    <DialogPrimitive.Description data-slot="sheet-description" className={cn("text-muted-foreground text-sm", className)} {...props} />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return <div data-slot="sheet-body" className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4", className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody };

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import { cn } from "~/lib/utils";

function TooltipProvider({ delayDuration = 300, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>): React.ReactElement {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>): React.ReactElement {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>): React.ReactElement {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.ReactElement {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md border border-hairline bg-popover px-2.5 py-1.5 text-xs",
          "text-popover-foreground shadow-pop fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TruncatedTooltip, HintInfo };

/**
 * 说明性 info 图标（业主定稿模式：说明文字收进图标，悬浮以 tooltip 预览）。
 * 说明若需承载动作（如保存模板），不用 tooltip 而用弹窗——见首页「批量导入说明」。
 */
function HintInfo({ text }: { text: string }): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help align-middle text-faint outline-none transition-colors hover:text-muted-foreground">
          <Info size={14} strokeWidth={1.5} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 截断文字专用：只有文字真的被截断（含窗口缩放、布局变化后）才显示 tooltip。
 * ResizeObserver 盯元素盒变化；label 变化（换文案）时重测溢出。
 */
function TruncatedTooltip({
  label,
  contentClassName,
  children,
}: {
  label: React.ReactNode;
  contentClassName?: string;
  children: React.ReactElement;
}): React.ReactElement {
  const ref = React.useRef<HTMLElement | null>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 1px 容差：DPR 缩放与亚像素舍入会让 scrollWidth/clientWidth 在刚好放得下时差出零点几像素
    const check = () =>
      setTruncated(el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [label]);

  // 始终受控（Radix Root 不允许 controlled/uncontrolled 切换），hover 意图只在截断时放行
  const onOpenChange = (next: boolean) => setOpen(next && truncated);

  return (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild>
        {React.cloneElement(children, { ref } as { ref: React.Ref<HTMLElement> })}
      </TooltipTrigger>
      <TooltipContent className={cn("max-w-80", contentClassName)}>{label}</TooltipContent>
    </Tooltip>
  );
}

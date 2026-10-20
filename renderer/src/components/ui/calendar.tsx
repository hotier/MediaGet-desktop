/**
 * 主题化日历（shadcn 形态）：不引 react-day-picker 的默认样式表，结构与视觉全部走
 * Tailwind utility + 本仓 token —— 选中 = primary、区间中段 = accent、非本月 = muted，
 * 于是明暗档与五套风格切换时无需另做适配。导航/日期按钮的坑位与默认类名照旧保留
 * （getDefaultClassNames），方便日后再接 rdp 的其它能力。
 */
import * as React from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  DayPicker,
  getDefaultClassNames,
  type ChevronProps,
  type DayButtonProps,
  type DayPickerProps,
} from "react-day-picker";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

function CalendarChevron({ orientation = "left", className }: ChevronProps): React.ReactElement {
  const Icon = orientation === "left" ? ChevronLeft : orientation === "right" ? ChevronRight : ChevronDown;
  return <Icon className={cn("size-4", className)} aria-hidden="true" />;
}

function CalendarDayButton({ className, modifiers, ...props }: DayButtonProps): React.ReactElement {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex size-8 items-center justify-center rounded-sm text-[13px] tabular-nums outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
        modifiers.today && "font-semibold text-primary",
        modifiers.range_middle && "rounded-none bg-primary/15 text-foreground hover:bg-primary/25",
        modifiers.range_start && "rounded-e-none bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
        modifiers.range_end && "rounded-s-none bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
        modifiers.range_start && modifiers.range_end && "rounded-sm",
        modifiers.selected &&
          !modifiers.range_start &&
          !modifiers.range_end &&
          !modifiers.range_middle &&
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
        modifiers.outside && "text-muted-foreground opacity-60",
        modifiers.disabled && "pointer-events-none opacity-40",
        className
      )}
      {...props}
    />
  );
}

function Calendar({ className, ...props }: DayPickerProps): React.ReactElement {
  const defaults = getDefaultClassNames();
  return (
    <DayPicker
      navLayout="around"
      showOutsideDays
      className={cn("text-sm", className)}
      classNames={{
        months: cn(defaults.months, "relative flex gap-6"),
        month: cn(defaults.month, "relative flex flex-col gap-2"),
        month_caption: cn(defaults.month_caption, "flex h-8 items-center justify-center px-8 text-sm font-medium"),
        // navLayout="around" 不生成 Nav 容器，上/下月按钮直接挂在 month 下，须靠绝对定位回到标题行
        button_previous: cn(
          defaults.button_previous,
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute start-0 top-0 z-10 text-muted-foreground"
        ),
        button_next: cn(
          defaults.button_next,
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute end-0 top-0 z-10 text-muted-foreground"
        ),
        month_grid: cn(defaults.month_grid, "border-collapse"),
        weekdays: cn(defaults.weekdays),
        weekday: cn(defaults.weekday, "size-8 pb-1 text-center text-[11px] font-normal text-muted-foreground"),
        weeks: cn(defaults.weeks),
        week: cn(defaults.week),
        day: cn(defaults.day, "p-0 text-center align-middle"),
        hidden: cn(defaults.hidden, "invisible"),
      }}
      components={{ Chevron: CalendarChevron, DayButton: CalendarDayButton }}
      {...props}
    />
  );
}

export { Calendar };

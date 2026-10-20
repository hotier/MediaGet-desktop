import * as React from "react";
import { CalendarDays } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** 盘上约定是本地自然日 YYYY-MM-DD；往返都按本地零点构造，不走 UTC 以免差一天 */
const parseKey = (key: string): Date | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
};

const keyOf = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const label = (key: string): string => key.replaceAll("-", "/");

/** 经典两步选法：第一次点击定起点（丢弃旧区间），第二次点击成区间并回传 */
function RangeCalendar({
  from,
  to,
  max,
  onCommit,
}: {
  from: Date;
  to: Date;
  max?: Date;
  onCommit: (from: Date, to: Date) => void;
}): React.ReactElement {
  const [anchor, setAnchor] = React.useState<Date | null>(null);
  const [range, setRange] = React.useState<DateRange | undefined>({ from, to });
  return (
    <Calendar
      mode="range"
      autoFocus
      selected={range}
      defaultMonth={from}
      numberOfMonths={2}
      locale={zhCN}
      disabled={max ? { after: max } : undefined}
      onSelect={(_next, triggerDate) => {
        if (!anchor) {
          setAnchor(triggerDate);
          setRange({ from: triggerDate, to: undefined });
          return;
        }
        const start = anchor <= triggerDate ? anchor : triggerDate;
        const end = anchor <= triggerDate ? triggerDate : anchor;
        setRange({ from: start, to: end });
        onCommit(start, end);
      }}
    />
  );
}

export function DateRangePicker({
  from,
  to,
  max,
  onChange,
}: {
  /** 草稿区间（YYYY-MM-DD，本地自然日） */
  from: string;
  to: string;
  /** 可选的最大日期，之后的日期不可选 */
  max?: string;
  onChange: (from: string, to: string) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const fromDate = parseKey(from);
  const toDate = parseKey(to);
  const maxDate = max ? parseKey(max) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="选择日期范围"
          className="gap-1.5 bg-control font-normal tabular-nums text-sm"
        >
          <CalendarDays className="text-muted-foreground" />
          {label(from)} – {label(to)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        {fromDate && toDate && (
          <RangeCalendar
            from={fromDate}
            to={toDate}
            max={maxDate}
            onCommit={(nextFrom, nextTo) => {
              onChange(keyOf(nextFrom), keyOf(nextTo));
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

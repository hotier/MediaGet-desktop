/**
 * 可搜索字体选择器（设置→外观→界面字体）。
 *
 * 数据源是**本机枚举**的字体族（font-list 在主进程跑，约 3–4s），所以：
 * - 打开面板时才懒加载（父级传 fetchFonts），带「读取中…」态；进程侧已缓存，重开即时。
 * - 列表可能上百条，顶部即时过滤 + 滚动；每项按自身字形渲染，选中/关闭即回调 value。
 *   顺序 = 主进程给的顺序（中文字体组在前、英文组在后，业主指令 2026-10-15），
 *   过滤只做保留、不重排——分组是数据源的承诺，不在 UI 层重实现一遍。
 * - 用原生 div + 面板自管理（本仓未装 Popover/Command 原语），视觉口径对齐 ui/select.tsx。
 *   触发器 w-36 / 面板 w-56 比通用 Select（w-28~36）宽一档：字体名动辄二三十字符，
 *   再窄就全是截断（业主指令 2026-10-15 宽度收窄，对齐通用档）。
 * value 语义："system" = 哨兵（内联 --font-ui 被清除，回落基座栈），其余 = 具体 family 名。
 */
import * as React from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "~/lib/utils";

const SYSTEM = "system";
const SYSTEM_LABEL = "系统默认";

/** CSS 安全字体名：含空格/非 ASCII（中文字面）加引号，与 theme.ts quoteFamily 同规则 */
function cssFamily(name: string): string {
  return /[^a-zA-Z0-9_-]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name;
}

export function FontPicker({
  value,
  onChange,
  fetchFonts,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (family: string) => void;
  fetchFonts: () => Promise<string[]>;
  ariaLabel?: string;
  className?: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [fonts, setFonts] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const load = React.useCallback(() => {
    if (fonts || loading) return;
    setLoading(true);
    setFailed(false);
    fetchFonts()
      .then((f) => setFonts(f))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [fonts, loading, fetchFonts]);

  React.useEffect(() => {
    if (!open) return;
    load();
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, load]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const q = query.trim().toLowerCase();
  const options = React.useMemo(() => {
    const showSystem = !q || SYSTEM_LABEL.includes(q) || SYSTEM.includes(q);
    const items = (fonts ?? []).filter((f) => (q ? f.toLowerCase().includes(q) : true));
    return [...(showSystem ? [SYSTEM] : []), ...items];
  }, [fonts, q]);

  // 结果集变化后把高亮夹回范围内
  React.useEffect(() => {
    setActive((a) => Math.min(a, Math.max(options.length - 1, 0)));
  }, [options.length]);

  // 高亮项滚动进视口
  React.useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function reset(): void {
    setOpen(false);
    setQuery("");
  }

  function choose(family: string): void {
    onChange(family);
    reset();
  }

  function onTriggerKey(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onInputKey(e: React.KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      reset();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const val = options[active];
      if (val) choose(val);
    }
  }

  const triggerLabel = value === SYSTEM ? SYSTEM_LABEL : value;
  const triggerStyle = value === SYSTEM ? undefined : { fontFamily: cssFamily(value) };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        className={cn(
          "flex h-9 w-36 items-center justify-between gap-2 rounded-md border border-input bg-control px-3 py-2 text-sm whitespace-nowrap outline-none",
          "transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0"
        )}
      >
        <span className="line-clamp-1" style={triggerStyle}>
          {triggerLabel}
        </span>
        <ChevronDown className="size-4 opacity-60" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 w-56 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-pop",
            "animate-in fade-in-0 zoom-in-95"
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
            <Search className="size-3.5 shrink-0 opacity-60" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="搜索字体…"
              role="searchbox"
              aria-label="搜索字体"
              className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <ul ref={listRef} role="listbox" aria-label={ariaLabel} className="max-h-56 overflow-y-auto p-1">
            {loading && <li className="px-2 py-3 text-center text-xs text-muted-foreground">读取本机字体…</li>}
            {!loading && failed && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">字体读取失败，关闭后重试</li>
            )}
            {!loading && !failed && options.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">无匹配字体</li>
            )}
            {!loading &&
              options.map((fam, i) => {
                const isSystem = fam === SYSTEM;
                const selected = fam === value;
                return (
                  <li key={fam} data-idx={i}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(fam)}
                      className={cn(
                        "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pe-7 ps-2 text-start text-sm outline-none",
                        i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                      )}
                    >
                      <span className="line-clamp-1" style={isSystem ? undefined : { fontFamily: cssFamily(fam) }}>
                        {isSystem ? SYSTEM_LABEL : fam}
                      </span>
                      {selected && <Check className="absolute end-2 size-4 shrink-0" />}
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </div>
  );
}

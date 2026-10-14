import * as React from "react";
import { cn } from "~/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">): React.ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-sunken px-3 py-1 text-sm outline-none",
        "transition-colors placeholder:text-muted-foreground/80 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "aria-invalid:border-err aria-invalid:ring-err/25 disabled:pointer-events-none disabled:opacity-50 disabled:text-disabled",
        className
      )}
      {...props}
    />
  );
}

export { Input };

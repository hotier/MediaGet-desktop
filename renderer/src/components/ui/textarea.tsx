import * as React from "react";
import { cn } from "~/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-md border border-input bg-control px-3 py-2 text-sm outline-none",
        "transition-colors placeholder:text-muted-foreground/80 field-sizing-content",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "aria-invalid:border-err aria-invalid:ring-err/25 disabled:pointer-events-none disabled:opacity-50 disabled:text-disabled",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };

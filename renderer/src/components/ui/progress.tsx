import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "~/lib/utils";

interface ProgressProps extends React.ComponentProps<typeof ProgressPrimitive.Root> {
  /** 0–100；省略 = 不确定态（总长未知的下载、等待中的解析） */
  value?: number;
}

function Progress({ className, value, ...props }: ProgressProps): React.ReactElement {
  const bounded = value === undefined ? undefined : Math.max(0, Math.min(100, value));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={bounded}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-progress-track", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full bg-progress",
          bounded === undefined ? "w-1/3 animate-progress-indeterminate" : "flex-1 transition-transform duration-200 ease-out"
        )}
        style={bounded === undefined ? undefined : { transform: `translateX(-${100 - bounded}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };

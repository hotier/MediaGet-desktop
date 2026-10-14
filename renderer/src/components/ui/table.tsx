import * as React from "react";
import { cn } from "~/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">): React.ReactElement {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      {/*
        table-fixed 是本仓库列表的截断前提：auto 布局下表格列宽由内容决定，长标题会把表撑破
        （实测 51 字标题：表宽 1117 > 容器 594，省略号根本不出现、操作列被顶出可视区）。
        定宽后「没写宽度的那一列」自动吃掉剩余空间，内部 span 的 truncate 才有可截断的盒。
        代价：非弹性列必须显式给宽，且组内无表头的表格要把同一个宽同时写进 th 与 td。
      */}
      <table
        data-slot="table"
        className={cn("w-full table-fixed caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">): React.ReactElement {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">): React.ReactElement {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.ReactElement {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-border transition-colors hover:bg-muted/60 data-[state=selected]:bg-muted", className)}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">): React.ReactElement {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-start align-middle text-xs font-medium whitespace-nowrap text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">): React.ReactElement {
  return <td data-slot="table-cell" className={cn("px-3 py-2 align-middle text-sm whitespace-nowrap", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };

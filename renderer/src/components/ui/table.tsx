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
      {/* 表格只有一个字号：14px（业主指令 2026-10-15 二次修订「统一都改为 14」）。
          列与列之间不分大小，层级靠字重与色彩：主信息 font-medium + 前景，元数据常规 + muted。 */}
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
        "h-9 px-3 text-start align-middle text-sm font-medium whitespace-nowrap text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">): React.ReactElement {
  /* 单元格不再声明字号：14px 由 <table> 上的基线继承下来。
     列间不分大小（「作品」与「作者」同字号），层级只靠字重与色彩。 */
  return <td data-slot="table-cell" className={cn("px-3 py-2 align-middle text-sm whitespace-nowrap", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };

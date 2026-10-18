/**
 * 作者头像：缺图与加载失败同一条退路 —— 首字占位。
 *
 * 尺寸与字号由调用方给（历史表格按 em 跟界面字号缩放、作者卡片用固定 12），
 * 组件只负责「有图显示图、没图显示首字」，不替调用方决定盒大小。
 * `src` 走代理链（`shared/preview-link.ts`）：微博图床对**空 Referer** 也回 403，
 * 单靠 `referrerPolicy` 换不出平台要的那对防盗链头，只有主进程带得上。建不出可渲染的
 * src（相对路由、坏地址）时走首字占位——不把必坏的地址写进 `<img>`（2026-10-18 事故）。
 */
import { useState } from "react";
import { buildImageSrc } from "../../../shared/preview-link";
import { cn } from "../lib/utils";

export function AuthorAvatar({
  avatar,
  name,
  platform,
  sizeClassName,
  textClassName,
}: {
  avatar?: string;
  name: string;
  /** 平台键：查防盗链 Referer 用，缺省只补 UA */
  platform?: string;
  sizeClassName: string;
  textClassName: string;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const src = avatar ? buildImageSrc(avatar, platform) : null;
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("shrink-0 rounded-full object-cover", sizeClassName)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold",
        sizeClassName,
        textClassName
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

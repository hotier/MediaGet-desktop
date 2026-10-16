/**
 * 平台图标：全站唯一出口（铁律：同一实体同一图标）。
 * 文件名来自 `shared/platforms.ts` 注册表（不再有本仓第二张键→图标表）；
 * 资产 = 上游 mediaGet public/logos 同套品牌 SVG，复制于 renderer/public/logos；
 * 按 img 静态资源引用（与封面图同规），不做远程请求。
 */
import { iconFileOf } from "../../../shared/platforms";
import { cn } from "../lib/utils";

export function PlatformIcon({
  platform,
  className,
}: {
  platform: string | undefined | null;
  className?: string;
}): React.ReactElement | null {
  const file = platform ? iconFileOf(platform) : null;
  if (!file) return null;
  return (
    <img
      className={cn("size-[15px] shrink-0 rounded-[3px] object-contain align-[-3px]", className)}
      src={`./logos/${file}`}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

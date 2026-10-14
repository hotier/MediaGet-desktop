/**
 * 平台图标：全站唯一出口（铁律：同一实体同一图标）。
 * 资产 = 上游 mediaGet public/logos 同套品牌 SVG，复制于 renderer/public/logos；
 * 按 img 静态资源引用（与封面图同规），不做远程请求。
 */
import { platformIconFile } from "../lib/platform-icon-map";

export function PlatformIcon({
  platform,
  className,
}: {
  platform: string | undefined | null;
  className?: string;
}): React.ReactElement | null {
  const file = platform ? platformIconFile(platform) : null;
  if (!file) return null;
  return (
    <img
      className={`p-icon ${className ?? ""}`}
      src={`./logos/${file}`}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

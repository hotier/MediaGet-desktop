/**
 * 作者卡片：快照字段逐项展示，缺项不占行；头像加载失败退回首字占位。
 *
 * 从历史页抽出来给结果卡共用（业主指令 2026-10-19）：同一份作者信息在两处必须长得一样，
 * 各写一遍就是下一个漂移点。数据是**解析那一刻的快照**，客户端不拉实时主页。
 *
 * 名字本身就是「在浏览器打开主页」那条链接（业主指令 2026-10-17 撤掉单独的外链按钮）；
 * 外链走 `<a target=_blank>`，由主进程 `setWindowOpenHandler` 转交系统浏览器——
 * 渲染层自己不发请求。不套 `text-primary`：那是动态魔法色，历史页没有封面去设它，
 * 会停在中性初值上（对比度不足，看着像禁用）；可点性只靠 hover 下划线与光标。
 */
import type { AuthorSnapshot } from "../../../types/ipc";
import { fmtCount } from "../lib/format";
import { AuthorAvatar } from "./AuthorAvatar";
import { TruncatedTooltip } from "./ui/tooltip";

export function AuthorCard({
  author,
  platform,
  platformName,
  /** 空态文案由调用方定：历史页要说清「旧记录没有、此后生效」，结果卡不需要这层解释 */
  emptyHint = "未保存作者信息。",
}: {
  author?: AuthorSnapshot;
  /** 平台键：头像走防盗链 Referer 用（与调用方的行数据同宽，可能缺省） */
  platform?: string;
  platformName: string;
  emptyHint?: string;
}): React.ReactElement {
  if (!author) return <p className="text-muted-foreground">{emptyHint}</p>;

  const name = author.name ?? author.id ?? "?";

  const stats: Array<{ label: string; value: string }> = [];
  if (author.followerCount != null) stats.push({ label: "粉丝", value: fmtCount(author.followerCount) });
  if (author.followingCount != null) stats.push({ label: "关注", value: fmtCount(author.followingCount) });
  if (author.totalFavorited != null) stats.push({ label: "获赞", value: fmtCount(author.totalFavorited) });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <AuthorAvatar
          avatar={author.avatar}
          name={name}
          platform={platform}
          sizeClassName="size-12"
          textClassName="text-sm"
        />
        <div className="min-w-0">
          {author.url ? (
            <TruncatedTooltip label={name}>
              <a
                href={author.url}
                target="_blank"
                rel="noreferrer"
                className="block cursor-pointer truncate font-semibold text-sm hover:underline"
              >
                {name}
              </a>
            </TruncatedTooltip>
          ) : (
            <TruncatedTooltip label={name}>
              <span className="block truncate font-semibold text-sm">{name}</span>
            </TruncatedTooltip>
          )}
          {/* 抖音 uid 这类长 ID 一定会被切，截断处同样要给 tooltip（全仓基准） */}
          {author.id && (
            <TruncatedTooltip label={`ID ${author.id}`}>
              <div className="truncate text-muted-foreground">ID {author.id}</div>
            </TruncatedTooltip>
          )}
          {platformName && (
            <TruncatedTooltip label={platformName}>
              <div className="truncate text-muted-foreground">{platformName}</div>
            </TruncatedTooltip>
          )}
        </div>
      </div>

      {stats.length > 0 && (
        <div className="flex gap-5">
          {stats.map((s) => (
            <div key={s.label} className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">{s.label}</span>
              <span className="text-sm font-semibold tabular-nums">{s.value}</span>
            </div>
          ))}
        </div>
      )}

      {author.sign && (
        <TruncatedTooltip label={author.sign}>
          <p className="truncate text-muted-foreground">{author.sign}</p>
        </TruncatedTooltip>
      )}
    </div>
  );
}

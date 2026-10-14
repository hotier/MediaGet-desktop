/**
 * 历史页：解析出的作品清单（作品 / 作者 / 类型 / 文件数 / 创建时间 / 操作）。
 * 分工（2026-10-14）：本页只讲「哪个作品」——平台、标题、作者、类型、文件数、来源链接；
 * 「哪些文件、下得多大、下到哪」是队列页的资源视图，这里不重复。
 * 因此操作列也不碰资源：唯一的动作是把这一行的信息复制成文本（含分享链接），
 * 「打开位置」已撤 —— 要找文件去队列页。
 * 作者列显示的是下载那一刻的快照（点昵称开卡片）；客户端不拉实时主页，
 * 所以粉丝量停在下载当天，这是设计而非缺陷。
 * 同一 groupId 的图集条目聚合成一行；旧记录缺 kind/sourceUrl/author（本版本前写入）显示「—」优雅降级；不存媒体直链（§3 隐私）。
 */
import { useEffect, useState } from "react";
import { Clock3, Copy, ExternalLink } from "lucide-react";
import { api } from "../lib/bridge";
import type { AppMeta, AuthorSnapshot, HistoryEntry } from "../../../types/ipc";
import { PlatformIcon } from "../components/PlatformIcon";
import { buildWorkInfoText } from "../lib/work-info";
import { fmtCount, fmtCreated } from "../lib/format";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

const KIND_LABEL: Record<string, string> = {
  video: "视频",
  image: "图集",
  audio: "音频",
  file: "文件",
};

/** Radix Select 不接受空串作为 value，「全部平台」用一个不会与平台 key 撞车的哨兵 */
const ALL = "__all__";

/** table-fixed 下「作品」列不设宽 = 吃掉剩余宽度并在此截断；其余列必须显式定宽 */
const COL = {
  kind: "w-14",
  /** 96px = 内边距 24 + 约 7 个汉字；再窄会把五字昵称切成「@胶片…」这种半截词 */
  author: "w-24",
  count: "w-14",
  /** 容纳最宽形态「2026-10-13 12:32:04」（约 125px 数字 + 24px 内边距） */
  time: "w-40",
  actions: "w-16",
} as const;

interface Row {
  key: string;
  platform?: string;
  title: string;
  kind?: string;
  count: number;
  createdAt: number;
  sourceUrl?: string;
  author?: AuthorSnapshot;
  /** 昵称优先，缺昵称退回 ID；两者都没有则不渲染作者单元格 */
  authorName?: string;
}

export default function HistoryPage({ meta }: { meta: AppMeta | null }): React.ReactElement {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [platform, setPlatform] = useState<string>("");
  const [toast, setToast] = useState<string>("");
  const [clearOpen, setClearOpen] = useState(false);
  const [authorRow, setAuthorRow] = useState<Row | null>(null);

  useEffect(() => {
    void api.history.list(platform ? { platform } : undefined).then(setList).catch(() => {});
  }, [platform]);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(h);
  }, [toast]);

  const nameOf = (key?: string): string =>
    (key && meta?.platforms.find((p) => p.key === key)?.name) || key || "";

  const seenPlatforms = Array.from(
    new Set(list.map((h) => h.platform).filter((p): p is string => Boolean(p)))
  );

  // store 返回新在前；按首次出现序聚组即保持倒序
  const rows: Row[] = (() => {
    const byGroup = new Map<string, HistoryEntry[]>();
    for (const h of list) {
      const key = h.groupId ?? h.id;
      const g = byGroup.get(key);
      if (g) g.push(h);
      else byGroup.set(key, [h]);
    }
    return [...byGroup.entries()].map(([key, g]) => {
      const head = g[0];
      const count = g.reduce((s, e) => s + e.files.length, 0);
      const author = g.find((e) => e.author)?.author;
      return {
        key,
        platform: head.platform,
        title: head.title ?? "（未命名）",
        kind: head.kind,
        count,
        createdAt: Math.max(...g.map((e) => e.createdAt)),
        sourceUrl: g.find((e) => e.sourceUrl)?.sourceUrl,
        author,
        authorName: author?.name || author?.id || undefined,
      };
    });
  })();

  function copyInfo(r: Row): void {
    const text = buildWorkInfoText({
      title: r.title,
      platformName: nameOf(r.platform),
      kindLabel: r.kind ? KIND_LABEL[r.kind] ?? r.kind : undefined,
      fileCount: r.count,
      createdAt: r.createdAt,
      sourceUrl: r.sourceUrl,
      author: r.author,
    });
    void navigator.clipboard
      .writeText(text)
      .then(() => setToast("已复制作品信息"))
      .catch(() => setToast("复制失败"));
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={platform === "" ? ALL : platform}
          onValueChange={(v) => setPlatform(v === ALL ? "" : v)}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="按平台筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部平台</SelectItem>
            {seenPlatforms.map((p) => (
              <SelectItem key={p} value={p}>
                {nameOf(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="destructive" size="sm" onClick={() => setClearOpen(true)}>
          清空历史
        </Button>
      </div>

      {toast && (
        <Alert>
          <AlertDescription>{toast}</AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Clock3 className="size-11 text-faint" strokeWidth={1.5} aria-hidden="true" />
          <div className="font-medium text-sm">暂无历史记录</div>
          <p className="text-xs text-muted-foreground">解析并下载成功的作品会自动记录在这里。</p>
        </div>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>作品</TableHead>
                <TableHead className={COL.author}>作者</TableHead>
                <TableHead className={COL.kind}>类型</TableHead>
                <TableHead className={COL.count}>文件数</TableHead>
                <TableHead className={COL.time}>创建时间</TableHead>
                <TableHead className={`${COL.actions} text-end`} aria-label="操作" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell>
                    <span className="flex min-w-0 items-center gap-2">
                      {r.platform && <PlatformIcon platform={r.platform} />}
                      <span className="min-w-0 truncate" title={r.title}>
                        {r.title}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.authorName ? (
                      <button
                        type="button"
                        className="block w-full min-w-0 cursor-pointer truncate text-start font-medium hover:underline"
                        title={`${r.authorName}（查看作者卡片）`}
                        onClick={() => setAuthorRow(r)}
                      >
                        @{r.authorName}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.kind ? KIND_LABEL[r.kind] ?? r.kind : "—"}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {r.count} 个
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {fmtCreated(r.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <IconAction label="复制作品信息" onClick={() => copyInfo(r)}>
                        <Copy />
                      </IconAction>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>清空全部下载历史？</DialogTitle>
            <DialogDescription>只删除本机的记录，已下载的文件不会被动。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                void api.history.clear().then(() => {
                  setList([]);
                  setClearOpen(false);
                });
              }}
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={authorRow !== null}
        onOpenChange={(o) => {
          if (!o) setAuthorRow(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>作者卡片</DialogTitle>
            <DialogDescription>下载那一刻解析到的作者信息，之后不会自动更新。</DialogDescription>
          </DialogHeader>
          {authorRow && (
            <AuthorCard row={authorRow} platformName={nameOf(authorRow.platform)} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 作者卡片：快照字段逐项展示，缺项不占行；头像加载失败退回首字占位 */
function AuthorCard({
  row,
  platformName,
}: {
  row: Row;
  platformName: string;
}): React.ReactElement {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const a = row.author;
  if (!a) return <p className="text-xs text-muted-foreground">该记录未保存作者信息（此后生效）。</p>;

  const stats: Array<{ label: string; value: string }> = [];
  if (a.followerCount != null) stats.push({ label: "粉丝", value: fmtCount(a.followerCount) });
  if (a.followingCount != null) stats.push({ label: "关注", value: fmtCount(a.followingCount) });
  if (a.totalFavorited != null) stats.push({ label: "获赞", value: fmtCount(a.totalFavorited) });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {a.avatar && !avatarFailed ? (
          <img
            src={a.avatar}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
            className="size-12 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-sm"
            aria-hidden="true"
          >
            {(a.name ?? a.id ?? "?").slice(0, 1)}
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate font-semibold text-sm">{a.name ?? a.id}</div>
          {a.id && <div className="truncate text-xs text-muted-foreground">ID {a.id}</div>}
          {platformName && (
            <div className="truncate text-xs text-muted-foreground">{platformName}</div>
          )}
        </div>
      </div>

      {stats.length > 0 && (
        <div className="flex gap-5">
          {stats.map((s) => (
            <div key={s.label} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{s.label}</span>
              <span className="text-sm font-semibold tabular-nums">{s.value}</span>
            </div>
          ))}
        </div>
      )}

      {a.sign && <p className="text-xs text-muted-foreground">{a.sign}</p>}

      {/* 外链走 <a target=_blank>，由主进程 setWindowOpenHandler 转交系统浏览器；
          样式跟结果卡一致（Button asChild + ExternalLink），不用 text-primary ——
          那是动态魔法色，历史页没有封面去设它，会停在中性初值上（对比度 1.9:1，看着像禁用） */}
      {a.url && (
        <Button asChild variant="outline" size="sm" className="self-start">
          <a href={a.url} target="_blank" rel="noreferrer">
            <ExternalLink />
            在浏览器中打开主页
          </a>
        </Button>
      )}

      <div
        className="truncate border-t border-border pt-3 text-xs text-muted-foreground"
        title={row.title}
      >
        作品：{row.title}
      </div>
    </div>
  );
}

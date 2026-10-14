/** 平台 key → 上游品牌 logo 文件名（源：mediaGet public/logos，随 renderer/public 打包） */
const MAP: Record<string, string> = {
  douyin: "douyin.svg",
  bilibili: "bilibili.svg",
  kuaishou: "kuaishou.svg",
  weibo: "sinaweibo.svg",
  xhs: "xiaohongshu.svg",
  qsmusic: "qsmusic.svg",
  pipigx: "pipigx.svg",
  ppxia: "pipixia.svg",
  xigua: "xigua.svg",
  zuiyou: "zuiyou.svg",
  huya: "huya.svg",
  acfun: "acfun.svg",
  quanminkge: "quanminkge.svg",
  sixroom: "sixroom.svg",
  xinpianchang: "xinpianchang.svg",
  haokan: "haokan.svg",
  twitter: "x.svg",
  tiktok: "tiktok.svg",
  instagram: "instagram.svg",
  youtube: "youtube.svg",
  qqmusic: "qqmusic.svg",
};

export function platformIconFile(key: string): string | null {
  return MAP[key] ?? null;
}

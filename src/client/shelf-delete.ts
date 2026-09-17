/**
 * 删除书籍的纯逻辑（书架卡片 ✕ 流程）。
 * 本地书必须点名「连删磁盘文件」——服务端 shelf DELETE 对 local: 前缀会连带删 txt/元数据，
 * 用户可见后果要在确认文案里如实告知。
 */

/** 删除确认文案：confirm=确认行（含书名）；warn=本地书的文件连删警告（在线书为 null） */
export function deleteBookCopy(title: string, isLocal: boolean): { confirm: string; warn: string | null } {
  return {
    confirm: `删除《${title}》？`,
    warn: isLocal ? '本地书：同时删除磁盘上的 txt 与元数据文件' : null,
  }
}

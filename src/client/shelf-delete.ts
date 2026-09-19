/**
 * 删除书籍的纯逻辑（书架卡片 ✕ 流程）。
 * 本地书删除的服务端真相：shelf DELETE 对 local: 前缀连带删 dataDir/local/ 下的副本
 * （uuid 文件名 + 元数据 json）——导入时落盘的拷贝，插件不持有用户原始文件的路径，
 * 原始文件永远不动。文案必须把这个区分说清：不点名「副本 + 原始文件不受影响」，
 * 用户会误以为删除动了自己硬盘上的原件（或反过来以为 txt 还在）。
 */

/** 删除确认文案：confirm=确认行（含书名）；warn=本地书的副本连删说明（在线书为 null） */
export function deleteBookCopy(title: string, isLocal: boolean): { confirm: string; warn: string | null } {
  return {
    confirm: `删除《${title}》？`,
    warn: isLocal
      ? '本地书：将同时删除 DSH 数据目录中的 txt 副本与元数据文件（默认 ~/.dsh/novel/local/，随 dataDir 配置）；你自己的原始文件不受影响'
      : null,
  }
}

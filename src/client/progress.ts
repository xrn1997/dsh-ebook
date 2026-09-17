/**
 * 阅读器进度数学（纯函数——连续滚动流的正确性全在此）。
 * 连续滚动流：章章首尾相接，锚点 = 每章起点 offset。
 */
export interface ChapterAnchor { index: number; start: number }

/** 定位当前章与章内比例：取 start <= scrollTop 的最大锚点 */
export function locateChapter(anchors: ChapterAnchor[], scrollTop: number): { chapterIndex: number; offsetRatio: number } {
  if (anchors.length === 0) return { chapterIndex: 0, offsetRatio: 0 }
  let idx = anchors[0].index
  for (const a of anchors) {
    if (a.start <= scrollTop) idx = a.index
    else break
  }
  const pos = anchors.find((a) => a.index === idx)!.start
  const next = anchors.find((a) => a.index === idx + 1)
  const denom = next === undefined ? Infinity : next.start - pos
  const offsetRatio = Number.isFinite(denom) && denom > 0 ? Math.max(0, (scrollTop - pos) / denom) : 0
  return { chapterIndex: idx, offsetRatio }
}

/** 恢复定位反函数：章 + 比例 → scrollTop；chapterIndex 越界 → 0 */
export function anchorTop(
  anchors: ChapterAnchor[], chapterIndex: number, offsetRatio: number,
  scrollHeight: number, clientHeight: number,
): number {
  const a = anchors.find((x) => x.index === chapterIndex)
  if (a === undefined) return 0
  const next = anchors.find((x) => x.index === chapterIndex + 1)
  const span = next === undefined ? scrollHeight - clientHeight - a.start : next.start - a.start
  if (span <= 0) return a.start
  return a.start + Math.min(1, Math.max(0, offsetRatio)) * span
}

// debounce 已迁 util.ts（它不是阅读进度数学）

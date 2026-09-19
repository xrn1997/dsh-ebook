import { LOCAL_SOURCE_ID } from '../shared/wire.js'
import type { ShelfBook } from './views/types.js'

/** 书架视图派生（纯函数、零 React）：筛选与卡片元信息的唯一口径。
 *
 *  pct 是书架卡片百分比的**唯一算式**（client.md 已知开口「百分比算式已收敛一处、剩两处」
 *  原记三处各算一份，shelf 分量已收敛到此）。口径：
 *   - reading = 有实质阅读进度（chapterIndex > 0 || offsetRatio > 0）；unread = 其补集；
 *   - local = sourceId === LOCAL_SOURCE_ID——**正交维度**：本地书是要做文件级操作
 *     （连删磁盘 txt）的对象，与读没读过无关；
 *   - 未读书 pct 归 null：简约版呈现口径「未读不出进度条」，卡片元信息只留文字。 */
export type ShelfFilterKey = 'all' | 'reading' | 'unread' | 'local'

export const SHELF_FILTERS: Array<{ key: ShelfFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'unread', label: '未读' },
  { key: 'local', label: '本地' },
]

const hasProgress = (b: ShelfBook): boolean => b.progress.chapterIndex > 0 || b.progress.offsetRatio > 0

export function filterShelfBooks(books: readonly ShelfBook[], key: ShelfFilterKey): ShelfBook[] {
  if (key === 'all') return [...books]
  if (key === 'local') return books.filter((b) => b.sourceId === LOCAL_SOURCE_ID)
  return books.filter((b) => (key === 'reading' ? hasProgress(b) : !hasProgress(b)))
}

/** 卡片元信息：text = 卡片下的灰色一行；pct = 进度条百分比（null = 不渲染进度条）。
 *  chapterIndex 是 0 基（存档口径），展示转 1 基「读至第 N 章」。 */
export function shelfCardMeta(b: ShelfBook): { text: string; pct: number | null } {
  const total = typeof b.totalChapters === 'number' ? b.totalChapters : 0
  const isLocal = b.sourceId === LOCAL_SOURCE_ID
  if (!hasProgress(b)) {
    return { text: isLocal ? '本地 TXT' : total > 0 ? `未开始 · ${total} 章` : '未开始', pct: null }
  }
  const pct = total > 0
    ? Math.min(100, Math.round(((b.progress.chapterIndex + b.progress.offsetRatio) / total) * 100))
    : null
  if (isLocal) return { text: pct === null ? '本地 TXT' : `本地 TXT · ${pct}%`, pct }
  if (pct === null) return { text: `读至第 ${b.progress.chapterIndex + 1} 章`, pct }
  return { text: `${b.progress.chapterIndex + 1}/${total} 章 · ${pct}%`, pct }
}

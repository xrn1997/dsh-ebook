import { describe, expect, it } from 'vitest'
import { coverTintClass } from '../../src/client/util.js'
import { filterShelfBooks, shelfCardMeta } from '../../src/client/shelf-view-model.js'
import type { ShelfBook } from '../../src/client/views/types.js'

/** 书架 view-model 钉子：筛选口径（reading/unread/local 正交）+ 卡片元信息/百分比唯一算式
 *  + 首字色块档位派生。客户端逻辑层测试口径：纯函数、零 React（client.md 模块地图）。 */

const book = (over: Partial<ShelfBook>): ShelfBook => ({
  bookKey: 'k', sourceId: 's', title: '书', addedAt: 1,
  progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
  ...over,
} as ShelfBook)

describe('filterShelfBooks（筛选口径）', () => {
  const list = [
    book({ bookKey: 'a', progress: { chapterIndex: 5, offsetRatio: 0.2, updatedAt: 1 } }),
    book({ bookKey: 'b' }),
    book({ bookKey: 'c', sourceId: '__local__', progress: { chapterIndex: 2, offsetRatio: 0, updatedAt: 1 } }),
  ]
  it('all 不过滤', () => expect(filterShelfBooks(list, 'all')).toEqual(list))
  it('reading = 有实质进度（含本地书）', () => expect(filterShelfBooks(list, 'reading').map((b) => b.bookKey)).toEqual(['a', 'c']))
  it('unread = 进度全零', () => expect(filterShelfBooks(list, 'unread').map((b) => b.bookKey)).toEqual(['b']))
  it('local = LOCAL_SOURCE_ID（正交维度）', () => expect(filterShelfBooks(list, 'local').map((b) => b.bookKey)).toEqual(['c']))
  it('不过滤时不共享底层数组（防调用方误改原书架态）', () => {
    const out = filterShelfBooks(list, 'all')
    out.pop()
    expect(list).toHaveLength(3)
  })
})

describe('shelfCardMeta（卡片元信息与百分比唯一算式）', () => {
  it('在读有总数 → 章数/百分比（chapterIndex 0 基、展示 1 基）', () => {
    expect(shelfCardMeta(book({ progress: { chapterIndex: 720, offsetRatio: 0, updatedAt: 1 }, totalChapters: 1162 })))
      .toEqual({ text: '721/1162 章 · 62%', pct: 62 })
  })
  it('未读 → 未开始 + 总章数；pct null（简约版口径：未读不出进度条）', () => {
    expect(shelfCardMeta(book({ totalChapters: 1280 }))).toEqual({ text: '未开始 · 1280 章', pct: null })
  })
  it('未读且缺总数 → 未开始', () => {
    expect(shelfCardMeta(book({}))).toEqual({ text: '未开始', pct: null })
  })
  it('本地 → 本地 TXT 文案点名', () => {
    expect(shelfCardMeta(book({ sourceId: '__local__', progress: { chapterIndex: 20, offsetRatio: 0.5, updatedAt: 1 }, totalChapters: 700 })))
      .toEqual({ text: '本地 TXT · 3%', pct: 3 })
  })
  it('缺 totalChapters → pct null，文案退章节文字', () => {
    expect(shelfCardMeta(book({ progress: { chapterIndex: 3, offsetRatio: 0, updatedAt: 1 } })))
      .toEqual({ text: '读至第 4 章', pct: null })
  })
  it('比例 clamp 到 100（存档越界不显示 120%）', () => {
    expect(shelfCardMeta(book({ progress: { chapterIndex: 990, offsetRatio: 0.9, updatedAt: 1 }, totalChapters: 900 })).pct).toBe(100)
  })
})

describe('coverTintClass（首字色块四档派生）', () => {
  it('空标题回 t1（与 coverFallbackChar「书」同防）', () => expect(coverTintClass('')).toBe('novel-cover-t1'))
  it('只认首字符档位、恒定可复现', () => {
    expect(coverTintClass('诡秘之主')).toBe(coverTintClass('诡秘之主'))
  })
  it('不同书可落不同档（四档真的被用起来）', () => {
    const set = new Set(['诡秘之主', '剑来', '赤心巡天', '道诡异仙', '深海余烬'].map(coverTintClass))
    expect(set.size).toBeGreaterThan(1)
  })
})

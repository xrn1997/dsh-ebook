import { describe, expect, it } from 'vitest'
import { nextChapterIndex, nextLoadTarget } from '../../src/client/reader-load.js'

describe('nextChapterIndex（前向流水：下一个要加载的章）', () => {
  it('目录未就绪（空表）→ -1', () => {
    expect(nextChapterIndex([])).toBe(-1)
  })
  it('全未载 → 从头开始（0）', () => {
    expect(nextChapterIndex([null, null, null])).toBe(0)
  })
  it('已载前缀 → 最大已载下标 + 1', () => {
    expect(nextChapterIndex(['a', 'b', null, null])).toBe(2)
  })
  it('目录直达跳章 → 从跳到的章继续往下读（不回头补前面的洞）', () => {
    expect(nextChapterIndex([null, null, 'c', null, null])).toBe(3)
  })
  it('读尽 → -1', () => {
    expect(nextChapterIndex(['a', 'b'])).toBe(-1)
  })
})

describe('nextLoadTarget（哨兵进预取区才加载——旧口径 scrollHeight/scrollTop 已废弃）', () => {
  // 旧口径 `scrollHeight - scrollTop - clientHeight < 2 屏` 在宿主内容撑高布局下两个方向都失效：
  // 阅读器容器 clientHeight == scrollHeight（97541 实测）永不滚动；912 章占位块又把 scrollHeight
  // 撑成整本书高（97579 实测）→ 真滚了也只在全书末尾触发。新签名里没有 scrollHeight/scrollTop，
  // 判据换成「未载边界哨兵相对视口的 top」——类型层面就堵住旧口径回归。
  const chapters = ['a', null, null]

  it('在途有章 → 不加载（单在途槽，滚动风暴去重）', () => {
    expect(nextLoadTarget(0, 500, { chapters, loading: 1 })).toBeNull()
  })
  it('读尽 → 不加载', () => {
    expect(nextLoadTarget(0, 500, { chapters: ['a', 'b'], loading: null })).toBeNull()
  })
  it('哨兵进「视口底 +2 屏」→ 加载首个未载章；恰好 2 屏 → 不加载（严格小于，口径与历史实现同源）', () => {
    expect(nextLoadTarget(1500, 500, { chapters, loading: null })).toBeNull()   // 1500 == 500 * (1+2)
    expect(nextLoadTarget(1499, 500, { chapters, loading: null })).toBe(1)
    expect(nextLoadTarget(0, 500, { chapters, loading: null })).toBe(1)         // 哨兵在视口顶：首屏没填满，继续补
  })
  it('已滚过哨兵（top 为负）→ 仍然加载（用户跳过头了，把正文跟上）', () => {
    expect(nextLoadTarget(-2000, 500, { chapters, loading: null })).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { followPages } from '../../src/services/pagination.js'
import { listValue } from '../../src/services/bridge.js'
import { evaluate } from '../../src/engine/index.js'
import type { Page, SubRuleEval } from '../../src/services/bridge.js'

// 3 页站点：/p1 /p2 /p3，每页 2 条目 + a.next；/p3 无 next
function site(): Map<string, Page> {
  const pages = new Map<string, Page>()
  const p = (n: number, next: string | null) => {
    pages.set(`https://x.com/p${n}`, {
      url: `https://x.com/p${n}`,
      body: `<div class="it">条${n}A</div><div class="it">条${n}B</div>` + (next ? `<a class="next" href="${next}">下一</a>` : ''),
    })
  }
  p(1, '/p2'); p(2, '/p3'); p(3, null)
  return pages
}
const subEval: SubRuleEval = async (rule, ctx, facet) => evaluate(rule, { html: ctx.html, baseUrl: ctx.baseUrl }, facet)
const extract = async (page: Page): Promise<string[]> =>
  listValue(await evaluate('@css:.it@textNodes', { html: page.body, baseUrl: page.url }, 'toc'), 'toc') ?? []
const keyOf = (s: string) => s

describe('followPages 三闸', () => {
  it('正常跟完 3 页 → end，items 不重复', async () => {
    const pages = site()
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf, { maxPages: 10 }, 'toc', subEval)
    expect(r.pages).toBe(3)
    expect(r.stoppedBy).toBe('end')
    expect(r.items).toEqual(['条1A', '条1B', '条2A', '条2B', '条3A', '条3B'])
  })
  it('回环（越界页重复首页内容）→ loop 停，重复条目不收', async () => {
    const pages = site()
    pages.set('https://x.com/p3', { url: 'https://x.com/p3', body: pages.get('https://x.com/p1')!.body }) // p3 复制 p1 内容
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf, { maxPages: 10 }, 'toc', subEval)
    expect(r.stoppedBy).toBe('loop')
    expect(r.pages).toBe(3)
    expect(new Set(r.items).size).toBe(r.items.length)
  })
  it('零新增（空页）→ zero-new 停，不追 next', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/p1', { url: 'https://x.com/p1', body: '<div class="it">A</div><a class="next" href="/p2">x</a>' }],
      ['https://x.com/p2', { url: 'https://x.com/p2', body: '<p>这页没有任何条目</p><a class="next" href="/p3">x</a>' }],
      ['https://x.com/p3', { url: 'https://x.com/p3', body: '<div class="it">C</div>' }],
    ])
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf, { maxPages: 10 }, 'toc', subEval)
    expect(r.stoppedBy).toBe('zero-new')
    expect(r.pages).toBe(2) // p2 空页即停，不进 p3
    expect(r.items).toEqual(['A'])
  })
  it('上限闸 cap', async () => {
    const mk = (n: number): Page => ({ url: `https://x.com/p${n}`, body: `<div class="it">条${n}</div><a class="next" href="/p${n + 1}">x</a>` })
    const r = await followPages('https://x.com/p1', async (u) => Promise.resolve(mk(Number(u.match(/p(\d+)/)![1]))), extract, 'tag.a.next@href', keyOf, { maxPages: 3 }, 'toc', subEval)
    expect(r.stoppedBy).toBe('cap')
    expect(r.pages).toBe(3)
    expect(r.items).toEqual(['条1', '条2', '条3'])
  })
  // 末页「下一页」常指向下一章（笔趣阁 `.prenext`）——跟进去就把后续章节拼成本章（实测 50 章 / 35846 字）
  it('串章闸：候选下一页不属本章 → chapter-boundary 停，不取那一页', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/c/1', { url: 'https://x.com/c/1', body: '<div class="it">本章正文</div><a class="next" href="/c/2">下一章</a>' }],
      ['https://x.com/c/2', { url: 'https://x.com/c/2', body: '<div class="it">下一章正文</div>' }],
    ])
    const r = await followPages('https://x.com/c/1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      { maxPages: 10, sameChapterBase: 'https://x.com/c/1' }, 'content', subEval)
    expect(r.stoppedBy).toBe('chapter-boundary')
    expect(r.pages).toBe(1)
    expect(r.items).toEqual(['本章正文'])
  })
  it('串章闸：本章续页（前缀形态）照常跟进', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/c/1.html', { url: 'https://x.com/c/1.html', body: '<div class="it">第一页</div><a class="next" href="/c/1p2.html">下一页</a>' }],
      ['https://x.com/c/1p2.html', { url: 'https://x.com/c/1p2.html', body: '<div class="it">第二页</div>' }],
    ])
    const r = await followPages('https://x.com/c/1.html', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      { maxPages: 10, sameChapterBase: 'https://x.com/c/1.html' }, 'content', subEval)
    expect(r.stoppedBy).toBe('end')
    expect(r.pages).toBe(2)
    expect(r.items).toEqual(['第一页', '第二页'])
  })
})

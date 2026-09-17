import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const BASE = 'https://s.com'
const SEARCH_HTML = '<html><body><div class="b"><a href="/book/1/">斗罗</a><span>唐家</span></div></body></html>'
const TOC_HTML = '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a href="/c/2.html">第二章</a></div><a class="tn" href="/toc2.html">下一页</a></body></html>'
const TOC2_HTML = '<html><body><div class="b ch"><a href="/c/3.html">第三章</a></div></body></html>'
const CONTENT1_HTML = '<html><body><div id="content">正文一<p></p><p>  第二段  </p><p></p><p></p><p>第三段</p></div><a class="np" href="/c/1p2.html">下页</a></body></html>'
const CONTENT1P2_HTML = '<html><body><div id="content">尾段</div></body></html>'

const rawSource = {
  bookSourceName: 'S', bookSourceUrl: BASE,
  searchUrl: `${BASE}/search?q={{key}}`,
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
  ruleTocUrl: `${BASE}/book/1/`,
  ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href',
  ruleContent: '@css:#content@textNodes', nextTocUrl: 'tag.a.tn@href', nextPageUrl: 'tag.a.np@href',
}

let svc: ReadingService, base: string, close: () => Promise<void>
let tocFetches = 0, contentFetches = 0
beforeAll(async () => {
  const dir = await makeTempDir('novel-apird-')
  const htmlOf = (u: string): string | null => {
    if (u.includes('/c/1.html')) { contentFetches++; return CONTENT1_HTML }
    if (u.includes('/c/1p2.html')) { contentFetches++; return CONTENT1P2_HTML }
    if (u.includes('/book/1/')) { tocFetches++; return TOC_HTML }
    if (u.includes('/toc2.html')) { tocFetches++; return TOC2_HTML }
    if (u.includes('/search')) return SEARCH_HTML
    return null
  }
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const body = htmlOf(String(input))
      return body === null
        ? new Response('', { status: 404 })
        : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }) as any,
  }))
  await svc.importOne(rawSource)
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

describe('reading/shelf 面', () => {
  it('GET /search 缺 keyword → 400；正常 → 分组', async () => {
    expect((await fetch(`${base}/novel-api/search?keyword=`)).status).toBe(400)
    const r = await fetch(`${base}/novel-api/search?keyword=${encodeURIComponent('斗罗')}`)
    const { value: groups } = await r.json() as any
    expect(groups[0].hits[0]).toMatchObject({ title: '斗罗', author: '唐家' })
  })
  it('GET /book → BookDetail 字段齐全（Miss 字段 null 不报错）', async () => {
    const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const r = await fetch(`${base}/novel-api/book?sourceId=${src[0].id}&url=${encodeURIComponent(`${BASE}/book/1/`)}`)
    const { value: detail } = await r.json() as any
    expect(detail).toHaveProperty('intro')
    expect(detail.intro).toBeNull()          // 该源没写 ruleIntro → 如实 null
  })
  it('GET /toc 两页合并；refresh=1 绕缓存', async () => {
    const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const u = `${base}/novel-api/toc?sourceId=${src[0].id}&url=${encodeURIComponent(`${BASE}/book/1/`)}`
    const { value: toc } = await (await fetch(u)).json() as any
    expect(toc.map((c: any) => c.name)).toEqual(['第一章', '第二章', '第三章'])
    const before = tocFetches
    await fetch(`${u}&refresh=1`)
    expect(tocFetches).toBeGreaterThan(before)
  })
  it('GET /chapter 缺 index → 400；正常 → 文本；越界 → 404', async () => {
    const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const u = `${base}/novel-api/chapter?sourceId=${src[0].id}&url=${encodeURIComponent(`${BASE}/book/1/`)}`
    expect((await fetch(u)).status).toBe(400)
    const { value: text } = await (await fetch(`${u}&index=0`)).json() as any
    expect(text).toBe('正文一\n第二段\n第三段\n尾段')
    expect((await fetch(`${u}&index=99`)).status).toBe(404)
  })
  it('shelf 三路由 + key 的 URI 编码往返', async () => {
    const bookKey = 'https://s.com/book/1/?a=1&b=2'
    const put = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(bookKey)}`, {
      method: 'PUT', body: JSON.stringify({ sourceId: 's1', title: '斗罗大陆' }),
    })
    expect((await put.json() as any).value).toMatchObject({ bookKey, title: '斗罗大陆' })
    const put2 = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(bookKey)}`, {
      method: 'PUT', body: JSON.stringify({ progress: { chapterIndex: 2, offsetRatio: 0.33 } }),
    })
    expect((await put2.json() as any).value.progress).toMatchObject({ chapterIndex: 2, offsetRatio: 0.33 })
    const { value: list } = await (await fetch(`${base}/novel-api/shelf`)).json() as any
    expect(list).toHaveLength(1)
    const del = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(bookKey)}`, { method: 'DELETE' })
    expect((await del.json() as any).value.removed).toBe(true)
    expect((await (await fetch(`${base}/novel-api/shelf`)).json() as any).value).toHaveLength(0)
  })
  it('shelf PUT 无 title 且无 progress → 400；书不在架 → 400', async () => {
    expect((await fetch(`${base}/novel-api/shelf/${encodeURIComponent('k')}`, { method: 'PUT', body: '{}' })).status).toBe(400)
    expect((await fetch(`${base}/novel-api/shelf/${encodeURIComponent('k2')}`, {
      method: 'PUT', body: JSON.stringify({ progress: { chapterIndex: 1, offsetRatio: 0 } }),
    })).status).toBe(400)
  })
  it('加书缺/空 sourceId → 400（此前静默兜底成空串，写入 200、读取才炸）', async () => {
    for (const body of [{ title: 'T' }, { title: 'T', sourceId: '' }, { title: 'T', sourceId: 7 }]) {
      const r = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(`k-${JSON.stringify(body)}`)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
  })
  it('progress 值域：Infinity/负数/非整数 → 400（此前写盘成 null）', async () => {
    const key = encodeURIComponent(`${BASE}/book/1/progress-dom`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 's1', title: 'T' }),
    })
    // 用原始 JSON 文本：JSON.parse('1e999') === Infinity（JSON.stringify 会把它变成 null，测不到 isFinite）
    for (const p of [
      '{"chapterIndex":1,"offsetRatio":1e999}',
      '{"chapterIndex":-1,"offsetRatio":0}',
      '{"chapterIndex":1.5,"offsetRatio":0}',
      '{"chapterIndex":1,"offsetRatio":1.5}',
    ]) {
      const r = await fetch(`${base}/novel-api/shelf/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: `{"progress":${p}}`,
      })
      expect(r.status, p).toBe(400)
    }
  })
  it('shelf PUT 识别 totalChapters', async () => {
    const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    await fetch(`${base}/novel-api/shelf/${encodeURIComponent(`${BASE}/book/1/`)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: src[0].id, title: '斗罗', totalChapters: 88 }),
    })
    const { value: shelf2 } = await (await fetch(`${base}/novel-api/shelf`)).json() as any
    expect(shelf2.find((b: any) => b.title === '斗罗')?.totalChapters).toBe(88)
  })
  it('title-only PUT 再加架不抹 totalChapters（spread 不带键才保值）', async () => {
    const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const key = encodeURIComponent(`${BASE}/book/1/`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: src[0].id, title: '斗罗', totalChapters: 88 }),
    })
    // 二次 PUT 只带 title（ReaderView/卡片分支真实形态）→ 合并语义必须保住已有的 88
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: src[0].id, title: '斗罗' }),
    })
    const { value: shelf3 } = await (await fetch(`${base}/novel-api/shelf`)).json() as any
    expect(shelf3.find((b: any) => b.title === '斗罗')?.totalChapters).toBe(88)
  })
  it('回写 PUT {sourceId,title,totalChapters} 往返：sourceId+四兄弟元数据全保、totalChapters 更新', async () => {
    // 真实链路：详情页全量 PUT 加架 → ReaderView 首读回写（只带 sourceId/title/totalChapters）
    const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const key = encodeURIComponent(`${BASE}/book/1/rt`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: src[0].id, title: '回写书', author: '作者甲', coverUrl: 'https://s.com/c.jpg',
        intro: '简介文', lastChapterName: '第9章',
      }),
    })
    // 回写体 = ReaderView 修复后的真形态（无 author/coverUrl/intro/lastChapterName 键）
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: src[0].id, title: '回写书', totalChapters: 66 }),
    })
    const { value: shelf } = await (await fetch(`${base}/novel-api/shelf`)).json() as any
    const b = shelf.find((x: any) => x.bookKey === `${BASE}/book/1/rt`)
    expect(b).toMatchObject({
      sourceId: src[0].id, author: '作者甲', coverUrl: 'https://s.com/c.jpg',
      intro: '简介文', lastChapterName: '第9章', totalChapters: 66,
    })
  })
  // ── patch 形态：ReaderView 回写只发 totalChapters 一个字段 ──────────────────
  it('PUT {patch:{totalChapters}} 单字段回写：其余元数据全保（shelfBody.patch → Shelf.update）', async () => {
    const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const key = encodeURIComponent(`${BASE}/book/1/patch`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: src[0].id, title: '补丁书', author: '作者乙', intro: '简介乙' }),
    })
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { totalChapters: 99 } }),      // ReaderView 真形态：一个字段
    })
    const { value: shelf } = await (await fetch(`${base}/novel-api/shelf`)).json() as any
    expect(shelf.find((x: any) => x.bookKey === `${BASE}/book/1/patch`)).toMatchObject({
      title: '补丁书', author: '作者乙', intro: '简介乙', totalChapters: 99,
    })
  })
  it('PUT {patch} 对不在架的书 → 400（不静默造书）', async () => {
    const r = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(`${BASE}/book/1/nopatch`)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { totalChapters: 1 } }),
    })
    expect(r.status).toBe(400)
  })
  it('GET /book 缺参 → 400；未知 sourceId → 404', async () => {
    expect((await fetch(`${base}/novel-api/book?url=x`)).status).toBe(400)
    const r = await fetch(`${base}/novel-api/book?sourceId=nope&url=${encodeURIComponent(`${BASE}/book/1/`)}`)
    expect(r.status).toBe(404)
  })
})

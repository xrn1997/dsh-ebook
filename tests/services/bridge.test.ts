import { describe, expect, it } from 'vitest'
import { firstValue, listValue, extractItems, absUrl, engineFetch } from '../../src/services/bridge.js'

describe('值规约', () => {
  it('miss → null（源没这条信息）', () => {
    expect(firstValue({ kind: 'miss', detail: 'x' })).toBeNull()
    expect(listValue({ kind: 'miss', detail: 'x' })).toBeNull()
  })
  it('value/list/matches 规约', () => {
    expect(firstValue({ kind: 'value', text: 'a' })).toBe('a')
    expect(firstValue({ kind: 'list', items: ['a', 'b'] })).toBe('a\nb')
    expect(firstValue({ kind: 'matches', rows: [['t1', 'x'], ['t2']] })).toBe('t1\nt2')
    expect(listValue({ kind: 'value', text: 'a' })).toEqual(['a'])
    expect(listValue({ kind: 'matches', rows: [['t1'], ['t2']] })).toEqual(['t1', 't2'])
  })
})

describe('extractItems（列表页条目）', () => {
  it('nodes → 逐节点 HTML 片段（条目数不压平）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const html = '<ul><li class="item"><a>甲</a></li><li class="item"><a>乙</a></li></ul>'
    const v = await evaluate('@css:li.item', { html }, 'search')
    const items = extractItems(v)
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('甲')
    expect(items[1]).toContain('乙')
  })
  it('miss → 空数组（搜索零结果合法）', () => {
    expect(extractItems({ kind: 'miss', detail: 'x' })).toEqual([])
  })
})

describe('absUrl', () => {
  const base = 'https://m.a.com/book/1/'
  it('相对/绝对/协议相对', () => {
    expect(absUrl('/2/3.html', base)).toBe('https://m.a.com/2/3.html')
    expect(absUrl('4.html', base)).toBe('https://m.a.com/book/1/4.html')
    expect(absUrl('https://x.com/a', base)).toBe('https://x.com/a')
    expect(absUrl('//cdn.com/c.png', base)).toBe('https://cdn.com/c.png')
  })
  it('javascript:/空 → null（不猜）', () => {
    expect(absUrl('javascript:void(0)', base)).toBeNull()
    expect(absUrl(null, base)).toBeNull()
    expect(absUrl('', base)).toBeNull()
  })
})

describe('engineFetch（java.ajax 出口）', () => {
  // legado 语义：java.ajax 的 URL 可带 `url,{json}` 请求选项（AnalyzeUrl 考证）。
  // 此前不解析选项、整串当 URL 发出 → 站点 403/404（真实崩溃案例：@js 脚本拼
  // `search.php,{'body':...}` 传给 java.ajax）。
  const mkFetcher = () => {
    const seen: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = []
    return {
      seen,
      fetcher: {
        fetchPage: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
          seen.push({ url, init })
          return { raw: Buffer.from('{"ok":true}'), finalUrl: url, contentType: 'application/json', charset: 'utf-8' }
        },
      } as never,
    }
  }

  it('URL 带 url,{json} 选项（单引号 JSON）→ 剥离选项、按 POST 发正确端点', async () => {
    const { seen, fetcher } = mkFetcher()
    const f = engineFetch(fetcher, { 'User-Agent': 'DEFAULT' })
    await f("https://m.a.com/search.php,{'body':'k={{key}}','method':'POST','headers':{'User-Agent':'UA-TEST'}}")
    expect(seen[0].url).toBe('https://m.a.com/search.php')
    expect(seen[0].init?.method).toBe('POST')
    expect(seen[0].init?.headers?.['User-Agent']).toBe('UA-TEST')
    expect(seen[0].init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('body 内 {{key}} 经 vars 插值（encodeURIComponent 口径）', async () => {
    const { seen, fetcher } = mkFetcher()
    const f = engineFetch(fetcher, {}, { key: '凡人' })
    await f("https://m.a.com/s,{'body':'k={{key}}','method':'POST'}")
    expect(seen[0].init?.body).toBe('k=%E5%87%A1%E4%BA%BA')
  })

  it('无选项的纯 URL → 直接 GET（行为不变）', async () => {
    const { seen, fetcher } = mkFetcher()
    const f = engineFetch(fetcher, { 'User-Agent': 'UA' })
    await f('https://m.a.com/plain.json')
    expect(seen[0].url).toBe('https://m.a.com/plain.json')
    expect(seen[0].init?.method).toBeUndefined()
  })
})

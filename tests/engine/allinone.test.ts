import { describe, expect, it } from 'vitest'
import { evalAllInOne } from '../../src/engine/allinone.js'
import { RuleEvalError } from '../../src/engine/errors.js'

const L = { segmentIndex: 0, segmentRaw: ':pattern' }

const tocHtml = `<a href="/read/30394_20940996.html">第一章 初入江湖</a>
<a href="/read/30394_20940997.html">第二章 风云再起</a>`

describe('AllInOne 整页正则（二维产物不压平）', () => {
  it('二维捕获：条目×组，不压平', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: 'href="(/read[^"]*html)">([^<]*)', flags: '' },
      tocHtml, L, 'toc')
    expect(v).toEqual({ kind: 'matches', rows: [
      ['/read/30394_20940996.html', '第一章 初入江湖'],
      ['/read/30394_20940997.html', '第二章 风云再起'],
    ] })
  })

  it('零匹配 → 空 list（不是 miss）', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: 'href="(/zzz[^"]*)">([^<]*)', flags: '' }, tocHtml, L, 'toc')
    expect(v).toEqual({ kind: 'list', items: [] })
  })

  // 正则必须用 \d+_\d+ 才拿到完整 id：\d{4}_\d+ 只匹配到 '0394_20940996'（前半截断）
  // 本用例保留原意（无捕获组 → 单元素行 [full]）
  it('无捕获组 → 单元素行', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: '\\d+_\\d+', flags: '' }, tocHtml, L, 'toc')
    expect((v as any).rows).toEqual([['30394_20940996'], ['30394_20940997']])
  })

  it('零长度匹配强制前进，不死循环', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: 'x*', flags: '' }, 'axb', L, 'content')
    expect((v as any).rows).toEqual([[''], ['x'], [''], ['']])
  })

  it('非法正则 → RuleEvalError（hits=0，段级定位，消息含坏 pattern）', () => {
    expect(() => evalAllInOne({ kind: 'allinone', pattern: '(', flags: '' }, tocHtml, L, 'toc')).toThrow(RuleEvalError)
    try {
      evalAllInOne({ kind: 'allinone', pattern: '(', flags: '' }, tocHtml, L, 'toc')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(RuleEvalError)
      expect((e as RuleEvalError).hits).toBe(0)
      expect((e as Error).message).toContain('(')
    }
  })
})

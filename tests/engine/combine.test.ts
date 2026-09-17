import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import { combine, reverseList } from '../../src/engine/combine.js'
import type { EngineValue } from '../../src/engine/types.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'

describe('|| 首个非空', () => {
  it('miss 跳过，空 list 跳过', () => {
    expect(combine([{ kind: 'miss', detail: 'x' }, { kind: 'value', text: '乙' }], 'first'))
      .toEqual({ kind: 'value', text: '乙' })
    expect(combine([{ kind: 'list', items: [] }, { kind: 'value', text: '乙' }], 'first'))
      .toEqual({ kind: 'value', text: '乙' })
  })
  it('全 miss → miss', () => {
    expect(combine([{ kind: 'miss', detail: 'a' }, { kind: 'miss', detail: 'b' }], 'first').kind).toBe('miss')
  })
  it('全空 list（无 miss）→ 空 list，不折叠成 miss', () => {
    expect(combine([{ kind: 'list', items: [] }, { kind: 'list', items: [] }], 'first'))
      .toEqual({ kind: 'list', items: [] })
  })
  it('matches 透传', () => {
    const m: EngineValue = { kind: 'matches', rows: [['a', 'b']] }
    expect(combine([{ kind: 'miss', detail: 'x' }, m], 'first')).toEqual(m)
  })
})

describe('&& 合并', () => {
  it('全 value → \\n 连接的 value', () => {
    expect(combine([{ kind: 'value', text: '甲' }, { kind: 'value', text: '乙' }], 'and'))
      .toEqual({ kind: 'value', text: '甲\n乙' })
  })
  it('混合 → 摊平 list；miss 分支静默跳过（legado 语义：&& 是多规则取并集，非全命中）', () => {
    expect(combine([{ kind: 'value', text: '甲' }, { kind: 'list', items: ['乙', '丙'] }], 'and'))
      .toEqual({ kind: 'list', items: ['甲', '乙', '丙'] })
    // legado AnalyzeByJSoup：`if (!temp.isNullOrEmpty()) results.add(temp)`——miss 分支不参与合并
    expect(combine([{ kind: 'value', text: '甲' }, { kind: 'miss', detail: 'x' }], 'and'))
      .toEqual({ kind: 'value', text: '甲' })
  })
  it('全 miss/空 → miss', () => {
    expect(combine([{ kind: 'miss', detail: 'a' }, { kind: 'list', items: [] }], 'and').kind).toBe('miss')
  })
  it('matches 透传（不摊平、不丢弃）', () => {
    const m: EngineValue = { kind: 'matches', rows: [['a', 'b']] }
    expect(combine([m], 'and')).toEqual(m)
  })
  it('多分支混合 matches → UnsupportedRuleError（宁炸不猜，不得用 Miss 冒充失败）', () => {
    const m: EngineValue = { kind: 'matches', rows: [['a', 'b']] }
    expect(() => combine([m, m], 'and')).toThrow(UnsupportedRuleError)
  })
})

describe('%% 交叉合并', () => {
  it('三个列表轮流取第 i 个，最长列表剩余项按次序追加', () => {
    // 注意：期望值必须含 'b2x'——「最长列表剩余项按次序追加」的语义（双重循环到 maxLen）
    const v = combine([
      { kind: 'list', items: ['a1', 'a2'] },
      { kind: 'list', items: ['b1', 'b2', 'b2x'] },
      { kind: 'list', items: ['c1'] },
    ], 'zip')
    expect(v).toEqual({ kind: 'list', items: ['a1', 'b1', 'c1', 'a2', 'b2', 'b2x'] })
  })
  it('miss 分支静默跳过（legado 语义：results 只收非空分支）', () => {
    expect(combine([{ kind: 'list', items: ['a'] }, { kind: 'miss', detail: 'x' }], 'zip'))
      .toEqual({ kind: 'list', items: ['a'] })
  })
  it('全 miss → miss', () => {
    expect(combine([{ kind: 'miss', detail: 'a' }, { kind: 'miss', detail: 'b' }], 'zip').kind).toBe('miss')
  })
  it('zip 遇 matches（AllInOne 2-D）→ UnsupportedRuleError（宁炸不猜）', () => {
    expect(() => combine([{ kind: 'list', items: ['a'] }, { kind: 'matches', rows: [['x']] }], 'zip'))
      .toThrow(UnsupportedRuleError)
  })
})

describe('反序', () => {
  it('list 反序，value 不动', () => {
    expect(reverseList({ kind: 'list', items: ['a', 'b', 'c'] })).toEqual({ kind: 'list', items: ['c', 'b', 'a'] })
    expect(reverseList({ kind: 'value', text: 'x' })).toEqual({ kind: 'value', text: 'x' })
  })
  it('matches 行反序，miss 原样', () => {
    expect(reverseList({ kind: 'matches', rows: [['a'], ['b']] }))
      .toEqual({ kind: 'matches', rows: [['b'], ['a']] })
    expect(reverseList({ kind: 'miss', detail: 'x' })).toEqual({ kind: 'miss', detail: 'x' })
  })
  it('nodes 节点集反序', () => {
    const $ = cheerio.load('<ul><li id="a">一</li><li id="b">二</li><li id="c">三</li></ul>')
    const v = reverseList({ kind: 'nodes', nodes: $('li') })
    expect(v.kind).toBe('nodes')
    if (v.kind !== 'nodes') return
    expect(v.nodes.toArray().map((n) => (n as Element).attribs.id)).toEqual(['c', 'b', 'a'])
  })
})

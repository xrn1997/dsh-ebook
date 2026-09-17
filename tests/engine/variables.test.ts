import { describe, expect, it } from 'vitest'
import { evalGetVar, evalPut } from '../../src/engine/variables.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'
import type { EvalContext } from '../../src/engine/types.js'

const L = { segmentIndex: 0, segmentRaw: '@put' }

describe('@put / @get 变量', () => {
  it('put 普通值 + get 读取', () => {
    const ctx: EvalContext = { vars: {} }
    evalPut('{bid:"123"}', ctx, L, 'detail')
    expect(ctx.vars).toEqual({ bid: '123' })
    expect(evalGetVar('bid', ctx)).toEqual({ kind: 'value', text: '123' })
  })

  it('put 多个键：顶层逗号切分，引号内逗号不切', () => {
    const ctx: EvalContext = { vars: {} }
    evalPut('{ name:"凡人修仙传,全本" , author:"忘语" }', ctx, L, 'search')
    expect(ctx.vars).toEqual({ name: '凡人修仙传,全本', author: '忘语' })
  })

  it('put 值为 JSONPath 规则 → 对 ctx.json 求值', () => {
    const ctx: EvalContext = { vars: {}, json: { _id: '9527' } }
    evalPut('{bid:"$._id"}', ctx, L, 'detail')
    expect(ctx.vars!.bid).toBe('9527')
  })

  it('@json: 剥前缀后按 JSONPath 对 ctx.json 求值', () => {
    const ctx: EvalContext = { vars: {}, json: { book: { name: '凡人' } } }
    evalPut('{title:"@json:$.book.name"}', ctx, L, 'detail')
    expect(ctx.vars!.title).toBe('凡人')
  })

  it('$.. 递归下降仍被路由到 JSONPath（$. 前缀覆盖；末段集合型 → List → 抛错）', () => {
    const ctx: EvalContext = { vars: {}, json: { a: { bid: '42' } } }
    expect(() => evalPut('{bid:"$..bid"}', ctx, L, 'detail')).toThrow(UnsupportedRuleError)
    expect(ctx.vars).toEqual({}) // 不是把 '$..bid' 当普通字符串存
  })

  it('不以 $. 开头的 $ 值（裸 $、$99）是普通字符串，原样存', () => {
    // 钉死：JSONPath 判定只看 `$.` 前缀——裸 `$` 绝不能被当成「整个文档」求值
    const ctx: EvalContext = { vars: {}, json: { secret: 'whole-doc' } }
    evalPut('{a:"$", b:"$99"}', ctx, L, 'detail')
    expect(ctx.vars).toEqual({ a: '$', b: '$99' })
  })

  it('JSONPath 求值 Miss → 变量不落盘，get 仍 Miss', () => {
    const ctx: EvalContext = { vars: {}, json: {} }
    evalPut('{nope:"$..ghost"}', ctx, L, 'detail')
    expect(ctx.vars).toEqual({})
    expect(evalGetVar('nope', ctx).kind).toBe('miss')
  })

  it('JSONPath 求值结果为列表 → v1 变量只存单值，抛 UnsupportedRuleError', () => {
    const ctx: EvalContext = { vars: {}, json: { chapters: ['c1', 'c2'] } }
    expect(() => evalPut('{cs:"$.chapters[*]"}', ctx, L, 'detail')).toThrow(UnsupportedRuleError)
  })

  it('get 未 put → Miss（detail 提到键名）', () => {
    const res = evalGetVar('nope', { vars: {} })
    expect(res.kind).toBe('miss')
    if (res.kind === 'miss') expect(res.detail).toContain('nope')
  })

  it('get 时 vars 未初始化 → Miss；put 时 vars 未初始化 → 自动建', () => {
    expect(evalGetVar('a', {}).kind).toBe('miss')
    const ctx: EvalContext = {}
    evalPut('{a:"1"}', ctx, L, 'detail')
    expect(ctx.vars).toEqual({ a: '1' })
  })

  it('非法 pairs 形态 → UnsupportedRuleError', () => {
    expect(() => evalPut('not-json-ish', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError)
    expect(() => evalPut('{bid:"//xpath"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError)
    expect(() => evalPut('{bid:"1"', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError) // 缺结尾 }
    expect(() => evalPut('{"1"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError) // 键后缺冒号
    expect(() => evalPut('{:"1"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError) // 键名为空
    expect(() => evalPut('{a:"1" b:"2"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError) // 顶层缺逗号
  })

  it('值不带引号 → UnsupportedRuleError「@put 值必须带引号」', () => {
    expect(() => evalPut('{bid:$._id}', { vars: {} }, L, 'detail')).toThrow(/@put 值必须带引号/)
  })

  it('值引号未闭合 → UnsupportedRuleError', () => {
    expect(() => evalPut('{bid:"123}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError)
  })

  it('XPath 等其他规则形态的值 → UnsupportedRuleError（宁炸不猜）', () => {
    expect(() => evalPut('{bid:"//div/@data"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError)
    expect(() => evalPut('{t:"@css:.title@text"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError)
    expect(() => evalPut('{x:"<js>1+1</js>"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError)
    expect(() => evalPut('{x:"#{1+1}"}', { vars: {} }, L, 'detail')).toThrow(UnsupportedRuleError)
  })

  it('某键抛错时整个 put 不落盘（无半截写入）', () => {
    const ctx: EvalContext = { vars: {} }
    expect(() => evalPut('{a:"1", b:"//x"}', ctx, L, 'detail')).toThrow(UnsupportedRuleError)
    expect(ctx.vars).toEqual({})
  })

  it('空 pairs {} → 不写任何变量，正常返回', () => {
    const ctx: EvalContext = { vars: {} }
    expect(evalPut('{}', ctx, L, 'detail').kind).toBe('value')
    expect(ctx.vars).toEqual({})
  })
})

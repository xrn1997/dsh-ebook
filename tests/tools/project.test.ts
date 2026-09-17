import { describe, expect, it } from 'vitest'
import { project } from '../../src/tools/project.js'

/** 缺键投影（tools/project.ts）：null/undefined 整键省略——lossless-JSON 约束的单点纪律 */
describe('project', () => {
  it('对象：null/undefined 字段整键省略，其余原值', () => {
    expect(project({ a: 1, b: null, c: undefined, d: 'x' })).toEqual({ a: 1, d: 'x' })
    expect('b' in project({ a: 1, b: null })).toBe(false)
  })
  it('递归：嵌套对象与数组都投影', () => {
    const out = project({ groups: [{ id: 'g', error: undefined, hits: [{ title: 't', author: null }] }] })
    expect(out).toEqual({ groups: [{ id: 'g', hits: [{ title: 't' }] }] })
  })
  it('原值/空串/0/false 不动（只丢「没值」，不丢「空值」）', () => {
    expect(project({ s: '', n: 0, f: false })).toEqual({ s: '', n: 0, f: false })
  })
  it('投影产物可安全过 JSON（无 undefined 键——harness lossless 校验一票否决点）', () => {
    const out = project({ a: undefined, b: { c: undefined, d: 1 } })
    expect(JSON.parse(JSON.stringify(out))).toEqual({ b: { d: 1 } })
  })
  it('不改输入对象（纯投影，非就地清洗）', () => {
    const input = { a: null, b: 1 }
    project(input)
    expect(input).toEqual({ a: null, b: 1 })
  })
})

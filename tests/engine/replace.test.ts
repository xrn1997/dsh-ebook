import { describe, expect, it } from 'vitest'
import { applyReplaces } from '../../src/engine/replace.js'
import type { EngineValue, ReplaceStep } from '../../src/engine/types.js'
import { RuleEvalError } from '../../src/engine/errors.js'

const step = (pattern: string, replacement = '', flags = ''): ReplaceStep => ({ pattern, flags, replacement })

describe('applyReplaces 净化（## 替换）', () => {
  it('净化：循环替换，逐项作用', () => {
    const v = { kind: 'list', items: ['第一 章　起 点', '第二章 转折'] } as const
    expect(applyReplaces(v as unknown as EngineValue, [step('\\s+', '', 'g')], false))
      .toEqual({ kind: 'list', items: ['第一章起点', '第二章转折'] })
  })

  it('净化作用于 Value.text', () => {
    expect(applyReplaces({ kind: 'value', text: 'a b c' }, [step('\\s+', '-')], false))
      .toEqual({ kind: 'value', text: 'a-b-c' })
  })

  it('OnlyOne 只替换第一个匹配（逐项各自首配）', () => {
    const v = { kind: 'value', text: 'aXaX' } as const
    expect(applyReplaces(v as unknown as EngineValue, [step('X', '-')], true))
      .toEqual({ kind: 'value', text: 'a-aX' })
    const list = { kind: 'list', items: ['aXaX', 'bXbX'] } as const
    expect(applyReplaces(list as unknown as EngineValue, [step('X', '-')], true))
      .toEqual({ kind: 'list', items: ['a-aX', 'b-bX'] })
  })

  it('OnlyOne 下即使 flags 带 g 也被剥掉（只配首处）', () => {
    expect(applyReplaces({ kind: 'value', text: 'aXaX' }, [step('X', '-', 'g')], true))
      .toEqual({ kind: 'value', text: 'a-aX' })
  })

  it('多个替换步按顺序串联（前一步结果喂给下一步）', () => {
    expect(applyReplaces({ kind: 'value', text: 'a,b;c' }, [step(',', ';'), step('c', 'd')], false))
      .toEqual({ kind: 'value', text: 'a;b;d' })
  })

  it('替换串 $1 等用 JS 原生捕获组语义', () => {
    expect(applyReplaces({ kind: 'value', text: '第3章' }, [step('第(\\d+)章', 'Chapter $1')], false))
      .toEqual({ kind: 'value', text: 'Chapter 3' })
  })

  it('替换结果变空串的项保留（净化不删条目）', () => {
    expect(applyReplaces({ kind: 'list', items: ['abc', 'xyz'] }, [step('abc')], false))
      .toEqual({ kind: 'list', items: ['', 'xyz'] })
    expect(applyReplaces({ kind: 'value', text: 'abc' }, [step('abc')], false))
      .toEqual({ kind: 'value', text: '' })
  })

  it('replaces 为空 → 原值透传（同引用）', () => {
    const v: EngineValue = { kind: 'value', text: 'x' }
    expect(applyReplaces(v, [], false)).toBe(v)
  })

  it('miss / matches 透传（不替换、同引用）', () => {
    const m = { kind: 'miss', detail: 'd' } as const
    expect(applyReplaces(m as unknown as EngineValue, [step('a', 'b')], false)).toBe(m)
    const matches = { kind: 'matches', rows: [['a', 'b']] } as const
    expect(applyReplaces(matches as unknown as EngineValue, [step('a', 'b')], false)).toBe(matches)
  })

  it('非法正则 → RuleEvalError 且带段定位（hits=0，段定位指向该替换步）', () => {
    expect(() => applyReplaces({ kind: 'value', text: 'x' }, [step('a', 'b'), step('(', 'y')], false))
      .toThrow(RuleEvalError)
    try {
      applyReplaces({ kind: 'value', text: 'x' }, [step('a', 'b'), step('(', 'y')], false)
      expect.unreachable('应当抛出 RuleEvalError')
    } catch (e) {
      expect(e).toBeInstanceOf(RuleEvalError)
      const err = e as RuleEvalError
      expect(err.hits).toBe(0)
      expect(err.segmentIndex).toBe(1) // 第 2 个替换步
      expect(err.message).toContain('(') // 消息提及非法 pattern
    }
  })
})

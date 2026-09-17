import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import { evalCss } from '../../src/engine/css.js'
import { RuleEvalError } from '../../src/engine/errors.js'

// fixture 与 select.test.ts 同源：3 个 li.clearfix（第 3 个 odd），章节名在 a.name 内
const html = `<div id="wrap"><ul class="list">
  <li class="item clearfix"><a class="name" href="/b/1">第一章 起点</a><span class="date">2024-01-01</span></li>
  <li class="item clearfix"><a class="name" href="/b/2">第二章 转折</a><span class="date">2024-01-02</span></li>
  <li class="item odd clearfix"><a class="name" href="/b/3">第三章 高潮</a><span class="date">2024-01-03</span></li>
</ul><div id="meta"><p>作者：甲</p><p>字数：10万</p></div></div>`

const $ = cheerio.load(html)
const root = () => $('#wrap') as any
const seg = (selector: string) => ({ kind: 'css', selector }) as const
const loc = (i: number, raw: string) => ({ segmentIndex: i, segmentRaw: raw })

describe('@css 选择器段', () => {
  it('命中 3 个 li.clearfix → nodes', () => {
    const v = evalCss(seg('li.clearfix'), $, root(), loc(0, '@css:li.clearfix'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(3)
  })
  it('零命中 .nope → Miss（detail 提到零命中与选择器）', () => {
    const v = evalCss(seg('.nope'), $, root(), loc(0, '@css:.nope'), 'toc')
    expect(v.kind).toBe('miss')
    expect((v as any).detail).toContain('零命中')
    expect((v as any).detail).toContain('.nope')
  })
  it('在当前节点集内 find，不做全文档查找', () => {
    const meta = $('#meta') as any
    const v = evalCss(seg('li'), $, meta, loc(0, '@css:li'), 'toc')
    expect(v.kind).toBe('miss') // li 都在 #meta 之外
    const inWrap = evalCss(seg('li'), $, root(), loc(1, '@css:li'), 'toc')
    expect((inWrap as any).nodes).toHaveLength(3)
  })
  it('子组合器 + 伪类：.list>li:nth-child(2) → 1 个且是第二章', () => {
    const v = evalCss(seg('.list>li:nth-child(2)'), $, root(), loc(0, '@css:.list>li:nth-child(2)'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(1)
    expect($(v.kind === 'nodes' ? (v.nodes as any)[0] : null).find('a').attr('href')).toBe('/b/2')
  })
  it('属性伪类：.name[href$="2"] → 1 个', () => {
    const v = evalCss(seg('.name[href$="2"]'), $, root(), loc(0, '@css:.name[href$="2"]'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(1)
    expect((v as any).nodes.text()).toBe('第二章 转折')
  })
  it('命中产物可用 $ 继续消费（nodes 重建）', () => {
    const v = evalCss(seg('.date'), $, root(), loc(0, '@css:.date'), 'toc') as any
    expect(v.nodes).toHaveLength(3)
    expect(v.nodes.eq(0).text()).toBe('2024-01-01')
  })
  it('非法选择器 @css:@@@ → RuleEvalError（message 提到选择器，hits=0，段级定位）', () => {
    let caught: unknown
    try {
      evalCss(seg('@@@'), $, root(), loc(2, '@css:@@@'), 'toc')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RuleEvalError)
    const err = caught as RuleEvalError
    expect(err.message).toContain('选择器')
    expect(err.message).toContain('@@@')
    expect(err.hits).toBe(0)
    expect(err.segmentIndex).toBe(2)
    expect(err.facet).toBe('toc')
  })
})

describe('! 排除语法（求值层：官方「!是排除，0 是第1个，负数为倒数」）', () => {
  const segEx = (selector: string, exclude: number[]) => ({ kind: 'css', selector, exclude }) as any
  it('li!0 → 3 个 li 去掉第 1 个 = 2 个', () => {
    const v = evalCss(segEx('li', [0]), $, root(), loc(0, 'li!0'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(2)
    expect((v as any).nodes.eq(0).text()).toContain('第二章')
  })
  it('负数排除：li!-1 去掉最后一个', () => {
    const v = evalCss(segEx('li', [-1]), $, root(), loc(0, 'li!-1'), 'toc')
    expect((v as any).nodes).toHaveLength(2)
    expect((v as any).nodes.eq(1).text()).toContain('第二章')
  })
  it('多值排除 li!0:2 → 只剩第 2 个', () => {
    const v = evalCss(segEx('li', [0, 2]), $, root(), loc(0, 'li!0:2'), 'toc')
    expect((v as any).nodes).toHaveLength(1)
    expect((v as any).nodes.text()).toContain('第二章')
  })
  it('排除后为空 → Miss（不是崩溃）', () => {
    const v = evalCss(segEx('li', [0, 1, 2]), $, root(), loc(0, 'li!0:1:2'), 'toc')
    expect(v.kind).toBe('miss')
  })
})

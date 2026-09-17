import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/evaluate.js'
import { reducePicked } from '../../src/engine/select.js'

/**
 * 取值规约单点：修复两处已发生的分叉——
 * ① 切片裁空（原集合非空）：default 选择段给 List{[]}、css 段给 Miss——同语义两种结果。
 *   裁决：**选择段四态一律「选择失败」语义（Miss）**——List{[]} 不是节点集，中链必抛
 *   「上游结果不是节点集」（真实源 `class.x.5:9@text` 直接炸），css 的 Miss 穿透才符合
 *   legado「空选择 → 下游取值为 null」口径。
 * ② 取值段的 `!` 排除被静默丢弃：parse 对 text/href… 也挂 exclude（`parse.ts` 里 `if (exclude !== undefined) seg.exclude = exclude`），
 *   但 getValue 从不读——`@text!0` 的排除无声消失（违反宁炸不猜）。修复：exclude 生效。
 * 取值段「取到空 → 空 List」（合法零条目，区别于 Miss）保持不变——那是取值规约不是选择规约。
 */

const HTML = '<html><body><ul><li class="item"><a href="/1">章一</a></li><li class="item"><a href="/2">章二</a></li><li class="item"><a href="/3">章三</a></li></ul></body></html>'
const ctx = { html: HTML, baseUrl: 'https://a.com' }

describe('reducePicked（选择结果后处理单点：exclude → index → 空态裁决）', () => {
  const arr = [1, 2, 3]
  it('四态：zero / excluded / oob / sliced 全部是「选择失败」', () => {
    expect(reducePicked<number>([], undefined, null)).toEqual({ ok: false, reason: 'zero' })
    expect(reducePicked(arr, [0, 1, 2], null)).toEqual({ ok: false, reason: 'excluded' })
    expect(reducePicked(arr, undefined, { kind: 'index', value: 9 })).toEqual({ ok: false, reason: 'oob' })
    expect(reducePicked(arr, undefined, { kind: 'slice', from: 5, to: 9 })).toEqual({ ok: false, reason: 'sliced' })
  })
  it('命中：exclude 先过滤、index 再取位（legado 先排除再取位）', () => {
    expect(reducePicked(arr, [0], null)).toEqual({ ok: true, items: [2, 3] })
    expect(reducePicked(arr, undefined, { kind: 'index', value: 0 })).toEqual({ ok: true, items: [1] })
  })
})

describe('选择段空态裁决统一（分叉①修复）', () => {
  it('default 选择段切片裁空 → Miss 穿透（此前 List{[]} 中链必抛「不是节点集」）', async () => {
    const v = await evaluate('class.item.5:9@text', ctx, 'toc')
    expect(v.kind).toBe('miss')
  })
  it('css 段（隐式回落）切片裁空 → Miss——与 default 同口径', async () => {
    const v = await evaluate('li.item.5:9@text', ctx, 'toc')
    expect(v.kind).toBe('miss')
  })
  it('选择段切片裁空在链尾同样 Miss（不再伪装合法空列表）', async () => {
    const v = await evaluate('class.item.5:9', ctx, 'toc')
    expect(v.kind).toBe('miss')
  })
})

describe('取值段 ! 排除生效（分叉②修复：此前静默丢参）', () => {
  it('@text!0：去掉第 1 个元素的取值', async () => {
    const v = await evaluate('class.item@text!0', ctx, 'toc')
    expect(v).toEqual({ kind: 'list', items: ['章二', '章三'] })
  })
  it('@href!-1：负数排除从尾数', async () => {
    const v = await evaluate('@css:.item a@href!-1', ctx, 'toc')
    expect(v).toEqual({ kind: 'list', items: ['/1', '/2'] })
  })
  it('排除全部 → Miss（选择失败语义，不是空 List）', async () => {
    const v = await evaluate('class.item@text!0:1:2', ctx, 'toc')
    expect(v.kind).toBe('miss')
  })
  it('取值段「取到空」仍是合法空 List（取值规约不变）', async () => {
    const v = await evaluate('class.e@text', { html: '<html><body><ul><li class="e"><i> </i></li></ul></body></html>' }, 'toc')
    expect(v).toEqual({ kind: 'list', items: [] })
  })
})

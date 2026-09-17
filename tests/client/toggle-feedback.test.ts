import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTransient, transientEntries } from '../../src/client/transient.js'
import { rowAnchorOf, toggleFeedback } from '../../src/client/toggle-feedback.js'

/**
 * 闪烁回归锁：单源启停**不许**进 pending 泳道。
 *
 * 这条断言就是那次闪烁的病因：泳道挂载 = 状态条插入流内 → 设置区整块 +35px 再弹回
 * （真机逐帧实测：`rowShiftPx` 35，往返 13~20ms ≈ 1 帧）。谁把 `inFlight()` 改回 pushPending，
 * 这里立刻变红。
 */
describe('单源启停反馈策略（闪烁回归锁）', () => {
  beforeEach(resetTransient)
  afterEach(resetTransient)

  it('在途零占用：inFlight() 不产生任何条目（挂泳道 = 顶动布局 = 闪）', () => {
    const fb = toggleFeedback(rowAnchorOf('a1'))
    fb.inFlight()
    expect(transientEntries()).toEqual([])
  })

  it('成功静默：settle(true) 后依旧零条目（开关翻转即反馈，少而淡）', () => {
    const fb = toggleFeedback(rowAnchorOf('a1'))
    fb.inFlight()
    fb.settle(true)
    expect(transientEntries()).toEqual([])
  })

  it('失败进 error 泳道：带行锚点（供「定位 →」跳转 + 行内 .row-err）', () => {
    const fb = toggleFeedback(rowAnchorOf('a1'))
    fb.inFlight()
    fb.settle(false, '「A」启停失败：boom')
    const [err] = transientEntries()
    expect(transientEntries()).toHaveLength(1)
    expect(err.kind).toBe('error')
    expect(err.label).toBe('「A」启停失败：boom')
    expect(err.anchor).toBe('[data-novel-source-row="a1"]')
  })

  it('多次在途（连点多个开关）也不累积条目', () => {
    for (const id of ['a1', 'a2', 'a3']) toggleFeedback(rowAnchorOf(id)).inFlight()
    expect(transientEntries()).toEqual([])
  })

  it('rowAnchorOf：行锚点选择器与行内 data 属性同源', () => {
    expect(rowAnchorOf('x9')).toBe('[data-novel-source-row="x9"]')
  })
})

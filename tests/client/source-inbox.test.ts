import { describe, expect, it } from 'vitest'
import { inboxIds, sourceInbox } from '../../src/client/source-inbox.js'
import type { SourcePublic } from '../../src/client/views/types.js'

const src = (over: Partial<SourcePublic> & { id: string }): SourcePublic => ({
  name: over.id, baseUrl: `https://${over.id}.com`, enabled: true, groups: [],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  ...over,
})

describe('sourceInbox（书源待办派生）', () => {
  it('broken/unverified 按状态分集合；健康源不进待办，停用源只看 status 照旧归队', () => {
    const sources = [
      src({ id: 'ok1', status: 'verified' }),
      src({ id: 'b1', status: 'broken' }),
      src({ id: 'u1', status: 'unverified' }),
      // 停用只摘掉「参与聚合搜索」，不改状态归属（2026-09 裁定：停用 ≠ 免验）——
      // 停用的坏源仍进坏源集合、停用的未验证仍进未验证集合（一键验证覆盖得到它）
      src({ id: 'off-ok', status: 'verified', enabled: false }),
      src({ id: 'off-broken', status: 'broken', enabled: false }),
      src({ id: 'off-unverified', status: 'unverified', enabled: false }),
    ]
    const inbox = sourceInbox(sources)
    expect(inbox.broken.map((s) => s.id)).toEqual(['b1', 'off-broken'])
    expect(inbox.unverified.map((s) => s.id)).toEqual(['u1', 'off-unverified'])
  })

  it('空库/全健康 → 两个集合都空（视图据此渲染「✓ 全部源状态良好」空态）', () => {
    expect(sourceInbox([])).toEqual({ broken: [], unverified: [] })
    expect(sourceInbox([src({ id: 'a' }), src({ id: 'b', enabled: false })])).toEqual({ broken: [], unverified: [] })
  })

  it('inboxIds：处置动作的作用对象 id 集（点击时快照语义的取数口）', () => {
    const inbox = sourceInbox([src({ id: 'b1', status: 'broken' }), src({ id: 'u1', status: 'unverified' })])
    expect(inboxIds(inbox, 'broken')).toEqual(['b1'])
    expect(inboxIds(inbox, 'unverified')).toEqual(['u1'])
  })
})

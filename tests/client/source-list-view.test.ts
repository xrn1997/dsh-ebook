import { describe, expect, it } from 'vitest'
import { deriveSourceListView } from '../../src/client/source-list-view.js'
import type { SourceListUi } from '../../src/client/source-list.js'
import type { SourcePublic } from '../../src/client/views/types.js'

/**
 * 源列表派生 view-model 的纯函数单测：
 * SettingsSourceList 曾把这些计算写成组件体闭包——零直接覆盖。抽纯函数后逐条钉语义，
 * 尤其是「分组选项集不随状态过滤缩水」这个语义决策（改了它过滤器就不可组合）。
 */

const src = (over: Partial<SourcePublic> & { id: string }): SourcePublic => ({
  name: over.id, baseUrl: `https://${over.id}.com`, enabled: true, groups: [],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  ...over,
})

/** 默认现场：无过滤、无选择、浏览态 */
const ui0: SourceListUi = { query: '', statusFilter: 'all', groupFilter: '', selection: [], editMode: false }
const ui = (over: Partial<SourceListUi>): SourceListUi => ({ ...ui0, ...over })

// 五源覆盖三个状态 × 启停两态 × 带/不带登录态 × 带图标/无图标分组
const ALL: SourcePublic[] = [
  src({ id: 'a', status: 'verified', groups: ['快速 ⚡', '小说'], hasAuth: true }),
  src({ id: 'b', status: 'broken', groups: ['快速 ⚡'] }),
  src({ id: 'c', status: 'unverified', groups: ['小说'] }),
  src({ id: 'd', status: 'verified', enabled: false, groups: [] }),
  src({ id: 'e', status: 'broken', enabled: false, groups: ['小说'], hasAuth: true }),
]

describe('deriveSourceListView：chip 计数', () => {
  it("'all' = 全库长度；其余按维过滤计数（disabled 维是 enabled 布尔，与 status 正交）", () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect(vm.chipCount('all')).toBe(5)
    expect(vm.chipCount('verified')).toBe(2)      // a、d
    expect(vm.chipCount('broken')).toBe(2)        // b、e
    expect(vm.chipCount('unverified')).toBe(1)    // c
    expect(vm.chipCount('disabled')).toBe(2)      // d（verified 但停用）、e（broken 但停用）
  })

  it('chip 计数不受现场过滤影响（计的是全库分布，不是当前过滤结果）', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'broken', query: 'a', groupFilter: '小说' }), 100)
    expect(vm.chipCount('all')).toBe(5)
    expect(vm.chipCount('verified')).toBe(2)
  })
})

describe('deriveSourceListView：分组选项集（语义决策：不随状态过滤缩水）', () => {
  it('默认现场：全库聚合计数，插入序遍历', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect([...vm.groupCounts.entries()]).toEqual([['快速 ⚡', 2], ['小说', 3]])
  })

  it('状态 chip 过滤后选项集不缩水——选了「坏源」，非坏源分组仍在下拉里（可组合过滤）', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'broken' }), 100)
    expect(vm.filtered.map((s) => s.id)).toEqual(['b', 'e'])   // 过滤管线生效
    expect([...vm.groupCounts.entries()]).toEqual([['快速 ⚡', 2], ['小说', 3]])  // 选项集纹丝不动
  })

  it('文本过滤同样不影响选项集', () => {
    const vm = deriveSourceListView(ALL, ui({ query: 'a' }), 100)
    expect(vm.filtered.map((s) => s.id)).toEqual(['a'])
    expect(vm.groupCounts.size).toBe(2)
  })

  it('ungroupedCount：groups 为空的源数（「未分组」伪选项计数，同口径不随过滤缩水）', () => {
    expect(deriveSourceListView(ALL, ui0, 100).ungroupedCount).toBe(1)                    // d
    expect(deriveSourceListView(ALL, ui({ statusFilter: 'broken' }), 100).ungroupedCount).toBe(1)
    expect(deriveSourceListView([src({ id: 'y', groups: ['小说'] })], ui0, 100).ungroupedCount).toBe(0)
  })
})

describe('deriveSourceListView：分组图例', () => {
  it('只列带图标组，形态 `icon = 组名`，\\n 连接（无图标组在格内显示全名，无需图例）', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect(vm.groupLegend).toBe('⚡ = 快速 ⚡')
  })

  it('全库无图标组 → 空串（视图据此不渲染「?」）', () => {
    const vm = deriveSourceListView([src({ id: 'x', groups: ['小说'] })], ui0, 100)
    expect(vm.groupLegend).toBe('')
  })
})

describe('deriveSourceListView：过滤管线（状态 → 分组 → 文本，交集）', () => {
  it('三维叠加取交集', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'broken', groupFilter: '小说', query: 'e' }), 100)
    expect(vm.filtered.map((s) => s.id)).toEqual(['e'])
  })

  it('shown = filtered 的前 limit 条（前端分页，加载更多只加 limit）', () => {
    const vm = deriveSourceListView(ALL, ui0, 2)
    expect(vm.shown.map((s) => s.id)).toEqual(['a', 'b'])
    expect(vm.filtered).toHaveLength(5)
  })
})

describe('deriveSourceListView：选中态派生', () => {
  it('selected 是选中集 Set 形态；全选 = 过滤结果非空且全在选中集', () => {
    const vm = deriveSourceListView(ALL, ui({ selection: ['a', 'b', 'c', 'd', 'e'], editMode: true }), 100)
    expect(vm.selected.has('a')).toBe(true)
    expect(vm.allFilteredSelected).toBe(true)
  })

  it('部分选中 → false；过滤结果为空 → 恒 false（全选 0 个没有语义）', () => {
    expect(deriveSourceListView(ALL, ui({ selection: ['a'] }), 100).allFilteredSelected).toBe(false)
    expect(deriveSourceListView(ALL, ui({ query: '不存在' }), 100).allFilteredSelected).toBe(false)
    expect(deriveSourceListView([], ui0, 100).allFilteredSelected).toBe(false)
  })

  it('全选判定以**过滤结果**为作用域：chip 缩小过滤面后，选满过滤结果即全选', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'broken', selection: ['b', 'e'] }), 100)
    expect(vm.allFilteredSelected).toBe(true)
  })
})

describe('deriveSourceListView：登录态计数与快捷批量 id 集', () => {
  it('authCountOf 只数作用域内带 hasAuth 的源；ids 外的不计', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect(vm.authCountOf(['a', 'b'])).toBe(1)
    expect(vm.authCountOf(['b', 'c', 'd'])).toBe(0)
    expect(vm.authCountOf(['a', 'e'])).toBe(2)
    expect(vm.authCountOf([])).toBe(0)
  })

  it('brokenIds / unverifiedIds 按状态收集（危险区两个快捷批量入口的作用对象）', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect(vm.brokenIds).toEqual(['b', 'e'])
    expect(vm.unverifiedIds).toEqual(['c'])
  })
})

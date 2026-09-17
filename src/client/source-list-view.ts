import { collectIdsByStatus } from './source-batch.js'
import { filterByGroup, filterByStatus, filterSources, groupIcon } from './source-list.js'
import type { SourceListUi, StatusFilter } from './source-list.js'
import type { SourcePublic } from './views/types.js'

/**
 * 源列表的派生 view-model：SettingsSourceList 曾把 chip 计数 / 分组图例 /
 * 过滤管线 / 选中态派生写成组件体里的闭包——纯计算被 React 接线包住，只能整壳 jsdom 间接验
 * （417 行的最大 view、零纯函数覆盖）。本 module 把「全库源列表 + UI 现场 → 展示所需派生值」
 * 收成一个纯函数：输入相同输出必相同，无 React、无 store、无 IO——逻辑可单测，视图只做接线。
 *
 * 语义决策钉在此处（单测钉死，别在视图里悄悄改）：
 * - 分组下拉选项集按**全库**聚合计数，不随状态/文本过滤缩水——筛选器的选项集要稳定，
 *   否则选了「坏源」chip 后非坏源的分组就从下拉里消失，没法组合过滤；
 * - 'disabled' 维度是 enabled 布尔而非 status（停用与坏源正交）——沿用 source-list.ts 口径；
 * - 状态 chip 的 'all' 计数 = 全库长度，其余 = 按维过滤后的长度。
 * 口径详见 `docs/design/client.md`。
 */

/** 派生结果：视图渲染所需的全部纯计算值（函数成员是「按维计数/按 ids 计数」两个查询口） */
export interface SourceListViewModel {
  /** 过滤管线结果：状态 chip → 分组 → 文本（交集，顺序即应用序） */
  filtered: SourcePublic[]
  /** 前端分页截取（limit 条） */
  shown: SourcePublic[]
  /** 选中集的 Set 形态（行级 selected 判定用） */
  selected: Set<string>
  /** 状态 chip 计数（'all' = 全库长度） */
  chipCount: (f: StatusFilter) => number
  /** 分组下拉选项集：全库聚合计数（**不随状态/文本过滤缩水**，见文件头注） */
  groupCounts: Map<string, number>
  /** 「未分组」伪选项的计数：groups 为空的源数（全库聚合，口径与 groupCounts 一致） */
  ungroupedCount: number
  /** 表头「?」图例：`icon = 组名`（只列带图标组——无图标组在格内显示全名，无需图例），\n 连接 */
  groupLegend: string
  /** 批量删除确认条的登录态点名计数（ids 里带 hasAuth 的源数） */
  authCountOf: (ids: string[]) => number
  /** 过滤结果全选态（编辑态表头复选框）；空过滤结果恒 false（全选 0 个没有语义） */
  allFilteredSelected: boolean
  /** 快捷批量入口的作用对象：全部坏源 / 全部未验证源 id（点击时快照，不随列表变化重算） */
  brokenIds: string[]
  unverifiedIds: string[]
}

/** 纯派生：全库源列表 + UI 现场 + 分页 limit → 展示派生值。零副作用。 */
export function deriveSourceListView(all: SourcePublic[], ui: SourceListUi, limit: number): SourceListViewModel {
  const filtered = filterSources(filterByGroup(filterByStatus(all, ui.statusFilter), ui.groupFilter), ui.query)
  const shown = filtered.slice(0, limit)
  const selected = new Set(ui.selection)
  // 分组选项集：全库聚合（不走任何过滤管线——选项集稳定，见文件头注）
  const groupCounts = new Map<string, number>()
  for (const s of all) for (const g of s.groups) groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1)
  const ungroupedCount = all.filter((s) => s.groups.length === 0).length
  const legend: string[] = []
  for (const g of groupCounts.keys()) {
    const icon = groupIcon(g)
    if (icon !== null) legend.push(`${icon} = ${g}`)
  }
  return {
    filtered,
    shown,
    selected,
    chipCount: (f) => (f === 'all' ? all.length : filterByStatus(all, f).length),
    groupCounts,
    ungroupedCount,
    groupLegend: legend.join('\n'),
    authCountOf: (ids) => {
      const idSet = new Set(ids)
      return all.filter((s) => idSet.has(s.id) && s.hasAuth).length
    },
    allFilteredSelected: filtered.length > 0 && filtered.every((s) => selected.has(s.id)),
    brokenIds: collectIdsByStatus(all, 'broken'),
    unverifiedIds: collectIdsByStatus(all, 'unverified'),
  }
}

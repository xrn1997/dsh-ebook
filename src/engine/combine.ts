import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { EngineValue } from './types.js'
import { UnsupportedRuleError } from './errors.js'

export type Combinator = 'first' | 'and' | 'zip'

/**
 * 组合符求值（语义钉死；`&&`/`%%` 口径按 legado-with-MD3 AnalyzeByJSoup/JSonPath 考证修正）：
 * - `first`（||）：左→右返回首个既非 Miss 也非空 List 的分支；空 List 视为「未取到」继续向右；
 *   全 Miss → Miss；全空 List（无 Miss）→ 空 List（不折叠成 Miss——Miss≠空 List）。
 * - `and`（&&）：legado 语义是「合并所有非空分支」——**空/Miss 分支静默跳过**（`if (!temp.isNullOrEmpty()) results.add`），
 *   非空结果按序拼接（Value 间 `\n` 连接，List 摊平）；全空/Miss → Miss。
 *   （此前实现为「任一 Miss → 整体 Miss」——与 legado 相反，`&&` 的本意是多规则取并集兜底。）
 * - `zip`（%%）：交叉合并——第 i 轮按分支顺序各取第 i 项（legado：以首个非空结果的长度为驱动，
 *   空分支同样静默跳过）。遇 Matches（AllInOne 2-D）→ UnsupportedRuleError（宁炸不猜）。
 * Matches 在 `first` 下透传原样；`and` 下单分支透传、多分支混合 → UnsupportedRuleError（与 `%%` 同款宁炸不猜）。
 * loc 可选：and/zip 抛错时带上规则定位（由求值链传入）。
 *
 * 设计文档：docs/design/engine.md
 */
export function combine(
  values: EngineValue[],
  combinator: Combinator,
  loc?: { facet?: 'search' | 'detail' | 'toc' | 'content' | 'explore' | 'rule'; segmentIndex: number; segmentRaw: string },
): EngineValue {
  switch (combinator) {
    case 'first': return combineFirst(values)
    case 'and': return combineAnd(values, loc)
    case 'zip': return combineZip(values, loc)
  }
}

function combineFirst(values: EngineValue[]): EngineValue {
  let allMiss = true
  for (const v of values) {
    if (v.kind === 'miss') continue
    allMiss = false
    if (v.kind === 'list' && v.items.length === 0) continue // 空 List = 未取到，继续向右
    return v
  }
  if (allMiss && values.length > 0) return { kind: 'miss', detail: '所有分支未命中' }
  return { kind: 'list', items: [] } // 全空 List 或零分支 → 空 List（保留 Miss≠空 List 区分）
}

/** legado `&&`：跳过 Miss/空 List 分支，其余按序合并（全 Value → `\n` 连接单 Value；混合 → 摊平 List） */
function combineAnd(
  values: EngineValue[],
  loc?: { facet?: 'search' | 'detail' | 'toc' | 'content' | 'explore' | 'rule'; segmentIndex: number; segmentRaw: string },
): EngineValue {
  const kept = values.filter((v) => v.kind !== 'miss' && !(v.kind === 'list' && v.items.length === 0))
  if (kept.length === 0) return { kind: 'miss', detail: '&& 所有分支未命中' }
  // Matches（2-D）无法摊平进 1-D——单分支透传原样；多分支混合无意义。
  // 与 `%%` 同款宁炸不猜：曾用 Miss 冒充失败（同文件另一组合符的做法就是抛），
  // 「用 Miss 冒充失败」正是本仓定为最高罪的那条。
  if (kept.some((v) => v.kind === 'matches')) {
    if (kept.length === 1) return kept[0]
    throw new UnsupportedRuleError('&& 混合 AllInOne(matches) 二维结果无法合并', {
      facet: loc?.facet ?? 'rule',
      segmentIndex: loc?.segmentIndex ?? -1,
      segmentRaw: loc?.segmentRaw ?? '&&（组合符）',
    })
  }
  if (kept.every((v) => v.kind === 'value')) {
    return { kind: 'value', text: kept.map((v) => (v as { text: string }).text).join('\n') }
  }
  const items: string[] = []
  for (const v of kept) {
    if (v.kind === 'value') items.push(v.text)
    else if (v.kind === 'list') items.push(...v.items)
  }
  return { kind: 'list', items }
}

function combineZip(
  values: EngineValue[],
  loc?: { facet?: 'search' | 'detail' | 'toc' | 'content' | 'explore' | 'rule'; segmentIndex: number; segmentRaw: string },
): EngineValue {
  // legado `%%`：空/Miss 分支跳过（results 只收非空），以首个非空结果长度为交叉驱动
  const kept = values.filter((v) => v.kind !== 'miss' && !(v.kind === 'list' && v.items.length === 0))
  if (kept.length === 0) return { kind: 'miss', detail: '%% 所有分支未命中' }
  if (kept.some((v) => v.kind === 'matches')) {
    // AllInOne 2-D 结果与列表交叉取数无意义——宁炸不猜
    throw new UnsupportedRuleError('%% 交叉合并不支持 AllInOne(matches) 二维结果', {
      facet: loc?.facet ?? 'rule',
      segmentIndex: loc?.segmentIndex ?? -1,
      segmentRaw: loc?.segmentRaw ?? '%%（组合符）',
    })
  }
  // 仅 List 有意义；Value 视作单元素列表，nodes 无法摊成字符串列表（求值链应先取值）
  const lists: string[][] = kept.map((v) => (v.kind === 'list' ? v.items : v.kind === 'value' ? [v.text] : []))
  const maxLen = Math.max(0, ...lists.map((l) => l.length))
  const items: string[] = []
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i < list.length) items.push(list[i])
    }
  }
  return { kind: 'list', items }
}

/**
 * 反序：List → 项反序；Matches → 行反序；Value/Miss → 原样；
 * nodes → 节点集反序（用 Cheerio 自身 `_make` 重建选择集，保持同一文档根）。
 */
export function reverseList(v: EngineValue): EngineValue {
  switch (v.kind) {
    case 'list': return { kind: 'list', items: [...v.items].reverse() }
    case 'matches': return { kind: 'matches', rows: [...v.rows].reverse() }
    case 'nodes': {
      const reversed = v.nodes.toArray().reverse()
      return { kind: 'nodes', nodes: (v.nodes as Cheerio<AnyNode>)._make(reversed) }
    }
    default: return v // value / miss 原样
  }
}

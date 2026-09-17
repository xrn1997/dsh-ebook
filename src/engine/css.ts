import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { EngineValue, Facet, Segment, SegmentLoc } from './types.js'
import { RuleEvalError } from './errors.js'
import { reducePicked } from './select.js'

type CssSegment = Extract<Segment, { kind: 'css' }>

/**
 * @css 选择器段求值：在当前节点集内 cur.find(SEL)（不做全文档查找）。
 * - cheerio 底层选择器引擎（nwsapi/css-select）对非法选择器抛错 → 包成 RuleEvalError
 *   （hits=0，说明是选择器写错而非语法外构造）
 * - `!` 排除与位置后缀、空态裁决走 reducePicked 单点：零命中/排除空/越界/切片裁空
 *   一律 Miss（选择失败），与 default 选择段同口径——此前两处各写一份且已语义分叉。
 * css 显式形态无位置后缀（恒整集）；隐式 CSS 回落（a.0/.odd.0）可携带位置后缀，按其取位。
 */
export function evalCss(
  seg: CssSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  let picked: Cheerio<AnyNode>
  try {
    picked = cur.find(seg.selector)
  } catch (e) {
    throw new RuleEvalError(`CSS 选择器无法解析：${seg.selector}（${(e as Error).message}）`, { ...loc, facet, hits: 0 })
  }
  const reduced = reducePicked(picked.toArray(), seg.exclude, seg.index ?? null)
  if (!reduced.ok) {
    const detail =
      reduced.reason === 'zero' ? `css 选择器 ${seg.selector} 零命中`
        : reduced.reason === 'excluded' ? `css 选择器 ${seg.selector} 排除 ${JSON.stringify(seg.exclude)} 后为空`
          : reduced.reason === 'oob' ? `位置 ${JSON.stringify(seg.index)} 越界`
            : `位置 ${JSON.stringify(seg.index)} 切片裁空`
    return { kind: 'miss', detail }
  }
  return { kind: 'nodes', nodes: $(reduced.items) }
}

import type { EngineValue, Facet, Segment, SegmentLoc } from './types.js'
import { RuleEvalError } from './errors.js'

/**
 * AllInOne 整页正则（口径：二维不压平）。
 *
 * 语义钉死：
 * - 对整页文本全局扫描（自动补 `g`；已有 `g` 不重复加）。
 * - 每个匹配 → 一行 `rows`，行内是捕获组 group 1..n；
 *   无捕获组 → 单元素行 `[fullMatch]`。
 * - 产物 `rows: string[][]` 永不压平——字段映射按组号由调用方做
 *   （service/工具层用 `rows[i][n]`）。
 * - 零匹配 → `List{items:[]}`（AllInOne 整页扫不到的合法零条目，
 *   区别于段级 Miss）。
 * - 非法正则 → RuleEvalError（hits=0，段级定位，消息含坏 pattern）。
 * - `-` 反序前缀由 parse/evaluate 层处理，首 `:` 已由 parse 层剥掉，
 *   此处不参与。
 * - 零长度匹配强制 `lastIndex++` 前进，防死循环。
 */
export function evalAllInOne(
  seg: Extract<Segment, { kind: 'allinone' }>,
  page: string,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  let re: RegExp
  try {
    re = new RegExp(seg.pattern, seg.flags.includes('g') ? seg.flags : `g${seg.flags}`)
  } catch (e) {
    throw new RuleEvalError(
      `AllInOne 正则非法：${(e as Error).message}（模式: ${JSON.stringify(seg.pattern)}）`,
      { ...loc, facet, hits: 0 },
    )
  }

  const rows: string[][] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(page)) !== null) {
    rows.push(m.length > 1 ? m.slice(1) : [m[0]])
    if (m[0] === '') re.lastIndex++ // 零长度匹配强制前进，防死循环
  }
  return rows.length > 0 ? { kind: 'matches', rows } : { kind: 'list', items: [] }
}

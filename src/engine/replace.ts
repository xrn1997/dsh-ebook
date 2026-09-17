import type { EngineValue, Facet, ReplaceStep } from './types.js'
import { RuleEvalError } from './errors.js'

/**
 * `##` 替换求值（净化 + OnlyOne，语义钉死）：
 * - 净化（循环替换）：对 `Value.text` 与 `List.items` 逐项、按 `replaces` 顺序依次应用；
 * - `OnlyOne`（`###`）：每步只替换第一个匹配（`String.replace` 首配，剥掉 `g`）；
 *   非 OnlyOne：全局替换（补 `g`）。替换串 `$1` 等用 JS 原生语义；
 * - 非法正则 → `RuleEvalError`（hits=0，段定位指向该替换步，消息含坏 pattern）；
 * - `replaces` 为空 → 原值透传；`miss` / `matches` → 原样透传（不做替换）；
 * - 替换结果变空串的项**保留**（净化不删条目，「取到空」口径不适用在替换层）；
 * - `nodes` 在此层透传原样（求值链应先取值再替换）。
 */
export function applyReplaces(
  v: EngineValue,
  replaces: ReplaceStep[],
  onlyOne: boolean,
  loc?: { facet?: Facet },
): EngineValue {
  if (v.kind === 'miss' || v.kind === 'matches') return v
  if (replaces.length === 0) return v
  if (v.kind === 'nodes') return v

  // 预编译全部正则：任一步非法立即抛错（段定位指向该步），不半途替换
  const pairs = replaces.map((step, i) => {
    const flags = onlyOne
      ? step.flags.replace('g', '')
      : step.flags + (step.flags.includes('g') ? '' : 'g')
    try {
      return { re: new RegExp(step.pattern, flags), replacement: step.replacement }
    } catch {
      throw new RuleEvalError(`## 替换正则非法: ${step.pattern}`, {
        facet: loc?.facet ?? 'rule',
        segmentIndex: i,
        segmentRaw: `${step.pattern}##${step.replacement}`,
        hits: 0,
      })
    }
  })

  const runOne = (text: string): string => {
    let out = text
    for (const { re, replacement } of pairs) out = out.replace(re, replacement)
    return out
  }

  switch (v.kind) {
    case 'value': return { kind: 'value', text: runOne(v.text) }
    case 'list': return { kind: 'list', items: v.items.map(runOne) }
    default: return v
  }
}

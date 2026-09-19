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
 * - `nodes` 在此层透传原样（求值链应先取值再替换）；
 * - **插值**（legado makeUpRule 同口径）：pattern / replacement 里的 `{{点路径}}`
 *   （如 `{{chapter.title}}`、`{{book.name}}`）先按 bindings 查表替换再编译正则——
 *   真实源 `##…|{{chapter.title}}|…##` 去章标题行全靠它；查不到的保持原文字面（不猜）。
 */
export function applyReplaces(
  v: EngineValue,
  replaces: ReplaceStep[],
  onlyOne: boolean,
  loc?: { facet?: Facet },
  interp?: Record<string, string>,
): EngineValue {
  if (v.kind === 'miss' || v.kind === 'matches') return v
  if (replaces.length === 0) return v
  if (v.kind === 'nodes') return v

  // 预编译全部正则：任一步非法立即抛错（段定位指向该步），不半途替换
  const pairs = replaces.map((step, i) => {
    const flags = onlyOne
      ? step.flags.replace('g', '')
      : step.flags + (step.flags.includes('g') ? '' : 'g')
    const pattern = interpolate(step.pattern, interp)
    const replacement = interpolate(step.replacement, interp)
    try {
      return { re: new RegExp(pattern, flags), replacement }
    } catch {
      throw new RuleEvalError(`## 替换正则非法: ${pattern}`, {
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

/** `{{点路径}}` 查表插值；bindings 缺席或**自有键**查不到 → 原文保留（不猜、不炸）。
 *  只认自有键：`interp[path]` 顺原型链会让 `{{toString}}` 回报函数源码
 *  （钉子 `tests/engine/replace.test.ts` 的 `describe('interp 查表只认自有键…')`）。 */
function interpolate(s: string, interp?: Record<string, string>): string {
  if (interp === undefined || !s.includes('{{')) return s
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path: string) =>
    (Object.hasOwn(interp, path) ? interp[path] : m))
}

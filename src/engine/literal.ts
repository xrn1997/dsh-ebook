/**
 * 模板字面段（CONTEXT.md「模板字面段」）的识别与切分——构词（normalize/服务层拼串）与
 * 解析（parse/evaluate 消费）共用同一份认知，唯一实现住这里。
 *
 * legado 语义（AnalyzeRule.SourceRule.makeUpRule + getString 的 `else -> rule` 分支）：
 * 规则串里出现 `{{expr}}` 时逐段插值——expr 以 `@`/`$.`/`$[`/`//` 开头按**规则递归求值**
 * （SourceRule.isRule），否则按 **JS 表达式**求值（绑定 result/baseUrl/book/chapter/key/page…）；
 * 插值后整段不构成选择器 → 原样作为字面串产出。`{$.path}`（单括号）是 JSONPath 内嵌形态
 * （RuleAnalyzer.innerRule("{$.")——平衡括号切分）。
 *
 * 为什么单独成段：真实源大量形态是「URL 模板」型规则——`http://api/novel/{{$.novelId}}`、
 * `{{baseUrl}}catalog/`、`https://...?id={{(baseUrl.match(...)||['',''])[1]}}`——它们不是
 * 选择器也不是取值终端，按旧口径全部在解析期抛「无法识别的段类型」（实测 15+ 源）。
 */

export interface LiteralPart {
  /** text=字面文本；js=JS 表达式（沙箱求值）；rule=规则串（引擎递归求值）；jsonpath=JSONPath（单括号内嵌）；getvar=@get 变量 */
  kind: 'text' | 'js' | 'rule' | 'jsonpath' | 'getvar'
  text: string
}

/** 这一段是不是模板字面段（parse 分类判据单点） */
export function isLiteralForm(raw: string): boolean {
  if (raw.includes('{{')) return true
  if (/^https?:\/\//i.test(raw)) return true
  if (/\{\$[^{}]+\}/.test(raw)) return true // `{$.path}` 单括号 JSONPath 内嵌
  return false
}

/** `{{...}}` 平衡括号切分（引号内的花括号不计深——legado chompCodeBalanced 同口径的最小版） */
export function splitLiteral(raw: string): LiteralPart[] {
  const parts: LiteralPart[] = []
  let buf = ''
  let i = 0
  const flushText = (): void => {
    if (buf !== '') { parts.push({ kind: 'text', text: buf }); buf = '' }
  }
  while (i < raw.length) {
    // @get:{key} / @get:key 形态（legado evalPattern 同款插值点）
    if (raw.startsWith('@get:', i)) {
      let name = ''
      let j: number
      if (raw[i + 5] === '{') {
        const end = raw.indexOf('}', i + 6)
        if (end === -1) { buf += raw.slice(i); i = raw.length; continue }
        name = raw.slice(i + 6, end); j = end + 1
      } else {
        const m = /^@get:([\w.-]+)/.exec(raw.slice(i))
        if (m === null) { buf += raw[i]; i++; continue }
        name = m[1]; j = i + m[0].length
      }
      flushText(); parts.push({ kind: 'getvar', text: name }); i = j; continue
    }
    if (raw.startsWith('{{', i)) {
      // 平衡括号找 }}（内容里可能有 JS 对象/正则量化的 { }）。
      // 表达式内容 = 第二个开括号之后、到「深度 2→1 的那个闭括号」为止——
      // `{{$.x}}` 的首个 `}` 是内容终点，第二个 `}` 才闭合外层（此前把首个 `}` 并进表达式
      // → `$.x}` JSONPath 报错 / `baseUrl}` JS 语法错）
      let depth = 2
      let j = i + 2
      let quote: string | null = null
      let contentEnd = -1
      while (j < raw.length && depth > 0) {
        const ch = raw[j]
        if (quote !== null) {
          if (ch === '\\') { j += 2; continue }
          if (ch === quote) quote = null
        } else if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch
        } else if (ch === '{') {
          depth++
        } else if (ch === '}') {
          if (depth === 2) contentEnd = j
          depth--
        }
        if (depth === 0) break
        j++
      }
      if (depth !== 0 || contentEnd === -1) { buf += raw.slice(i); i = raw.length; continue } // 未闭合：按字面（不猜）
      const expr = raw.slice(i + 2, contentEnd).trim()
      flushText()
      parts.push(classifyExpr(expr))
      i = j + 1
      continue
    }
    // 单括号 JSONPath 内嵌：{$.path}
    const single = /^\{\$([^{}]+)\}/.exec(raw.slice(i))
    if (single !== null) {
      flushText(); parts.push({ kind: 'jsonpath', text: `$${single[1]}` }); i += single[0].length; continue
    }
    buf += raw[i]; i++
  }
  flushText()
  return parts
}

/** `{{expr}}` 内容分类（legado SourceRule.isRule：`@`/`$.`/`$[`/`//` 开头按规则，否则 JS） */
function classifyExpr(expr: string): LiteralPart {
  if (expr === '') return { kind: 'text', text: '' }
  if (expr.startsWith('@') || expr.startsWith('$.') || expr.startsWith('$[') || expr.startsWith('//')) {
    return { kind: 'rule', text: expr }
  }
  return { kind: 'js', text: expr }
}

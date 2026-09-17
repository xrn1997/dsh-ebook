import type { Branch, Facet, IndexSpec, ParsedRule, Segment } from './types.js'
import { UnsupportedRuleError } from './errors.js'
import { jsRegionEnd, parseTails } from './grammar.js'

/**
 * parseRule 词法流水线（纯词法：字符串 → ParsedRule AST，零 IO）。
 *
 * 切分次序（钉死）：
 *   ② 剥 ## 替换尾（含 OnlyOne ###）
 *   ③ 剥链首 - 反序前缀
 *   ① AllInOne：剥完上面两步后仍以 : 开头 → 整链是一个 allinone 段
 *   ④ 分支切分（|| / && / %%，左到右，混用抛错）
 *   ⑤⑥ 段切分与识别（globalIndex 全规则连续编号，写进错误定位）
 *   ⑦ 链尾 (jsCode) 形态与 js 末位限制
 */

// default 段白名单（选择段 + 取值段；白名单之外一律 UnsupportedRuleError——
// 含裸词（无点号简单词），解析期必炸，不留给 eval 兜底）
const KNOWN_MODES = new Set([
  'text', 'textAll', 'ownText', 'html', 'all', 'href', 'src', 'content', 'textNodes',
  'class', 'id', 'tag', 'child', 'children',
])

const COMBINATOR_TOKENS = ['||', '&&', '%%'] as const
type CombToken = (typeof COMBINATOR_TOKENS)[number]
const COMBINATOR_MAP: Record<CombToken, ParsedRule['combinator']> = {
  '||': 'first', '&&': 'and', '%%': 'zip',
}

/** 解析期共享状态：facet 用于错误面，counter 是全规则连续段号 */
interface ParseCtx { facet: Facet; counter: number }

export function parseRule(rule: string, facet: Facet = 'rule'): ParsedRule {
  // ② 剥 ## 替换尾（含 OnlyOne ###）——文法口 parseTails 单点（grammar.ts：构词与解析同属一处）
  const { chain, replaces, onlyOne } = parseTails(rule)

  // ③ - 反序前缀（只看链首，段内负索引不受影响）
  let reverse = false
  let rest = chain
  if (rest.startsWith('-')) {
    reverse = true
    rest = rest.slice(1).trimStart()
  }

  // ① AllInOne：剥完替换尾与反序前缀后仍以 : 开头 → 整链一个 allinone 段
  if (rest.startsWith(':')) {
    const segment: Segment = { kind: 'allinone', pattern: rest.slice(1), flags: '' }
    return {
      branches: [{ segments: [segment], raws: [rest] }],
      combinator: 'first', reverse, replaces, onlyOne,
    }
  }

  // 独立净化形态（## 开头）或剥空：branches 为空，求值时对 all 结果替换
  if (rest === '') {
    return { branches: [], combinator: 'first', reverse, replaces, onlyOne }
  }

  // ④ 分支切分 + 混用检测（组合符切分跳过 JS 段——@js:/<js> 内的 ||/&&/%% 是 JS 代码不是连接符）
  const parts = splitTop(rest)
  const seen = new Set(parts.slice(1).map(p => p.comb))
  if (seen.size > 1) {
    throw new UnsupportedRuleError('一条规则混用了多个连接符（|| / && / %%）', { facet, segmentIndex: 0, segmentRaw: rule })
  }
  const combinator: ParsedRule['combinator'] =
    seen.size === 1 ? COMBINATOR_MAP[[...seen][0] as CombToken] : 'first'

  // ⑤⑥ 段切分与识别
  const ctx: ParseCtx = { facet, counter: 0 }
  const branches = parts.map(p => parseBranch(p.text, ctx))
  return { branches, combinator, reverse, replaces, onlyOne }
}

// ── ④ 分支切分 ─────────────────────────────────────────────────────────

interface TopPart { text: string; comb: CombToken | null }

/** 按 || / && / %% 从左到右切分（算符不嵌套；JS 段整体跳过——块内的算符是 JS 代码不是连接符）。
 *  JS 区域探测 jsRegionEnd 现在 grammar.ts（与构词侧 withImplicitText 共用同一份认知）。 */
function splitTop(s: string): TopPart[] {
  const parts: TopPart[] = []
  let start = 0
  let pending: CombToken | null = null
  let i = 0
  while (i < s.length) {
    const jsEnd = jsRegionEnd(s, i)
    if (jsEnd !== null) { i = jsEnd; continue }
    const tok = COMBINATOR_TOKENS.find(t => s.startsWith(t, i))
    if (tok) {
      parts.push({ text: s.slice(start, i), comb: pending })
      pending = tok
      i += tok.length
      start = i
    } else {
      i++
    }
  }
  parts.push({ text: s.slice(start), comb: pending })
  return parts
}

// ── ⑤⑥ 段切分与识别 ───────────────────────────────────────────────────

/** 按 @ 切分分支段：单个 @ 是段边界；连续 @@ 是字面 @（@@ 显式声明形态——
 *  段内剥一个 @ 后按常规识别）。首个元素若是空串则跳过（链首 @ 的边界残留）。
 *  XPath 主导规则（//、.//、/、@XPath: 开头——274 条真实规则）：谓词里的 @class 与
 *  属性步 @href 不是段边界——只在 `@已知特殊前缀`（js:/css:/…）处切；
 *  切过一段后回归普通模式（混链 `//x@css:y@text` 的后续段正常切）。 */
const XPATH_HEAD = /^(@xpath:|\/\/|\.\/\/|\/)/i
const SEG_PREFIX_TOKENS = ['js:', 'css:', 'json:', 'xpath:', 'put:', 'get:', '<js>']

function splitElements(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let xpathPending = XPATH_HEAD.test(s)
  let i = 0
  while (i < s.length) {
    // JS 区域整体跳过：<js>…</js> 块内与 @js: 链尾段内的 @ 是 JS 代码，不是段界。
    // `<js>` 可出现在任意位置（真实源有 `text<js>…</js>` 无 @ 直接衔接的形态）：
    // 块起始即隐式段界——cur 先独立成段，块本身起新段；块结束若紧跟内容（非 @）同样断段。
    const jsEnd = jsRegionEnd(s, i)
    if (jsEnd !== null) {
      if (cur !== '') { out.push(cur); cur = '' }
      cur = s.slice(i, jsEnd)
      i = jsEnd
      if (i < s.length && s[i] !== '@') {
        out.push(cur)
        cur = ''
      }
      continue
    }
    if (s[i] === '@') {
      if (s[i + 1] === '@') { cur += '@'; i++; continue }
      if (xpathPending) {
        const restLow = s.slice(i + 1).toLowerCase()
        if (i > 0 && SEG_PREFIX_TOKENS.some((p) => restLow.startsWith(p))) {
          out.push(cur)
          cur = ''
          xpathPending = false // 混链：后续段回归普通 @ 切分
          i++
          continue
        }
        cur += s[i] // 谓词 @class / 属性步 @href：字面保留
        i++
        continue
      }
      out.push(cur)
      cur = ''
      i++
    } else {
      cur += s[i]
      i++
    }
  }
  out.push(cur)
  if (out[0] === '') out.shift()
  return out
}

function parseBranch(text: string, ctx: ParseCtx): Branch {
  const els = splitElements(text)
  if (els.length === 0) {
    throw new UnsupportedRuleError('空分支', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: text })
  }
  const segments: Segment[] = []
  const raws: string[] = []
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    const isLast = i === els.length - 1

    // ⑦ 链尾 (jsCode) 形态：仅对末元素、且该元素不是前缀可识别的特殊段时尝试
    const tail = isLast ? detectTailJs(el) : null
    if (tail) {
      const xSeg = classifySegment(tail.prefix, ctx)
      segments.push(xSeg)
      raws.push(tail.prefix)
      ctx.counter++
      segments.push({ kind: 'js', code: tail.code, form: 'tail' })
      raws.push(el.slice(tail.openIdx)) // 原文记 (code) 部分
      ctx.counter++
      continue
    }

    const seg = classifySegment(el, ctx)
    segments.push(seg)
    raws.push(el)
    ctx.counter++
  }
  return { segments, raws }
}

/** 前缀可直接识别的特殊段（不参与链尾 (…) 检测）——前缀大小写不敏感（真实源有 @CSS: 大写形态）。
 *  链首 @（如 @XPath:）先剥再判——否则 `@XPath:…text()` 的尾括号会被误判为链尾 js。 */
function isPrefixedSpecial(el: string): boolean {
  const s = el.startsWith('@') ? el.slice(1) : el
  const low = s.toLowerCase()
  return low.startsWith('css:') || low.startsWith('json:') || low.startsWith('js:')
    || low.startsWith('put:') || low.startsWith('get:') || low.startsWith('xpath:')
    || low.startsWith('<js>')
    || s.startsWith('$') || s.startsWith('//') || s.startsWith('.//')
}

/**
 * 链尾 (jsCode) 检测：整串形如 X(jsCode) 且 X 非空——从末尾 ) 向前找第一个
 * 能配平的 (，括号内是 js 代码，X 继续按常规切分识别。
 */
function detectTailJs(el: string): { prefix: string; code: string; openIdx: number } | null {
  if (el.length < 2 || !el.endsWith(')')) return null
  if (isPrefixedSpecial(el)) return null
  let depth = 0
  for (let i = el.length - 1; i >= 0; i--) {
    if (el[i] === ')') depth++
    else if (el[i] === '(') {
      depth--
      if (depth === 0) {
        const prefix = el.slice(0, i)
        if (prefix === '') return null // X 必须非空，否则按普通段识别（不认识就抛错）
        return { prefix, code: el.slice(i + 1, -1), openIdx: i }
      }
    }
  }
  return null
}

/** `!` 排除语法切分（官方文档：!是排除，序号用 : 隔开，0 是第1个，-1 最后一个）。
 *  只对选择段（css/default）合法；js 段代码里的 `!0`（布尔取反）在前缀识别时已先行返回，不受影响。 */
const EXCLUDE_RE = /^(.+?)!(-?\d+(?::-?\d+)*)$/

function splitExclude(el: string): { base: string; exclude: number[] | undefined } {
  const m = EXCLUDE_RE.exec(el)
  if (m === null) return { base: el, exclude: undefined }
  return { base: m[1], exclude: m[2].split(':').map(Number) }
}

function classifySegment(el: string, ctx: ParseCtx): Segment {
  // 段内前后空白修剪（真实源 `<js>…</js>\n$.[*]` 的段间换行——不 trim 的话 `.` 开头判定全失效）；
  // raws 仍记原文（错误定位不丢原文形态）
  let raw = el.trim()
  if (raw.startsWith('@')) raw = raw.slice(1) // @@ 显式声明形态：剥一个 @

  // 特殊前缀大小写不敏感（真实源有 @CSS:/@JS: 大写形态）
  const low = raw.toLowerCase()
  if (low.startsWith('css:')) {
    const { base, exclude } = splitExclude(raw.slice(4))
    return exclude === undefined ? { kind: 'css', selector: base } : { kind: 'css', selector: base, exclude }
  }
  if (low.startsWith('json:')) return { kind: 'jsonpath', path: normalizeJsonPath(raw.slice(5)) }
  if (raw.startsWith('$')) return { kind: 'jsonpath', path: raw }
  // XPath：@XPath:/@xpath: 前缀 或 //、.//、/ 开头（274 条真实规则形态）
  if (low.startsWith('xpath:')) return { kind: 'xpath', path: raw.slice(6) }
  if (raw.startsWith('//') || raw.startsWith('.//') || raw.startsWith('/')) return { kind: 'xpath', path: raw }
  if (low.startsWith('js:')) return { kind: 'js', code: raw.slice(3), form: 'at-js' }
  if (low.startsWith('put:')) return { kind: 'put', pairsRaw: raw.slice(4) }
  if (low.startsWith('get:')) return { kind: 'getvar', name: raw.slice(4) }
  if (low.startsWith('<js>')) {
    if (!raw.toLowerCase().endsWith('</js>')) {
      throw new UnsupportedRuleError('内联 js 段缺少 </js> 结束标记', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
    }
    return { kind: 'js', code: raw.slice(4, -5), form: 'inline' }
  }
  // 其余段：先切 ! 排除，再走 default 识别（含隐式 CSS 回落）
  const { base, exclude } = splitExclude(raw)
  return classifyDefault(base, exclude, el, ctx)
}

/** `Json:` 前缀路径归一：真实源有 `Json:data.list`（无 $ 前缀）形态——legado 的 JSONPath
 *  从根起算，无 $ 视为根相对路径补 `$.`（data.list → $.data.list）；@ 开头保持原样如实报错。 */
function normalizeJsonPath(path: string): string {
  const p = path.trim()
  if (p.startsWith('$') || p.startsWith('@')) return p
  return p.startsWith('[') ? `$${p}` : `$.${p}`
}

/** 常见 HTML 标签名（「元素.类」形态判定依据——首词是标签即 CSS 组合选择器） */
const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body',
  'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd',
  'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main',
  'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option',
  'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
])

/** 隐式 CSS 判定（官方简写考证：class.x≡.x、id.x≡#x；社区知识库：裸词=tag 选择器，
 *  `class.xxx@li@a@text` ≡ `.xxx li a@text`）：`#id` / `.class` 简写、裸 tag 词（li/a/div）、
 *  tag+属性（div[itemscope]）、**tag.类 组合**（li.chapter——189 条真实规则，首词是合法标签名）、
 *  **tag+伪类/组合**（a:contains(在线阅读)、li:first-child a——Jsoup/legado 常用，css-select 原生求值）、
 *  **纯属性选择器**（[class="col-12 col-md-6"]）、**后代/子代组合链**（tbody>tr、dd>h3>a、div span）。
 *  首词非标签的词.词形态（weirdsyntax.x）与 default 方言歧义——仍抛错（宁炸不猜边界）。 */
function isImplicitCss(name: string): boolean {
  if (name.startsWith('#') || name.startsWith('.')) return true
  if (/^[a-zA-Z][\w-]*(?:\[[^\]]*\])*$/.test(name)) return true
  // 纯属性选择器：[class="col-12 col-md-6"]（无前导标签）
  if (name.startsWith('[') && name.endsWith(']')) return true
  // tag.类 组合（li.chapter / a.list-group-item）：首词是合法 HTML 标签 → CSS
  const dotIdx = name.indexOf('.')
  if (dotIdx > 0) {
    const head = name.slice(0, dotIdx).toLowerCase()
    if (HTML_TAGS.has(head)) return true
  }
  // tag+伪类/空白组合（a:contains(x) / li:first-child a）：同一基准——首词是合法标签名 → CSS；
  // 非标签首词（nonsense:x）依旧拒绝。伪类求值失败由 css-select 在求值层如实报错。
  if (/^[a-zA-Z][\w-]*[:\s>]/.test(name)) {
    const head = /^[a-zA-Z][\w-]*/.exec(name)?.[0].toLowerCase() ?? ''
    if (HTML_TAGS.has(head)) return true
  }
  return false
}

/** 段尾位置后缀剥离（选择器段共用）：从最后一个 . 起找第一个可解析为 IndexSpec 的后缀 */
function splitIndexSuffix(raw: string): { base: string; index: IndexSpec | null } {
  for (let i = raw.length - 1; i > 0; i--) {
    if (raw[i] !== '.') continue
    const parsed = parseIndexSuffix(raw.slice(i + 1))
    if (parsed) return { base: raw.slice(0, i), index: parsed }
  }
  return { base: raw, index: null }
}

function classifyDefault(raw: string, exclude: number[] | undefined, el: string, ctx: ParseCtx): Segment {
  // 位置后缀：从最后一个 . 起，取第一个能解析为 IndexSpec 的后缀；
  // 都不成立则整串是名称（class.note.clearfix → arg 'note.clearfix'，不许在第一个 . 截断）
  const { base: name, index } = splitIndexSuffix(raw)

  const dot = name.indexOf('.')
  const mode = dot === -1 ? name : name.slice(0, dot)
  const arg = dot === -1 ? null : name.slice(dot + 1)

  if (KNOWN_MODES.has(mode)) {
    if (exclude !== undefined && index !== null) {
      throw new UnsupportedRuleError('位置索引与 ! 排除语法不并存（legado 二选一）', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
    }
    return exclude === undefined ? { kind: 'default', mode, arg, index } : { kind: 'default', mode, arg, index, exclude }
  }

  // 隐式 CSS 回落（官方简写 + 考证：#page/.txt-list/li/a/div[itemscope] 都是选择器）。
  // 位置后缀随 css 段带走（`a.0` = 选择 a 再取第 0 个——真实源高频形态，
  // 此前被并进选择器 `a.0` 当 class 选择 → 恒零命中 → 首条书名为空）。
  // 无索引时不带 index 字段（AST 精确形态，toEqual 口径）
  if (isImplicitCss(name)) {
    if (exclude !== undefined && index !== null) {
      throw new UnsupportedRuleError('位置索引与 ! 排除语法不并存（legado 二选一）', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
    }
    const seg: Segment = { kind: 'css', selector: name }
    if (exclude !== undefined) seg.exclude = exclude
    if (index !== null) seg.index = index
    return seg
  }

  // 白名单之外且不构成选择器形态（词.词，如 'nonsense.x'）→ 解析期 UnsupportedRuleError（宁炸不猜）
  throw new UnsupportedRuleError('无法识别的段类型（default 段白名单之外）', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
}

/** 位置后缀解析：all | 整数（含负） | a:b / a: / :b 切片（含负；半开区间） */
function parseIndexSuffix(suffix: string): IndexSpec | null {
  if (suffix === 'all') return { kind: 'all' }
  if (/^-?\d+$/.test(suffix)) return { kind: 'index', value: Number(suffix) }
  const m = /^(-?\d*):(-?\d*)$/.exec(suffix)
  if (m && (m[1] !== '' || m[2] !== '')) {
    return { kind: 'slice', from: m[1] === '' ? null : Number(m[1]), to: m[2] === '' ? null : Number(m[2]) }
  }
  return null
}

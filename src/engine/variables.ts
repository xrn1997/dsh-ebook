import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import { UnsupportedRuleError } from './errors.js'
import { evalJsonPath } from './jsonpath.js'

/**
 * JSONPath 求值数据解析（evaluate 的 Runtime 与 @put 共用）：ctx.json 优先；缺席且 html 是合法
 * JSON 时回退解析 html（legado `isJSON = content.toString().isJson()` → `JsonPath.parse(content)` 口径——
 * 搜索链路只传 html 不传 json，不回退的话所有 $. 规则对 JSON API 源恒 Miss）。
 * 住址从 evaluate 迁来：evaluate 值 import 本模块、本模块又值 import evaluate 形成唯一运行时环
 * ——本函数只依赖 EvalContext，搬来即打破环。
 */
export function resolveJsonData(ctx: EvalContext): unknown {
  if (ctx.json !== undefined) return ctx.json
  const text = ctx.html?.trim() ?? ''
  // 合法 JSON 才回退解析（对象/数组都算）；非 JSON 保持 undefined → JSONPath Miss（如实）
  if (text.startsWith('{') || text.startsWith('[')) {
    try { return JSON.parse(text) } catch { /* 非法 JSON → undefined */ }
  }
  return undefined
}

/**
 * `@put:` / `@get:` 变量（照 legado 文档口径）。
 *
 * `ctx.vars` 由调用方持有、跨规则共享（引擎零内部状态）。
 *
 * `@put:{k1:"v1", k2:"ruleOrJsonPath"}` 值语义（钉死）：
 *   - 普通字符串 → 原样存；
 *   - 以 `$.` 或 `@json:` 开头 → 视为 JSONPath 规则，对 `ctx.json` 求值
 *     （`$.` 前缀天然覆盖 `$..` 递归下降；`@json:` 剥前缀后即路径；与 parse.ts 的
 *     `json:` 段剥前缀口径一致），
 *     求值结果 Miss → 变量不落盘（@get 时自然 Miss；Miss≠空串）；
 *     求值结果为 List → v1 变量只存单值，抛 UnsupportedRuleError（宁炸不猜）；
 *   - 其他规则形态（XPath `//…`、`@css:`、`<js>`、`#{}` 等）→ UnsupportedRuleError。
 *
 * pairs 解析（手写小 parser，不用 JSON.parse——legado 的值不保证是严格 JSON）：
 *   `{` 开头 `}` 结尾；顶层逗号切分（引号内逗号不切）；每项 `key:"value"`；
 *   v1 REQUIREMENTS：值必须带双引号，不带引号 → UnsupportedRuleError「@put 值必须带引号」。
 *
 * `@get:name` → 读 `ctx.vars[name]`；未 put 过 / vars 未初始化 → Miss（detail 提到键名）。
 */

function reject(detail: string, pairsRaw: string, loc: SegmentLoc, facet: Facet): never {
  throw new UnsupportedRuleError(detail, { ...loc, facet })
}

/** 手写 pairs 解析：顶层逗号切分（引号内不切），每项 key:"value"（v1 值必须带引号） */
function parsePairs(pairsRaw: string, loc: SegmentLoc, facet: Facet): Array<[string, string]> {
  const s = pairsRaw.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) {
    reject('@put 形态必须为 {key:"value", …}（{ 开头 } 结尾）', pairsRaw, loc, facet)
  }
  const inner = s.slice(1, -1)
  const pairs: Array<[string, string]> = []
  const n = inner.length
  let i = 0
  const skipWs = (): void => { while (i < n && /\s/.test(inner[i])) i++ }

  while (true) {
    skipWs()
    if (i >= n) break
    // key：读到冒号为止
    const kStart = i
    while (i < n && inner[i] !== ':' && inner[i] !== ',') i++
    const key = inner.slice(kStart, i).trim()
    if (key === '') reject('@put 键名为空', pairsRaw, loc, facet)
    if (i >= n || inner[i] !== ':') reject(`@put 键值对缺少冒号：${JSON.stringify(key)}`, pairsRaw, loc, facet)
    i++ // 吃掉 ':'
    skipWs()
    if (inner[i] !== '"') reject('@put 值必须带引号', pairsRaw, loc, facet)
    i++ // 吃掉开引号
    let value = ''
    let closed = false
    while (i < n) {
      const c = inner[i]
      if (c === '\\' && i + 1 < n) { value += inner[i + 1]; i += 2; continue } // \" 转义
      if (c === '"') { closed = true; i++; break }
      value += c
      i++
    }
    if (!closed) reject('@put 值引号未闭合', pairsRaw, loc, facet)
    pairs.push([key, value])
    skipWs()
    if (i >= n) break
    if (inner[i] !== ',') reject(`@put 顶层逗号分隔处出现意外字符：${JSON.stringify(inner[i])}`, pairsRaw, loc, facet)
    i++ // 吃掉逗号；尾逗号由循环顶的 skipWs + break 收编
  }
  return pairs
}

/**
 * `@put:` 段求值：解析 pairs 并写入 `ctx.vars`（未初始化则自动建）。
 * 返回值：原样回显 pairsRaw（Value）——**仅供直测读取**；规则链里 @put 是副作用段，
 * evaluate 丢弃其返回并以透传的上游值为链值（legado 口径），故生产路径不消费该返回值。
 */
export function evalPut(pairsRaw: string, ctx: EvalContext, loc: SegmentLoc, facet: Facet): EngineValue {
  const pairs = parsePairs(pairsRaw, loc, facet)
  // 先全部求值进 staged，全成功才落盘 ctx.vars——中途抛错不留下半截写入
  const staged: Record<string, string> = {}
  /** JSONPath 值落盘：Value → 存；Miss → 不落盘（@get 时自然 Miss；Miss≠空串）；List → v1 只存单值，宁炸 */
  const putJsonPath = (key: string, path: string): void => {
    // 数据源与 JSONPath 段同口径：ctx.json 缺席时回退解析 ctx.html（legado isJSON 口径）
    const res = evalJsonPath(path, resolveJsonData(ctx), loc, facet)
    if (res.kind === 'value') { staged[key] = res.text; return }
    if (res.kind === 'miss') return
    reject(`@put 的 JSONPath 求值结果为列表，v1 变量只存单值（键: ${key}）`, pairsRaw, loc, facet)
  }
  for (const [key, value] of pairs) {
    if (value.startsWith('$.')) {
      // JSONPath 规则（钉死 `$.` 起——`$..` 递归下降被 `$.` 前缀天然覆盖；裸 `$`、`$99` 等
      // 不以 `$.` 开头的值不构成 JSONPath 规则，落入下方普通字符串原样存）
      putJsonPath(key, value)
    } else if (value.startsWith('@json:')) {
      // @json: 前缀 = 数据源声明；剥掉后余下即对 ctx.json 的 JSONPath（与 parse.ts 的 json: 段口径一致）
      putJsonPath(key, value.slice('@json:'.length))
    } else if (value.startsWith('//') || value.startsWith('/') || value.startsWith('@')
      || value.startsWith('<') || value.startsWith('#{')) {
      // 其他规则形态（XPath / @css: / <js> / #{} 等）v1 不支持——宁炸不猜
      reject(`@put 值不支持该规则形态（v1 仅支持普通字符串或 JSONPath）：${JSON.stringify(value)}`, pairsRaw, loc, facet)
    } else {
      staged[key] = value // 普通字符串 → 原样存
    }
  }
  Object.assign(ctx.vars ??= {}, staged)
  return { kind: 'value', text: pairsRaw }
}

/** `@get:` 段求值：读 `ctx.vars[name]`；未 put 过 → Miss（detail 提到键名） */
export function evalGetVar(name: string, ctx: EvalContext): EngineValue {
  const v = ctx.vars?.[name]
  if (v === undefined) return { kind: 'miss', detail: `变量未定义：${name}` }
  return { kind: 'value', text: v }
}

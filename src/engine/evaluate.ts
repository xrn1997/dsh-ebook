import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { Branch, EngineValue, EvalContext, Facet, ParsedRule, Segment, SegmentLoc } from './types.js'
import { parseRule } from './parse.js'
import { evalCss } from './css.js'
import { evalDefault } from './select.js'
import { evalJsonPath } from './jsonpath.js'
import { evalXPath } from './xpath.js'
import { evalAllInOne } from './allinone.js'
import { evalPut, evalGetVar, resolveJsonData } from './variables.js'
import { evalJs } from './js-sandbox.js'
import type { EvaluateRef, JsHost } from './js-sandbox.js'
import { combine, reverseList } from './combine.js'
import { applyReplaces } from './replace.js'
import { loadHtml } from './dom.js'
import { engineValueToString } from './js-utils.js'

/** 设计文档：docs/design/engine.md */
import { JsSandboxError, RuleEvalError, UnsupportedRuleError, isEngineError } from './errors.js'

// ── trace 类型（冻结：服务层 / 工具面 / UI 只准用这套）──────────────────

export interface TraceStep {
  segmentIndex: number
  segmentRaw: string
  segmentKind: Segment['kind']
  /** 节点/条目数（Value 记 1、Miss 记 0）；js 段为 null */
  hits: number | null
  /** 取值预览（截断 80 字符） */
  preview: string
  jsLogs?: string[]
  error?: { code: 'UnsupportedRuleError' | 'RuleEvalError' | 'JsSandboxError'; message: string }
}

export interface TraceResult {
  value: EngineValue
  steps: TraceStep[]
  combinator: ParsedRule['combinator']
  reverse: boolean
}

// ── 公开接口 ───────────────────────────────────────────────────────────

/**
 * 总装求值：parse → 逐分支逐段求值 → 组合符合并 → 反序 → `##` 替换尾。
 * 收到 ParsedRule 时直通内部 runner，不重 parse。
 * 引擎语义：Miss 是值（透传/合并按组合符口径）；UnsupportedRuleError /
 * RuleEvalError / JsSandboxError 一律不吞，向上抛（trace 只由 evaluateWithTrace 收集）。
 */
export async function evaluate(
  rule: ParsedRule | string,
  ctx: EvalContext,
  facet: Facet = 'rule',
): Promise<EngineValue> {
  const parsed = typeof rule === 'string' ? parseRule(rule, facet) : rule
  return runParsed(parsed, ctx, facet, null)
}

/** 带段级 trace 的求值：每段一行 Step；错误段 push error Step 后照抛（不认识的语法必须炸）。 */
export async function evaluateWithTrace(
  rule: string,
  ctx: EvalContext,
  facet: Facet = 'rule',
): Promise<TraceResult> {
  const parsed = parseRule(rule, facet)
  const steps: TraceStep[] = []
  const value = await runParsed(parsed, ctx, facet, steps)
  return { value, steps, combinator: parsed.combinator, reverse: parsed.reverse }
}

// ── 运行时（每条规则一份；lazy 化 cheerio 与整页文本）───────────────────

interface Runtime {
  ctx: EvalContext
  facet: Facet
  /** 懒加载的页面 DOM（jsonpath/js-only 规则不付 cheerio 成本） */
  $(): CheerioAPI
  /** 整页文本：ctx.html ?? String(ctx.json ?? '')（allinone / 独立净化用） */
  pageText(): string
  /** JSONPath 求值数据：ctx.json 优先；缺席且 html 是合法 JSON 时回退解析 html
   *  （legado `isJSON = content.toString().isJson()` → `JsonPath.parse(content)` 口径——
   *  搜索链路只传 html 不传 json，不回退的话所有 $. 规则对 JSON API 源恒 Miss） */
  jsonData(): unknown
  /** java.getString* 的递归求值回调（同步子规则接线口） */
  evaluateRef: EvaluateRef
}

function makeRuntime(ctx: EvalContext, facet: Facet): Runtime {
  let api: CheerioAPI | null = null
  let page: string | null = null
  let jsonParsed = false
  let jsonValue: unknown
  return {
    ctx,
    facet,
    $: () => (api ??= loadHtml(ctx.html ?? '')),
    pageText: () => (page ??= ctx.html ?? String(ctx.json ?? '')),
    jsonData: () => {
      if (!jsonParsed) {
        jsonParsed = true
        jsonValue = resolveJsonData(ctx)
      }
      return jsonValue
    },
    // 子规则对「给定数据」求值：data 作为子规则的 html 上下文（与 host.result 同源）
    evaluateRef: (ruleStr, data) =>
      runParsedSync(parseRule(ruleStr, facet), { ...ctx, html: String(data ?? '') }, facet),
  }
}

/** JSONPath 求值数据解析已迁 variables.ts（resolveJsonData）——打破 evaluate ↔ variables 运行时环 */

/** 独立净化形态（##a##b，branches 为空）：基值 = 整页原文（ctx.html ?? String(ctx.json ?? ''）），
 * 不经 DOM——JSON 页（无 html）以序列化文本为基值净化 */
function standaloneBase(rt: Runtime): EngineValue {
  return { kind: 'value', text: rt.pageText() }
}

// ── 链语义单点（双 runner 收拢）──────────────────────────────────────
//
// 一条取值链的执行语义（链衔接、@put 副作用透传、js 段特判、trace 组装、错误步）只此一份，
// 以 generator 表达：非 js 段同步推进，js 段 yield 出完整 evalJs 入参给驱动器。两个驱动器
// 只负责喂结果，零链知识：
//  - 异步驱动（evaluate / evaluateWithTrace 主路径）：await evalJs 后回喂；
//  - 同步驱动（java.getString* 的 evaluateRef 专用——沙箱宿主桥是同步接口）：
//    遇第一次 yield 即「子规则内不支持 js 段」宁炸不猜。
// 此前 runParsed/runParsedSync 是 ~60 行逐条镜像的孪生：特判段（js/put）必须双写，
// 且同步环路（真实 evaluateRef）零测试（见 tests/engine/evaluate-sync-loop.test.ts）。

/** js 段调用：generator yield 给驱动器的完整 evalJs 入参（驱动器对段零知识） */
type JsCall = Parameters<typeof evalJs>
type JsOutcome = Awaited<ReturnType<typeof evalJs>>

function* ruleGen(
  parsed: ParsedRule, ctx: EvalContext, facet: Facet, collect: TraceStep[] | null,
): Generator<JsCall, EngineValue, JsOutcome> {
  const rt = makeRuntime(ctx, facet)
  if (parsed.branches.length === 0) return finalize(parsed, [standaloneBase(rt)], facet)
  const values: EngineValue[] = []
  let offset = 0 // 全规则连续段号（与 parse 的 counter 口径一致）
  for (const branch of parsed.branches) {
    values.push(yield* branchGen(branch, offset, rt, collect))
    offset += branch.segments.length
  }
  return finalize(parsed, values, facet)
}

function* branchGen(
  branch: Branch, offset: number, rt: Runtime, collect: TraceStep[] | null,
): Generator<JsCall, EngineValue, JsOutcome> {
  let cur: EngineValue | null = null // null = 尚未起链（select 段落地时取根节点集 $('*')）
  for (let i = 0; i < branch.segments.length; i++) {
    const seg = branch.segments[i]
    const loc: SegmentLoc = { segmentIndex: offset + i, segmentRaw: branch.raws[i] }
    try {
      checkChainStart(seg, i, loc, rt.facet)
      if (seg.kind === 'js') {
        const prev: EngineValue | null = cur // 首段（prev=null）时 host.result 取整页原文
        // 驱动器经 gen.throw(e) 把 evalJs 失败投回此处——错误步与重抛走同一条 catch（单点）
        const outcome: JsOutcome = yield [
          seg.form === 'tail' ? `return (${seg.code})` : seg.code, // 链尾 (…) 是表达式形态
          jsHostOf(prev, rt), rt.ctx, loc, rt.facet, rt.evaluateRef,
        ]
        let out: EngineValue = outcome.value
        // 链上游是 List（多节点取值）→ js 串结果按 \n 拆回 List，保持链的「多条目」语义
        if (prev?.kind === 'list' && out.kind === 'value' && out.text.includes('\n')) {
          out = { kind: 'list', items: out.text.split('\n') }
        }
        cur = out
        if (collect) collect.push(stepOf(seg, loc, out, outcome.logs))
        continue
      }
      if (seg.kind === 'put') {
        // @put 是副作用段：写 ctx.vars 后链值透传，不替换 cur（legado 口径）
        evalPut(seg.pairsRaw, rt.ctx, loc, rt.facet)
        if (collect) collect.push(putStepOf(loc, cur))
        continue
      }
      cur = evalNonJs(seg, cur, rt, loc)
      if (collect) collect.push(stepOf(seg, loc, cur))
    } catch (e) {
      if (collect) collect.push(errorStepOf(e, seg, loc))
      throw e
    }
  }
  return cur ?? { kind: 'miss', detail: '空分支' }
}

/** 异步驱动：js 段 await evalJs 回喂；evalJs 失败经 gen.throw 投回 generator（错误步单点在内） */
async function driveAsync(gen: Generator<JsCall, EngineValue, JsOutcome>): Promise<EngineValue> {
  let step = gen.next()
  while (!step.done) {
    let outcome: JsOutcome
    try {
      outcome = await evalJs(...step.value)
    } catch (e) {
      gen.throw(e) // generator 的 catch 记错误步后照抛——此处必然再抛，下一行不可达
      throw e
    }
    step = gen.next(outcome)
  }
  return step.value
}

/** 同步驱动（evaluateRef 专用）：第一次 yield 即子规则含 js 段——宁炸不猜（语义与旧 runBranchSync 逐字一致） */
function driveSync(gen: Generator<JsCall, EngineValue, JsOutcome>, facet: Facet): EngineValue {
  const step = gen.next()
  if (!step.done) {
    const loc = step.value[3]
    throw new UnsupportedRuleError('子规则（java.getString 等递归求值）内不支持 js 段——沙箱宿主桥为同步接口', {
      segmentIndex: loc.segmentIndex,
      segmentRaw: loc.segmentRaw,
      facet,
    })
  }
  return step.value
}

async function runParsed(
  parsed: ParsedRule,
  ctx: EvalContext,
  facet: Facet,
  collect: TraceStep[] | null,
): Promise<EngineValue> {
  return driveAsync(ruleGen(parsed, ctx, facet, collect))
}

function runParsedSync(parsed: ParsedRule, ctx: EvalContext, facet: Facet): EngineValue {
  return driveSync(ruleGen(parsed, ctx, facet, null), facet)
}

// ── 非 js 段分派 + 链衔接状态机 ────────────────────────────────────────

function checkChainStart(seg: Segment, i: number, loc: SegmentLoc, facet: Facet): void {
  if (i === 0) return
  if (seg.kind === 'jsonpath') {
    throw new UnsupportedRuleError('jsonpath 段必须是分支首位', { ...loc, facet })
  }
  if (seg.kind === 'allinone') {
    throw new UnsupportedRuleError('AllInOne 段必须是分支首位', { ...loc, facet })
  }
}

/** 链中段（不含 js/put——两者在 runBranch* 内联处理） */
type ChainSegment = Exclude<Segment, { kind: 'js' } | { kind: 'put' }>

/** 非 js 段求值：选择段消费 nodes 链；Miss 穿透（选择/取值段对 Miss 上游原样透传） */
function evalNonJs(
  seg: ChainSegment,
  cur: EngineValue | null,
  rt: Runtime,
  loc: SegmentLoc,
): EngineValue {
  const $ = rt.$
  switch (seg.kind) {
    case 'css': {
      if (cur?.kind === 'miss') return cur // Miss 穿透：选择/取值段对 Miss 上游原样透传
      return evalCss(seg, $(), requireNodes(cur, rt, loc), loc, rt.facet)
    }
    case 'xpath': {
      if (cur?.kind === 'miss') return cur
      // 链首 → 文档根为上下文（`//` 语义全覆盖）；链中 → 上游节点集为作用域（`.//` 条目语义）
      const ctxNodes = cur === null ? $().root() : requireNodes(cur, rt, loc)
      return evalXPath(seg, $(), ctxNodes, loc, rt.facet)
    }
    case 'default': {
      if (cur?.kind === 'miss') return cur
      return evalDefault(seg, $(), requireNodes(cur, rt, loc), loc, rt.facet)
    }
    case 'jsonpath':
      return evalJsonPath(seg.path, rt.jsonData(), loc, rt.facet)
    case 'allinone':
      return evalAllInOne(seg, rt.pageText(), loc, rt.facet)
    case 'getvar':
      // @get 产出存储值（Value/Miss），合法替换链值
      return evalGetVar(seg.name, rt.ctx)
  }
}

/** 选择段上游解析：未起链 → 根节点集 $('*')；Miss → 原样穿透；
 *  Value（js 段产物/取值段产物）→ 按 HTML 解析为新上下文（legado String→JSoup 语义：
 *  `<js>…</js>@css:.x` 中 js 返回的字符串被当作新文档继续选择）；其余 → RuleEvalError */
function requireNodes(cur: EngineValue | null, rt: Runtime, loc: SegmentLoc): Cheerio<AnyNode> {
  if (cur === null) return rt.$()('*')
  if (cur.kind === 'miss') {
    // 上游 Miss 时由调用方（evalNonJs）提前短路，此分支仅兜底
    throw new RuleEvalError('上游结果是 Miss，无法继续选择', { ...loc, facet: rt.facet, hits: 0 })
  }
  if (cur.kind === 'value') {
    return loadHtml(cur.text).root()
  }
  if (cur.kind !== 'nodes') {
    throw new RuleEvalError('上游结果不是节点集，无法继续选择', { ...loc, facet: rt.facet, hits: 0 })
  }
  return cur.nodes
}

// ── 分支结果 → 组合 → 反序 → 替换尾 ─────────────────────────────────────

function finalize(parsed: ParsedRule, values: EngineValue[], facet: Facet): EngineValue {
  let value = combine(values, parsed.combinator, { facet, segmentIndex: -1, segmentRaw: '%%（组合符）' })
  if (parsed.reverse) value = reverseList(value)
  if (parsed.replaces.length > 0) {
    value = applyReplaces(value, parsed.replaces, parsed.onlyOne, { facet })
  }
  return value
}

// ── trace 组装 ─────────────────────────────────────────────────────────

/** js 宿主注入：host.result = 上一段结果的序列化；首个段 → 整页原文（pageText：html ?? String(json)，与独立净化同口径） */
function jsHostOf(prev: EngineValue | null, rt: Runtime): JsHost {
  return {
    result: prev === null ? rt.pageText() : serialize(prev),
    baseUrl: rt.ctx.baseUrl ?? '',
    source: rt.ctx.source ?? '',
  }
}

function serialize(v: EngineValue): string {
  // 序列化单点归 js-utils；@js host.result 的 nodes 口径 = outerHTML（'outer'）——
  // 与 java.getString 的 innerHTML 口径由参数显式区分，不再各存一份实现。
  return engineValueToString(v, 'outer')
}

function hitsOf(v: EngineValue): number {
  switch (v.kind) {
    case 'value': return 1
    case 'list': return v.items.length
    case 'matches': return v.rows.length
    case 'nodes': return v.nodes.length
    case 'miss': return 0
  }
}

function previewOf(v: EngineValue): string {
  let s: string
  switch (v.kind) {
    case 'value': s = v.text; break
    case 'list': s = `${v.items.slice(0, 2).join(', ')}…(共${v.items.length}项)`; break
    case 'matches': s = (v.rows[0] ?? []).join('\t'); break
    case 'nodes': s = `${v.nodes.length}个节点`; break
    case 'miss': s = `miss: ${v.detail}`; break
  }
  return s.length > 80 ? s.slice(0, 80) : s
}

function stepOf(seg: Segment, loc: SegmentLoc, out: EngineValue, logs?: string[]): TraceStep {
  const step: TraceStep = {
    segmentIndex: loc.segmentIndex,
    segmentRaw: loc.segmentRaw,
    segmentKind: seg.kind,
    hits: seg.kind === 'js' ? null : hitsOf(out),
    preview: previewOf(out),
  }
  if (logs && logs.length > 0) step.jsLogs = logs
  return step
}

/** @put 步（副作用段）：链值透传——trace 显示透传态（pairs 原文见 segmentRaw） */
function putStepOf(loc: SegmentLoc, cur: EngineValue | null): TraceStep {
  return {
    segmentIndex: loc.segmentIndex,
    segmentRaw: loc.segmentRaw,
    segmentKind: 'put',
    hits: cur === null ? null : hitsOf(cur),
    preview: cur === null ? 'put 透传（链起点，无上游值）' : previewOf(cur),
  }
}

function errorStepOf(e: unknown, seg: Segment, loc: SegmentLoc): TraceStep {
  const code: NonNullable<TraceStep['error']>['code'] =
    e instanceof UnsupportedRuleError ? 'UnsupportedRuleError'
      : e instanceof JsSandboxError ? 'JsSandboxError'
        : 'RuleEvalError' // RuleEvalError 与其他异常统一按求值错呈现
  return {
    segmentIndex: loc.segmentIndex,
    segmentRaw: loc.segmentRaw,
    segmentKind: seg.kind,
    hits: e instanceof RuleEvalError ? e.hits : null,
    preview: '',
    error: { code, message: isEngineError(e) ? e.message : String((e as Error)?.message ?? e) },
  }
}

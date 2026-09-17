import vm from 'node:vm'
import { DEFAULT_JS_TIMEOUT_MS } from './types.js'
import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import { JsSandboxError } from './errors.js'
import { SANDBOX_MOUNTS, invokeJavaMethod } from './js-protocol.js'
import type { BridgeDeps } from './js-protocol.js'

/** JavaBridge 协议的**唯一登记点**在 js-protocol.ts 的 JAVA_PROTOCOL 表（方法名·sync/async·
 *  挂载点·实现四元组收于一行，interface/BOOTSTRAP 名单/宿主分派全部从表派生）。
 *  此处仅 re-export 推导出的类型，保持既有导入路径可用。
 *  设计文档：docs/design/engine.md */
export type { JavaBridge } from './js-protocol.js'

/** 沙箱宿主注入面。注：旧版此处有 `java?: JavaBridge` 覆盖点——全仓零生产者（一个 adapter
 *  都没有的假 seam），已删除：桥始终由 evalJs 内部按协议表构造。 */
export interface JsHost {
  /** 上一段结果序列化（Value.text / List.items.join('\n') / 页面原文） */
  result: string
  baseUrl: string
  source: string
  /** searchUrl @js 形态：搜索关键词与页码（legado 沙箱全局变量 key/page） */
  key?: string
  page?: number
  /** 源静态 header 的 JSON 串（真实源 `JSON.parse(source.header)` 的形态） */
  header?: string
  console?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

export interface EvalJsOptions {
  /** 脚本完成值语义（legado @js 口径）：代码作为脚本执行，最后一个表达式的值即结果；
   *  顶层 return/await 触发 SyntaxError 时自动回落函数体（async IIFE）形态。 */
  scriptForm?: boolean
  /** 脚本可见的源会话状态（cookie 垫片/源变量）——缺省进程级实例（跨调用存活）；
   *  测试注入 createSourceSession() 隔离实例，跨源污染类用例第一次可写。 */
  session?: SourceSession
}

/**
 * runScript：evalJs 的单对象入口。
 *
 * evalJs 的 JsHost 与 EvalContext 字段重叠（baseUrl/source 双份、key/page/header vs vars/jsLib），
 * 调用方此前必须双拼两份上下文（request.ts 里近逐字写了两遍）。本入口把重叠字段**收进一个
 * 对象**，host/ctx 在此合并构造——调用方学一个形状；evalJs 保持原样（引擎内部逐段求值仍用它）。
 */
export interface RunScriptOptions {
  code: string
  /** 上一段结果序列化（host.result）；缺省 ''（脚本起步无上游） */
  result?: string
  baseUrl?: string
  source?: string
  /** legado 沙箱全局变量（searchUrl @js 形态用 key/page；header 为源静态头 JSON 串） */
  key?: string
  page?: number
  header?: string
  vars?: Record<string, string>
  fetch?: (url: string) => Promise<{ body: string; contentType?: string }>
  jsLib?: string
  jsTimeoutMs?: number
  loc: SegmentLoc
  facet: Facet
  /** 缺省 true：完成值即结果（legado @js 口径） */
  scriptForm?: boolean
  evaluateRef?: EvaluateRef
  /** 脚本可见的源会话（cookie 垫片/源变量）：缺省进程级实例；测试注入 createSourceSession() */
  session?: SourceSession
}

export function runScript(o: RunScriptOptions): Promise<JsOutcome> {
  const ctx: EvalContext = {
    ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }),
    ...(o.source === undefined ? {} : { source: o.source }),
    ...(o.vars === undefined ? {} : { vars: o.vars }),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.jsLib === undefined ? {} : { jsLib: o.jsLib }),
    ...(o.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: o.jsTimeoutMs }),
  }
  const host: JsHost = {
    result: o.result ?? '',
    baseUrl: o.baseUrl ?? '',
    source: o.source ?? '',
    ...(o.key === undefined ? {} : { key: o.key }),
    ...(o.page === undefined ? {} : { page: o.page }),
    ...(o.header === undefined ? {} : { header: o.header }),
  }
  return evalJs(o.code, host, ctx, o.loc, o.facet, o.evaluateRef,
    { scriptForm: o.scriptForm ?? true, ...(o.session === undefined ? {} : { session: o.session }) })
}

export interface JsOutcome {
  value: EngineValue
  logs: string[]
}

/** 规则递归求值回调（避免与求值层循环依赖，由求值层注入真实现）。
 *  两个参数：rule + data（data 作为子规则的 html 上下文）。baseUrl 由外层 EvalContext
 *  经 `{...ctx, html}` 继承——此前声明的第三参 `baseUrl?` 两处实现都丢弃（死参数）。 */
export type EvaluateRef = (rule: string, data: unknown) => EngineValue

const TIMEOUT = Symbol('js-sandbox-timeout')

/** 进程级 unhandledRejection 防线（加载期常驻，幂等挂载一次）。
 *  沙箱里 `java.ajax()` 每次调用都新建一个 async IIFE promise；脚本常 fire-and-forget（不 await 不 catch），
 *  其 rejection 在 **ajax fetch settle 之后**才悬空触发。Node 20+ 默认把这类 unhandled rejection 当致命错误，
 *  直接干掉整个 dsh 进程——尤其在**导入书源**时：探针逐源跑 @js，命中一个 fire-and-forget ajax 源就崩，
 *  用户看到的「fatal load failure / 请求失败 403 / 404」正是这条 rejection 冒到进程顶层。
 *  早前实现是「evalJs 期间挂、finally 摘」——但 rejection 晚于 evalJs 返回才触发，摘早了照样漏。故改为
 *  加载期常驻：只需拦住进程默认的 throw 行为，插件 dispose 时才摘（不给进程留永久监听器）。 */
let guardInstalled = false
function unhandledGuardHandler(reason: unknown): void {
  console.warn('[dsh-novel] 沙箱脚本产生未处理的 rejection（已捕获，不影响进程）:',
    reason instanceof Error ? reason.message : reason)
}
/** 幂等挂载：多次调用只挂一次。返回卸载函数（插件 dispose 时调用）。 */
export function ensureUnhandledGuard(): () => void {
  if (!guardInstalled) {
    process.on('unhandledRejection', unhandledGuardHandler)
    guardInstalled = true
  }
  return () => {
    // 只在仍是已挂载状态时摘（防止重复 ensure 后误摘别人的）
    if (guardInstalled) {
      process.off('unhandledRejection', unhandledGuardHandler)
      guardInstalled = false
    }
  }
}

/**
 * 沙箱引导脚本（在 vm 上下文内执行一次）。
 *
 * 逃逸防御核心：宿主**绝不**把函数/对象直接交给用户代码。唯一入口 `__host_call__`
 * （宿主函数）被本闭包捕获后即从全局移除并锁死（不可恢复）；暴露给用户的 `java`/`console`
 * 全部是 vm  realm 的包装函数，参数与返回值经 JSON 双向序列化（原始值/纯数据），
 * 宿主抛出的错误对象只取 `.message` 字符串后以 vm  realm 的 Error 重抛。
 * 因此用户代码无法沿 `.constructor`（跨 realm Function）或错误对象触达宿主 realm；
 * 而 vm realm 内 codeGeneration:{strings:false} 使 eval / Function 构造器一律 EvalError。
 */
const BOOTSTRAP = `;(function (g) {
  'use strict'
  const call = g.__host_call__
  const d = JSON.parse(g.__init__)
  const hide = function (k) {
    try { delete g[k] } catch (e) {}
    try { Object.defineProperty(g, k, { value: 0, writable: false, configurable: false }) } catch (e) {}
  }
  hide('__host_call__')
  hide('__init__')
  const ser = function (a) { return JSON.stringify(a) }
  const msg = function (e) { return (e && e.message) ? String(e.message) : String(e) }
  const invoke = function (name, a) {
    let r
    try { r = call(name, ser(a)) } catch (e) { throw new Error(msg(e)) }
    return r
  }
  const sync = function (name) {
    return function () { return JSON.parse(invoke(name, [].slice.call(arguments))) }
  }
  const ajax = function () {
    const args = [].slice.call(arguments)
    const p = (async function () {
      const r = invoke('ajax', args)
      try { return JSON.parse(await r) } catch (e) { throw new Error(msg(e)) }
    })()
    // fire-and-forget 防线（bridge 内**唯一**一层，受 DSH_NOVEL_NO_GUARD 开关控制）：
    // 脚本常不 await 也不 catch，给外层 promise 挂空 catch，让拒绝在 vm realm 内就地消化
    // （不逃逸到宿主 realm 成 unhandled）。await 方照常收到拒绝——空 catch 不影响 p 本身，
    // 只是多一个已消化的派生分支。
    // 防线口径（三层职责收敛）：
    //   ① 本层 = bridge 内防线，开关控制（DSH_NOVEL_NO_GUARD=1 时裸奔便于排障）；
    //   ② 协议表 ajax 实现（js-protocol）只管发起请求并如实失败，不再各挂一层空 catch
    //      （旧实现此处与 makeJavaBridge 各一层、口径不一——已合并到本层）；
    //   ③ 进程级 unhandledRejection guard（ensureUnhandledGuard）是常驻最后防线，另有所司，不动。
    if (!__d__.noGuard) p.catch(function () {})
    return p
  }
  const log = function (kind) {
    return function () {
      try { call(kind, ser([].slice.call(arguments))) } catch (e) {}
    }
  }
  g.java = {
    ajax: ajax,
    log: log('console.log'),
    toast: function(){}, longToast: function(){}, copyText: function(){},
    startBrowser: function(){}, open: function(){},
  }
  // 同步方法名单从协议表派生（js-protocol.SANDBOX_MOUNTS，经 __init__ 注入）——
  // 加一个 java 方法只改表一行，此处零改动；ajax 为 async 走上面的特制包装，不在名单内
  d.mounts.javaSync.forEach(function (n) { g.java[n] = sync(n) })
  ;['webView','startBrowserAwait','refreshTocUrl','ajaxAll','createSymmetricCrypto','createAsymmetricCrypto',
    'aesBase','queryTTF','queryBase','replaceFont','digestHex','digestBase64Str','HMacHex','HMacBase64',
    'createSign','strToBytes'].forEach(function (n) {
    g.java[n] = function () { throw new Error('java.' + n + ' 不支持：需要安卓宿主环境（WebView/加密/系统服务无法仿真）') }
  })
  g.cookie = {}
  d.mounts.cookie.forEach(function (p) { g.cookie[p.key] = sync(p.name) })
  const noHost = function (name) {
    return new Proxy({}, { get: function (t, p) {
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return function () { return name }
      throw new Error(name + ' 不支持：需要安卓宿主环境')
    } })
  }
  g.android = noHost('android.*')
  g.org = noHost('org.*')
  g.console = { log: log('console.log'), error: log('console.error') }
  g.__d__ = d
  g.__src__ = { key: d.source, bookSourceUrl: d.source, bookSourceName: d.sourceName || '', loginUrl: '',
    header: d.header || '{}',
    getKey: function () { return d.source },
    // getLoginInfoMap：legado 登录信息表（用户在 loginUi 录入的键值）。我们无 loginUi——
    // 返回空表如实仿真（脚本取不到配置走默认分支；不伪造假配置）
    getLoginInfoMap: function () { return {} },
    toString: function () { return d.source }, valueOf: function () { return d.source } }
  // 源变量垫片方法（getVariable/setVariable/get/put）同样从协议表派生
  d.mounts.source.forEach(function (p) { g.__src__[p.key] = sync(p.name) })
  g.result = d.result
  g.baseUrl = d.baseUrl
  g.source = g.__src__
  g.key = d.key
  g.page = d.page
})(globalThis)`

/**
 * 在 node:vm 受限上下文中执行用户 JS 片段（`@js` / `<js>` / 链尾 `(…)`）。
 *
 * - 上下文 codeGeneration:{strings:false,wasm:false}：eval / Function 构造器一律 EvalError。
 * - wrapper 为 async IIFE：顶层 `await` 可用；单次 `vm.runInContext` 同时覆盖编译与同步段
 *   （vm timeout 杀死 while(true){} 这类同步死循环），异步总时长由外层 Promise.race 硬超时约束
 *   （timer 已 unref，不拖住事件循环）。
 * - 返回值映射：string→Value；array→List（元素 String()）；null/undefined/''→Miss；对象→JSON.stringify 的 Value。
 * - `console.log/error` 收集进返回的 logs（join(' ')），不外泄打印。
 */
export async function evalJs(
  code: string,
  host: JsHost,
  ctx: EvalContext,
  loc: SegmentLoc,
  facet: Facet,
  evaluateRef?: EvaluateRef,
  opts?: EvalJsOptions,
): Promise<JsOutcome> {
  const logs: string[] = []
  const timeout = Math.max(1, ctx.jsTimeoutMs ?? DEFAULT_JS_TIMEOUT_MS)
  // 幂等挂载进程级 unhandledRejection 防线（多次调用只挂一次；挂上后常驻至插件 dispose）
  ensureUnhandledGuard()
  const session = opts?.session ?? processSession
  // 协议实现的闭包依赖（原 makeJavaBridge 的参数+可变态收成一个对象；实现本体在协议表）
  const deps: BridgeDeps = {
    ctx,
    code,
    loc,
    facet,
    result: host.result ?? '',
    session,
    sourceKey: ctx.source ?? ctx.baseUrl ?? '',
    evaluateRef,
    contentBase: null,
  }
  const call = makeHostCall(deps, logs, host.console)
  const init = JSON.stringify({
    result: host.result ?? '', baseUrl: ctx.baseUrl ?? '', source: ctx.source ?? '',
    key: host.key ?? '', page: host.page ?? 1, header: host.header ?? '{}',
    noGuard: process.env.DSH_NOVEL_NO_GUARD === '1',
    // 沙箱挂载清单从协议表派生（见 js-protocol.SANDBOX_MOUNTS）
    mounts: SANDBOX_MOUNTS,
  })
  const context = vm.createContext(
    { __host_call__: call, __init__: init } as unknown as vm.Context,
    { codeGeneration: { strings: false, wasm: false } },
  )

  try {
    vm.runInContext(BOOTSTRAP, context, { timeout })
  } catch (e) {
    throw jsErr(e, code, loc, facet, '沙箱初始化失败')
  }

  // jsLib（legado 源级全局函数库）：先于用户代码在同一上下文执行——函数定义落全局，
  // 用户 @js 里直接调用（真实源 urlUserFavorite/host/qmSearchUrl 等都定义在这里）。
  // 它本身不是求值目标：抛错如实上报（jsLib 坏了整源的 js 都不可信）。
  const jsLib = ctx.jsLib
  if (jsLib !== undefined && jsLib.trim() !== '') {
    try {
      vm.runInContext(jsLib, context, { timeout })
    } catch (e) {
      if (isVmTimeout(e)) throw jsTimeoutErr(timeout, jsLib.slice(0, 200), loc, facet)
      throw jsErr(e, jsLib.slice(0, 200), loc, facet, 'jsLib 执行失败')
    }
  }

  // key/page/result/baseUrl/source 已由 bootstrap 注入为全局（g.key=…）——wrapper 不再声明同名参数：
  // 真实源有 `let page = java.get("page")` 的重声明形态，参数位会与之冲突（Identifier already declared）
  const wrapped = `;(async function (result, baseUrl, source, java, cookie, console) { 'use strict';\n${code}\n}).apply(undefined, [__d__.result, __d__.baseUrl, __src__, java, cookie, console])`

  let started: unknown
  try {
    started = opts?.scriptForm === true
      // legado @js 口径：代码是脚本，最后一个表达式的值即结果（顶层 return/await → SyntaxError → 回落函数体）
      ? runAsScript(code, wrapped, context, timeout)
      : vm.runInContext(wrapped, context, { timeout })
  } catch (e) {
    if (isVmTimeout(e)) throw jsTimeoutErr(timeout, code, loc, facet)
    throw jsErr(e, code, loc, facet, '脚本编译/同步执行失败')
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ret = await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(TIMEOUT), timeout)
        timer?.unref?.()
      }),
    ])
    return { value: toEngineValue(ret), logs }
  } catch (e) {
    if (e === TIMEOUT || isVmTimeout(e)) throw jsTimeoutErr(timeout, code, loc, facet)
    if (e instanceof JsSandboxError) throw e
    throw jsErr(e, code, loc, facet, '脚本执行抛错')
  } finally {
    if (timer) clearTimeout(timer)
    // unhandledRejection 防线常驻（不再此处摘除）——见 ensureUnhandledGuard
  }
}

/** 脚本形态执行：完成值即结果；顶层 return/await 的 SyntaxError 回落 async IIFE 函数体形态。
 *  vm 抛的错误来自 vm realm——跨 realm `instanceof SyntaxError` 不成立，按 constructor.name 判定。 */
function runAsScript(code: string, wrapped: string, context: vm.Context, timeout: number): unknown {
  try {
    return vm.runInContext(code, context, { timeout })
  } catch (e) {
    if ((e as { constructor?: { name?: string } })?.constructor?.name !== 'SyntaxError') throw e
    return vm.runInContext(wrapped, context, { timeout })
  }
}

function toEngineValue(ret: unknown): EngineValue {
  if (ret === null || ret === undefined || ret === '') return { kind: 'miss', detail: 'js 返回空' }
  if (Array.isArray(ret)) return { kind: 'list', items: ret.map((x) => String(x)) }
  if (typeof ret === 'object') return { kind: 'value', text: JSON.stringify(ret) }
  return { kind: 'value', text: String(ret) }
}

/** 宿主侧唯一入口：与沙箱引导层约定 (name, argsJson) → JSON 字符串（ajax 为 Promise<string>）。
 *  方法分派查协议表（js-protocol.invokeJavaMethod），无逐案 switch；console.* 是引导层日志
 *  通道、不属 java 协议，在此特判（收集进 logs，可选透传宿主 console）。 */
function makeHostCall(
  deps: BridgeDeps,
  logs: string[],
  hostConsole?: JsHost['console'],
): (name: string, argsJson: string) => string | Promise<string> {
  return (name: string, argsJson: string): string | Promise<string> => {
    if (name === 'console.log' || name === 'console.error') {
      const arr: unknown[] = JSON.parse(argsJson)
      logs.push(arr.join(' '))
      if (name === 'console.log') hostConsole?.log(...arr)
      else hostConsole?.error(...arr)
      return 'null'
    }
    const args: unknown[] = JSON.parse(argsJson)
    const out = invokeJavaMethod(deps, name, args)
    if (out instanceof Promise) return out.then((v) => JSON.stringify(v))
    // undefined（java.get 未命中 / void 方法）→ 'null'：与旧逐案分派的 `?? null` / `'null'` 口径一致
    return JSON.stringify(out) ?? 'null'
  }
}

/** cookie 垫片存储：按源隔离（真实源 cookie.removeCookie(url) 后再 ajax 的形态——最小仿真，
 *  不做真实 CookieJar/域匹配——那是无头浏览器的活，我们如实只做脚本可见的键值）。
 *  存储本体归 SourceSession：这两个 Map 是进程级缺省实例的后仓。 */
const COOKIE_JARS = new Map<string, Map<string, string>>()

/** source.getVariable()/setVariable() 存储：按源隔离（legado 源级变量——真实源存用户自定义
 *  配置项（如自定义域名），下次执行读回的形态。键值表结构：getVariable 序列化整表，
 *  get/put 直接按键读写（legado BookSource 变量表同构）。进程内仿真，不落盘） */
const SOURCE_VARS = new Map<string, Map<string, string>>()

/**
 * 源会话：脚本可见的按源状态——cookie 垫片与源变量。
 * 此前这两个存储是模块级进程 Map，「按源隔离」只写在注释里：无 reset 导出、跨服务实例永生，
 * 跨源污染类用例写不出来。现在它是显式 interface：生产缺省 processSession（跨调用存活，
 * 行为与从前一字不差），测试注入 createSourceSession() 隔离实例——两个 adapter 即真 seam。
 */
export interface SourceSession {
  /** 某源的 cookie 垫片（键值表，缺省建档） */
  cookieJar(sourceKey: string): Map<string, string>
  /** 某源的变量表（键值表，缺省建档——写口用） */
  sourceVars(sourceKey: string): Map<string, string>
  /** 某源变量表的非建档读口：从未碰过 → undefined（getVariable 语义区分「从未设置」与「显式清空」） */
  peekSourceVars(sourceKey: string): Map<string, string> | undefined
}

function keyedStore(get: () => Map<string, Map<string, string>>): (sourceKey: string) => Map<string, string> {
  return (sourceKey: string): Map<string, string> => {
    const all = get()
    let m = all.get(sourceKey)
    if (m === undefined) { m = new Map(); all.set(sourceKey, m) }
    return m
  }
}

/** 进程级缺省会话（生产）：按源建档、跨调用/跨服务实例存活——与旧实现行为一致 */
export const processSession: SourceSession = {
  cookieJar: keyedStore(() => COOKIE_JARS),
  sourceVars: keyedStore(() => SOURCE_VARS),
  peekSourceVars: (sourceKey) => SOURCE_VARS.get(sourceKey),
}

/** 全新隔离会话（测试）：与进程级实例、与其他隔离实例互不可见——跨源污染用例的入口 */
export function createSourceSession(): SourceSession {
  const jars = new Map<string, Map<string, string>>()
  const vars = new Map<string, Map<string, string>>()
  return {
    cookieJar: keyedStore(() => jars),
    sourceVars: keyedStore(() => vars),
    peekSourceVars: (sourceKey) => vars.get(sourceKey),
  }
}

function jsErr(e: unknown, code: string, loc: SegmentLoc, facet: Facet, prefix: string): JsSandboxError {
  const msg = (e as Error)?.message ?? String(e)
  const line = parseLineFromStack((e as Error)?.stack ?? '')
  return new JsSandboxError(`${prefix}：${msg}`, { ...loc, facet, script: code, line })
}

function jsTimeoutErr(timeout: number, code: string, loc: SegmentLoc, facet: Facet): JsSandboxError {
  return new JsSandboxError(`脚本超时（>${timeout}ms）`, { ...loc, facet, script: code })
}

function isVmTimeout(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}

function parseLineFromStack(stack: string): number | undefined {
  // wrapper 首行偏移 1：从 <anonymous>:N:M 提取 N（vm 脚本名 evalmachine.<anonymous>）
  const withCol = stack.match(/<anonymous>:(\d+):\d+/)
  if (withCol) return Math.max(1, Number(withCol[1]) - 1)
  // 语法错误栈无列号形态（evalmachine.<anonymous>:N）
  const noCol = stack.match(/<anonymous>:(\d+)\b/)
  if (noCol) return Math.max(1, Number(noCol[1]) - 1)
  // 无行号信息 → undefined（此前返回 1 会**谎报「第 1 行」**；errors 侧 `loc.line ?` 判定据此省略行号）
  return undefined
}

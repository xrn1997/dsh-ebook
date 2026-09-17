/**
 * JavaBridge 协议表（根治「JavaBridge 协议知识散四处」）。
 *
 * 病灶：加一个 java 方法曾要同步改 4 处——①JavaBridge interface ②BOOTSTRAP 的 sync/async 名单
 * ③makeHostCall 的 switch 分派 ④makeJavaBridge 的实现。本文件把 ①③④ 收成**一张表**：
 * 每行 = 方法名 · sync/async · 沙箱挂载点 · 宿主实现（inline 闭包）。
 *
 * - **JavaBridge 类型从表推导**（mapped type）——不存在独立手写 interface，缺登记/多登记在
 *   类型面就不存在；表即唯一登记点。
 * - **BOOTSTRAP 名单从表派生**：SANDBOX_MOUNTS 由表过滤生成，经 evalJs 的 __init__ JSON
 *   注入沙箱，引导脚本按清单挂 sync 包装（ajax 为 async 走引导层特制包装，不进 sync 名单）。
 * - **分派从表查**：invokeJavaMethod 按名查行调实现，无逐案 switch。
 *
 * 加一个方法 = 本表加一行（含实现）——BOOTSTRAP/分派/类型面全部自动跟随。
 *
 * 纪律：本文件**不进** engine barrel（src/engine/index.ts）——仅由 js-sandbox 内部引用。
 *
 * 设计文档：docs/design/engine.md
 */
import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import { JsSandboxError, UnsupportedRuleError } from './errors.js'
import type { EvaluateRef, SourceSession } from './js-sandbox.js'
import {
  base64Decode,
  base64Encode,
  engineValueToString,
  engineValueToStrings,
  fmtTime,
  hexDecodeToString,
  md5Hex,
  md5Hex16,
  uriEncode,
} from './js-utils.js'

/** 协议实现的全部闭包依赖——每次求值构造一个（原 makeJavaBridge 的参数与可变态收进一个对象） */
export interface BridgeDeps {
  ctx: EvalContext
  /** 用户脚本原文（错误定位用） */
  code: string
  loc: SegmentLoc
  facet: Facet
  /** 上一段结果序列化（host.result）——getString* 的默认基内容 */
  result: string
  session: SourceSession
  /** cookie/源变量的按源隔离键（ctx.source ?? ctx.baseUrl ?? ''） */
  sourceKey: string
  evaluateRef: EvaluateRef | undefined
  /** setContent 覆盖基内容（null = 未覆盖 → 用 result） */
  contentBase: string | null
}

/** 沙箱侧挂载点：java 对象（属性名=方法名）/ cookie·source 对象（as 为脚本可见属性名） */
type Mount =
  | { readonly obj: 'java' }
  | { readonly obj: 'cookie'; readonly as: string }
  | { readonly obj: 'source'; readonly as: string }

/** 表行 make 的返回签名约束（仅约束形状；具体参数类型逐行精确声明，供 JavaBridge 推导） */
type HostFn = (...args: never[]) => unknown

interface JavaMethod<N extends string, F extends HostFn> {
  readonly name: N
  /** sync（缺省）：宿主同步返回；async：返回 Promise（当前仅 ajax） */
  readonly mode?: 'async'
  readonly mount: Mount
  /** 宿主实现工厂：闭包捕获 deps；返回的函数即桥方法（内部自带 String()/Number() 防御转换） */
  readonly make: (d: BridgeDeps) => F
}

function method<N extends string, F extends HostFn>(
  name: N,
  mount: Mount,
  make: (d: BridgeDeps) => F,
  mode?: 'async',
): JavaMethod<N, F> {
  return mode === undefined ? { name, mount, make } : { name, mode, mount, make }
}

/** java.getString* 的递归求值（evaluateRef 未注入 → 宁炸不猜） */
function evalRule(d: BridgeDeps, rule: string): EngineValue {
  if (!d.evaluateRef) {
    throw new JsSandboxError(`java 递归求值需要引擎接线（evaluateRef 未注入，规则: ${JSON.stringify(rule)}）`, {
      ...d.loc,
      facet: d.facet,
      script: d.code,
    })
  }
  return d.evaluateRef(rule, d.contentBase ?? d.result)
}

const jar = (d: BridgeDeps): Map<string, string> => d.session.cookieJar(d.sourceKey)
const sourceVars = (d: BridgeDeps): Map<string, string> => d.session.sourceVars(d.sourceKey)

/**
 * JavaBridge 协议表：**唯一登记点**。行序即文档序（与 legado 宿主 API 分组一致）。
 * 添加方法只改此处一行（含实现）——类型面/BOOTSTRAP 名单/宿主分派全部派生跟随。
 */
export const JAVA_PROTOCOL = [
  // ── 网络 ────────────────────────────────────────────────────────────
  method('ajax', { obj: 'java' }, (d) => (url: string): Promise<string> => {
    const fetchFn = d.ctx.fetch
    if (!fetchFn) {
      throw new JsSandboxError('该源未提供网络能力（ctx.fetch 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    // 如实失败：fire-and-forget 防线不在这里挂——唯一一层在引导脚本的 ajax 包装内
    // （受 DSH_NOVEL_NO_GUARD 开关控制），进程级 guard 是常驻最后防线。见 js-sandbox BOOTSTRAP 注释。
    return fetchFn(url).then((r) => r?.body ?? '')
  }, 'async'),
  // ── 沙箱变量（java.get/put）─────────────────────────────────────────
  method('get', { obj: 'java' }, (d) => (key: string): string | undefined =>
    d.ctx.vars?.[String(key)]),
  method('put', { obj: 'java' }, (d) => (key: string, value: unknown): void => {
    d.ctx.vars ??= {}
    d.ctx.vars[String(key)] = String(value)
  }),
  // ── 递归求值 ────────────────────────────────────────────────────────
  method('getString', { obj: 'java' }, (d) => (rule: string, isUrl?: boolean): string => {
    if (isUrl === true) {
      // legado 的 isUrl=true 表示「这条规则产出的是 URL，取到后还要再抓取一次」。
      // v1 桥不实现 fetch-in-bridge；静默把 URL 串当内容返回是错误结果 → 宁炸不猜
      throw new UnsupportedRuleError('getString 的 isUrl=true 在 v1 不支持（不支持取 URL 后自动抓取）', {
        ...d.loc,
        facet: d.facet,
      })
    }
    return engineValueToString(evalRule(d, String(rule)))
  }),
  method('getStringList', { obj: 'java' }, (d) => (rule: string): string[] =>
    engineValueToStrings(evalRule(d, String(rule)))),
  method('getElements', { obj: 'java' }, (d) => (rule: string): Array<{ html: string; text: string }> => {
    const v = evalRule(d, String(rule))
    if (v.kind !== 'nodes') return []
    return v.nodes.toArray().map((_, i) => ({ html: v.nodes.eq(i).toString(), text: v.nodes.eq(i).text() }))
  }),
  method('getElement', { obj: 'java' }, (d) => (rule: string): { html: string; text: string } | null => {
    const v = evalRule(d, String(rule))
    // 非 nodes 或空选择集 → null（旧行为 = getElements(rule)[0] ?? null）
    if (v.kind !== 'nodes' || v.nodes.length === 0) return null
    return { html: v.nodes.eq(0).toString(), text: v.nodes.eq(0).text() }
  }),
  method('setContent', { obj: 'java' }, (d) => (content: unknown): void => {
    // legado：后续 getString* 以设定内容为基，而非上一段 result
    d.contentBase = content === null || content === undefined ? null : String(content)
  }),
  // ── 纯工具（实现走 js-utils，可直测）────────────────────────────────
  method('timeFormat', { obj: 'java' }, () => (ts: number | string): string => fmtTime(ts, false)),
  method('timeFormatUTC', { obj: 'java' }, () => (ts: number | string): string => fmtTime(ts, true)),
  method('base64Encode', { obj: 'java' }, () => (s: string): string => base64Encode(String(s))),
  method('base64Decode', { obj: 'java' }, () => (s: string): string => base64Decode(String(s))),
  method('md5Encode', { obj: 'java' }, () => (s: string): string => md5Hex(String(s))),
  method('md5Encode16', { obj: 'java' }, () => (s: string): string => md5Hex16(String(s))),
  method('encodeURI', { obj: 'java' }, () => (s: string): string => uriEncode(String(s))),
  method('hexDecodeToString', { obj: 'java' }, () => (hex: string): string => hexDecodeToString(String(hex))),
  // ── cookie 垫片（挂 cookie.getCookie/setCookie/removeCookie）─────────
  method('cookieGet', { obj: 'cookie', as: 'getCookie' }, (d) => (name: string): string | null =>
    jar(d).get(String(name)) ?? null),
  method('cookieSet', { obj: 'cookie', as: 'setCookie' }, (d) => (name: string, value: string): void => {
    jar(d).set(String(name), String(value))
  }),
  method('cookieRemove', { obj: 'cookie', as: 'removeCookie' }, (d) => (name: string): void => {
    jar(d).delete(String(name))
  }),
  // ── 源变量垫片（挂 source.getVariable/setVariable/get/put）───────────
  method('sourceGetVariable', { obj: 'source', as: 'getVariable' }, (d) => (): string => {
    const m = d.session.peekSourceVars(d.sourceKey)
    if (m === undefined) return ''
    return JSON.stringify(Object.fromEntries(m))
  }),
  method('sourceSetVariable', { obj: 'source', as: 'setVariable' }, (d) => (value: string): void => {
    const m = sourceVars(d)
    const raw = String(value)
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        m.clear()
        for (const [k, v] of Object.entries(obj)) m.set(k, String(v))
        return
      }
    } catch { /* 非 JSON 对象串：legado 同样存任意串——按单值表落位（键 ''） */ }
    m.clear()
    if (raw !== '') m.set('', raw)
  }),
  method('sourceVarGet', { obj: 'source', as: 'get' }, (d) => (key: string): string | null =>
    sourceVars(d).get(String(key)) ?? null),
  method('sourceVarPut', { obj: 'source', as: 'put' }, (d) => (key: string, value: string): void => {
    sourceVars(d).set(String(key), String(value))
  }),
] as const

type AnyJavaMethod = (typeof JAVA_PROTOCOL)[number]

/** JavaBridge 接口**从表推导**（名称→精确函数签名）——不存在第二份手写 interface */
export type JavaBridge = { [E in AnyJavaMethod as E['name']]: ReturnType<E['make']> }

const PROTOCOL_INDEX = new Map<string, AnyJavaMethod>()
for (const row of JAVA_PROTOCOL) PROTOCOL_INDEX.set(row.name, row)

/** 沙箱引导用挂载清单（从表派生）：引导脚本按此挂 sync 包装，不再手写名单 */
export const SANDBOX_MOUNTS = {
  /** java 对象上的同步方法名（async 行不进——ajax 走引导层特制包装） */
  javaSync: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'java' && r.mode !== 'async' ? [r.name] : [])),
  /** cookie 对象：{ name: 宿主调用名, key: 脚本属性名 } */
  cookie: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'cookie' ? [{ name: r.name, key: r.mount.as }] : [])),
  /** source 对象（__src__）：{ name: 宿主调用名, key: 脚本属性名 } */
  source: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'source' ? [{ name: r.name, key: r.mount.as }] : [])),
}

/**
 * 宿主分派（表查，无逐案 switch）：返回 JSON 可序列化的值；async 行返回 Promise。
 * 参数为引导层 JSON.parse 出的原始数组——实现内部自行防御转换（与旧 switch 逐案
 * String()/Number() 的行为一致）。
 */
export function invokeJavaMethod(d: BridgeDeps, name: string, rawArgs: readonly unknown[]): unknown | Promise<unknown> {
  const row = PROTOCOL_INDEX.get(name)
  if (row === undefined) {
    throw new JsSandboxError(`未知 java 方法: ${name}`, { facet: 'rule', segmentIndex: -1, segmentRaw: name, script: name })
  }
  // 受控的唯一收窄点：表行 make 的精确签名服务类型面推导；宿主分派处按 JSON 原始参数调用。
  const fn = row.make(d) as (...args: unknown[]) => unknown
  return fn(...rawArgs)
}

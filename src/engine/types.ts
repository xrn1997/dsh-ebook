import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'

export type Facet = 'search' | 'detail' | 'toc' | 'content' | 'explore' | 'rule'

export type EngineValue =
  | { kind: 'miss'; detail: string }
  | { kind: 'value'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'nodes'; nodes: Cheerio<AnyNode> }
  | { kind: 'matches'; rows: string[][] }

export interface SegmentLoc { segmentIndex: number; segmentRaw: string }

export interface EvalContext {
  html?: string
  json?: unknown
  baseUrl?: string
  source?: string
  vars?: Record<string, string>
  fetch?: (url: string) => Promise<{ body: string; contentType?: string }>
  jsTimeoutMs?: number
  /** legado jsLib：源级全局 JS 函数库——先于每段 @js 代码在同上下文执行（函数定义全局可见） */
  jsLib?: string
}

export const DEFAULT_JS_TIMEOUT_MS = 2000

// ── parseRule 产物 AST ────────────────────────────────────────────────

export type IndexSpec =
  | { kind: 'all' }
  | { kind: 'index'; value: number }
  | { kind: 'slice'; from: number | null; to: number | null }

export type Segment =
  | { kind: 'default'; mode: string; arg: string | null; index: IndexSpec | null; exclude?: number[] }
  // css 段位置后缀（隐式 CSS 回落 `a.0`/`.odd.0`——legado 语义：选择器 + 取第 n 个；
  // @css: 显式形态无位置后缀概念，恒 null）
  | { kind: 'css'; selector: string; exclude?: number[]; index?: IndexSpec | null }
  | { kind: 'jsonpath'; path: string }
  | { kind: 'xpath'; path: string }
  | { kind: 'allinone'; pattern: string; flags: string }
  | { kind: 'js'; code: string; form: 'at-js' | 'inline' | 'tail' }
  | { kind: 'put'; pairsRaw: string }
  | { kind: 'getvar'; name: string }

/** raws 与 segments 一一对应，供错误定位 */
export interface Branch { segments: Segment[]; raws: string[] }

export interface ReplaceStep { pattern: string; flags: string; replacement: string }

export interface ParsedRule {
  branches: Branch[]
  /** || → 'first'；&& → 'and'；%% → 'zip'；无连接符 → 'first' */
  combinator: 'first' | 'and' | 'zip'
  reverse: boolean
  /** 求值层消费 */
  replaces: ReplaceStep[]
  onlyOne: boolean
}

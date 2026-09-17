import type { Facet, SegmentLoc } from './types.js'

export interface ErrorLoc extends SegmentLoc { facet: Facet }

export class EngineError extends Error {
  readonly facet: Facet
  readonly segmentIndex: number
  readonly segmentRaw: string
  constructor(message: string, loc: ErrorLoc) {
    super(`[${loc.facet}#段${loc.segmentIndex}] ${message}（规则片段: ${JSON.stringify(loc.segmentRaw)}）`)
    this.name = new.target.name
    this.facet = loc.facet
    this.segmentIndex = loc.segmentIndex
    this.segmentRaw = loc.segmentRaw
  }
}

export class UnsupportedRuleError extends EngineError {}

export class RuleEvalError extends EngineError {
  readonly hits: number
  constructor(message: string, loc: ErrorLoc & { hits: number }) {
    super(`${message}（命中 ${loc.hits} 个）`, loc)
    this.hits = loc.hits
  }
}

export class JsSandboxError extends EngineError {
  readonly script: string
  readonly line: number | undefined
  constructor(message: string, loc: ErrorLoc & { script: string; line?: number }) {
    super(loc.line ? `${message}（第${loc.line}行）` : message, loc)
    this.script = loc.script
    this.line = loc.line
  }
}

export function isEngineError(e: unknown): e is EngineError { return e instanceof EngineError }

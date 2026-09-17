import render from 'dom-serializer'
import { evaluate, RuleEvalError } from '../engine/index.js'
import type { EngineValue, Facet } from '../engine/index.js'
import { engineFetch } from './engine-fetch.js'
import { headerOf } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import type { NovelSource } from './types.js'

// 兼容 re-export：absUrl 迁至 url.ts（拆 request↔bridge 环）、engineFetch 迁至 engine-fetch.ts
// （请求组装语义归 request.assembleRequest）——既有 import 路径保持可用。
export { absUrl } from './url.js'
export { engineFetch } from './engine-fetch.js'

/** 页面快照（URL + 解码后正文 + 可选解析好的 JSON）——门面层传给字段求值的输入。
 *  `url` 是**实际落地**地址（跟随重定向后，相对链接按其解析——浏览器语义）；
 *  `requestedUrl` 只作诊断（两者不同＝被跳转走了，报错里点名，站点整站 302 一眼可见）。 */
export interface Page { url: string; requestedUrl?: string; body: string; json?: unknown }

/** 条目片段上的子规则求值器：与引擎内部 evaluateRef 同构（片段即 html 上下文） */
export interface SubRuleEval {
  (rule: string, ctx: { html?: string; json?: unknown; baseUrl: string }, facet: Facet): Promise<EngineValue>
}

/** 值规约（链终点取值）：miss→null；value→text；list→join('\n')；matches→取每行首列 join。 */
export function firstValue(v: EngineValue, facet: Facet = 'rule'): string | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return v.text
    case 'list': return v.items.join('\n')
    case 'matches': return v.rows.map((r) => r[0] ?? '').join('\n')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** 多值规约：miss→null；value→[text]；list→items；matches→每行首列。 */
export function listValue(v: EngineValue, facet: Facet = 'rule'): string[] | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return [v.text]
    case 'list': return v.items
    case 'matches': return v.rows.map((r) => r[0] ?? '')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** 列表页条目提取：nodes→逐节点 HTML 片段；list→逐项；matches→行 join('\t')；miss→[]（零结果合法）。 */
export function extractItems(v: EngineValue): string[] {
  switch (v.kind) {
    case 'miss': return []
    case 'value': return [v.text]
    case 'list': return [...v.items]
    case 'matches': return v.rows.map((r) => r.join('\t'))
    // encodeEntities:'utf8'：默认选项把 CJK 全部编码成 &#x…; 数字实体；'utf8' 只转义 &<> 保留可读原文
    case 'nodes': return v.nodes.toArray().map((n) => render(n, { encodeEntities: 'utf8' }))
  }
}

/** 源级求值上下文组装单点：「引擎上下文该有哪些字段」的唯一实现——
 *  fetch（守门 + auth 头合并）/ source / vars / jsLib 全在此拼装；面（facet）只决定
 *  html/json/baseUrl 的取值。此前 makeSubEval 与 search-template.scriptOf 各拼一份，
 *  runLogin 手拼漏 jsLib/vars（@js 登录调 jsLib 函数只在登录那一刻炸 not defined），
 *  tocUrlOf 连 source/fetch 都没有。新面接入 = 传参数，不 = 再手拼一份字段。 */
export function engineContextOf(
  fetcher: Fetcher, source: NovelSource,
  opts: { baseUrl: string; html?: string; json?: unknown; vars?: Record<string, string> },
): {
  html?: string; json?: unknown; baseUrl: string; source: string
  vars?: Record<string, string>; fetch: ReturnType<typeof engineFetch>; jsLib?: string
} {
  return {
    ...(opts.html === undefined ? {} : { html: opts.html }),
    ...(opts.json === undefined ? {} : { json: opts.json }),
    baseUrl: opts.baseUrl,
    source: source.baseUrl,
    ...(opts.vars === undefined ? {} : { vars: opts.vars }),
    fetch: engineFetch(fetcher, headerOf(source)),
    ...(source.rules.jsLib === null ? {} : { jsLib: source.rules.jsLib }),
  }
}

/** 缝合器：源级 SubRuleEval——上下文组装走 engineContextOf 单点。 */
export function makeSubEval(fetcher: Fetcher, source: NovelSource, vars?: Record<string, string>): SubRuleEval {
  return (rule, ctx, facet) =>
    evaluate(rule, engineContextOf(fetcher, source, {
      baseUrl: ctx.baseUrl, html: ctx.html, json: ctx.json, vars,
    }), facet)
}

/** 链终点不该剩节点集：带 facet 与节点数的段级错误（segmentIndex -1 = 服务层规约层） */
function nodesError(v: Extract<EngineValue, { kind: 'nodes' }>, facet: Facet): RuleEvalError {
  return new RuleEvalError('结果不是取值而是节点集', {
    facet,
    segmentIndex: -1,
    segmentRaw: '(服务层规约)',
    hits: v.nodes.length,
  })
}

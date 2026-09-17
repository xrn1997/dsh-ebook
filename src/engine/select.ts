import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode, Element, Text } from 'domhandler'
import type { EngineValue, Facet, IndexSpec, Segment, SegmentLoc } from './types.js'
import { RuleEvalError } from './errors.js'
import { cleanText, isNodeValue, nodeText } from './dom.js'

type DefaultSegment = Extract<Segment, { kind: 'default' }>

const SELECT_MODES = ['class', 'id', 'tag', 'child', 'children'] as const
const GET_MODES = ['text', 'textAll', 'ownText', 'html', 'all', 'href', 'src', 'content', 'textNodes'] as const

/**
 * 位置后缀统一口径：
 * - null / all → 整个数组
 * - index：第 n 个（负数从尾数）；越界 → 'miss'（不抛）
 * - slice：半开区间 [from,to)，负数从尾数，越界静默裁剪
 *
 * 设计文档：docs/design/engine.md
 */
export function applyIndex<T>(arr: T[], index: IndexSpec | null): T[] | 'miss' {
  if (index === null || index.kind === 'all') return arr
  if (index.kind === 'index') {
    const i = index.value < 0 ? arr.length + index.value : index.value
    if (i < 0 || i >= arr.length) return 'miss'
    return [arr[i]]
  }
  const from = index.from === null ? 0 : (index.from < 0 ? arr.length + index.from : index.from)
  const to = index.to === null ? arr.length : (index.to < 0 ? arr.length + index.to : index.to)
  return arr.slice(Math.max(from, 0), Math.max(to, 0))
}

/**
 * `!` 排除口径（官方文档：!是排除，0 是第1个，-1 最后一个，: 隔开多值）：
 * 从结果集去掉指定位置的元素；越界位置静默忽略（排除语义是过滤，不是定位）。
 */
export function applyExclude<T>(arr: T[], exclude: number[] | undefined): T[] {
  if (exclude === undefined || exclude.length === 0) return arr
  const drop = new Set(exclude.map((v) => (v < 0 ? arr.length + v : v)))
  return arr.filter((_, i) => !drop.has(i))
}

/** 选择失败原因（规约单点） */
export type PickedOutcome<T> =
  | { ok: true; items: T[] }
  | { ok: false; reason: 'zero' | 'excluded' | 'oob' | 'sliced' }

/**
 * 选择结果后处理单点（规约单点）：exclude 过滤 → index 取位 → 空态裁决，唯一实现
 * （default 选择段与 css 段同源——此前两处各写一份且已语义分叉：切片裁空 default 给空 List、
 * css 给 Miss，而空 List 不是节点集、中链必抛「上游结果不是节点集」）。
 * 口径：四态皆「选择失败」语义，调用方按 reason 组 Miss detail；
 * 「合法零条目（空 List）」只属于取值段（getValue：元素在、取值全空）。legado：先排除再取位。
 */
export function reducePicked<T>(
  arr: T[], exclude: number[] | undefined, index: IndexSpec | null,
): PickedOutcome<T> {
  if (arr.length === 0) return { ok: false, reason: 'zero' }
  const excluded = applyExclude(arr, exclude)
  if (excluded.length === 0) return { ok: false, reason: 'excluded' }
  const applied = applyIndex(excluded, index)
  if (applied === 'miss') return { ok: false, reason: 'oob' }
  if (applied.length === 0) return { ok: false, reason: 'sliced' }
  return { ok: true, items: applied }
}

/**
 * default 段求值：选择段（class/id/tag/child/children）产出节点集；
 * 取值段（text/textAll/ownText/html/all/href/src/content/textNodes）产出字符串值。
 * 第 2 参 $（CheerioAPI）用于重建节点集与逐节点取值。
 */
export function evalDefault(
  seg: DefaultSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  if (!isNodeValue(cur)) {
    throw new RuleEvalError('上游结果不是节点集，无法继续选择', { ...loc, facet, hits: 0 })
  }

  if (!(SELECT_MODES as readonly string[]).includes(seg.mode)) {
    if ((GET_MODES as readonly string[]).includes(seg.mode)) return getValue(seg, $, cur, loc, facet)
    // classifySegment（parse）已挡掉未知 mode，此处兜底
    throw new RuleEvalError('未知 default 段模式', { ...loc, facet, hits: 0 })
  }

  let picked: Cheerio<AnyNode>
  try {
    switch (seg.mode) {
      // legado `class.x y` = getElementsByClassName("x y") = 同时含所有类 → CSS `.x.y` 链
      // （此前直译 `.x y` 后代选择器 → 恒零命中——真实源 class.col-12 col-md-6 3 源）
      case 'class': picked = cur.find('.' + (seg.arg ?? '').trim().split(/\s+/).filter(Boolean).join('.')); break
      case 'id': picked = cur.find('#' + seg.arg); break
      case 'tag': picked = cur.find(seg.arg!); break
      case 'child': picked = cur.children(seg.arg!); break
      default: picked = cur.children(); break // children
    }
  } catch (e) {
    // 隐式回落的选择器形态非法（如 tag 名含 . 等）→ 包成 RuleEvalError 带段定位（错误分类不泄漏裸 Error）
    throw new RuleEvalError(`选择器无法解析：${seg.mode}.${seg.arg ?? ''}（${(e as Error).message}）`, { ...loc, facet, hits: 0 })
  }

  const pickedArr = picked.toArray()
  // 空态裁决走 reducePicked 单点：零命中/排除空/越界/切片裁空一律 Miss（选择失败）
  const reduced = reducePicked(pickedArr, seg.exclude, seg.index)
  if (!reduced.ok) {
    const detail =
      reduced.reason === 'zero' ? `选择 ${seg.mode}.${seg.arg ?? ''} 未命中节点`
        : reduced.reason === 'excluded' ? `选择 ${seg.mode}.${seg.arg ?? ''} 排除 ${JSON.stringify(seg.exclude)} 后为空`
          : reduced.reason === 'oob' ? `位置 ${JSON.stringify(seg.index)} 越界`
            : `位置 ${JSON.stringify(seg.index)} 切片裁空（原集合 ${pickedArr.length} 项）`
    return { kind: 'miss', detail }
  }
  return { kind: 'nodes', nodes: $(reduced.items) }
}

/**
 * 取值段：单节点 → Value；多节点 → List；零节点/取位失败 → Miss；取到空（合法零条目）→ 空 List。
 * 空态/取位裁决复用 reducePicked 单点：此前本函数自写一份排除+applyIndex+空态逻辑，
 * 与选择段分叉——切片裁空在选择段给 Miss、取值段给空 List（同一 `x.5:9` 后缀两种结果）。
 * 现与选择段同口径：zero/excluded/oob/sliced 一律「取位失败」→ Miss；
 * 「合法零条目（元素在、取值全空）」仍是空 List（见函数末尾 texts.length === 0 分支）。
 */
function getValue(
  seg: DefaultSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  const arr = cur.toArray()
  const reduced = reducePicked(arr, seg.exclude, seg.index)
  if (!reduced.ok) {
    const detail =
      reduced.reason === 'zero' ? '取值时上游节点集为空'
        : reduced.reason === 'excluded' ? `取值排除 ${JSON.stringify(seg.exclude)} 后为空`
          : reduced.reason === 'oob' ? `位置 ${JSON.stringify(seg.index)} 越界`
            : `位置 ${JSON.stringify(seg.index)} 切片裁空（原集合 ${arr.length} 项）`
    return { kind: 'miss', detail }
  }
  const applied = reduced.items

  // textNodes：全部后代文本节点的文本列表（逐文本节点输出一条）
  if (seg.mode === 'textNodes') {
    const items: string[] = []
    for (const el of applied) {
      const textNodes: Text[] = []
      collectTextNodes(el, textNodes)
      for (const node of textNodes) {
        const t = cleanText(node.data)
        if (t !== '') items.push(t)
      }
    }
    return { kind: 'list', items }
  }

  const texts: string[] = []
  for (const el of applied) {
    const t = extract($, el, seg.mode)
    if (t !== '') texts.push(t)
  }
  if (texts.length === 0) return { kind: 'list', items: [] } // 取到空（合法零条目），区别于 Miss
  if (applied.length === 1 && arr.length === 1) return { kind: 'value', text: texts[0] }
  return { kind: 'list', items: texts }
}

/** 深度优先收集全部后代文本节点（含元素内层，如 <b> 内文本） */
function collectTextNodes(node: AnyNode, out: Text[]): void {
  if (node.type === 'text') {
    out.push(node as Text)
    return
  }
  const children = (node as Element).children
  if (children) for (const c of children) collectTextNodes(c as AnyNode, out)
}

/** 直系文本节点合并（排除后代元素内的文本） */
function directText($: CheerioAPI, el: AnyNode): string {
  return $(el).contents().filter((_, node) => node.type === 'text').text()
}

function extract($: CheerioAPI, el: AnyNode, mode: string): string {
  switch (mode) {
    // text：**全部后代文本**（legado/Jsoup `element.text()` 口径），块级边界落成换行。
    // 此前实现按「严格直系文本」收（与 ownText 同义），实测打不动真实源：
    // 笔趣阁正文规则 `.con@text` 而 `.con` 里全是 <p> 子元素 → 直系文本为空 → 正文零命中。
    // legado 侧 li/div 容器取文本同样是后代文本（JvSoup .text()），android-ebook 同源语义。
    case 'text':
      return nodeText(el)
    // ownText：严格直系文本节点（排除后代元素内的文本，如 <p>外<b>内</b>尾</p> → 外尾）。
    // 与 text 的区别就在这里（legado 的 ownText 语义），无直系文本 → 空，不做后代兜底。
    case 'ownText':
      return cleanText(directText($, el))
    case 'textAll':
      return cleanText($(el).text())
    case 'html':
      return $(el).html() ?? ''
    case 'all':
      return $.html(el) ?? ''
    // 原样属性值（相对 URL 的绝对化由 service 层负责，引擎不拼）。
    // legado 口径：自身属性为空时向下兜底——href/src 取第一个含该属性的后代，
    // content 取第一个 meta 的 content（钉死语义：li 上 @href → 内层 a 的 href）。
    // 但 html/body 是片段加载的人造包装（非用户规则所指）：链首 $('*') 上下文里它们的
    // 兜底会与目标元素自身属性重复出多份同值（@href ×3 → \n 拼接 → URL 解析剥换行拼接成事故），
    // 包装元素一律不兜底——目标元素自身仍在节点集里正常取值。
    case 'href':
    case 'src': {
      const own = (el as Element).attribs?.[mode] ?? ''
      if (own !== '') return own
      const tag = (el as Element).name
      if (tag === 'html' || tag === 'body') return ''
      return $(el).find(`[${mode}]`).first().attr(mode) ?? ''
    }
    case 'content': {
      const own = (el as Element).attribs?.content ?? ''
      if (own !== '') return own
      const tag = (el as Element).name
      if (tag === 'html' || tag === 'body') return ''
      return $(el).find('meta[content]').first().attr('content') ?? ''
    }
    default:
      return cleanText($(el).text())
  }
}

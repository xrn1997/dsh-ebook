import * as cheerio from 'cheerio'
import type { Cheerio } from 'cheerio'
import { isTag, isText } from 'domhandler'
import type { AnyNode, Element, Text } from 'domhandler'

/** cheerio.load 薄封装，供 select / css 段共用 */
export function loadHtml(html: string): cheerio.CheerioAPI {
  return cheerio.load(html)
}

/** 文本清洗：全角空格 　 → 半角空格、连续空白折叠为单空格、去首尾空白 */
export function cleanText(s: string): string {
  return s.replace(/\u3000/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim()
}

/** 判定「上游结果是节点集」（Cheerio 集有 length 与 text()；普通 Value 对象没有） */
export function isNodeValue(v: unknown): v is Cheerio<AnyNode> {
  return typeof v === 'object' && v !== null && 'length' in (v as any) && typeof (v as any).text === 'function'
}

// ── 块级感知的纯文本（本插件的正文契约：按 \n 分段）─────────────────────
//
// 为什么不是 cheerio 的 .text()：它把整棵子树拼成一整行（`<p>a</p><p>b</p>` → `ab`），
// 阅读器/导出按 \n 分段就只剩一个巨型段落。legado 的 Jsoup `.text()` 也归一成一行——
// 本插件的信息量与之一致，只是把块级边界落成换行（可读性，不丢字）。
// 另见 services/content.ts：@html 规则收回来的是 HTML 片段，同一套口径转纯文本。

/** 块级元素：边界即换行（浏览器渲染语义） */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'pre', 'hr', 'form', 'fieldset', 'address',
])

/** 行内元素：只留文本（单独列出用于「像不像 HTML」判定） */
const INLINE_TAGS = ['br', 'span', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'font', 'img', 'sub', 'sup', 'small', 'code', 'mark', 'wbr']

/** 非正文元素：整棵子树丢弃（脚本/样式/表单控件/文档头） */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'audio', 'video',
  'head', 'title', 'meta', 'link', 'base', 'input', 'button', 'select', 'textarea', 'option',
])

/**
 * 节点子树 → 纯文本：块级边界换行、行内标签只留文本、实体解码、逐行收敛空白（空行不留）。
 * 直接吃 domhandler 节点（cheerio 的活节点，不重新解析）。
 */
export function nodeText(node: AnyNode): string {
  const lines: string[] = []
  let buf = ''
  /** 收当前行：nbsp/全角空格归一为空格、空白折叠、trim；空行不入列 */
  const flush = (): void => {
    const line = buf.replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim()
    if (line !== '') lines.push(line)
    buf = ''
  }
  const visit = (n: AnyNode): void => {
    if (isText(n)) { buf += (n as Text).data; return }
    if (!isTag(n)) {
      // Document/片段容器（cheerio 的 root）：无标签语义，继续下钻子节点
      const kids = (n as { children?: AnyNode[] }).children
      if (kids !== undefined) for (const child of kids) visit(child)
      return
    }
    const el = n as Element
    const tag = el.name.toLowerCase()
    if (SKIP_TAGS.has(tag)) return
    const block = BLOCK_TAGS.has(tag)
    if (block || tag === 'br') flush()                       // 换行点：先收上一行
    if (tag === 'br') return                                 // 空元素：无子树
    for (const child of el.children) visit(child)
    if (block) flush()                                       // 块级终点：收本块
  }
  visit(node)
  flush()
  return lines.join('\n')
}

/** 「这是一段 HTML 标记」判据：白名单标签名 + **真正的属性语法**（`<p>` / `</p>` / `<br/>` / `<p class="x">`）。
 *  属性段按 ASCII 属性名/值文法收，故 `<b 不是标签>` 这类正文里的尖括号内容不算标签——
 *  判错的方向选保守：漏判只是标签原样显示（源里本就少见），误判会吃掉正文文字。 */
const ATTR = String.raw`(?:\s+[a-zA-Z_:][-\w:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*`
const TAG_NAME = `(?:${[...BLOCK_TAGS, ...INLINE_TAGS].join('|')})`
const HTML_TAG_RE = new RegExp(`</?${TAG_NAME}${ATTR}\\s*/?>`, 'i')

/** 串里是否含真 HTML 标签（白名单口径） */
export function looksLikeHtml(s: string): boolean {
  return HTML_TAG_RE.test(s)
}

/** HTML 片段 → 纯文本（块级边界换行） */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html)
  const root = $.root().get(0)
  return root === undefined ? '' : nodeText(root)
}

/** 翻页三闸跟进（目录/正文共用）：现状真相与口径见 docs/design/services.md。 */
import { absUrl, firstValue } from './bridge.js'
import type { Page, SubRuleEval } from './bridge.js'
import { isSameChapterPage } from './chapter-page.js'
import { stripUrlOption } from './request.js'
import type { Facet } from '../engine/index.js'

export interface FollowOptions {
  maxPages: number
  /** 正文分页专用：入口章地址——候选下一页必须仍属本章，否则停（防串章，见 chapter-page.ts） */
  sameChapterBase?: string
}
export interface FollowResult<T> { items: T[]; pages: number; stoppedBy: 'end' | 'zero-new' | 'loop' | 'cap' | 'chapter-boundary' }

export async function followPages<T>(
  startUrl: string, fetchPage: (url: string) => Promise<Page>,
  extract: (page: Page) => Promise<T[]>, nextRule: string,
  keyOf: (item: T) => string, opts: FollowOptions, facet: Facet, subEval: SubRuleEval,
): Promise<FollowResult<T>> {
  const items: T[] = []
  const seen = new Set<string>()
  let url: string | null = startUrl
  let pages = 0
  let stoppedBy: FollowResult<T>['stoppedBy'] = 'end'
  while (url !== null) {
    if (pages >= opts.maxPages) { stoppedBy = 'cap'; break }
    const page = await fetchPage(url)
    pages++
    const pageItems = await extract(page)
    let newCount = 0
    for (const it of pageItems) {
      const k = keyOf(it)
      if (seen.has(k)) continue
      seen.add(k); items.push(it); newCount++
    }
    if (pageItems.length - newCount > 0) { stoppedBy = 'loop'; break }   // 回环闸：出现重复条目即判到底（软404防御）
    if (pageItems.length === 0) { stoppedBy = 'zero-new'; break }        // 零新增闸：空页不追 next
    const nv = await subEval(nextRule, { html: page.body, json: page.json, baseUrl: page.url }, facet)
    const nextHref = firstValue(nv, facet)
    const next = absUrl(nextHref === null ? null : stripUrlOption(nextHref), page.url)
    // 串章闸：末页「下一页」常指向下一章（笔趣阁 `.prenext`）——跟进会把后续章节拼成本章
    if (next !== null && opts.sameChapterBase !== undefined && !isSameChapterPage(next, opts.sameChapterBase)) {
      stoppedBy = 'chapter-boundary'
      break
    }
    url = next
  }
  return { items, pages, stoppedBy }
}

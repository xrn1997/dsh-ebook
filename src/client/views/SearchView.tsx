import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { paramRoutes, queries, ROUTES, shelfBody } from '../../shared/wire.js'
import type { SearchPlan } from '../../shared/wire.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { runBatchedSearch } from '../search-batch.js'
import { navigate, routeStore, useStore } from '../store.js'
import { EmptyState, ProgressBar, SearchIcon, StatusBadge } from './bits.js'
import type { SearchGroup, SearchHit } from './types.js'

/** 搜索：分批进度（630 源一次性请求是黑盒等待——分批 + 进度条 + 命中增量渲染）+ 逐源分组（失败组折叠）。
 *  IA 与呈现口径：分批/进度/失败隔离/runId 防线一字不动（search-batch + 接线测试钉死）；
 *  简约版只收敛呈现——进度一条线 + 灰字、组头=源名+状态徽标+灰字计数、命中行 hover 行式、
 *  失败源收一行 details。测试钉子：placeholder「书名 / 作者」、form aria-label「搜索书籍」
 *  （getByRole('form') 依赖）、空态两分支文案原文。
 * deps 注入：runId 陈旧回调防线是接线层——此前不可测，历史 bug 形态（一轮迟到批次
 *  污染二轮结果）第一次可以被测试钉死。
 *  本轮两处呈现改动：
 *  ① 收尾留痕——进度条原先在完成那一刻整块消失，用户无从判断「搜完了」还是「断了」，
 *     现在完成行常驻（本轮搜了几家 / 命中几本 / 几家未响应）。
 *  ② 命中行改「容器 + 主按钮 + 兄弟动作钮」：旧结构 div[role=button] 里套 button，
 *     键盘 Enter 什么都不发生、读屏念「按钮含按钮」（守卫 ui-system.test.tsx）。 */
const SEARCH_BATCH_SIZE = 20
const SEARCH_CONCURRENCY = 3

/** 一轮搜索的收口数字（进度条退场后仍在） */
interface SearchSummary { sources: number; hits: number; found: number; failed: number }

/** 收口算式：命中本数 = 各命中组之和；found = 有命中的源数；failed = 带 error 的组数。
 *  与 known-开口 #4 的「三处百分比各算一份」不同源——这是**计数**不是百分比，只此一处。 */
function sumRound(groups: SearchGroup[], sources: number): SearchSummary {
  let hits = 0
  let found = 0
  let failed = 0
  for (const g of groups) {
    if (g.error === undefined) { hits += g.hits.length; found += 1 } else failed += 1
  }
  return { sources, hits, found, failed }
}

export function SearchView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const { route } = useStore(routeStore)
  const initialKeyword = route.name === 'search' ? route.keyword ?? '' : ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const [groups, setGroups] = useState<SearchGroup[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [summary, setSummary] = useState<SearchSummary | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [emptyPlan, setEmptyPlan] = useState(false)   // plan 返回 0 源（全部停用）——与「搜了没命中」区分
  const runId = useRef(0)                             // 新一轮搜索作废旧一轮的迟到回调
  const accRef = useRef<SearchGroup[]>([])            // 本轮累计组（onProgress 逐批 push，finally 复算收口）
  const planTotalRef = useRef(0)                      // 本轮真实参搜源数（plan 说了算）
  useEffect(() => { if (initialKeyword !== '') search(initialKeyword) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const search = (kw: string): void => {
    const trimmed = kw.trim()
    if (trimmed === '') return
    const id = ++runId.current
    accRef.current = []
    planTotalRef.current = 0
    setGroups(null)
    setSearchError(null)
    setEmptyPlan(false)
    setSummary(null)
    setProgress({ done: 0, total: 0 })
    void (async () => {
      // 参与集唯一主人在服务端（search/plan）——客户端不再自拉源表重推导启停 invariant
      const plan = await deps.apiGet<SearchPlan>(ROUTES.searchPlan.path)
      const ids = plan.sourceIds
      if (runId.current !== id) return
      planTotalRef.current = ids.length
      setProgress({ done: 0, total: ids.length })
      // 0 源：runBatchedSearch 早退、onProgress 一次不调 → groups 恒 null、progress finally 复位 null →
      // 页面只剩 0% 进度条（既无结果空态也无错误）。显式置空组让空态呈现。
      if (ids.length === 0) { setEmptyPlan(true); setGroups([]); return }
      await runBatchedSearch(
        ids,
        (batch) => deps.apiGet<SearchGroup[]>(queries.search({ keyword: trimmed, sourceIds: batch })),
        {
          batchSize: SEARCH_BATCH_SIZE,
          concurrency: SEARCH_CONCURRENCY,
          onProgress: (done, total, added) => {
            if (runId.current !== id) return           // 旧一轮迟到批次：丢弃
            accRef.current.push(...added)
            setGroups([...accRef.current])             // 增量渲染：命中的源边搜边出
            setProgress({ done, total })
          },
        },
      )
    })().catch((e) => {
      if (runId.current !== id) return
      setSearchError(e instanceof Error ? e.message : String(e))
    }).finally(() => {
      if (runId.current !== id) return
      setSummary(sumRound(accRef.current, planTotalRef.current))   // 收尾留痕：进度条退场后这行常驻
      setProgress(null)
    })
  }

  // 进度条在完成后不许倒退回 0%：条子中态走 done/total，收尾态恒满
  const pct = progress === null
    ? (summary === null ? 0 : 100)
    : progress.total === 0
      ? 0
      : Math.min(100, Math.round((progress.done / progress.total) * 100))
  const live = progress !== null
    ? (progress.total === 0
      ? <>正在获取源列表…</>
      : <>已搜 <b>{progress.done}</b>/{progress.total} 家书源 · 命中源会陆续出现在下方</>)
    : summary === null || summary.sources === 0
      ? null
      : <>本轮搜过 <b>{summary.sources}</b> 家 · 命中 <b>{summary.hits}</b> 本（来自 {summary.found} 家）· <b>{summary.failed}</b> 家未响应</>
  return (
    <div data-novel-view="search" className="novel-view">
      <div className="novel-wrap">
        <div className="novel-search-bar">
          <button className="novel-btn" onClick={() => navigate({ name: 'shelf' })}>‹ 书架</button>
          <form
            onSubmit={(e) => { e.preventDefault(); search(keyword) }}
            className="novel-search-form"
            aria-label="搜索书籍"
          >
            <label className="novel-searchbox">
              <SearchIcon />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="书名 / 作者"
                aria-label="搜索书籍"
              />
            </label>
            <button type="submit" className="novel-btn primary" disabled={progress !== null}>
              {progress === null ? '搜索' : '搜索中…'}
            </button>
          </form>
        </div>
        <div data-novel-search-progress className="novel-search-prog">
          <ProgressBar pct={pct} />
          {live === null ? null : <div className="novel-prog-text"><span>{live}</span></div>}
        </div>
        {searchError === null ? null : (
          <div className="novel-err novel-note-md">搜索中断：{searchError}</div>
        )}
        {groups !== null && progress === null && groups.length === 0 && (
          emptyPlan
            ? <EmptyState title="没有参与搜索的书源" hint="全部书源都已停用，或尚未导入——书源在「小说 → 书源管理」中导入" />
            : <EmptyState title="没有结果" hint="换个关键词，或在「小说 → 书源管理」中导入更多书源" />
        )}
        {groups !== null && renderGroups(groups, deps)}
      </div>
    </div>
  )
}

/** 命中行：行内双动作——主按钮 = 加架并直接阅读；「＋ 加书架」只加架。
 * 结构：容器 .novel-row + 主钮 .novel-row-main + 兄弟动作钮（**不嵌套**）。
 * apiSend 经 deps 透传（行内接线同样可被测试驱动）。
 * url 守卫口径现状：undefined/null 渲染不可点行；空串 '' 的问题是 client.md 已知开口
 * 「`hit.url` 是空串时会用空 bookKey 加书」，本轮呈现层重构不改该口径（修法需 wire/守卫二选一拍板）。 */
function HitRow({ sourceId, hit, deps }: { sourceId: string; hit: SearchHit; deps: ClientCoreDeps }): ReactNode {
  const [added, setAdded] = useState(false)
  const add = (): Promise<void> => {
    const bookKey = hit.url ?? ''
    return deps.apiSend('PUT', paramRoutes.shelfKey(bookKey), shelfBody.addBook({
      sourceId, title: hit.title, author: hit.author, coverUrl: hit.coverUrl,
      intro: hit.intro, lastChapterName: hit.lastChapterName,
    })).then(() => { setAdded(true) })
  }
  const read = (): void => {
    // 点行直接阅读：先加架（进度保存依赖书架条目）再进阅读器；已加过则幂等
    void add().catch(() => undefined).then(() => navigate({ name: 'reader', sourceId, bookKey: hit.url ?? '', title: hit.title }))
  }
  const sub = `${hit.author ?? ''}${hit.lastChapterName === undefined ? '' : ` · ${hit.lastChapterName}`}`
  if (hit.url === undefined || hit.url === null) {
    // 无 url：这条既进不了阅读器也加不了架——如实呈现为一行文字，不给假的可点态
    return (
      <div className="novel-row novel-row-dead">
        <span className="novel-hit-title">{hit.title}</span>
        <span className="novel-hit-sub">{sub}</span>
      </div>
    )
  }
  return (
    <div className="novel-row">
      <button className="novel-row-main" onClick={read} aria-label={`阅读 ${hit.title}`}>
        <span className="novel-hit-title">{hit.title}</span>
        <span className="novel-hit-sub">{sub}</span>
      </button>
      <button className="novel-btn sm" disabled={added} onClick={() => { void add().catch(() => undefined) }}>
        {added ? '已在书架' : '＋ 加书架'}
      </button>
    </div>
  )
}

/** 分组渲染：有命中的源成组（组头=源名+状态徽标+灰字计数）；失败源折叠一行 details——
 *  失败折叠的呈现口径（点名 code / message / statusDetail）原样保留，仅容器换简约版类。
 *  组头原先「绿点 + 带点的状态徽标」双重点：点不携带徽标之外的信息，去掉。 */
function renderGroups(groups: SearchGroup[], deps: ClientCoreDeps): ReactNode {
  const hits = groups.filter((g) => g.error === undefined)
  const failed = groups.filter((g) => g.error !== undefined)
  if (hits.length === 0 && failed.length === 0) return null
  return (
    <div className="novel-groups">
      {hits.map((g) => (
        <section key={g.sourceId} className="novel-group">
          <header className="novel-group-head">
            <strong>{g.sourceName}</strong>
            {/* 状态走 bits.StatusBadge 的中文映射（verified→「可用」）——原始状态字不进 UI */}
            <StatusBadge status={g.status} />
            <span className="novel-muted">{g.hits.length} 本</span>
          </header>
          <div className="novel-list">
            {g.hits.map((h, i) => <HitRow key={i} sourceId={g.sourceId} hit={h} deps={deps} />)}
          </div>
        </section>
      ))}
      {failed.length === 0 ? null : (
        <details className="novel-fail">
          <summary>{failed.length} 家书源未响应（多为站点不可达，展开看原因）</summary>
          <div className="novel-group novel-fail-list">
            {failed.map((g) => (
              <div key={g.sourceId}>
                <span>{g.sourceName}</span>
                <span className="novel-err"> · {g.error?.code}</span>
                <div className="novel-note-sm">{g.error?.message}{g.statusDetail === undefined ? '' : `（${g.statusDetail}）`}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

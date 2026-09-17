import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { paramRoutes, queries, ROUTES, shelfBody } from '../../shared/wire.js'
import type { SearchPlan } from '../../shared/wire.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { runBatchedSearch } from '../search-batch.js'
import { navigate, routeStore, useStore } from '../store.js'
import { EmptyState, ProgressBar } from './bits.js'
import type { SearchGroup, SearchHit } from './types.js'

/** 搜索：分批进度（630 源一次性请求是黑盒等待——分批 + 进度条 + 命中增量渲染）+ 逐源分组（失败组折叠）。
 * deps 注入：runId 陈旧回调防线是接线层——此前不可测，历史 bug 形态（一轮迟到批次
 *  污染二轮结果）第一次可以被测试钉死。 */
const SEARCH_BATCH_SIZE = 20
const SEARCH_CONCURRENCY = 3

export function SearchView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const { route } = useStore(routeStore)
  const initialKeyword = route.name === 'search' ? route.keyword ?? '' : ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const [groups, setGroups] = useState<SearchGroup[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [emptyPlan, setEmptyPlan] = useState(false)   // plan 返回 0 源（全部停用）——与「搜了没命中」区分
  const runId = useRef(0)                             // 新一轮搜索作废旧一轮的迟到回调
  useEffect(() => { if (initialKeyword !== '') search(initialKeyword) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const search = (kw: string): void => {
    const trimmed = kw.trim()
    if (trimmed === '') return
    const id = ++runId.current
    setGroups(null)
    setSearchError(null)
    setEmptyPlan(false)
    setProgress({ done: 0, total: 0 })
    void (async () => {
      // 参与集唯一主人在服务端（search/plan）——客户端不再自拉源表重推导启停 invariant
      const plan = await deps.apiGet<SearchPlan>(ROUTES.searchPlan.path)
      const ids = plan.sourceIds
      if (runId.current !== id) return
      setProgress({ done: 0, total: ids.length })
      // 0 源：runBatchedSearch 早退、onProgress 一次不调 → groups 恒 null、progress finally 复位 null →
      // 页面只剩 0% 进度条（既无结果空态也无错误）。显式置空组让空态呈现。
      if (ids.length === 0) { setEmptyPlan(true); setGroups([]); return }
      const acc: SearchGroup[] = []
      await runBatchedSearch(
        ids,
        (batch) => deps.apiGet<SearchGroup[]>(queries.search({ keyword: trimmed, sourceIds: batch })),
        {
          batchSize: SEARCH_BATCH_SIZE,
          concurrency: SEARCH_CONCURRENCY,
          onProgress: (done, total, added) => {
            if (runId.current !== id) return           // 旧一轮迟到批次：丢弃
            acc.push(...added)
            setGroups([...acc])                        // 增量渲染：命中的源边搜边出
            setProgress({ done, total })
          },
        },
      )
    })().catch((e) => {
      if (runId.current !== id) return
      setSearchError(e instanceof Error ? e.message : String(e))
    }).finally(() => {
      if (runId.current !== id) return
      setProgress(null)
    })
  }

  const pct = progress === null || progress.total === 0
    ? 0
    : Math.min(100, Math.round((progress.done / progress.total) * 100))
  return (
    <div data-novel-view="search" className="novel-view">
      <button className="novel-btn sm" onClick={() => navigate({ name: 'shelf' })}>← 首页</button>
      <form
        onSubmit={(e) => { e.preventDefault(); search(keyword) }}
        className="novel-toolbar"
        aria-label="搜索书籍"
      >
        <input
          className="novel-input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="书名 / 作者"
          style={{ flex: 1 }}
        />
        <button type="submit" className="novel-btn primary" disabled={progress !== null}>
          {progress === null ? '搜索' : '搜索中…'}
        </button>
      </form>
      <div data-novel-search-progress className="novel-group">
        <ProgressBar pct={pct} />
        {progress === null ? null : (
          <span className="novel-muted">
            {progress.total === 0
              ? '正在获取源列表…'
              : `已搜 ${progress.done}/${progress.total} 源（${pct}%）——命中的源会陆续出现在下方`}
          </span>
        )}
      </div>
      {searchError === null ? null : (
        <div className="novel-err" style={{ fontSize: 13 }}>搜索中断：{searchError}</div>
      )}
      {groups !== null && progress === null && groups.length === 0 && (
        emptyPlan
          ? <EmptyState title="没有参与搜索的书源——全部书源都已停用，或尚未导入" />
          : <EmptyState title="没有结果——书源在 DSH 设置 →「小说」中导入" />
      )}
      {groups !== null && renderGroups(groups, deps)}
    </div>
  )
}

/** 命中行：行内双动作——点行 = 加架并直接阅读；「＋加书架」只加架（stopPropagation）。
 * apiSend 经 deps 透传（行内接线同样可被测试驱动）。 */
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
  if (hit.url === undefined || hit.url === null) return <div className="novel-row"><span>{hit.title}</span><span className="novel-muted" style={{ marginLeft: 8 }}>{hit.author ?? ''}</span></div>
  return (
    <div role="button" tabIndex={0} className="novel-row" onClick={read}>
      <span>{hit.title}</span>
      <span className="novel-muted" style={{ marginLeft: 8 }}>{hit.author ?? ''}{hit.lastChapterName === undefined ? '' : ` · ${hit.lastChapterName}`}</span>
      <span style={{ marginLeft: 'auto' }}>
        <button className="novel-btn sm" disabled={added} onClick={(e) => { e.stopPropagation(); void add().catch(() => undefined) }}>{added ? '已加' : '＋加书架'}</button>
      </span>
    </div>
  )
}

function renderGroups(groups: SearchGroup[], deps: ClientCoreDeps): ReactNode {
  const hits = groups.filter((g) => g.error === undefined)
  const failed = groups.filter((g) => g.error !== undefined)
  if (hits.length === 0 && failed.length === 0) return null
  return (
    <div className="novel-list" style={{ marginTop: 8 }}>
      {hits.map((g) => (
        <div key={g.sourceId} className="novel-group">
          <div className="novel-toolbar" style={{ alignItems: 'baseline' }}>
            <strong>{g.sourceName}</strong>
            <span className="novel-muted">{g.status} · {g.hits.length} 本</span>
          </div>
          <div className="novel-list">
            {g.hits.map((h, i) => <HitRow key={i} sourceId={g.sourceId} hit={h} deps={deps} />)}
          </div>
        </div>
      ))}
      {failed.length === 0 ? null : (
        <details className="novel-muted">
          <summary>失败源 {failed.length} 个（多为站点不可达，展开看原因）</summary>
          <div className="novel-group" style={{ marginTop: 6 }}>
            {failed.map((g) => (
              <div key={g.sourceId}>
                <span>{g.sourceName}</span>
                <span className="novel-err"> · {g.error?.code}</span>
                <div style={{ fontSize: 12 }}>{g.error?.message}{g.statusDetail === undefined ? '' : `（${g.statusDetail}）`}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

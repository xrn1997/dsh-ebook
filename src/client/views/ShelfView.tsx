import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { LOCAL_SOURCE_ID, paramRoutes, queries, ROUTES } from '../../shared/wire.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { navigate } from '../store.js'
import type { ShelfBook } from './types.js'
import { coverFallbackChar, ProgressBar } from './bits.js'
import { deleteBookCopy } from '../shelf-delete.js'

/** 本地书保留源 id 归 wire 契约（第四轮卡「顺带」项）：此前此处手抄 '__local__'——
 *  服务端单主人在 src/services/localbooks.ts，client 纯度门禁拦跨半 import，字面量双份即漂移隐患。 */

/** 首页：居中搜索框 + 封面网格书架；无 tab 栏两级导航的根。
 * deps 注入：接线层可被测试驱动——加载失败/删除失败的半场此前不可达。 */
export function ShelfView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const [books, setBooks] = useState<ShelfBook[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({})
  // 本地 TXT 导入：隐藏 file input + 上传后直进阅读器
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // 删除书籍（卡片 ✕ → 确认条 → DELETE shelf/:key；本地书服务端连删磁盘文件）
  const [pendingDel, setPendingDel] = useState<ShelfBook | null>(null)
  const [delError, setDelError] = useState<string | null>(null)
  const confirmDelete = (): void => {
    if (pendingDel === null) return
    void deps.apiSend('DELETE', paramRoutes.shelfKey(pendingDel.bookKey)).then(() => {
      // 成功才本地过滤（失败半场卡片保留——乐观删除的回滚半场归接线测试钉死）
      setBooks((prev) => (prev ?? []).filter((b) => b.bookKey !== pendingDel.bookKey))
      setPendingDel(null)
      setDelError(null)
    }, (e) => {
      setPendingDel(null)
      setDelError(e instanceof Error ? e.message : String(e))
    })
  }
  useEffect(() => {
    // 失败不许伪装成空架（历史 bug：网络失败 setBooks([]) → 渲染「书架空空」误导）
    void deps.apiGet<ShelfBook[]>(ROUTES.shelf.path).then((list) => {
      setBooks(list)
      setLoadError(null)
    }, (e) => {
      setBooks([])
      setLoadError(e instanceof Error ? e.message : String(e))
    })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const search = (): void => {
    if (keyword.trim() !== '') navigate({ name: 'search', keyword: keyword.trim() })
  }
  return (
    <div data-novel-view="shelf" className="novel-view">
      <form className="novel-hero" onSubmit={(e) => { e.preventDefault(); search() }}>
        <input
          className="novel-input novel-hero-input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜书名 / 作者"
          aria-label="搜索书籍"
        />
      </form>
      {/* 导入行放空态/非空态共用位置——书架空时也能导入 */}
      <div className="novel-toolbar" style={{ justifyContent: 'center' }}>
        <button className="novel-btn sm" onClick={() => fileRef.current?.click()}>导入 TXT</button>
        <input ref={fileRef} type="file" accept=".txt,text/plain" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f === undefined) return
            setImportError(null)
            void deps.apiUpload<{ bookKey: string; title: string; sourceId: string }>(
              queries.localImport({ name: f.name }), f,
            ).then((book) => navigate({ name: 'reader', sourceId: book.sourceId, bookKey: book.bookKey, title: book.title }),
              (err) => { setImportError(err instanceof Error ? err.message : String(err)) })
          }} />
        {importError === null ? null : <span className="novel-err" style={{ fontSize: 12 }}>{importError}</span>}
      </div>
      {delError === null ? null : <div className="novel-err" style={{ fontSize: 13, textAlign: 'center' }}>删除失败：{delError}</div>}
      {pendingDel === null ? null : (() => {
        const copy = deleteBookCopy(pendingDel.title, pendingDel.sourceId === LOCAL_SOURCE_ID)
        return (
          <div className="novel-panel novel-group" style={{ alignSelf: 'center', textAlign: 'center', maxWidth: 420 }}>
            <div><strong className="novel-err">{copy.confirm}</strong></div>
            {copy.warn === null ? null : <div className="novel-warn" style={{ fontSize: 12 }}>{copy.warn}</div>}
            <div className="novel-toolbar" style={{ justifyContent: 'center' }}>
              <button className="novel-btn sm" onClick={confirmDelete}>确认删除</button>
              <button className="novel-btn sm" onClick={() => setPendingDel(null)}>取消</button>
            </div>
          </div>
        )
      })()}
      {loadError === null ? null : (
        <div className="novel-err" style={{ fontSize: 13, textAlign: 'center' }}>书架加载失败：{loadError}（稍后重试或检查 DSH 服务端）</div>
      )}
      {books === null ? <div className="novel-muted">加载中…</div>
        : books.length === 0
          ? <div className="novel-empty">{loadError === null ? '书架空空——上方搜一本书开始阅读' : '书架暂时不可用（见上方错误）'}<br /><span className="novel-muted">书源在 DSH 设置 →「小说」中导入</span></div>
          : (
            <div className="novel-grid">
              {books.map((b) => {
                const isLocal = b.sourceId === LOCAL_SOURCE_ID
                const failed = imgFailed[b.bookKey] === true
                const pct = typeof b.totalChapters === 'number' && b.totalChapters > 0
                  ? Math.min(1, (b.progress.chapterIndex + b.progress.offsetRatio) / b.totalChapters)
                  : null
                return (
                  <div key={b.bookKey} role="button" tabIndex={0} className="novel-card" onClick={() => navigate({ name: 'reader', sourceId: b.sourceId, bookKey: b.bookKey, title: b.title })}>
                    <button
                      className="novel-btn sm novel-card-x"
                      title="删除本书"
                      aria-label={`删除 ${b.title}`}
                      onClick={(e) => { e.stopPropagation(); setDelError(null); setPendingDel(b) }}
                    >✕</button>
                    {isLocal
                      ? <div className="novel-cover-fallback">本地</div>
                      : b.coverUrl !== undefined && !failed
                        ? <img className="novel-cover" src={b.coverUrl} alt="" loading="lazy" onError={() => setImgFailed((m) => ({ ...m, [b.bookKey]: true }))} />
                        : <div className="novel-cover-fallback">{coverFallbackChar(b.title)}</div>}
                    <div className="novel-card-title" title={b.title}>{b.title}</div>
                    {pct === null ? null : (
                      <ProgressBar pct={Math.round(pct * 100)} style={{ borderRadius: 0, margin: '0 6px 6px' }} />
                    )}
                  </div>
                )
              })}
            </div>
          )}
    </div>
  )
}

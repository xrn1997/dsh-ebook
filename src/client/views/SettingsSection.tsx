import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { paramRoutes, ROUTES } from '../../shared/wire.js'
import { prodDeps } from '../deps.js'
import type { SettingsDeps } from '../deps.js'
import { useJobStatus } from '../jobs.js'
import { applyRouteIntent, hasSavedSections, loadSections, saveSections, toggleSection } from '../sections.js'
import type { Sections } from '../sections.js'
import { collectIdsByStatus } from '../source-batch.js'
import { NovelStyles } from '../styles.js'
import { GlobalStatusBar } from './SettingsStatusBar.js'
import { SourceList } from './SettingsSourceList.js'
import { ImportPane } from './SettingsImportPane.js'
import { ErrorBanner, StatusBadge } from './bits.js'
import type { ProbeResult, SourcePublic } from './types.js'

/**
 * 宿主设置「小说」区块：本文件只剩**壳**——手风琴区块 + 任务轮询单实例
 * + 试跑下钻路由；三份现场各归各的 module：
 * - 全局状态条 → SettingsStatusBar.tsx（transient 现场的呈现端）；
 * - 源列表 → SettingsSourceList.tsx（query/chip/选择/编辑态现场）；
 * - 导入区 → SettingsImportPane.tsx（拖放/粘贴/任务汇总现场）。
 * job 经 props 下发（单实例轮询在此，两区运行卡与状态条共享——避免双轮询）。
 * deps 整壳注入：apiGet / startBatchProbeJob 不再硬 import——与 ShelfView/
 * SearchView 同款「props 注入 + prodDeps 缺省」，并向下透传给两区（否则子组件仍吃各自缺省）。
 */
export function SettingsSection({ deps = prodDeps }: { deps?: SettingsDeps }): ReactNode {
  type SourcesSub = { name: 'list' } | { name: 'probe'; sourceId: string }
  const [sub, setSub] = useState<SourcesSub>({ name: 'list' })
  const [sources, setSources] = useState<SourcePublic[] | null>(null)
  const [sections, setSections] = useState<Sections>(() => loadSections(false))
  const [loadError, setLoadError] = useState<string | null>(null)
  // 失败不许伪装成空列表（历史 bug，与 ShelfView 同款口径）：网络失败 setSources([]) →
  // 区块 meta 显示「0 个源」+ 空态「还没有书源」→ 用户以为 642 条源被清空，可能触发重导入/删除。
  const reload = (): void => {
    void deps.apiGet<SourcePublic[]>(ROUTES.sources.path).then((list) => {
      setSources(list)
      setLoadError(null)
    }, (e) => {
      setSources([])
      setLoadError(e instanceof Error ? e.message : String(e))
    })
  }
  useEffect(reload, [])
  // 首次拿到真实源数：无持久化时按默认策略收敛（有源 → 导入收起、列表展开）
  useEffect(() => {
    if (sources !== null && !hasSavedSections()) setSections(applyRouteIntent(loadSections(sources.length > 0), undefined))
  }, [sources])
  const toggle = (key: keyof Sections): void => setSections((s) => {
    const next = toggleSection(s, key)
    saveSections(next)
    return next
  })
  /** 状态条跳转用「强制展开」（toggle 是取反语义，不能复用） */
  const openSection = (key: keyof Sections): void => setSections((s) => {
    const next = { ...s, [key]: true }
    saveSections(next)
    return next
  })

  // 任务轮询单实例：状态条与两区运行卡经 props 共享；取数走注入 deps
  const { job, refresh, stale } = useJobStatus(deps)
  // 任务收尾 → 刷新源列表（按 job.id 记账一次，不重复 reload）
  const [reloadedJob, setReloadedJob] = useState<string | null>(null)
  useEffect(() => {
    if (job !== null && job.phase !== 'running' && job.id !== reloadedJob) {
      setReloadedJob(job.id)
      reload()
    }
  }, [job, reloadedJob])

  /** 状态条点击：跳到任务对应的区块并展开 + 滚动到位 */
  const jumpToJob = (): void => {
    if (job === null) return
    if (job.kind === 'import') {
      openSection('importOpen')
      setTimeout(() => document.querySelector('[data-novel-run-card]')?.scrollIntoView({ block: 'center' }), 0)
    } else {
      openSection('listOpen')
      setTimeout(() => document.querySelector('[data-novel-source-list]')?.scrollIntoView({ block: 'center' }), 0)
    }
  }
  const statusBar = <GlobalStatusBar job={job} stale={stale} onOpen={jumpToJob} />

  if (sub.name === 'probe') {
    return (
      <div data-novel-view="sources" data-novel-scope className="novel-view novel-status-host">
        {/* 宿主设置是独立 React 树——样式层必须自带；data-novel-scope = token 层锚点 */}
        <NovelStyles />
        {statusBar}
        <ProbePane sourceId={sub.sourceId} onBack={() => setSub({ name: 'list' })} deps={deps} />
      </div>
    )
  }

  const unverifiedIds = sources === null ? [] : collectIdsByStatus(sources, 'unverified')
  return (
    <div data-novel-view="sources" data-novel-scope className="novel-view novel-status-host">
      <NovelStyles />
      {statusBar}
      {loadError === null ? null : (
        <div className="novel-err" style={{ fontSize: 13 }}>源列表加载失败：{loadError}（稍后重试或检查 DSH 服务端）</div>
      )}
      <Section id="import" title="导入书源" open={sections.importOpen} onToggle={() => toggle('importOpen')}>
        <ImportPane job={job} refresh={refresh} unverifiedCount={unverifiedIds.length} deps={deps}
          onVerifyUnverified={() => {
            void deps.startBatchProbeJob(unverifiedIds).then(refresh, (e: unknown) => {
              deps.pushError(`启动验证失败：${e instanceof Error ? e.message : String(e)}`)
            })
          }} />
      </Section>
      <Section
        id="list"
        title="源列表"
        meta={loadError !== null ? '加载失败'
          : sources === null ? '加载中…'
            : `${sources.length} 个源 · 已启用 ${sources.filter((s) => s.enabled).length}`}
        open={sections.listOpen}
        onToggle={() => toggle('listOpen')}
      >
        <SourceList sources={sources} job={job} refresh={refresh} onChanged={reload} deps={deps} loadError={loadError}
          onProbe={(id) => setSub({ name: 'probe', sourceId: id })} />
      </Section>
    </div>
  )
}

// ── 手风琴区块 ──────────────────────────────────────────────────────────

function Section({ id, title, meta, open, onToggle, children }: {
  id: string; title: string; meta?: string; open: boolean; onToggle: () => void; children: ReactNode
}): ReactNode {
  return (
    <section className="novel-group">
      <button
        data-novel-section-toggle={id}
        className="novel-section-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="novel-caret">{open ? '▾' : '▸'}</span>
        <strong>{title}</strong>
        {meta === undefined ? null : <span className="novel-muted" style={{ marginLeft: 'auto' }}>{meta}</span>}
      </button>
      {open && <div className="novel-section-body">{children}</div>}
    </section>
  )
}

// ── 试跑器（v1 search 面）：段级 trace 结果卡 ───────────────────────────

/**
  * 试跑器：deps 注入（与兄弟 panes 同款 seam）。
 * 历史 bug 钉死：`apiSend(...).then(setResult)` 无 rejection handler——请求失败即
 * 永久停在「探针执行中…」并留下 unhandled rejection。失败显式呈现是接线的一部分。
 */
export function ProbePane({ sourceId, onBack, deps = prodDeps }: {
  sourceId: string; onBack: () => void; deps?: SettingsDeps
}): ReactNode {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const run = (): void => {
    setFailed(null)
    void deps.apiSend<ProbeResult>('POST', paramRoutes.sourceProbe(sourceId))
      .then(setResult, (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
  }
  useEffect(run, [sourceId])
  return (
    <div className="novel-group">
      <div className="novel-toolbar">
        <button className="novel-btn" onClick={onBack}>← 返回源列表</button>
        <button className="novel-btn" onClick={run}>重跑</button>
      </div>
      {failed !== null
        ? <div className="novel-err" style={{ fontSize: 13 }}>探针请求失败：{failed}</div>
        : result === null
          ? <div className="novel-muted">探针执行中…</div>
          : (
            <div className="novel-panel novel-group">
              <div>
                <StatusBadge status={result.ok ? 'verified' : 'broken'} />
                {' '}{result.ok ? `命中 ${result.itemCount} 条，首条「${result.firstTitle ?? ''}」` : '不可用'}
              </div>
              {result.error === undefined ? null : <ErrorBanner error={{ code: result.error.code, message: result.error.message }} />}
            </div>
          )}
    </div>
  )
}

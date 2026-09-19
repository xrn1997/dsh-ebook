import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { paramRoutes, ROUTES } from '../../shared/wire.js'
import { prodDeps } from '../deps.js'
import type { SettingsDeps } from '../deps.js'
import { useJobStatus } from '../jobs.js'
import { inboxIds, sourceInbox } from '../source-inbox.js'
import { NovelStyles } from '../styles.js'
import { GlobalStatusBar } from './SettingsStatusBar.js'
import { ImportPane } from './SettingsImportPane.js'
import { ProbeRunCard, SourceList } from './SettingsSourceList.js'
import { ErrorBanner, StatusBadge } from './bits.js'
import type { JobState, ProbeResult, SourcePublic } from './types.js'

/**
 * 书源管理 tab 壳（2026 调度台 IA，用户拍板）：**待办收件箱 + 任务槽 + 源列表 + 导入弹层**。
 * 演进史：曾是宿主设置页的手风琴两区（导入区/源列表区竖栏叠放）→ 2026 搬入小说视图顶部
 * tab（settings.section 注册撤除，单一归属）→ 打碎重组为调度台：按「用户带什么任务来」组织——
 * ① 待办（反常置顶：坏源/未验证成任务卡，处置动作贴读数）② 源列表（朴素资产表）
 * ③ 导入（低频任务收纳为弹层，完成事项回流待办，闭环）。
 * 手风琴（sections.ts）与危险区专区随改版退役；删除统一模态二次确认（与书架删书同款口径）。
 *
 * 组件职责边界（未变的口径）：本文件只做接线与现场——sources 每次挂载经 api 拉取、
 * 组件内 useState（业务数据不进 store）；任务轮询单实例在此（useJobStatus，job 经 props
 * 下发给子组件，避免双轮询）；deps 整壳注入（SettingsDeps）向下透传。派生逻辑归纯函数
 * module：待办集合 → source-inbox.ts；列表派生 → source-list-view.ts。
 * 口径详见 `docs/design/client.md`「书源管理 tab 的 IA」。
 */
export function SettingsSection({ deps = prodDeps, withStyles = true }: {
  /** 注入的 deps seam（缺省走生产实现） */
  deps?: SettingsDeps
  /** 样式层是否自带：宿主（`NovelView`）已在其根上注入时传 false，避免同一棵树里两份 NOVEL_CSS */
  withStyles?: boolean
}): ReactNode {
  type Sub = { name: 'list' } | { name: 'probe'; sourceId: string }
  const [sub, setSub] = useState<Sub>({ name: 'list' })
  const [sources, setSources] = useState<SourcePublic[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // 失败不许伪装成空列表/空架（宁炸不猜的呈现半场）：网络失败 → 显式错误，
  // 待办收件箱随之不渲染（不拿未知当「✓ 全部源状态良好」）
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
  // 任务轮询单实例：状态条与任务槽共享；取数走注入 deps
  const { job, refresh, stale } = useJobStatus(deps)
  // 任务收尾 → 刷新源列表（按 job.id 记账一次，不重复 reload）——待办读数随任务结果自动收敛
  const [reloadedJob, setReloadedJob] = useState<string | null>(null)
  useEffect(() => {
    if (job !== null && job.phase !== 'running' && job.id !== reloadedJob) {
      setReloadedJob(job.id)
      reload()
    }
  }, [job, reloadedJob])

  // 待办集合唯一派生口在 source-inbox.ts：导入弹层的「去验证」也走它，视图不另抄一份按状态筛
  const unverifiedIds = sources === null ? [] : inboxIds(sourceInbox(sources), 'unverified')
  /** 待办处置动作（批量重验/一键验证/导入后「去验证」）的统一提交口：
   *  ids 点击时快照；失败走 pushError 显式呈现（历史 bug：此处曾是 () => undefined 吞掉
   *  rejection，「去验证」点了没反应还留 unhandled） */
  const verifyIds = (ids: string[]): void => {
    void deps.startBatchProbeJob(ids).then(refresh, (e: unknown) => {
      deps.pushError(`启动验证失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }

  /** 状态条点击：import 任务 → 打开导入弹层（运行卡/汇总在弹层内）；probe 任务 → 滚到任务卡 */
  const jumpToJob = (): void => {
    if (job === null) return
    if (job.kind === 'import') {
      setImportOpen(true)
    } else {
      setTimeout(() => document.querySelector('[data-novel-run-card]')?.scrollIntoView({ block: 'center' }), 0)
    }
  }
  const statusBar = <GlobalStatusBar job={job} stale={stale} onOpen={jumpToJob} />

  if (sub.name === 'probe') {
    return (
      <div data-novel-view="sources" data-novel-scope className="novel-view novel-status-host">
        {/* 样式层自带 + data-novel-scope token 锚点：单飞渲染（测试、未来任何新挂载点）都自足；
            NovelView 已在其根上注入时经 withStyles=false 让位，不在同一棵树里注两遍 NOVEL_CSS */}
        {withStyles ? <NovelStyles /> : null}
        {statusBar}
        <ProbePane sourceId={sub.sourceId} onBack={() => setSub({ name: 'list' })} deps={deps} />
      </div>
    )
  }

  return (
    <div data-novel-view="sources" data-novel-scope className="novel-view novel-status-host">
      {withStyles ? <NovelStyles /> : null}
      {statusBar}
      {loadError === null ? null : (
        <div className="novel-err novel-note-md">源列表加载失败：{loadError}（稍后重试或检查 DSH 服务端）</div>
      )}
      {/* ① 待办收件箱：反常置顶；加载中/加载失败不渲染 */}
      <SourceInbox sources={sources} loadError={loadError} job={job} onVerify={verifyIds} />
      {/* ② 任务槽：验证类任务的运行卡归位于此（导入任务的运行卡在导入弹层内——kind 分家） */}
      {job !== null && job.kind !== 'import' && job.phase === 'running' && (
        <div data-novel-job-slot><ProbeRunCard job={job} /></div>
      )}
      {/* ③ 源列表（资产清单）：过滤/编辑/批量/删除模态/行内动作全在其内 */}
      <SourceList
        sources={sources}
        job={job}
        refresh={refresh}
        onChanged={reload}
        onProbe={(id) => setSub({ name: 'probe', sourceId: id })}
        onImport={() => setImportOpen(true)}
        loadError={loadError}
        deps={deps}
      />
      {/* ④ 导入弹层：低频任务收纳；提交后自动关闭，完成事项经待办收件箱回流（闭环） */}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)}>
          <ImportPane
            job={job}
            refresh={refresh}
            unverifiedCount={unverifiedIds.length}
            onVerifyUnverified={() => { setImportOpen(false); verifyIds(unverifiedIds) }}
            onSubmitted={() => setImportOpen(false)}
            deps={deps}
          />
        </ImportModal>
      )}
    </div>
  )
}

/** 待办收件箱：坏源/未验证两任务卡（auto-fit 横排，宽屏并排窄屏堆叠）；每卡只留处置动作——
 *  逐源排查在列表行内「试跑」（待办是任务摘要，不放重复入口，用户裁定）。 */
function SourceInbox({ sources, loadError, job, onVerify }: {
  sources: SourcePublic[] | null; loadError: string | null; job: JobState | null
  onVerify: (ids: string[]) => void
}): ReactNode {
  if (sources === null || loadError !== null) return null
  const inbox = sourceInbox(sources)
  // 在途禁用面 = 任何任务（不限 probe kind）：服务端**单任务槽**——import-job.begin 运行中
  // 抛 JobRunningError，import 在途时提交探针同样无处可去（审查建议按 kind 收窄，拿服务端
  // 契约驳回：那只会把一个必然失败的请求放行到点击之后）。
  const probing = job?.phase === 'running'
  if (sources.length === 0) {
    return (
      <div data-novel-inbox="empty" className="novel-inbox">
        <div className="novel-inbox-head">
          <strong>待办</strong>
          <span className="novel-muted">还没有书源——点列表右上「＋ 导入书源」开始</span>
        </div>
      </div>
    )
  }
  if (inbox.broken.length === 0 && inbox.unverified.length === 0) {
    return (
      <div data-novel-inbox="ok" className="novel-inbox">
        <div className="novel-inbox-ok">✓ 全部源状态良好，没有待办事项</div>
      </div>
    )
  }
  return (
    <div data-novel-inbox className="novel-inbox">
      <div className="novel-inbox-head">
        <strong>待办</strong>
        <span className="novel-muted">需要你处理的事 · {inbox.broken.length + inbox.unverified.length} 项</span>
      </div>
      <div className="novel-inbox-grid">
        {inbox.broken.length === 0 ? null : (
          <div className="novel-todo-card err" data-novel-todo="broken">
            <span className="novel-todo-label err">✗ 坏源 {inbox.broken.length}</span>
            <span className="novel-todo-names">{inbox.broken.map((s) => s.name).join(' · ')}</span>
            <button className="novel-btn sm primary" disabled={probing}
              onClick={() => onVerify(inboxIds(inbox, 'broken'))}>批量重验</button>
            <span className="novel-muted">逐源排查在列表行内「试跑」</span>
          </div>
        )}
        {inbox.unverified.length === 0 ? null : (
          <div className="novel-todo-card warn" data-novel-todo="unverified">
            <span className="novel-todo-label warn">? 未验证 {inbox.unverified.length}</span>
            <span className="novel-todo-names">{inbox.unverified.map((s) => s.name).join(' · ')}</span>
            <button className="novel-btn sm primary" disabled={probing}
              onClick={() => onVerify(inboxIds(inbox, 'unverified'))}>一键验证</button>
            <span className="novel-muted">新导入的源也汇入此处</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 导入弹层：遮罩 + 宽档模态（`.novel-modal.wide`）；Esc / 点遮罩 /「关闭」退出。
 *  入场焦点在关闭钮（轻量焦点口径；删除确认模态另有完整 Tab 圈闭包，在 SourceList 侧）。
 *  焦点/Esc effect **挂载作用域**（空依赖 + onClose 走 ref）：壳层 useJobStatus 每 1s
 *  setJob 新对象 → 每 render 新闭包，进依赖数组会每秒把用户焦点劫回关闭钮（审查 2026
 *  发现的真缺陷）；弹层条件渲染 = 每次打开都是新挂载，入场焦点语义不受影响。
 *  回归钉在 views-wiring「导入弹层焦点不被壳层重渲染劫持」用例。 */
function ImportModal({ onClose, children }: { onClose: () => void; children: ReactNode }): ReactNode {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose                      // 每 render 刷新 ref：effect 内永远调到最新闭包
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="novel-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="novel-modal wide" role="dialog" aria-modal="true" aria-label="导入书源">
        <div className="novel-modal-title">导入书源</div>
        {children}
        <div className="novel-modal-actions">
          <button ref={closeRef} className="novel-btn sm" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

// ── 试跑器（单源排查下钻）：段级 trace 结果卡 ────────────────────────────

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
        <span className="novel-muted">单源试跑：真实搜索请求 + 规则求值 trace</span>
      </div>
      {failed !== null
        ? <div className="novel-err novel-note-md">探针请求失败：{failed}</div>
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

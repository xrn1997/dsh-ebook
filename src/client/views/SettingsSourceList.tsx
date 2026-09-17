import type { ReactNode } from 'react'
import { Fragment, useState } from 'react'
import { parseCookieString } from '../importer.js'
import { paramRoutes, ROUTES } from '../../shared/wire.js'
import { prodDeps } from '../deps.js'
import type { SettingsDeps } from '../deps.js'
import { groupIcon, selectMany, setEditMode, setGroupFilter, setQuery, setStatusFilter, sourceListUi, toggleSelect, UNGROUPED } from '../source-list.js'
import type { StatusFilter } from '../source-list.js'
import { deriveSourceListView } from '../source-list-view.js'
import { batchConfirmKind } from '../source-batch.js'
import { useStore } from '../store.js'
import { useTransientFlag } from '../transient.js'
import { rowAnchorOf, toggleFeedback } from '../toggle-feedback.js'
import { jobPct, RunCard, StatusBadge } from './bits.js'
import type { JobState, SourcePublic } from './types.js'

/**
 * 源列表（设置区「源列表」区块）：chips 过滤 + 浏览/编辑两态 + 行内启停开关 + 选中动作条 + 危险操作折叠区。
 * 从 SettingsSection.tsx 拆出：本文件只持「列表现场」这一份职责——
 * 现场（query/chip/选择/编辑态）在模块级 sourceListUi store；任务现场 job 经 props 注入（不自取）。
 */

const PAGE_SIZE = 100
const STATUS_CHIPS: Array<{ key: StatusFilter; label: string; color: string | null }> = [
  { key: 'all', label: '全部', color: null },
  { key: 'verified', label: '已验证', color: 'var(--novel-status-verified)' },
  { key: 'broken', label: '坏源', color: 'var(--novel-status-broken)' },
  { key: 'unverified', label: '未验证', color: 'var(--novel-status-unverified)' },
  { key: 'disabled', label: '已停用', color: 'var(--novel-brand)' },
]

export function SourceList({ sources, job, refresh, onChanged, onProbe, loadError = null, deps = prodDeps }: {
  sources: SourcePublic[] | null; job: JobState | null; refresh: () => void
  onChanged: () => void; onProbe: (id: string) => void
  /** 上层取数失败信息：有错时不得渲染「还没有书源」空态（把失败伪装成确定结论） */
  loadError?: string | null
  /** 依赖束：缺省生产实现；测试注入假 adapter 驱动接线层 */
  deps?: SettingsDeps
}): ReactNode {
  // 列表现场在模块级 store——试跑下钻/重开设置不丢
  const ui = useStore(sourceListUi)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [pending, setPending] = useState<{ ids: string[]; label: string } | null>(null)
  if (sources !== null && sources.length === 0) {
    return loadError === null
      ? <div className="novel-muted">还没有书源——选择文件或拖入一个 legado 书源开始</div>
      : <div className="novel-err" style={{ fontSize: 13 }}>源列表暂时不可用：{loadError}</div>
  }
  const all = sources ?? []
  // 派生计算归纯函数 module：chip 计数/分组图例/过滤管线/选中态此前是组件体
  // 闭包——纯计算被 React 接线包住只能整壳间接验。现在本组件只做接线，语义在那边单测钉死
  // （含「分组选项集不随状态过滤缩水」的语义决策）。
  const vm = deriveSourceListView(all, ui, limit)
  const { filtered, shown, selected: selection } = vm
  const { brokenIds, unverifiedIds, groupCounts, groupLegend, chipCount, authCountOf, allFilteredSelected } = vm
  const { ungroupedCount } = vm
  const probing = job?.phase === 'running'
  const submitJob = (fn: () => Promise<unknown>): void => {
    void fn().then(refresh, (e) => deps.pushError(`操作失败：${e instanceof Error ? e.message : String(e)}`))
  }
  const confirmDelete = (): void => {
    if (pending === null) return
    const ids = pending.ids                          // 点击时快照，不随列表变化重算
    void deps.apiSend<{ removed: number }>('POST', ROUTES.sourcesBatchDelete.path, { ids }).then(() => {
      setPending(null)
      onChanged()
    }, (e) => {
      setPending(null)
      deps.pushError(`批量删除失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }
  /** 行内启停开关：单击即切——乐观更新在行内组件；**在途不进泳道**（进条就顶动
   *  设置区布局 → 秒级操作闪烁，见 toggle-feedback.ts 头注），失败才进 error 泳道并挂行锚点。 */
  const toggleEnabled = (s: SourcePublic, next: boolean): Promise<boolean> => {
    const fb = toggleFeedback(rowAnchorOf(s.id), deps)
    fb.inFlight()
    return deps.apiSend('POST', paramRoutes.sourceEnabled(s.id), { enabled: next }).then(() => {
      fb.settle(true)
      onChanged()
      return true
    }, (e) => {
      fb.settle(false, `「${s.name}」启停失败：${e instanceof Error ? e.message : String(e)}（若路由 404，请重启 DSH 服务端）`)
      onChanged()                                        // 服务端为准的二次校准（行内已即刻回滚）
      return false
    })
  }
  return (
    <div data-novel-source-list className="novel-group">
      {/* 状态统计 chips：互斥单选过滤，与文本过滤叠加 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STATUS_CHIPS.map((c) => (
          <button key={c.key}
            className="novel-btn sm"
            data-novel-chip={c.key}
            aria-pressed={ui.statusFilter === c.key}
            style={ui.statusFilter === c.key
              ? { borderColor: 'var(--novel-brand)', background: 'var(--novel-brand-tint)' }
              : undefined}
            onClick={() => { setStatusFilter(ui.statusFilter === c.key ? 'all' : c.key); setLimit(PAGE_SIZE) }}>
            {c.color === null ? null : <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c.color, marginRight: 6 }} />}
            {c.label} <strong>{chipCount(c.key)}</strong>
          </button>
        ))}
      </div>
      <div className="novel-toolbar">
        <input
          data-novel-source-filter
          className="novel-input"
          value={ui.query}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE) }}
          placeholder="过滤：名称 / 地址 / 分组（与状态筛选叠加）"
          style={{ flex: 1 }}
        />
        {/* 分组过滤（增补）：分组名五花八门不配 chips——下拉单选收敛宽度，与状态/文本过滤叠加 */}
        <select
          data-novel-group-filter
          className="novel-input"
          value={ui.groupFilter}
          aria-label="按分组过滤"
          onChange={(e) => { setGroupFilter(e.target.value); setLimit(PAGE_SIZE) }}
          style={{ maxWidth: 200 }}
        >
          <option value="">全部分组</option>
          {/* 「未分组」伪选项（增补）：无分组源不属于任何真实组——单独入口才定位得到（批量补分组）；
              哨兵值 UNGROUPED 防与真实组名撞名；计数 0 时不渲染（不添噪声选项） */}
          {ungroupedCount > 0 && <option value={UNGROUPED}>未分组（{ungroupedCount}）</option>}
          {[...groupCounts.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([g, n]) => (
            <option key={g} value={g}>{g}（{n}）</option>
          ))}
        </select>
        <span className="novel-muted">{filtered.length}/{all.length} 个源</span>
      </div>

      {/* 选中动作条：操作与作用对象同框；删除只有这一个入口 */}
      {ui.selection.length > 0 && (
        <div data-novel-selbar className="novel-toolbar"
          style={{ background: 'var(--novel-brand-soft)', border: '1px solid var(--novel-brand-line)', borderRadius: 8, padding: '7px 12px', flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--novel-brand-strong)' }}>已选 {ui.selection.length}</strong>
          <button className="novel-btn sm" disabled={probing}
            onClick={() => submitJob(() => deps.apiSend('POST', ROUTES.sourcesBatchEnabled.path, { ids: ui.selection, enabled: true }).then(() => setEditMode(false)))}>
            启用所选
          </button>
          <button className="novel-btn sm" disabled={probing}
            onClick={() => submitJob(() => deps.apiSend('POST', ROUTES.sourcesBatchEnabled.path, { ids: ui.selection, enabled: false }).then(() => setEditMode(false)))}>
            停用所选
          </button>
          <button className="novel-btn sm primary" disabled={probing}
            onClick={() => submitJob(() => deps.startBatchProbeJob(ui.selection))}>
            验证所选
          </button>
          <button className="novel-btn sm" style={{ color: 'var(--novel-err)', borderColor: 'color-mix(in srgb, var(--novel-err) 35%, transparent)' }}
            onClick={() => setPending({ ids: ui.selection, label: '所选' })}>
            删除所选
          </button>
          <span style={{ flex: 1 }} />
          <button className="novel-btn sm" onClick={() => setEditMode(false)}>清空选择</button>
        </div>
      )}
      {/* 批量验证运行卡：验证任务作用于源，归位源列表区 */}
      {job !== null && job.kind === 'batch-probe' && job.phase === 'running' && <ProbeRunCard job={job} />}

      {pending === null ? null : (
        <BatchConfirm
          label={pending.label}
          count={pending.ids.length}
          authCount={authCountOf(pending.ids)}
          kind={batchConfirmKind(pending.ids.length) === 'typed' ? 'typed' : 'simple'}
          onConfirm={confirmDelete}
          onCancel={() => setPending(null)}
        />
      )}

      <div className="novel-toolbar">
        <button className="novel-btn sm" disabled={probing || unverifiedIds.length === 0}
          onClick={() => submitJob(() => deps.startBatchProbeJob(unverifiedIds))}>
          验证全部未验证（{unverifiedIds.length}）
        </button>
        <span className="novel-muted">导入后的常用路径；其余场景用「chip 过滤 + 编辑态全选 + 验证所选」</span>
      </div>

      {/* 危险操作折叠区：整库级破坏操作，默认收起；
          危险性由文案与按钮表达，不靠整块刷红 */}
      <details className="novel-panel" style={{ padding: 0 }}>
        <summary style={{ cursor: 'pointer', padding: '7px 12px', fontSize: 13, userSelect: 'none' }}>
          危险操作（整库级）
        </summary>
        <div className="novel-group" style={{ padding: '2px 12px 10px', gap: 8 }}>
          <div className="novel-toolbar">
            <span style={{ fontSize: 13 }}>删除全部坏源 <strong className="novel-err">{brokenIds.length}</strong> 个</span>
            <button className="novel-btn sm" style={{ color: 'var(--novel-err)', borderColor: 'color-mix(in srgb, var(--novel-err) 35%, transparent)' }}
              disabled={brokenIds.length === 0}
              onClick={() => setPending({ ids: brokenIds, label: '全部坏源' })}>
              删除…
            </button>
          </div>
          <div className="novel-toolbar">
            <span style={{ fontSize: 13 }}>删除全部未验证 <strong className="novel-err">{unverifiedIds.length}</strong> 个</span>
            <button className="novel-btn sm" style={{ color: 'var(--novel-err)', borderColor: 'color-mix(in srgb, var(--novel-err) 35%, transparent)' }}
              disabled={unverifiedIds.length === 0}
              onClick={() => setPending({ ids: unverifiedIds, label: '全部未验证源' })}>
              删除…
            </button>
          </div>
          <span className="novel-muted">超过 20 条需手输「删除」确认</span>
        </div>
      </details>

      {/* 表格 = 末位元素（IA）：列表级操作全部上移到表格之前 */}
      <div className="novel-table">
        <div className="novel-tr" style={{ gridTemplateColumns: 'minmax(130px, 1.3fr) 68px minmax(0, 1fr) minmax(0, 1.6fr) auto auto' }}>
          <span>
            {ui.editMode && (
              <input type="checkbox" checked={allFilteredSelected} aria-label="全选当前过滤结果"
                onChange={() => { if (!allFilteredSelected) selectMany(filtered.map((s) => s.id)) }} />
            )} 名称
          </span>
          <span>状态</span>
          <span>
            分组
            {/* 「?」图例（增补）：分组列只显示图标，悬停解释每个图标对应哪个组 */}
            {groupLegend === '' ? null : (
              <span data-novel-group-legend className="novel-muted" title={groupLegend}
                style={{ cursor: 'help', marginLeft: 3 }} aria-label="图标图例">?</span>
            )}
          </span>
          <span>地址</span>
          <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="novel-btn sm"
              data-novel-edit-toggle
              style={ui.editMode ? { background: 'var(--novel-brand-tint)', borderColor: 'var(--novel-brand)', color: 'var(--novel-brand-strong)' } : undefined}
              onClick={() => setEditMode(!ui.editMode)}>
              {ui.editMode ? '完成' : '编辑'}
            </button>
          </span>
          <span style={{ textAlign: 'right' }}>启用</span>
        </div>
        {shown.map((s) => (
          <SourceRow key={s.id} source={s} editMode={ui.editMode} selected={selection.has(s.id)}
            onChanged={onChanged} onProbe={onProbe} onToggleEnabled={toggleEnabled} deps={deps} />
        ))}
      </div>
      {filtered.length > shown.length && (
        <button className="novel-btn" onClick={() => setLimit(limit + PAGE_SIZE)}>
          显示更多（还有 {filtered.length - shown.length} 个）
        </button>
      )}
    </div>
  )
}

/** 批量删除确认条：≤20 普通计数确认；>20 手输「删除」放行；带登录态源点名提醒 */
function BatchConfirm({ label, count, authCount, kind, onConfirm, onCancel }: {
  label: string; count: number; authCount: number
  kind: 'simple' | 'typed'; onConfirm: () => void; onCancel: () => void
}): ReactNode {
  const [text, setText] = useState('')
  const ok = kind === 'simple' || text.trim() === '删除'
  return (
    <div className="novel-tr danger" style={{ gridTemplateColumns: '1fr' }}>
      <div className="novel-toolbar" style={{ flexWrap: 'wrap' }}>
        <strong className="novel-err">删除{label}（{count} 个）</strong>
        {authCount > 0 && <span className="novel-warn">其中 {authCount} 个带登录态，删除后 cookie 失效</span>}
        {kind === 'typed' && (
          <input
            className="novel-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="大批量：手输「删除」二字确认"
            style={{ maxWidth: 220 }}
          />
        )}
        <button className="novel-btn sm" disabled={!ok} onClick={onConfirm}>确认删除</button>
        <button className="novel-btn sm" onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

/** 行：浏览态只名称/状态/分组/地址/开关；编辑态加复选框+试跑/登录；行级删除已取消 */
function SourceRow({ source: s, editMode, selected, onChanged, onProbe, onToggleEnabled, deps = prodDeps }: {
  source: SourcePublic; editMode: boolean; selected: boolean
  onChanged: () => void; onProbe: (id: string) => void; onToggleEnabled: (s: SourcePublic, next: boolean) => Promise<boolean>
  deps?: SettingsDeps
}): ReactNode {
  const [authOpen, setAuthOpen] = useState(false)
  // 乐观态：点击即翻转本地展示，reload 后以服务端为准——642 行列表的全量 reload 有一拍延迟，
  // 没有乐观反馈用户会以为「点不动」。失败（resolve false）即刻清零回滚，不等 reload。
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [savingN, setSavingN] = useState(0)             // 在途请求数：「保存中」装饰的精确生命周期
  const rowAnchor = rowAnchorOf(s.id)
  // 失败标记来自全局瞬态层（sticky 到条目被 dismiss）：行留红边，错误条目「定位 →」跳到这里
  const failed = useTransientFlag((e) => e.kind === 'error' && e.anchor === rowAnchor)
  const enabled = optimistic ?? s.enabled
  const saving = savingN > 0
  const cols = 'minmax(130px, 1.3fr) 68px minmax(0, 1fr) minmax(0, 1.6fr) auto auto'
  const toggle = (next: boolean): void => {
    setOptimistic(next)
    setSavingN((n) => n + 1)
    void onToggleEnabled(s, next).then((ok) => {
      setSavingN((n) => n - 1)
      if (!ok) setOptimistic(null)                    // 失败即刻回滚（原实现乐观态无人清零，开关会永久停在错误态）
    })
  }
  return (
    <Fragment>
      <div data-novel-source-row={s.id}
        className={`novel-tr${failed ? ' row-err' : ''}`}
        style={{ gridTemplateColumns: cols }}>
        <span className="novel-td" title={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {editMode && <input type="checkbox" checked={selected} onChange={() => toggleSelect(s.id)} aria-label={`选择 ${s.name}`} />}
          <strong style={enabled ? undefined : { fontWeight: 400 }}>{s.name}</strong>
        </span>
        {/* 状态列只放验证状态：曾用类型徽标（bookSourceType）顶掉验证位，实测造成误读——已撤 */}
        <span style={enabled ? undefined : { opacity: 0.55 }}><StatusBadge status={s.status} /></span>
        {/* 分组格：只留图标——图标即组的视觉身份，hover 出全名；无图标组回退全名（不造图标） */}
        <span title={s.groups.length > 0 ? s.groups.join(' / ') : undefined}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', minWidth: 0, overflow: 'hidden',
            ...(enabled ? {} : { opacity: 0.55 }) }}>
          {s.groups.length > 0
            ? s.groups.map((g) => {
              const icon = groupIcon(g)
              return <span key={g} className="novel-grouppill" title={g}>{icon ?? g}</span>
            })
            : <span className="novel-muted">—</span>}
        </span>
        <span className="novel-td novel-muted" title={s.statusDetail ?? s.baseUrl} style={enabled ? undefined : { opacity: 0.55 }}>
          {s.baseUrl}
          {s.hasAuth && <span> · {s.authExpired ? '登录已过期' : '已登录'}</span>}
        </span>
        <span className="novel-actions">
          {editMode && (
            <>
              <button className="novel-btn sm" onClick={() => onProbe(s.id)}>试跑</button>
              <button className="novel-btn sm" onClick={() => setAuthOpen(!authOpen)}>
                {authOpen ? '收起' : s.hasAuth ? '改登录' : '登录'}
              </button>
            </>
          )}
        </span>
        {/* 启停开关：右对齐常驻（两态都渲染——启停是高频决策，不进编辑模式） */}
        <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button data-novel-switch role="switch" aria-checked={enabled} aria-label={`${enabled ? '停用' : '启用'} ${s.name}`}
            title={saving ? '保存中…' : enabled ? '点击停用（不参与聚合搜索，可随时开回）' : '点击启用'}
            onClick={() => toggle(!enabled)}
            style={{
              position: 'relative', width: 30, height: 17, borderRadius: 999, padding: 0,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.55 : 1,
              background: enabled ? 'var(--novel-ok)' : 'var(--novel-skeleton)',
              border: `1px solid ${enabled ? 'var(--novel-ok)' : 'var(--novel-border-strong)'}`,
            }}>
            <span style={{
              position: 'absolute', top: 1, left: enabled ? 15 : 1, width: 13, height: 13, borderRadius: '50%',
              background: enabled ? 'var(--novel-on-solid)' : 'var(--novel-text-3)', transition: 'left .15s',
            }} />
          </button>
        </span>
      </div>
      {authOpen && (
        <div className="novel-tr" style={{ gridTemplateColumns: '1fr' }}>
          <SourceAuthPane source={s} onDone={() => { setAuthOpen(false); onChanged() }} deps={deps} />
        </div>
      )}
    </Fragment>
  )
}

/** 登录配置：cookie 录入（输入值不进 store，直接 POST）+ 去登录新 tab。
 *  反馈全走全局状态条——成功条自动退场。 */
function SourceAuthPane({ source, onDone, deps = prodDeps }: {
  source: SourcePublic; onDone: () => void; deps?: SettingsDeps
}): ReactNode {
  const [cookie, setCookie] = useState('')
  const save = (): void => {
    void deps.apiSend('POST', paramRoutes.sourceAuth(source.id), { cookies: parseCookieString(cookie) }).then(() => {
      setCookie('')                      // 输入值即刻清空
      deps.pushOk('已保存登录态')
      onDone()
    }, (e) => deps.pushError(`保存登录失败：${e instanceof Error ? e.message : String(e)}`, rowAnchorOf(source.id)))
  }
  return (
    <span className="novel-toolbar" onClick={(e) => e.stopPropagation()}>
      <button className="novel-btn sm" onClick={() => window.open(source.baseUrl, '_blank')}>去登录</button>
      <input
        className="novel-input"
        value={cookie}
        onChange={(e) => setCookie(e.target.value)}
        placeholder="cookie：token=abc; sid=def"
        style={{ flex: 1, maxWidth: 360 }}
      />
      <button className="novel-btn sm" onClick={save}>保存登录</button>
    </span>
  )
}

/** 批量验证运行卡：kind 分家的「验证」侧——显示在源列表区。
 * 外壳归 bits.RunCard（与 ImportRunCard 曾是近逐字同构的双胞胎），此处只供文案与 counts。 */
export function ProbeRunCard({ job }: { job: JobState }): ReactNode {
  const pct = jobPct(job)
  return (
    <RunCard
      label="验证中…"
      meta={<>{job.done}/{job.total}（{pct}%）· 并发 5 路</>}
      pct={pct}
      counts={<>
        <span className="novel-ok">已验证 {job.counts.ok}</span>
        <span className="novel-muted">· 未通过 {job.counts.failed}</span>
      </>}
    />
  )
}

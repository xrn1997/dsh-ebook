import type { CSSProperties, ReactNode } from 'react'
import type { JobState } from './types.js'

/** 小组件集：状态徽标 / 错误横幅（带段级定位徽标）/ 空态 / 运行卡与进度段——六视图共用。
 *  颜色一律走 `--novel-*` 局部 token（由 NovelStyles 的 token 层定义，见 styles.tsx 头注）：
 *  写死 hex 等于钉死一套主题观感，暗态下与宿主调色板不一致。 */

export function StatusBadge({ status }: { status: string }): ReactNode {
  // token 引用写在 var() 里，光/暗两态由宿主 alias 层自己切——本组件不做深浅判断
  const [color, label] = status === 'verified'
    ? ['var(--novel-status-verified)', '可用']
    : status === 'broken'
      ? ['var(--novel-status-broken)', '不可用']
      : ['var(--novel-status-unverified)', '未验证']
  return (
    <span data-novel="badge" className="novel-badge" style={{ color }}>
      ● {label}
    </span>
  )
}

export interface ApiErrorLike {
  code?: string
  message?: string
  segment?: { facet: string; segmentIndex: number; segmentRaw?: string }
}

/** 错误横幅：message 红字 + segment 存在时「面#段N」徽标（底/字/徽标全走 token） */
export function ErrorBanner({ error, onRetry }: { error: ApiErrorLike; onRetry?: () => void }): ReactNode {
  return (
    <div data-novel="error" className="novel-panel" style={{ background: 'var(--novel-err-weak)', margin: '8px 0' }}>
      {error.segment !== undefined && (
        <span className="novel-badge-pill" style={{ marginRight: 8 }}>
          {error.segment.facet}#段{error.segment.segmentIndex}
        </span>
      )}
      <span className="novel-err">{error.code ?? 'Error'}: {error.message ?? '未知错误'}</span>
      {onRetry !== undefined && (
        <button className="novel-btn sm" onClick={onRetry} style={{ marginLeft: 12 }}>重试</button>
      )}
    </div>
  )
}

/** 空态：标题 + 动作按钮组 */
export function EmptyState({ title, actions }: { title: string; actions?: ReactNode }): ReactNode {
  return (
    <div data-novel="empty" style={{ textAlign: 'center', padding: '48px 16px', opacity: 0.75 }}>
      <div style={{ fontSize: 16, marginBottom: 12 }}>{title}</div>
      {actions}
    </div>
  )
}

/** 封面降级首字（无封面/加载失败 → 书名首字色块）；空标题回退「书」 */
export function coverFallbackChar(title: string): string {
  const t = title.trim()
  return t === '' ? '书' : t.slice(0, 1)
}

// ── 后台任务呈现（运行卡双胞胎 + 迷你进度条同源）─────────────────────

/** 任务百分比（total=0 防除零）：运行卡与状态条共用同一算法——三处进度各算是 bug 苗床 */
export function jobPct(job: Pick<JobState, 'done' | 'total'>): number {
  return job.total === 0 ? 0 : Math.round((job.done / job.total) * 100)
}

/** 进度段（.novel-progress）：运行卡与状态条迷你条同源——role/aria 三件套只写这一份 */
export function ProgressBar({ pct, style }: { pct: number; style?: CSSProperties }): ReactNode {
  return (
    <div className="novel-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={style}>
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}

/** 运行卡外壳：导入/批量验证两卡此前近逐字同构——浮层底 + 标题行 + 进度段
 *  + counts 尾行 + 「可以关掉设置页，任务在服务端继续」全同，差异仅 label/meta 文案与
 *  dupSkipped 等条件行。本组件持公共外壳（brand 派生色走 --novel-brand-* token），
 *  两卡收薄为调用、差异插槽化（meta/counts）。 */
export function RunCard({ label, meta, pct, counts }: {
  /** 「导入中…」/「验证中…」 */
  label: string
  /** done/total（pct%）· 并发 5 路 之类 */
  meta: ReactNode
  pct: number
  /** 尾行 counts（已新增/已验证/未通过/重复跳过……）——两卡形态不同，插槽化 */
  counts: ReactNode
}): ReactNode {
  return (
    <div data-novel-run-card className="novel-group"
      style={{ border: '1px solid var(--novel-brand-line)', borderRadius: 10, background: 'var(--novel-brand-soft)', padding: '14px 16px', gap: 8 }}>
      <div className="novel-toolbar">
        <strong>{label}</strong>
        <span className="novel-muted">{meta}</span>
        <span style={{ flex: 1 }} />
        <span className="novel-muted">可以关掉设置页，任务在服务端继续</span>
      </div>
      <ProgressBar pct={pct} />
      <div className="novel-toolbar">{counts}</div>
    </div>
  )
}

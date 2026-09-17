import type { CSSProperties, ReactNode } from 'react'
import { useTransient } from '../transient.js'
import { jobKindLabel } from '../jobs.js'
import { jobPct, ProgressBar } from './bits.js'
import type { JobState } from './types.js'

/**
 * 全局状态条（瞬态统一层的呈现端）：错误(红,sticky) > 运行任务 > 保存中(聚合) > 成功(自动退场）。
 * **浮层**：absolute 定位、不参与布局（挂载/卸载不顶动区块内容——曾把整块顶下去 35px 造成
 * 启停闪烁，见 styles.tsx `.novel-status-bar` 注释）；空闲零占用（无条目无任务不渲染）。
 * 任务泳道保留 data-novel-job-status（smoke 断言）。
 * interface：job（任务现场）+ onOpen（点任务泳道跳转到对应区块）。
 */

/** 泳道公共样式：老 JobStatusBar 的细条观感，逐泳道扩 grid 列 */
function statusLane(extra?: CSSProperties): CSSProperties {
  return {
    display: 'grid', gap: 8, alignItems: 'center', width: '100%', textAlign: 'left',
    border: 'none', padding: '4px 12px', fontSize: 12, cursor: 'pointer',
    background: 'transparent', color: 'inherit', font: 'inherit', ...extra,
  }
}

export function GlobalStatusBar({ job, stale = false, onOpen }: { job: JobState | null; stale?: boolean; onOpen: () => void }): ReactNode {
  const { entries, dismiss } = useTransient()
  const errors = entries.filter((e) => e.kind === 'error')
  const pendings = entries.filter((e) => e.kind === 'pending')
  const oks = entries.filter((e) => e.kind === 'ok')
  const running = job !== null && job.phase === 'running'
  if (errors.length === 0 && pendings.length === 0 && oks.length === 0 && !running && !stale) return null
  const pct = running && job !== null ? jobPct(job) : 0
  return (
    <div data-novel-status-bar className="novel-status-bar">
      {stale && (
        <div data-novel-job-stale className="novel-warn" style={statusLane({ cursor: 'default', gridTemplateColumns: '1fr' })}>
          连接异常，重试中……（任务状态刷新失败，显示的是最后一帧）
        </div>
      )}
      {errors.map((e) => (
        <div key={e.id} className="novel-err"
          style={statusLane({ gridTemplateColumns: 'auto 1fr auto auto', background: 'var(--novel-err-weak)' })}>
          <span>⚠ {e.label}</span>
          <span />
          {e.anchor === undefined ? null : (
            <button className="novel-btn sm"
              onClick={() => document.querySelector(e.anchor as string)?.scrollIntoView({ block: 'center' })}>
              定位 →
            </button>
          )}
          <button className="novel-btn sm" aria-label="忽略此错误" onClick={() => dismiss(e.id)}>✕</button>
        </div>
      ))}
      {running && job !== null && (
        <button data-novel-job-status style={statusLane({ gridTemplateColumns: 'auto auto 1fr auto' })} onClick={onOpen}>
          <span className="novel-muted">{jobKindLabel(job.kind)}中…</span>
          <span className="novel-muted">{job.done}/{job.total}（{pct}%）</span>
          {/* 迷你进度条与两区运行卡同源：ProgressBar + jobPct，仅高度覆写 */}
          <ProgressBar pct={pct} style={{ height: 4 }} />
          <span style={{ color: 'var(--novel-brand)', whiteSpace: 'nowrap' }}>点此查看 →</span>
        </button>
      )}
      {pendings.length > 0 && (
        <div className="novel-muted" style={statusLane({ cursor: 'default', gridTemplateColumns: '1fr' })}>
          {pendings.length === 1 ? pendings[0].label : `正在保存 ${pendings.length} 项…`}
        </div>
      )}
      {oks.map((e) => (
        <div key={e.id} className="novel-ok" style={statusLane({ cursor: 'default', gridTemplateColumns: '1fr' })}>
          ✓ {e.label}
        </div>
      ))}
    </div>
  )
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RunCard } from '../../src/client/views/bits.js'
import { ProbeRunCard } from '../../src/client/views/SettingsSourceList.js'
import { ImportRunCard } from '../../src/client/views/SettingsImportPane.js'
import type { JobState } from '../../src/client/views/types.js'

/**
 * 运行卡双胞胎抽共：ProbeRunCard（SettingsSourceList）与 ImportRunCard
 * （SettingsImportPane）此前近逐字同构——外框浮层、progress bar、counts 尾行、「可以关掉
 * 设置页，任务在服务端继续」文案全同，差异仅 label/meta 文案与 dupSkipped 行。抽 RunCard
 * 后两卡收薄为调用；本文件钉死两卡的公共外壳与各自差异（含 total=0 防除零与内联 hex 归零）。
 */

const job = (over: Partial<JobState> = {}): JobState => ({
  id: 'j1', kind: 'batch-probe', phase: 'running', total: 10, done: 4,
  counts: { ok: 3, failed: 1, dupSkipped: 2, replaced: 0 },
  issues: [], fileErrors: [], startedAt: 0,
  ...over,
})

afterEach(cleanup)

describe('RunCard 公共外壳（抽共）', () => {
  it('ProbeRunCard：进度段 + counts 尾行 + 「可关设置页」文案原样保留', () => {
    render(<ProbeRunCard job={job()} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(screen.getByText('验证中…')).toBeTruthy()
    expect(screen.getByText('已验证 3')).toBeTruthy()
    expect(screen.getByText('· 未通过 1')).toBeTruthy()
    expect(screen.getByText('可以关掉设置页，任务在服务端继续')).toBeTruthy()
  })

  it('total=0 防除零：pct 归 0（不是 NaN）', () => {
    render(<ProbeRunCard job={job({ total: 0, done: 0 })} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  })

  it('ImportRunCard：已新增 + dupSkipped/failed 条件行渲染', () => {
    render(<ImportRunCard job={job({ kind: 'import', counts: { ok: 5, failed: 2, dupSkipped: 1, replaced: 0 } })} />)
    expect(screen.getByText('导入中…')).toBeTruthy()
    expect(screen.getByText('已新增 5')).toBeTruthy()
    expect(screen.getByText('· 重复跳过 1')).toBeTruthy()
    expect(screen.getByText('· 失败 2')).toBeTruthy()
  })

  it('ImportRunCard：零 dupSkipped/failed 不渲染对应行（原条件语义不丢）', () => {
    render(<ImportRunCard job={job({ kind: 'import', counts: { ok: 5, failed: 0, dupSkipped: 0, replaced: 0 } })} />)
    expect(screen.queryByText(/重复跳过/)).toBeNull()
    expect(screen.queryByText(/失败/)).toBeNull()
  })

  it('外壳零内联 brand hex：底/描边走 --novel-brand-soft / --novel-brand-line token', () => {
    const { container } = render(<ProbeRunCard job={job()} />)
    const card = container.querySelector('[data-novel-run-card]')
    expect(card).not.toBeNull()
    const style = card?.getAttribute('style') ?? ''
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(style).toContain('var(--novel-brand-soft)')
    expect(style).toContain('var(--novel-brand-line)')
  })

  it('RunCard 本体是插槽件：label / meta / counts 按传入渲染', () => {
    render(<RunCard label="自定义中…" meta="meta 文案" pct={30} counts={<span>counts 文案</span>} />)
    expect(screen.getByText('自定义中…')).toBeTruthy()
    expect(screen.getByText('meta 文案')).toBeTruthy()
    expect(screen.getByText('counts 文案')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30')
  })
})

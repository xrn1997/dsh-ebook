// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useJobStatus } from '../../src/client/jobs.js'
import type { JobStatusDeps } from '../../src/client/jobs.js'
import type { JobState } from '../../src/client/views/types.js'

/**
 * 任务轮询 hook 的接线测试：`useJobStatus` 此前直接调模块函数 `fetchJobStatus()`
 * ——SettingsDeps.fetchJobStatus 是个「承诺可换成确定性时钟」却无人消费的假 seam。
 * 现在取数走注入 deps：挂载即拉一次、refresh 触发重拉、卸载后轮询终止，三条时序全部可测。
 */

const probeJob = (done: number): JobState => ({
  id: `j${done}`, kind: 'batch-probe', phase: 'running', total: 10, done,
  counts: { ok: done, failed: 0, dupSkipped: 0, replaced: 0 },
  issues: [], fileErrors: [], startedAt: 0,
})

function Harness({ deps }: { deps: JobStatusDeps }): ReactNode {
  const { job, refresh, stale } = useJobStatus(deps)
  return (
    <div>
      <span data-testid="state">{job === null ? '无任务' : `${job.done}/${job.total}`}</span>
      <span data-testid="stale">{stale ? '连接异常' : ''}</span>
      <button onClick={refresh}>刷新</button>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useJobStatus 轮询（deps seam 驱动）', () => {
  it('挂载即拉一次：假 fetchJobStatus 的首轮结果进状态', async () => {
    const fetchJobStatus = vi.fn(async () => probeJob(3))
    render(<Harness deps={{ fetchJobStatus }} />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('3/10'))
    expect(fetchJobStatus).toHaveBeenCalledTimes(1)
  })

  it('refresh 触发重拉（不等下个 1s 轮询拍）', async () => {
    let n = 0
    const fetchJobStatus = vi.fn(async () => probeJob(++n))
    render(<Harness deps={{ fetchJobStatus }} />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('1/10'))

    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('2/10'))
    expect(fetchJobStatus).toHaveBeenCalledTimes(2)
  })

   it('取数抛错 → 保留旧值但如实置 stale；恢复后清 stale（「连接异常，重试中」）', async () => {
    let fail = true
    let n = 0
    const fetchJobStatus = vi.fn(async () => {
      if (fail) throw new Error('网络抖动')
      return probeJob(++n)
    })
    render(<Harness deps={{ fetchJobStatus }} />)
    await waitFor(() => expect(screen.getByTestId('stale').textContent).toBe('连接异常'))
    fail = false
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('1/10'))
    expect(screen.getByTestId('stale').textContent).toBe('')
  })

  it('1s 轮询节拍可测（假时钟）：卸载后不再取数、不再 setState', async () => {
    vi.useFakeTimers()
    const fetchJobStatus = vi.fn(async () => probeJob(1))
    const { unmount } = render(<Harness deps={{ fetchJobStatus }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(fetchJobStatus).toHaveBeenCalledTimes(4)          // 挂载 1 次 + 每秒 1 次 ×3

    unmount()                                                // 卸载即清 timer（不许孤儿轮询）
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetchJobStatus).toHaveBeenCalledTimes(4)          // 卸载后零新增
  })
})

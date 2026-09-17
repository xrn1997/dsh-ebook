// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { SourceList } from '../../src/client/views/SettingsSourceList.js'
import { makeDeps } from './fake-deps.js'
import type { FakeSettingsDeps } from './fake-deps.js'
import { resetSourceListUi } from '../../src/client/source-list.js'
import { ROUTES } from '../../src/shared/wire.js'
import type { JobState, SourcePublic } from '../../src/client/views/types.js'

/**
 * 选中动作条 + 批量删除确认流的接线测试：「启用/停用所选」「验证所选」
 * 「删除所选」与 BatchConfirm typed 确认流（>20 手输「删除」）、confirmDelete 失败半场
 * 此前零测试（grep tests/ = 0 命中）——client 破坏性最高的未测 seam，全是破坏性写操作。
 * 经 makeDeps 假束驱动：断言写口载荷、失败上报、确认强度与在途防重复提交。
 */

const src = (over: Partial<SourcePublic> & { id: string }): SourcePublic => ({
  name: over.id, baseUrl: `https://${over.id}.com`, enabled: true, groups: [],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  ...over,
})

const S1 = src({ id: 's1', name: '源一' })
const S2 = src({ id: 's2', name: '源二' })
const S3 = src({ id: 's3', name: '源三', hasAuth: true })

const runningProbe: JobState = {
  id: 'p1', kind: 'batch-probe', phase: 'running', total: 3, done: 1,
  counts: { ok: 1, failed: 0, dupSkipped: 0, replaced: 0 },
  issues: [], fileErrors: [], startedAt: 0,
}

const view = (deps: FakeSettingsDeps, sources: SourcePublic[] = [S1, S2, S3], job: JobState | null = null): ReactNode =>
  <SourceList sources={sources} job={job} refresh={() => {}} onChanged={() => {}} onProbe={() => {}} deps={deps} />

/** 进编辑态并勾选指定行（复选框 aria-label = `选择 ${name}`） */
function selectRows(names: string[]): void {
  fireEvent.click(screen.getByText('编辑'))
  for (const n of names) fireEvent.click(screen.getByLabelText(`选择 ${n}`))
}

/** 选中动作条上的按钮（disabled 断言用原生属性） */
function selbarButton(label: string): HTMLElement {
  const bar = document.querySelector<HTMLElement>('[data-novel-selbar]')
  expect(bar, '选中动作条未出现').not.toBeNull()
  const btn = [...(bar as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  expect(btn, `动作条上找不到「${label}」`).toBeDefined()
  return btn as HTMLElement
}

beforeEach(() => resetSourceListUi())
afterEach(cleanup)

describe('选中动作条：启用/停用/验证所选（写口载荷 + 成功刷新 + 失败上报）', () => {
  it('启用所选：POST batch-enabled {ids, enabled:true}，回包后 refresh 并退出编辑态', async () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一', '源二'])
    fireEvent.click(screen.getByText('启用所选'))

    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchEnabled.path, { ids: ['s1', 's2'], enabled: true }))
    // 成功路径：编辑态退出 → 选择集清空 → 动作条消失（服务端为准，行内开关等 reload 校准）
    await waitFor(() => expect(document.querySelector('[data-novel-selbar]')).toBeNull())
    expect(deps.pushError).not.toHaveBeenCalled()
  })

  it('停用所选：同端点 enabled:false', async () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源三'])
    fireEvent.click(screen.getByText('停用所选'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchEnabled.path, { ids: ['s3'], enabled: false }))
  })

  it('验证所选：startBatchProbeJob(选中 ids) 经注入 deps 提交', async () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一', '源三'])
    fireEvent.click(screen.getByText('验证所选'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['s1', 's3']))
  })

  it('失败半场：pushError 上报「操作失败」+ 原因；不触发 refresh（服务端没变就不重拉）', async () => {
    const deps = makeDeps({ apiSend: vi.fn(() => Promise.reject(new Error('boom'))) })
    const refresh = vi.fn()
    render(
      <SourceList sources={[S1, S2, S3]} job={null} refresh={refresh} onChanged={() => {}} onProbe={() => {}} deps={deps} />
    )
    selectRows(['源一'])
    fireEvent.click(screen.getByText('启用所选'))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('操作失败')
    expect(String(deps.pushError.mock.calls[0][0])).toContain('boom')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('在途防重复提交：批量任务运行中（probing）三个写按钮全部禁用，删除所选仍可开确认', () => {
    const deps = makeDeps()
    render(view(deps, [S1, S2, S3], runningProbe))
    selectRows(['源一'])
    expect(selbarButton('启用所选').hasAttribute('disabled')).toBe(true)
    expect(selbarButton('停用所选').hasAttribute('disabled')).toBe(true)
    expect(selbarButton('验证所选').hasAttribute('disabled')).toBe(true)
    // 删除走 typed 确认流（可先攒着，任务跑完再确认）——不随 probing 禁用
    expect(selbarButton('删除所选').hasAttribute('disabled')).toBe(false)
  })
})

describe('删除所选：确认流（≤20 计数确认 / >20 手输「删除」）', () => {
  it('≤20 普通计数确认：确认后 POST batch-delete {ids}，成功关条 + onChanged', async () => {
    const deps = makeDeps()
    const onChanged = vi.fn()
    render(
      <SourceList sources={[S1, S2, S3]} job={null} refresh={() => {}} onChanged={onChanged} onProbe={() => {}} deps={deps} />
    )
    selectRows(['源一', '源二'])
    fireEvent.click(screen.getByText('删除所选'))

    // 确认条：计数点名 + 无口令输入
    expect(screen.getByText('删除所选（2 个）')).toBeTruthy()
    expect(screen.queryByPlaceholderText('大批量：手输「删除」二字确认')).toBeNull()

    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchDelete.path, { ids: ['s1', 's2'] }))
    await waitFor(() => expect(screen.queryByText('确认删除')).toBeNull())   // 关条
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(deps.pushError).not.toHaveBeenCalled()
  })

  it('>20 typed 流：确认钮先禁用，手输「删除」（trim 后）才放行；口令不对不放行', async () => {
    const many = Array.from({ length: 21 }, (_, i) => src({ id: `m${i}`, name: `源${i}` }))
    const deps = makeDeps()
    render(view(deps, many))
    fireEvent.click(screen.getByText('编辑'))
    fireEvent.click(screen.getByLabelText('全选当前过滤结果'))
    await waitFor(() => expect(screen.getByText('已选 21')).toBeTruthy())
    fireEvent.click(screen.getByText('删除所选'))

    expect(screen.getByText('删除所选（21 个）')).toBeTruthy()
    const input = screen.getByPlaceholderText('大批量：手输「删除」二字确认')
    const confirm = (): HTMLElement => screen.getByText('确认删除')
    expect(confirm().hasAttribute('disabled')).toBe(true)

    fireEvent.change(input, { target: { value: '删除啊' } })                // 错口令：仍禁用
    expect(confirm().hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: ' 删除 ' } })                // trim 后放行
    expect(confirm().hasAttribute('disabled')).toBe(false)

    fireEvent.click(confirm())
    const expected = many.map((s) => s.id)
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchDelete.path, { ids: expected }))
  })

  it('带登录态源点名：确认条提示 cookie 失效（authCount 经派生 view-model）', () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一', '源三'])
    fireEvent.click(screen.getByText('删除所选'))
    expect(screen.getByText('其中 1 个带登录态，删除后 cookie 失效')).toBeTruthy()
  })

  it('confirmDelete 失败半场：pushError 上报「批量删除失败」，确认条照常收起，onChanged 不触发', async () => {
    const deps = makeDeps({ apiSend: vi.fn(() => Promise.reject(new Error('磁盘只读'))) })
    const onChanged = vi.fn()
    render(
      <SourceList sources={[S1, S2, S3]} job={null} refresh={() => {}} onChanged={onChanged} onProbe={() => {}} deps={deps} />
    )
    selectRows(['源一'])
    fireEvent.click(screen.getByText('删除所选'))
    fireEvent.click(screen.getByText('确认删除'))

    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('批量删除失败')
    expect(String(deps.pushError.mock.calls[0][0])).toContain('磁盘只读')
    expect(screen.queryByText('确认删除')).toBeNull()        // setPending(null)：失败也收条（错误进全局条）
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('取消：确认条收起，零写请求', () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('删除所选'))
    fireEvent.click(screen.getByText('取消'))
    expect(screen.queryByText(/删除所选（/)).toBeNull()
    expect(deps.apiSend).not.toHaveBeenCalled()
  })
})

describe('危险操作区：整库级快捷批量（ids 点击时快照）', () => {
  it('删除全部坏源：确认条点名坏源集合，确认后按快照 ids 提交', async () => {
    const broken1 = src({ id: 'b1', name: '坏一', status: 'broken' })
    const broken2 = src({ id: 'b2', name: '坏二', status: 'broken' })
    const deps = makeDeps()
    render(view(deps, [S1, broken1, broken2]))
    fireEvent.click(screen.getAllByText('删除…')[0])         // 危险区第一个：删除全部坏源

    expect(screen.getByText('删除全部坏源（2 个）')).toBeTruthy()
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchDelete.path, { ids: ['b1', 'b2'] }))
  })

  it('删除全部未验证：作用对象是未验证集合，与坏源集合互不串', async () => {
    const unv = src({ id: 'u1', name: '未验一', status: 'unverified' })
    const brk = src({ id: 'b1', name: '坏一', status: 'broken' })
    const deps = makeDeps()
    render(view(deps, [S1, unv, brk]))
    const dels = screen.getAllByText('删除…')
    fireEvent.click(dels[1])                                 // 第二个：删除全部未验证

    expect(screen.getByText('删除全部未验证源（1 个）')).toBeTruthy()
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchDelete.path, { ids: ['u1'] }))
  })
})

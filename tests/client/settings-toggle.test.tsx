// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { SourceList } from '../../src/client/views/SettingsSourceList.js'
import { makeDeps } from './fake-deps.js'
import type { FakeSettingsDeps } from './fake-deps.js'
import { resetSourceListUi, UNGROUPED } from '../../src/client/source-list.js'
import type { SourcePublic } from '../../src/client/views/types.js'

/**
  * 接线层交互测试：启停开关的「乐观翻转 → 在途 → 失败即刻回滚
 * → error 泳道挂行锚点」整条时序，历史上住着真 bug（「原实现乐观态无人清零，开关会永久停在
 * 错误态」），却因为视图硬 import 真实现而**无法被测试驱动**。现在经 deps seam 注入假 adapter
  * （桩工厂统一到 tests/client/fake-deps.ts）。
 */

const src: SourcePublic = {
  id: 's1', name: '源A', baseUrl: 'https://a.com', enabled: true, groups: ['小说'],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
}

const view = (deps: FakeSettingsDeps): ReactNode =>
  <SourceList sources={[src]} job={null} refresh={() => {}} onChanged={() => {}} onProbe={() => {}} deps={deps} />

const checked = (): string | null => screen.getByRole('switch').getAttribute('aria-checked')

beforeEach(() => resetSourceListUi())   // 模块级现场一次复位（先例 resetTransient）
afterEach(cleanup)

describe('SourceList 启停开关接线（deps seam 驱动）', () => {
  it('成功路径：点击即乐观翻转（请求未回已是新态），回包后保持', async () => {
    let resolveSend: (v: unknown) => void = () => { /* replaced below */ }
    const deps = makeDeps({ apiSend: vi.fn(() => new Promise((res) => { resolveSend = res })) })
    render(view(deps))
    expect(checked()).toBe('true')                        // 初始：已启用（按钮语义=停用）

    fireEvent.click(screen.getByRole('switch'))
    expect(checked()).toBe('false')                       // 乐观翻转：请求还没回，展示已切

    resolveSend({})
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(checked()).toBe('false'))  // 回包后保持新态
    expect(deps.pushError).not.toHaveBeenCalled()
  })

  it('失败路径：即刻回滚到服务端原态 + error 泳道挂行锚点（历史 bug 回归钉死）', async () => {
    const deps = makeDeps({ apiSend: vi.fn(() => Promise.reject(new Error('boom'))) })
    render(view(deps))
    expect(checked()).toBe('true')

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))

    expect(checked()).toBe('true')                        // 回滚：不许永久停在错误的乐观态
    const [label, anchor] = deps.pushError.mock.calls[0]
    expect(String(label)).toContain('启停失败')
    expect(String(label)).toContain('boom')
    expect(anchor).toBe('[data-novel-source-row="s1"]')   // 全局条「定位 →」与行内红边共用的选择器
  })

  it('在途不进瞬态泳道（闪烁修复的政策：inFlight 零占用）', async () => {
    let settle: (v: unknown) => void = () => { /* replaced below */ }
    const deps = makeDeps({ apiSend: vi.fn(() => new Promise((res) => { settle = res })) })
    render(view(deps))
    fireEvent.click(screen.getByRole('switch'))
    // 请求在途：既无 pending 泳道（无 pushPending 通道），也无错误
    expect(deps.pushError).not.toHaveBeenCalled()
    expect(screen.queryByRole('progressbar')).toBeNull()
    settle({})
    await waitFor(() => expect(checked()).toBe('false'))
  })
})

/** 分组下拉「未分组」伪选项（增补）：无分组源不属于任何真实组——没有这个入口就定位不到 */
describe('SourceList 分组下拉「未分组」伪选项', () => {
  const ungrouped: SourcePublic = { ...src, id: 's2', name: '源B', baseUrl: 'https://b.com', groups: [] }
  const renderWith = (sources: SourcePublic[]): HTMLSelectElement => {
    render(<SourceList sources={sources} job={null} refresh={() => {}} onChanged={() => {}} onProbe={() => {}} deps={makeDeps()} />)
    return screen.getByLabelText('按分组过滤') as HTMLSelectElement
  }

  it('有无分组源 → 出现「未分组（n）」选项；选中后只显示无分组源', () => {
    const sel = renderWith([src, ungrouped])
    expect([...sel.options].find((o) => o.value === UNGROUPED)?.textContent).toBe('未分组（1）')

    fireEvent.change(sel, { target: { value: UNGROUPED } })
    expect(screen.getByText('源B')).toBeTruthy()      // 无分组源入选
    expect(screen.queryByText('源A')).toBeNull()      // 有分组源被排除
  })

  it('计数为 0 → 不渲染该选项（不添噪声）', () => {
    const sel = renderWith([src])
    expect([...sel.options].some((o) => o.value === UNGROUPED)).toBe(false)
  })
})

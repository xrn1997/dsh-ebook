// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { ApiClientError } from '../../src/client/api.js'
import { ProbePane } from '../../src/client/views/SettingsSection.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { SearchView } from '../../src/client/views/SearchView.js'
import { makeCoreDeps, makeDeps, makeReaderDeps } from './fake-deps.js'
import type { CoreDepsOverrides, FakeCoreDeps, FakeReaderDeps, FakeSettingsDeps, ReaderDepsOverrides, SettingsDepsOverrides } from './fake-deps.js'
import type { JobState, SourcePublic } from '../../src/client/views/types.js'

/**
 * 接线层交互测试·第二梯队：
  * deps seam 此前只盖设置区——书架/搜索的接线（陈旧回调、乐观删除、误导性空态）
 * 与试跑器（失败假死）仍是 bug 巢穴且无 seam。本文件用核心依赖束（ClientCoreDeps）
 * 驱动这些历史 bug 形态，逐条钉死。桩工厂统一到 fake-deps.ts。
 */

const coreDeps = (over: CoreDepsOverrides): FakeCoreDeps => makeCoreDeps(over)

afterEach(cleanup)

describe('ProbePane：失败显式呈现（历史 bug：.then(setResult) 无 rejection handler → 永久「探针执行中…」）', () => {
  const probeDeps = (apiSend: unknown): FakeSettingsDeps => makeDeps({ apiSend })

  it('请求失败 → 显示错误卡，不再假死在执行中', async () => {
    const deps = probeDeps(vi.fn(() => Promise.reject(new Error('路由 404（请重启 DSH）'))))
    render(createElement(ProbePane, { sourceId: 's1', onBack: () => {}, deps }))
    // 初始：执行中（请求在途）
    expect(screen.getByText(/探针执行中/)).toBeTruthy()
    // 失败落地：错误显式呈现（不再永久执行中）
    await waitFor(() => expect(screen.getByText(/探针请求失败/)).toBeTruthy())
    expect(screen.queryByText(/探针执行中/)).toBeNull()
  })

  it('成功路径不受影响：结果卡照常渲染', async () => {
    const deps = probeDeps(vi.fn(async () => ({ ok: true, itemCount: 3, firstTitle: '斗罗', probedAt: 1 })))
    render(createElement(ProbePane, { sourceId: 's1', onBack: () => {}, deps }))
    await waitFor(() => expect(screen.getByText(/命中 3 条/)).toBeTruthy())
  })
})

describe('ShelfView 接线（deps seam 驱动）', () => {
  const book = {
    bookKey: 'k1', sourceId: 's1', title: '斗罗', addedAt: 1,
    progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
  }

  it('加载失败 → 显示错误而非「书架空空」误导性空态（历史 bug 钉死）', async () => {
    const deps = coreDeps({ apiGet: vi.fn(() => Promise.reject(new Error('网络断了'))) })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText(/书架加载失败/)).toBeTruthy())
    expect(screen.queryByText(/书架空空/)).toBeNull()    // 失败不许伪装成空架
  })

  it('空架（真零本）仍显示引导空态', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async () => []) })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText(/书架空空/)).toBeTruthy())
  })

  it('删除失败 → 卡片保留 + 错误呈现（乐观删除的回滚半场）', async () => {
    let call = 0
    const deps = coreDeps({
      apiGet: vi.fn(async () => [book]),
      apiSend: vi.fn(() => { call++; return Promise.reject(new Error('删不动')) }),
    })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    fireEvent.click(screen.getByTitle('删除本书'))
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(screen.getByText(/删除失败/)).toBeTruthy())
    expect(call).toBe(1)
    expect(screen.getByText('斗罗')).toBeTruthy()         // 卡片还在（本地过滤只在成功后）
  })
})

describe('SearchView 接线：陈旧回调防线（历史 bug 形态：一轮迟到批次污染二轮结果）', () => {
  const group = (title: string) => ({
    sourceId: 's1', sourceName: 'S', status: 'verified',
    hits: [{ title, author: null, url: 'https://s.com/book/1', coverUrl: null, intro: null, lastChapterName: null }],
  })

  it('第二轮搜索后，第一轮的迟到批次被丢弃（runId 防线经 seam 可测）', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    const firstCall = { pending: true }
    const deps = coreDeps({
      apiGet: vi.fn((path: string) => {
        if (path === 'search/plan') return Promise.resolve({ sourceIds: ['s1'] })   // 参与集归服务端
        if (path.includes(encodeURIComponent('第一'))) {
          firstCall.pending = false
          return new Promise((res) => { resolveFirst = res })
        }
        if (path.includes(encodeURIComponent('第二'))) return Promise.resolve([group('第二轮书')])
        return Promise.resolve([])
      }),
    })
    render(createElement(SearchView, { deps }))

    // 第一轮提交（批次挂起）
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '第一' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(firstCall.pending).toBe(false))    // 第一轮已发出批次请求

    // 第二轮提交（批次立即回来）
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '第二' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText('第二轮书')).toBeTruthy())

    // 第一轮迟到批次此刻才回来——必须被丢弃，不许污染二轮结果
    resolveFirst([group('第一轮书')])
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('第一轮书')).toBeNull()
    expect(screen.getByText('第二轮书')).toBeTruthy()
  })

   it('plan 返回 0 源 → 显式空态，不再只剩 0% 进度条', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => (path === 'search/plan' ? { sourceIds: [] } : [])),
    })
    render(createElement(SearchView, { deps }))
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText(/没有参与搜索的书源/)).toBeTruthy())
  })
})

describe('SettingsSection 整壳接线（SettingsDeps 注入——startBatchProbeJob/apiGet 不再硬 import）', () => {
  const unverifiedSrc: SourcePublic = {
    id: 'u1', name: '未验源', baseUrl: 'https://u.com', enabled: true, groups: [],
    type: 'text', status: 'unverified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  }
  const doneImportJob: JobState = {
    id: 'imp1', kind: 'import', phase: 'done', total: 1, done: 1,
    counts: { ok: 1, failed: 0, dupSkipped: 0, replaced: 0 },
    issues: [], fileErrors: [], startedAt: 0,
  }
  const settingsDeps = (over: SettingsDepsOverrides = {}): FakeSettingsDeps =>
    makeDeps({ apiGet: vi.fn(async (path: string) => (path === 'sources' ? [unverifiedSrc] : null)), ...over })

  // 手风琴折叠态持久化在 localStorage（本环境的全局 localStorage 无方法实现——照
  // sections.test.ts 的做法 stub 一份内存版）：每例钉成「两区展开」，导入完成态与验证入口都在 DOM 里
  const mem = new Map<string, string>()
  beforeEach(() => {
    mem.set('dsh-novel.sections', JSON.stringify({ importOpen: true, listOpen: true }))
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('源列表经 deps.apiGet 加载（整壳注入后子组件不吃 prodDeps 缺省）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText('未验源')).toBeTruthy())
    expect(deps.apiGet).toHaveBeenCalledWith('sources')
  })

  it('「去验证」回调经 deps.startBatchProbeJob 提交（SettingsSection 里那个硬 import 的写动词）', async () => {
    const deps = settingsDeps({ lastImportJob: () => doneImportJob })
    render(createElement(SettingsSection, { deps }))
    const go = await screen.findByText(/去验证 1 个未验证源/)
    fireEvent.click(go)
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
  })

  it('源列表区「验证全部未验证」同样走注入 deps（透传到子组件，非各自 prodDeps）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText(/验证全部未验证（1）/))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
  })

   it('源列表加载失败 → 显式错误，不伪装空列表（此前 setSources([]) 把失败说成「0 个源」）', async () => {
    const deps = settingsDeps({ apiGet: vi.fn(async () => { throw new Error('boom') }) })
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText(/源列表加载失败：boom/)).toBeTruthy())
    expect(screen.queryByText('还没有书源——选择文件或拖入一个 legado 书源开始')).toBeNull()
  })

   it('「去验证」提交失败 → 走 pushError 显式呈现（此前 () => undefined 吞掉 rejection）', async () => {
    const deps = settingsDeps({
      lastImportJob: () => doneImportJob,
      startBatchProbeJob: vi.fn(async () => { throw new Error('网络失败') }),
    })
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText(/去验证 1 个未验证源/))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledWith(expect.stringContaining('网络失败')))
  })
})

describe('ReaderView 接线（ReaderDeps 注入 + 整本导出流经 export-run）', () => {
  const readerDeps = (over: ReaderDepsOverrides = {}): FakeReaderDeps => makeReaderDeps(over)

  const reader = (deps: FakeReaderDeps): ReturnType<typeof createElement> =>
    createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '斗罗', deps })

  it('阅读会话的网络取数走注入 deps（toc 经 deps.apiGet，不再硬 import apiGet）', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(deps.apiGet).toHaveBeenCalled())
    expect(String(deps.apiGet.mock.calls[0][0])).toContain('toc')
  })

  it('点「⤓ 下载」→ streamExport 经 deps 在途，成功后 saveBlob 按书名落盘', async () => {
    const deps = readerDeps()
    render(reader(deps))
    fireEvent.click(screen.getByText('⤓ 下载'))
    await waitFor(() => expect(deps.streamExport).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(deps.saveBlob).toHaveBeenCalledTimes(1))
    expect(String(deps.saveBlob.mock.calls[0][1])).toBe('斗罗.txt')
  })

  it('导出失败：错误条呈现 code（导出错误与阅读链路 error 分家，历史形态：整段硬 import 零覆盖）', async () => {
    const deps = readerDeps({
      streamExport: vi.fn(async () => { throw new ApiClientError('ExportFailed', 500, '服务端导出失败') }),
    })
    render(reader(deps))
    fireEvent.click(screen.getByText('⤓ 下载'))
    await waitFor(() => expect(screen.getByText(/ExportFailed/)).toBeTruthy())
  })
})

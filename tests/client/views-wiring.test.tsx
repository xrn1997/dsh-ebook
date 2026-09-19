// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { ApiClientError } from '../../src/client/api.js'
import { ProbePane } from '../../src/client/views/SettingsSection.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'
import { NovelView } from '../../src/client/views/NovelView.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { SearchView } from '../../src/client/views/SearchView.js'
import { navigate } from '../../src/client/store.js'
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

  it('删除确认是模态：✕ 弹对话框；Esc 取消关闭且不发 DELETE', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async () => [book]), apiSend: vi.fn() })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    fireEvent.click(screen.getByTitle('删除本书'))
    // 模态在场：role=dialog + 确认文案带书名（deleteBookCopy 口径）
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('删除《斗罗》？')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deps.apiSend).not.toHaveBeenCalled()           // 取消不许发出删除请求
    expect(screen.getByText('斗罗')).toBeTruthy()
  })

  it('删除确认模态：点遮罩取消同样零请求', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async () => [book]), apiSend: vi.fn() })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    fireEvent.click(screen.getByTitle('删除本书'))
    fireEvent.click(document.querySelector('.novel-modal-mask')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deps.apiSend).not.toHaveBeenCalled()
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

describe('SettingsSection 整壳接线（2026 调度台 IA：待办箱 + 弹层闭环；SettingsDeps 注入）', () => {
  const unverifiedSrc: SourcePublic = {
    id: 'u1', name: '未验源', baseUrl: 'https://u.com', enabled: true, groups: [],
    type: 'text', status: 'unverified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  }
  const brokenSrc: SourcePublic = {
    id: 'b1', name: '坏源甲', baseUrl: 'https://b.com', enabled: true, groups: [],
    type: 'text', status: 'broken', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  }
  const doneImportJob: JobState = {
    id: 'imp1', kind: 'import', phase: 'done', total: 1, done: 1,
    counts: { ok: 1, failed: 0, dupSkipped: 0, replaced: 0 },
    issues: [], fileErrors: [], startedAt: 0,
  }
  const settingsDeps = (over: SettingsDepsOverrides = {}, sources: SourcePublic[] = [unverifiedSrc]): FakeSettingsDeps =>
    makeDeps({ apiGet: vi.fn(async (path: string) => (path === 'sources' ? sources : null)), ...over })

  it('源列表经 deps.apiGet 加载（整壳注入后子组件不吃 prodDeps 缺省）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(document.querySelector('[data-novel-source-list]')).not.toBeNull())
    await waitFor(() => expect(screen.getAllByText('未验源').length).toBeGreaterThan(0))   // 名字同时在待办卡与表格行（多匹配属正常）
    expect(deps.apiGet).toHaveBeenCalledWith('sources')
  })

  it('待办收件箱：坏源/未验证成任务卡（反常置顶）；「一键验证」走注入 deps', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    expect(await screen.findByText('? 未验证 1')).toBeTruthy()
    expect(screen.getByText('✗ 坏源 1')).toBeTruthy()
    const brokenCard = document.querySelector('[data-novel-todo="broken"]')
    expect(brokenCard, '坏源任务卡未渲染').not.toBeNull()
    expect(within(brokenCard as HTMLElement).getByText('坏源甲')).toBeTruthy()   // 名单在卡内
    fireEvent.click(screen.getByText('一键验证'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
  })

  it('「批量重验」= 坏源集合的处置动作（ids 经 source-inbox 纯派生，点击时快照）', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('批量重验'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['b1']))
  })

  it('导入弹层：默认关闭；「＋ 导入书源」打开（拖放区在场），Esc 收起', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(document.querySelector('[data-novel-source-list]')).not.toBeNull())
    expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull()   // 弹层默认关（低频任务不常驻）
    fireEvent.click(screen.getByText('＋ 导入书源'))
    expect(screen.getByText(/选择或拖入 legado 书源文件/)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull())
  })

  it('导入完成态「去验证」：弹层内回调 → startBatchProbeJob(未验证 ids) + 弹层收起（闭环）', async () => {
    const deps = settingsDeps({ lastImportJob: () => doneImportJob })
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    fireEvent.click(await screen.findByText(/去验证 1 个未验证源/))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
    await waitFor(() => expect(screen.queryByText('选择或拖入 legado 书源文件')).toBeNull())
  })

  it('提交导入 → 弹层自动关闭（onSubmitted 口径：任务在服务端继续，结果经待办回流）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File(['[{"bookSourceName":"A"}]'], 'a.json', { type: 'application/json' })
    fireEvent.change(input as Element, { target: { files: [file] } })
    await waitFor(() => expect(deps.startImportJob).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('选择或拖入 legado 书源文件')).toBeNull())
  })

  it('源列表加载失败 → 显式错误；待办箱不渲染（不拿未知当「✓ 全部良好」）', async () => {
    const deps = settingsDeps({ apiGet: vi.fn(async () => { throw new Error('boom') }) })
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText(/源列表加载失败：boom/)).toBeTruthy())
    expect(screen.queryByText('一键验证')).toBeNull()
    expect(screen.queryByText(/全部源状态良好/)).toBeNull()
  })

  it('「去验证」提交失败 → pushError 显式呈现（历史 bug：() => undefined 吞 rejection）', async () => {
    const deps = settingsDeps({
      lastImportJob: () => doneImportJob,
      startBatchProbeJob: vi.fn(async () => { throw new Error('网络失败') }),
    })
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    fireEvent.click(await screen.findByText(/去验证 1 个未验证源/))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledWith(expect.stringContaining('启动验证失败')))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('网络失败')
  })

  it('全健康源 → 待办箱空态「✓ 全部源状态良好」；顺序不变量：待办箱在表格之前', async () => {
    const healthy: SourcePublic = { ...unverifiedSrc, id: 'h1', name: '健康源', status: 'verified' }
    const deps = settingsDeps({}, [healthy])
    const { container } = render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText(/全部源状态良好/)).toBeTruthy())
    // 顺序断言走 DOM 比较而非 innerHTML.indexOf——innerHTML 里 <style>（NovelStyles）注入的
    // CSS 文本先出现，字符串匹配会打到规则文本上（`.novel-table` 规则在 `.novel-inbox` 之前=假红）
    const inbox = container.querySelector('[data-novel-inbox]')
    const table = container.querySelector('.novel-table')
    expect(inbox, '待办箱未渲染').not.toBeNull()
    expect(table, '表格未渲染').not.toBeNull()
    expect((inbox as Element).compareDocumentPosition(table as Element) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('导入弹层焦点不被壳层重渲染劫持（useJobStatus 1s 轮询 tick → 新 onClose 闭包；mount-scoped 口径）', async () => {
    // 病史（审查 2026）：ImportModal 的焦点/Esc effect 依赖 [onClose]，而 onClose 是壳层
    // 每 render 新造的内联箭头；任务记录在场时 useJobStatus 每秒 setJob 新对象 → 壳层重渲染
    // → effect cleanup+重跑 → 用户焦点被每秒劫回「关闭」钮。挂载作用域化后焦点必须原地不动。
    const deps = settingsDeps()
    const { rerender } = render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    const closeBtn = screen.getByText('关闭')
    expect(document.activeElement).toBe(closeBtn)        // 入场焦点在关闭钮
    const dropzone = document.querySelector('[data-novel-dropzone]') as HTMLElement
    expect(dropzone).not.toBeNull()
    dropzone.focus()                                     // 用户把焦点移进弹层内容
    rerender(createElement(SettingsSection, { deps }))   // 模拟轮询 tick 的壳层重渲染 ×2
    rerender(createElement(SettingsSection, { deps }))
    expect(document.activeElement).toBe(dropzone)        // 旧实现：每次重渲染都被劫回关闭钮
    fireEvent.keyDown(document, { key: 'Escape' })       // Esc 监听不因挂载作用域化丢注册（走 ref 调最新闭包）
    await waitFor(() => expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull())
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

describe('NovelView 顶部 tab 导航（书架|书城|书源管理 并列；settings.section 注册已撤，书源管理归属主界面）', () => {
  // routeStore 是模块级全局现场——本组每条测完复位 shelf，防止污染后续依赖默认路由的断言
  afterEach(() => { navigate({ name: 'shelf' }) })

  it('点 tab 切换分支：书城=占位空态；书源管理=原设置区块渲染在小说视图内；书架=回首页', async () => {
    render(createElement(NovelView))
    const tabs = (): ReturnType<typeof within> => within(screen.getByRole('group', { name: '小说视图导航' }))
    // 默认书架：tab 组在场（书架 tab 激活）+ 书架内容渲染（搜索框常驻，与加载态无关）
    expect(tabs().getByRole('button', { name: '书架' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(screen.getByPlaceholderText(/搜书名/)).toBeTruthy())
    // 「搜索」提交钮在场：与搜索页同款口径（Enter 是隐藏交互，可见按钮才是显式入口）
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy()
    // 书城：CityView 占位空态，书架内容已卸载
    fireEvent.click(tabs().getByRole('button', { name: '书城' }))
    await waitFor(() => expect(screen.getByText(/书城未上线/)).toBeTruthy())
    expect(screen.queryByPlaceholderText(/搜书名/)).toBeNull()
    // 书源管理：SettingsSection（原宿主设置「小说」区块整体）渲染在小说视图内
    fireEvent.click(tabs().getByRole('button', { name: '书源管理' }))
    await waitFor(() => expect(document.querySelector('[data-novel-view="sources"]')).not.toBeNull())
    expect(screen.queryByText(/书城未上线/)).toBeNull()
    // 回书架：首页内容回来
    fireEvent.click(tabs().getByRole('button', { name: '书架' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/搜书名/)).toBeTruthy())
  })
})

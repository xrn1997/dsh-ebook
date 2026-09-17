import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { NovelView } from '../../src/client/views/NovelView.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { routeStore } from '../../src/client/store.js'

describe('NovelView smoke（renderToString 不炸——数据获取在 effect，smoke 只锁渲染分支）', () => {
  it.each([
    ['shelf', { name: 'shelf' }],
    ['reader', { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' }],
    ['search', { name: 'search' }],
  ])('route=%s 可渲染', (_n, route) => {
    routeStore.set({ route: route as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel')             // 根容器标记
  })
  it('首页 = 居中搜索框 + 封面网格', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-view="shelf"')
    expect(html).toContain('placeholder="搜书名 / 作者"')   // 首页搜索框
  })
  it('设置「小说」区块：导入子面 = 拖放区主入口 + 粘贴折叠区', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-dropzone')                // 拖放区是主入口
    expect(html).toContain('选择或拖入 legado 书源文件')
    expect(html).toContain('粘贴 legado 书源')                   // 粘贴降级折叠区仍在
    expect(html).not.toContain('data-novel-run-card')            // 无任务不渲染运行卡
    expect(html).not.toContain('data-novel-job-status')          // 无任务不渲染状态条
    expect(html).not.toContain('data-novel-status-bar')          // 空闲零占用：无条目时全局状态条整体不渲染
  })
  it('§5.4 风格统一：原生 file input 隐藏（拖放区点击触发，不裸露原生控件）', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('type="file"')
    expect(html).toMatch(/display:\s*none/)                      // 隐藏 input + 拖放区点击/drop 触发
  })
  it('源列表：chips 过滤条 + 浏览态纯浏览（复选框/行操作不渲染）', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-chip="all"')
    expect(html).toContain('data-novel-chip="disabled"')         // 已停用 chip（启停功能）
    expect(html).toContain('data-novel-edit-toggle')             // 表头「编辑」显式切换
    expect(html).not.toContain('type="checkbox"')                // 浏览态无复选框
    expect(html).toContain('危险操作（整库级）')                  // 危险操作折叠区
  })
  it('IA：表格是末位元素——列表级操作在表格之前（长列表下表格之下摸不着，增补）', () => {
    const html = renderToString(createElement(SettingsSection))
    const atTable = html.indexOf('class="novel-table"')
    expect(atTable).toBeGreaterThan(-1)
    expect(html.indexOf('危险操作（整库级）')).toBeLessThan(atTable)   // 危险区上移，不沉底
    expect(html.indexOf('验证全部未验证')).toBeLessThan(atTable)      // 验证入口同理
  })
  it('设置「小说」区块：源列表渲染为行式列表 + 过滤框（630 源必须可定位）', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-source-list')
    expect(html).toContain('data-novel-source-filter')
    expect(html).toContain('data-novel-group-filter')            // 分组下拉过滤
  })
  it('设置「小说」区块：手风琴区块头可折叠（源列表与导入各有折叠钮）', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-section-toggle="list"')
    expect(html).toContain('data-novel-section-toggle="import"')
  })
  it('设置「小说」区块自带样式层（宿主设置是另一棵 React 树——不自带则 novel-* 类全裸奔）', () => {
    const html = renderToString(createElement(SettingsSection))
    expect(html).toContain('data-novel-style')
    expect(html).toContain('.novel-btn')
  })
  it('状态条不吃布局（闪烁修复）：条身 absolute、宿主锚 relative', () => {
    // 病因：状态条曾以流内元素挂在区块首，一次启停就把整块顶下去 35px 再弹回（真机逐帧实测）
    expect(NOVEL_CSS).toMatch(/\.novel-status-bar\s*\{[^}]*position:\s*absolute/)
    expect(NOVEL_CSS).toMatch(/\.novel-status-host\s*\{[^}]*position:\s*relative/)
  })
  it('样式层注入：渲染含 <style data-novel-style> 与基础类', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-style')
    expect(html).toContain('.novel-btn')
  })
  it('布局修复：根容器是 flex 列布局（视图区 flex:1——此前被 height:100% 挤出视口）', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-root')
    expect(html).toContain('data-novel-main')
    const css = html.slice(html.indexOf('data-novel-style'))
    expect(css).toContain('.novel-root')                  // 样式串含 flex 列定义
    expect(css).toContain('flex-direction: column')
  })
  it('阅读器：正文承载在宿主 scrollport 上——根容器带 data-novel-view 标记（sticky 工具栏的 :has 钩子）', () => {
    routeStore.set({ route: { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-view="reader"')
    expect(html).toContain('.novel-root:has(')             // 该视图下放开祖先 overflow，否则 sticky 落在自己身上
    expect(html).toContain('.novel-main:has(')
  })
  it('阅读器：未载章节不进 DOM（旧实现渲染 912 个占位块 → scrollHeight 被撑成整本书高，预取判据失效）', () => {
    routeStore.set({ route: { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('目录加载中…')                    // 目录未到：不渲染任何章块，也不渲染哨兵
    expect(html).not.toContain('data-chapter=')
    expect(html).not.toContain('data-novel-sentinel')
  })
  it('小说视图收掉宿主常驻 composer（AI 输入框）——只藏默认层，接管层（提问/审批）仍在', () => {
    // 直接断言样式串本身：renderToString 会把文本节点里的 " 转义成 &quot;，选择器断言走原串更可靠
    expect(NOVEL_CSS).toContain('[data-conversation-scroll]:has([data-novel-root]) [data-chain-overlay-fallback="conversation.composer"]')
    expect(NOVEL_CSS).toContain('display: none !important')  // 盖 inline display:contents；不整座藏（否则吞掉提问/审批接管）
    expect(NOVEL_CSS).not.toContain('[data-composer-seat] { display: none')
    routeStore.set({ route: { name: 'reader', sourceId: 's', bookKey: 'k', title: 'T' } as any })
    expect(renderToString(createElement(NovelView))).toContain('data-novel-style')   // 样式层确实随视图注入
  })
  it('小说视图收掉配套的列宽拖拽把手（data-width-handle，调 AI 输入框宽度那条）——兄弟选择器，不误伤对话视图', () => {
    expect(NOVEL_CSS).toContain('[data-conversation-scroll]:has([data-novel-root]) ~ [data-width-handle]')
    expect(NOVEL_CSS).toContain('~ [data-width-handle] { display: none; }')   // 兄弟（~）而非后代：chat 视图的把手照旧
    expect(NOVEL_CSS).not.toContain(']) [data-width-handle]')             // 不是后代选择器：chat 视图的把手照旧可见可拖
  })
  it('tab 栏已退役', () => {
    routeStore.set({ route: { name: 'shelf' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).not.toContain('data-novel="tabbar"')
  })
  it('搜索面渲染进度容器（分批进度条常驻）', () => {
    routeStore.set({ route: { name: 'search' } as any })
    const html = renderToString(createElement(NovelView))
    expect(html).toContain('data-novel-search-progress')
  })
  it('未知 route 兜底 shelf', () => {
    routeStore.set({ route: { name: 'nonexistent' } as any })
    expect(renderToString(createElement(NovelView))).toContain('data-novel-view="shelf"')
  })
})

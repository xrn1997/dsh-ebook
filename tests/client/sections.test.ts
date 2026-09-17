import { describe, expect, it, vi } from 'vitest'
import { applyRouteIntent, defaultSections, loadSections, parseSections, saveSections, toggleSection } from '../../src/client/sections.js'

/** 手风琴区块状态：默认策略 + 解析容错 + 持久化往返（用户明确要求「源列表要收得起来」） */
describe('sections 折叠状态', () => {
  it('默认策略：有源 → 列表展开/导入收起；零源 → 两者展开（引导去导入）', () => {
    expect(defaultSections(true)).toEqual({ importOpen: false, listOpen: true })
    expect(defaultSections(false)).toEqual({ importOpen: true, listOpen: true })
  })
  it('parseSections：只认布尔，缺项/坏 JSON 回退默认', () => {
    expect(parseSections('{"importOpen":false,"listOpen":false}', true)).toEqual({ importOpen: false, listOpen: false })
    expect(parseSections('{"importOpen":"yes"}', true)).toEqual({ importOpen: false, listOpen: true })  // 非布尔忽略
    expect(parseSections('garbage', false)).toEqual({ importOpen: true, listOpen: true })
    expect(parseSections(null, true)).toEqual({ importOpen: false, listOpen: true })
  })
  it('toggleSection：只翻指定键', () => {
    const s = { importOpen: false, listOpen: true }
    expect(toggleSection(s, 'listOpen')).toEqual({ importOpen: false, listOpen: false })
    expect(toggleSection(s, 'importOpen')).toEqual({ importOpen: true, listOpen: true })
  })
  it('load/save 往返：localStorage 可用时持久化；坏 JSON 不炸回默认', () => {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
    })
    saveSections({ importOpen: true, listOpen: false })
    expect(loadSections(true)).toEqual({ importOpen: true, listOpen: false })
    mem.set('dsh-novel.sections', '{bad json')
    expect(loadSections(true)).toEqual({ importOpen: false, listOpen: true })
    vi.unstubAllGlobals()
  })
  it('loadSections：localStorage 不可用 → 默认（不炸）', async () => {
    vi.resetModules()                     // 隔离 store.ts 的内存兜底（前例写入不许泄漏）
    vi.stubGlobal('localStorage', undefined)
    const fresh = await import('../../src/client/sections.js')
    expect(fresh.loadSections(false)).toEqual({ importOpen: true, listOpen: true })
    vi.unstubAllGlobals()
  })
})

/** 深链意图优先：书架空态「导入书源」导航过来，导入区必须展开——
 *  不许被「源数加载完成后的默认收敛」重新收起（用户实测：点了导入就回不去/不见了） */
describe('applyRouteIntent', () => {
  it('sub=import → 强制展开导入区，listOpen 不动', () => {
    expect(applyRouteIntent({ importOpen: false, listOpen: true }, 'import')).toEqual({ importOpen: true, listOpen: true })
    expect(applyRouteIntent({ importOpen: false, listOpen: false }, 'import')).toEqual({ importOpen: true, listOpen: false })
  })
  it('sub 为其他/缺省 → 原样返回', () => {
    const s = { importOpen: false, listOpen: true }
    expect(applyRouteIntent(s, 'list')).toBe(s)
    expect(applyRouteIntent(s, undefined)).toBe(s)
  })
})

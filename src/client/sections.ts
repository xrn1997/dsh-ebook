import { ls } from './util.js'

/** 手风琴区块折叠态（源管理：源列表/导入两块都要收得起来——用户实测 630 源铺满不可用）。
 *  localStorage 持久；无 DOM/坏 JSON → 默认策略（不炸）。 */
export interface Sections { importOpen: boolean; listOpen: boolean }

/** 默认策略：有源 → 列表展开、导入收起（导入是次频操作）；零源 → 两者展开（引导去导入） */
export function defaultSections(hasSources: boolean): Sections {
  return hasSources ? { importOpen: false, listOpen: true } : { importOpen: true, listOpen: true }
}

/** 解析持久化值：只认布尔，缺项/类型不符回退默认（坏数据不放大成坏体验） */
export function parseSections(raw: string | null, hasSources: boolean): Sections {
  const def = defaultSections(hasSources)
  if (raw === null) return def
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      importOpen: typeof parsed.importOpen === 'boolean' ? parsed.importOpen : def.importOpen,
      listOpen: typeof parsed.listOpen === 'boolean' ? parsed.listOpen : def.listOpen,
    }
  } catch {
    return def
  }
}

const KEY = 'dsh-novel.sections'

/** 是否已有持久化选择（无 → 首次进入按源数套默认策略） */
export function hasSavedSections(): boolean {
  return ls.getItem(KEY) !== null
}

export function loadSections(hasSources: boolean): Sections {
  return parseSections(ls.getItem(KEY), hasSources)
}

export function saveSections(sections: Sections): void {
  ls.setItem(KEY, JSON.stringify(sections))
}

/** 只翻指定键（其余原样） */
export function toggleSection(s: Sections, key: keyof Sections): Sections {
  return { ...s, [key]: !s[key] }
}

/** 深链意图优先：sub=import（书架空态「导入书源」导航）强制展开导入区——
 *  不许被「源数加载完成后的默认收敛」重新收起（意图赢过策略）。 */
export function applyRouteIntent(s: Sections, sub: string | undefined): Sections {
  return sub === 'import' ? { ...s, importOpen: true } : s
}

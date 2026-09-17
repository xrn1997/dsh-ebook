import { useSyncExternalStore } from 'react'
import { ls } from './util.js'

/** 轻量 store（useSyncExternalStore 驱动）：业务数据不进 store——每次挂载经 api 拉取，组件内 useState 持有
 *  口径详见 `docs/design/client.md`。 */
export interface Store<T> {
  get(): T
  set(patch: Partial<T>): void
  subscribe(cb: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; for (const cb of [...listeners]) cb() },
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

export function useStore<T extends object>(store: Store<T>): T {
  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

// ── 路由（view 内路由，无 URL 路由）─────────────────────────────

export type Route =
  | { name: 'shelf' }
  | { name: 'reader'; sourceId: string; bookKey: string; title: string }
  | { name: 'search'; keyword?: string }

export const routeStore = createStore<{ route: Route }>({ route: { name: 'shelf' } })
export function navigate(route: Route): void { routeStore.set({ route }) }

// ── 阅读偏好（localStorage 持久；进度不进 prefs——进度归服务端 shelf）──────

export interface Prefs { fontSize: number; lineHeight: number; paperColor: string; darkController: boolean }
export const DEFAULT_PREFS: Prefs = { fontSize: 18, lineHeight: 1.8, paperColor: '#f7f3e8', darkController: false }
const PREFS_KEY = 'dsh-novel.prefs'

// ls（localStorage guard）已迁 util.ts（它不是 store 的一部分）

function loadPrefs(): Prefs {
  try {
    const raw = ls.getItem(PREFS_KEY)
    if (raw === null) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return { ...DEFAULT_PREFS, ...parsed }
  } catch {
    return DEFAULT_PREFS
  }
}

export const prefsStore = createStore<Prefs>(loadPrefs())
export function setPref(patch: Partial<Prefs>): void {
  const next = { ...prefsStore.get(), ...patch }
  prefsStore.set(next)
  ls.setItem(PREFS_KEY, JSON.stringify(next))
}

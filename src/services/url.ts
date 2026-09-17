/**
 * URL 纯工具（从 bridge.ts 迁出——absUrl 是请求组装与链接规约的公共依赖，
 * 放在 bridge 会让 request/engine-fetch/bridge 三方成环：bridge→engineFetch→request→bridge）。
 */

/** URL 绝对化：空 / javascript: / new URL 解析失败 → null（不猜）。 */
export function absUrl(href: string | null | undefined, base: string): string | null {
  if (href === null || href === undefined) return null
  const h = href.trim()
  if (h === '' || /^\s*javascript:/i.test(h)) return null
  try {
    return new URL(h, base).toString()
  } catch {
    return null
  }
}

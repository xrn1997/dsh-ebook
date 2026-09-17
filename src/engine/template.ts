import { splitVarExpr } from './grammar.js'

export function interpolateUrl(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (whole, inner: string) => {
    // 词法拆分归 grammar.splitVarExpr 单点（此前与搜索面 isPureVarExpr 各写一份 || 拆分）
    const { name, fallback } = splitVarExpr(inner)
    if (name in vars) return encodeURIComponent(String(vars[name]))
    if (fallback !== null) return fallback
    return whole
  })
}

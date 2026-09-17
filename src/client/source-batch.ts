/**
 * 批量删除书源的纯逻辑（多选打底 + 状态快捷批量；确认强度=计数确认+大批量口令）。
 * 抽纯函数是本仓库 client 测试惯例——逻辑可单测，视图只做接线。
 */

/** 超过此数的批量删除要求手输「删除」二字才放行（计数确认 + 大批量口令） */
export const TYPED_CONFIRM_THRESHOLD = 20

/** 确认形态：0 个无操作；≤门槛普通计数确认；>门槛手输口令 */
export function batchConfirmKind(count: number): 'none' | 'simple' | 'typed' {
  if (count <= 0) return 'none'
  return count <= TYPED_CONFIRM_THRESHOLD ? 'simple' : 'typed'
}

/** 按状态收集源 id（状态快捷按钮用——数据取自现有 GET /sources 的公开投影） */
export function collectIdsByStatus(sources: Array<{ id: string; status: string }>, status: string): string[] {
  return sources.filter((s) => s.status === status).map((s) => s.id)
}

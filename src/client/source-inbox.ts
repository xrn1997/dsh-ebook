import type { SourcePublic } from './views/types.js'

/**
 * 书源待办（source inbox）的纯派生：全库源清单 →「需要你处理的事」两集合。
 * IA 口径（2026 调度台改版，用户拍板）：待办收件箱是书源管理 tab 的首屏——
 * 反常状态（坏源/未验证）置顶成任务卡，健康源退居列表；处置动作（批量重验/一键验证）
 * 贴着读数，逐源排查归列表行内「试跑」（待办是任务摘要，不放重复入口）。
 *
 * 抽纯函数的理由与 source-list-view.ts 同：派生逻辑可单测，视图只做接线。
 * 口径详见 `docs/design/client.md`「书源管理 tab 的 IA」。
 */

export interface SourceInbox {
  /** 坏源（status=broken）：处置 = 批量重验（探针重测）；逐源排查在列表行内 */
  broken: SourcePublic[]
  /** 未验证（status=unverified）：处置 = 一键验证；新导入的源自动汇入此处 */
  unverified: SourcePublic[]
}

/** 纯派生：零副作用。只看 `status`、不看 `enabled`——停用只摘掉「参与聚合搜索」这一件事，
 *  坏源/未验证的异常还在（2026-09 裁定：停用 ≠ 免验）。 */
export function sourceInbox(sources: SourcePublic[]): SourceInbox {
  return {
    broken: sources.filter((s) => s.status === 'broken'),
    unverified: sources.filter((s) => s.status === 'unverified'),
  }
}

/** 待办处置动作的作用对象 id 集（点击时快照，交由任务提交口）——集合已由 sourceInbox 裁过，这里只取 id */
export function inboxIds(inbox: SourceInbox, kind: 'broken' | 'unverified'): string[] {
  return inbox[kind].map((s) => s.id)
}

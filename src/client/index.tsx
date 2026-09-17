import type { Context } from '@deepseek-ai/cordis'
import { NovelView } from './views/NovelView.js'
import { SettingsSection } from './views/SettingsSection.js'

export const inject = ['slots', 'sessions']

/**
 * 浏览器半入口：注册对话区视图环的「小说」tab（slot-only 路线——DSH 插件 API 调研（docs/reference/dsh-plugin-api.md）§5 证实：
 * 独立应用 view 不需要 uiConversation.views/events.register，壳层对未注册 target 宽容）。
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as {
    slots: {
      inject(name: string, fn: () => () => void): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
  }).slots
  ctx.effect(() => slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: 'novel', order: 20, label: '小说' },
    NovelView,
  )), 'dsh-novel: conversation view')
  // 宿主设置「小说」区块：书源管理迁入 DSH 设置页——与 better-sidebar 的
  // settings.section 注册同款 API；外部 section 导航图标为宿主壳硬编码齿轮，无法自定义。
  ctx.effect(() => slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'novel', order: 100, label: '小说' },
    SettingsSection,
  )), 'dsh-novel: settings section')
}

export { NovelView }

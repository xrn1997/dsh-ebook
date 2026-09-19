/** 阅读偏好 UI 常量（自 SettingsView 迁出，供阅读控制器复用） */
export const FONT_STEPS = [12, 14, 16, 18, 20, 22, 24, 26, 28]
export const LINE_HEIGHTS = [1.4, 1.6, 1.8, 2.0]
/** 正文栏宽档位（em）：中文一行约 28–44 字。默认 36em 在舒适区上沿；
 *  要「一屏装更多字」的用户往 44 走，觉得行太长往 28 走。 */
export const MEASURES: Array<{ em: number; label: string }> = [
  { em: 28, label: '窄' },
  { em: 32, label: '中' },
  { em: 36, label: '标准' },
  { em: 44, label: '宽' },
]
export const PAPER_PRESETS = [
  { name: '米黄', color: '#f7f3e8' },
  { name: '纯白', color: '#ffffff' },
  { name: '淡绿', color: '#e8f0e8' },
  { name: '淡粉', color: '#f0e8e8' },
]

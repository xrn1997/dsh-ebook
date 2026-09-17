import { htmlToText, looksLikeHtml } from '../engine/dom.js'

/**
 * 正文文本收口（服务层）。
 *
 * legado 源常以 `@html` 收正文（元素 HTML 原样返回），而本插件的正文契约是**纯文本**：
 * 阅读器按 `\n` 分段渲染 `<p>`、整本导出写 .txt、agent 工具直接回文本。不转换就会把标签
 * 当正文打出来——久久小说网 `#view_content_txt@html` 实测：2603 字里 21 个 `<p>` 原样落库。
 *
 * HTML→文本 的实现在引擎层（engine/dom.ts 的 htmlToText/nodeText）——引擎的 `@text` 段用
 * 同一套口径（块级边界换行），这里只保留「像不像 HTML」的判定与幂等收口。
 * 判定用白名单标签（见 engine/dom.ts）：纯文本正文原样直通，小说里的 `<系统提示>`
 * 这类尖括号内容不会被误判。转换幂等：产物不含标签，二次调用必然直通——缓存里旧版
 * 写入的带标签正文也能就地自愈。
 */
export { htmlToText, looksLikeHtml }

/** 正文取值收口：像 HTML 就转纯文本，否则原样返回（幂等） */
export function contentToText(raw: string): string {
  return looksLikeHtml(raw) ? htmlToText(raw) : raw
}

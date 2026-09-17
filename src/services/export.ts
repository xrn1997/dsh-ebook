import type { ChapterEntry } from './reading.js'

/**
 * 整本导出核心：串行逐章 + 章间节流 + 失败即停 + abort 即停。
 * 限流敬畏是第一原则——绝不并行抓章；getChapter 缓存优先语义即天然断点续传。
 */
export interface ExportDeps {
  getToc(sourceId: string, bookKey: string): Promise<ChapterEntry[]>
  getChapter(sourceId: string, bookKey: string, index: number): Promise<string>
  /** 测试注入假 sleep；生产缺省真实 setTimeout */
  sleep?: (ms: number) => Promise<void>
}
export interface ExportOptions {
  /** 用于章节头《书名》与路由层文件名 */
  title: string
  /** 章间节流毫秒（配置 exportDelayMs） */
  delayMs: number
  signal?: AbortSignal
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function* exportBook(
  deps: ExportDeps, sourceId: string, bookKey: string, opts: ExportOptions,
): AsyncGenerator<string> {
  const sleep = deps.sleep ?? realSleep
  yield '\uFEFF'                                             // BOM：Windows 记事本兼容
  const toc = await deps.getToc(sourceId, bookKey)
  for (let i = 0; i < toc.length; i++) {
    if (opts.signal?.aborted === true) return
    let text: string
    try {
      text = await deps.getChapter(sourceId, bookKey, i)
    } catch (e) {
      // 失败即停：HTTP 首包后状态码不可改，用文本标记告知文件不完整；重跑只补缺章
      const reason = e instanceof Error ? e.message.split('\n')[0] : String(e)
      yield `\n[导出中断于第 ${i + 1} 章《${toc[i].name}》：${reason}]\n`
      return
    }
    yield `《${opts.title}》· ${toc[i].name}\n\n${text}\n\n`
    if (i < toc.length - 1) await sleep(opts.delayMs)      // N-1 次：最后一章后不睡
  }
}

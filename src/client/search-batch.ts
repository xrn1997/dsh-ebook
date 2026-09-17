import type { SearchGroup } from './views/types.js'

/** 分批搜索：630 源一次性大请求是黑盒等待——分批（search?sourceIds=）+ 并发工作池
 *  + 逐批增量回调（UI 边搜边渲染）+ 失败隔离（单批网络错误合成错误组，不拖垮全局）。 */
export interface BatchedSearchOptions {
  /** 每批源数（20：批内服务端按 5 并行，单批时长可控） */
  batchSize: number
  /** 并发批数（3：对目标站点保持克制，不打成 DDoS） */
  concurrency: number
  /** 每批完成后回调：done=累计批数对应源数、total=总源数、added=该批增量组（增量渲染） */
  onProgress?: (doneSources: number, totalSources: number, added: SearchGroup[]) => void
}

export async function runBatchedSearch(
  sourceIds: string[],
  post: (ids: string[]) => Promise<SearchGroup[]>,
  opts: BatchedSearchOptions,
): Promise<SearchGroup[]> {
  if (sourceIds.length === 0) return []
  const size = Math.max(1, Math.floor(opts.batchSize))
  const batches: string[][] = []
  for (let i = 0; i < sourceIds.length; i += size) batches.push(sourceIds.slice(i, i + size))

  const out: SearchGroup[] = []
  const total = sourceIds.length
  let next = 0
  let doneSources = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++                       // 取下一批（单线程事件循环，自增原子）
      if (index >= batches.length) return
      const ids = batches[index]
      let added: SearchGroup[]
      try {
        added = await post(ids)
      } catch (e) {
        // 网络层失败：合成错误组如实上报——用户该看到「这批源没回应」，而不是整体 spinner 到天荒地老
        added = [{
          sourceId: `batch-${index}`, sourceName: `批次 ${index + 1}（${ids.length} 源）`,
          status: 'broken', hits: [],
          error: { code: 'NetworkError', message: e instanceof Error ? e.message : String(e) },
        }]
      }
      out.push(...added)
      doneSources += ids.length
      opts.onProgress?.(doneSources, total, added)
    }
  }

  const pool = Math.min(Math.max(1, Math.floor(opts.concurrency)), batches.length)
  await Promise.all(Array.from({ length: pool }, () => worker()))
  return out
}

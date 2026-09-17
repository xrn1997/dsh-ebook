import { describe, expect, it, vi } from 'vitest'
import { runBatchedSearch } from '../../src/client/search-batch.js'
import type { SearchGroup } from '../../src/client/views/types.js'

const group = (id: string, hits = 1): SearchGroup => ({
  sourceId: id, sourceName: id, status: 'verified',
  // wire 口径：可空字段一律 null（不是缺键），见 src/shared/wire.ts
  hits: Array.from({ length: hits }, (_, i) => ({
    title: `${id}-book${i}`, author: null, url: null, coverUrl: null, intro: null, lastChapterName: null,
  })),
})

/** 分批搜索：630 源一次性大请求是黑盒等待——分批 + 进度 + 增量渲染 + 失败隔离 */
describe('runBatchedSearch', () => {
  it('按批切分，尾批带余数；结果聚合', async () => {
    const batches: string[][] = []
    const post = vi.fn(async (ids: string[]) => { batches.push(ids); return ids.map((id) => group(id)) })
    const out = await runBatchedSearch(['a', 'b', 'c', 'd', 'e'], post, { batchSize: 2, concurrency: 1 })
    expect(batches).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(out.map((g) => g.sourceId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(post).toHaveBeenCalledTimes(3)
  })
  it('进度逐批回调：done 累计、added 为该批增量（驱动增量渲染）', async () => {
    const progress: Array<{ done: number; total: number; added: number }> = []
    const post = async (ids: string[]) => ids.map((id) => group(id))
    await runBatchedSearch(['a', 'b', 'c'], post, {
      batchSize: 1, concurrency: 1,
      onProgress: (done, total, added) => progress.push({ done, total, added: added.length }),
    })
    expect(progress).toEqual([
      { done: 1, total: 3, added: 1 },
      { done: 2, total: 3, added: 1 },
      { done: 3, total: 3, added: 1 },
    ])
  })
  it('某批网络失败 → 合成错误组如实上报，其余批次不受影响（不整体 reject）', async () => {
    const post = async (ids: string[]) => {
      if (ids.includes('b')) throw new TypeError('fetch failed')
      return ids.filter((id) => id !== 'b').map((id) => group(id))
    }
    const out = await runBatchedSearch(['a', 'b', 'c', 'd'], post, { batchSize: 2, concurrency: 1 })
    const okIds = out.filter((g) => g.error === undefined).map((g) => g.sourceId)
    expect(okIds).toEqual(['c', 'd'])                  // 与失败批同批的 a 无结果（服务端未返回），如实为空
    const errGroup = out.find((g) => g.error !== undefined)!
    expect(errGroup.error?.code).toBe('NetworkError')
    expect(errGroup.hits).toEqual([])
  })
  it('空源列表：零请求零回调，返回空数组', async () => {
    const post = vi.fn(async () => [])
    const onProgress = vi.fn()
    const out = await runBatchedSearch([], post, { batchSize: 10, concurrency: 2, onProgress })
    expect(post).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(out).toEqual([])
  })
  it('并发工作池：多批并行时进度总数仍正确（按源数计）', async () => {
    let inflight = 0
    let maxInflight = 0
    const post = async (ids: string[]) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight--
      return ids.map((id) => group(id))
    }
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`)
    let lastDone = 0
    let total = 0
    const out = await runBatchedSearch(ids, post, {
      batchSize: 4, concurrency: 3,
      onProgress: (done, t) => { total = t; lastDone = done },
    })
    expect(out).toHaveLength(20)
    expect(total).toBe(20)                             // total = 总源数（UI 口径：已搜 x/630 源）
    expect(lastDone).toBe(20)                          // 全部批次完成后 done = 源总数
    expect(maxInflight).toBeLessThanOrEqual(3)   // 并发上限被遵守
  })
})

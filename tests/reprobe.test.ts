import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReadingService } from '../src/services/reading.js'
import { makeTempDir, trackService } from './temp-dir.js'

// 真机重探（DSH_REPROBE=1 门控——630 源全量真打网络，几分钟量级；不进常规集）
// 用途：引擎/请求形态改动后实测 verified 率变化（compat 跑通率就是验收标准本身）

describe.skipIf(process.env.DSH_REPROBE !== '1')('真机重探（全量 probe 统计）', () => {
  it('sources.json 全量重探 → verified 率 + 失败分布', { timeout: 1_800_000 }, async () => {
    const sj = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'sources.json')
    const sources = JSON.parse(await fs.readFile(sj, 'utf8')) as Array<{ raw: unknown }>
    const dir = await makeTempDir('novel-reprobe-')
    const svc = trackService(await ReadingService.create({ dir }))
    let verified = 0
    const reasons = new Map<string, number>()
    const queue = [...sources]
    const workers = Array.from({ length: 8 }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        try {
          const out = await svc.importOne(item.raw)
          // 导入不探针——重探统计口径：导入后显式探一次
          const probe = out.sourceId === null || out.sourceId === undefined ? null : await svc.probe(out.sourceId)
          if (probe?.ok === true) verified++
          else {
            const code = probe?.error?.code ?? (out.ok ? '(无探针)' : '导入失败')
            reasons.set(code, (reasons.get(code) ?? 0) + 1)
          }
        } catch { reasons.set('异常', (reasons.get('异常') ?? 0) + 1) }
      }
    })
    await Promise.all(workers)
    await svc.flush()
    const dist = [...reasons].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `[${v}] ${k}`).join('; ')
    console.log(`\n=== 重探结果 ===\n总计 ${sources.length}；verified ${verified}（${(verified / sources.length * 100).toFixed(1)}%）\n失败分布：${dist}\n`)
    expect(sources.length).toBeGreaterThan(0)
  })
})

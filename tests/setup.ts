import { promises as fs } from 'node:fs'
import { afterAll } from 'vitest'
import { cleanupWarn, debugLog, drainCleanups, takeRegisteredDirs } from './temp-dir.js'

/**
 * 每个测试文件的根 suite 挂一个 afterAll：先等写侧收尾，再删 temp-dir 登记簿里的目录。
 *
 * setupFiles 在文件的根 suite 收集前求值，所以这里的 afterAll 属于文件级生命周期——
 * 无论用例成功失败、是否抛出，文件结束都会跑。
 *
 * 顺序不可换：**先 drainCleanups() 再删**。Shelf 的 100ms 尾沿防抖写会 `mkdir -p` 父目录，
 * 用例不 await flush 就结束时，写挂在 timer 上——先删的话 timer 随后触发又把目录建回来
 * （实测仍漏 19 个/全量）。「删失败就重试」治不了这个：删是成功的，复活在后。
 */
async function rmRetry(dir: string, attempts = 3): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (e) {
      if (i >= attempts) throw e
      await new Promise((r) => setTimeout(r, 25 * (i + 1)))
    }
  }
}

afterAll(async () => {
  const dirs = takeRegisteredDirs()
  if (dirs.length === 0) return
  await drainCleanups()
  const results = await Promise.allSettled(dirs.map((d) => rmRetry(d)))
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') cleanupWarn(`[setup] 临时目录清理失败（已重试）：${dirs[i]} —— ${String(r.reason)}`)
  }
  // 二次 rm 兜底：覆盖登记之外的迟到写（例如用例自建却未登记的 writer）。
  // 此时无人持写侧，删不掉就是真删不掉，不再重试。
  await Promise.allSettled(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  const alive: string[] = []
  for (const d of dirs) { try { await fs.stat(d); alive.push(d) } catch { /* gone */ } }
  debugLog(`[setup] drained=${dirs.length} still-present=${alive.length}`)
  if (alive.length > 0) cleanupWarn(`[setup] ${alive.length} 个临时目录删不掉（写侧仍在写？）：${alive.join(', ')}`)
})

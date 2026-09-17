import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'

/**
 * compat 回放 harness：真实源 + 脱敏页面 fixture 的离线回放（全程零网络）。
  * 「全链路跑通」口径：import 探针 verified → 聚合搜索命中 ≥1 → 首本 getToc 非空 → 首章 getChapter 非空文本。
 */

export interface CompatCase {
  caseName: string
  dir: string
  source: unknown
  manifest: { keyword: string; capturedAt?: number; pages: Record<string, string> }
}

export type CompatFace = 'import' | 'search' | 'toc' | 'chapter'
export interface CaseStep {
  face: CompatFace
  ok: boolean
  error?: { code: string; message: string }
}
export interface CaseResult {
  caseName: string
  ok: boolean
  steps: CaseStep[]
  stats: { searchHits: number; tocChapters: number; chapterChars: number }
}

/** root 本身含 source.json → 单 case 目录；否则扫 root 的每个含 source.json 的子目录。坏 manifest → 跳过 + warn（不 throw——坏 case 不打挂整个 compat 面） */
export function loadCases(root: string): CompatCase[] {
  const out: CompatCase[] = []
  const consider = (dir: string, caseName: string): void => {
    const sourcePath = path.join(dir, 'source.json')
    const manifestPath = path.join(dir, 'manifest.json')
    if (!existsSync(sourcePath) || !existsSync(manifestPath)) return
    try {
      const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CompatCase['manifest']
      if (typeof manifest.keyword !== 'string' || typeof manifest.pages !== 'object' || manifest.pages === null) {
        throw new Error('manifest 缺 keyword/pages')
      }
      out.push({ caseName, dir, source, manifest })
    } catch (e) {
      console.warn(`[compat] 跳过坏 case ${caseName}: ${String(e)}`)
    }
  }
  if (existsSync(path.join(root, 'source.json'))) {
    consider(root, path.basename(root))
  } else {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) consider(path.join(root, entry.name), entry.name)
    }
  }
  return out
}

/** manifest 精确 URL 匹配的回放 fetch（响应 content-type 按扩展名）；未命中 → 确定性报错指引重跑 capture */
export function makeReplayFetch(c: CompatCase): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const rel = c.manifest.pages[url]
    if (rel === undefined) throw new Error(`fixture 缺失: ${url}（重跑 capture 补齐）`)
    const body = await fs.readFile(path.join(c.dir, rel))
    return new Response(body as unknown as BodyInit, {
      headers: { 'content-type': rel.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' },
    })
  }) as typeof globalThis.fetch
}

const faceOrder: CompatFace[] = ['import', 'search', 'toc', 'chapter']

/** 单 case 全链路回放：四步串行，失败步后 break；每步独立临时数据目录（归 setup.ts 登记簿回收） */
export async function runCase(c: CompatCase): Promise<CaseResult> {
  const tmp = await makeTempDir('compat-run-')
  const steps: CaseStep[] = []
  const stats = { searchHits: 0, tocChapters: 0, chapterChars: 0 }
  let ok = true
  const fail = (face: CompatFace, e: unknown): void => {
    ok = false
    steps.push({ face, ok: false, error: { code: e instanceof Error ? e.constructor.name : 'Error', message: e instanceof Error ? e.message.split('\n')[0] : String(e) } })
  }
  try {
    const svc = trackService(await ReadingService.create({ dir: tmp, fetchImpl: makeReplayFetch(c) }))
    try {
      // ① import（规范化入库后显式探针——导入不探针，验证归 probe 单点）
      const outcome = (await svc.importSource(c.source))[0]
      if (!outcome.ok) throw new Error(`规范化失败：${outcome.missing.map((m) => m.field).join(',')}`)
      const sourceId = outcome.sourceId!
      const probe = await svc.probe(sourceId)
      if (!probe.ok) {
        throw new Error(`探针失败：${probe.error?.code ?? '?'} ${probe.error?.message ?? ''}`)
      }
      steps.push({ face: 'import', ok: true })

      // ② search（首个非空组首条）
      const groups = await svc.search(String(c.manifest.keyword))
      const hit = groups.flatMap((g) => g.hits).find((h) => h.url !== null)
      if (hit === undefined || hit.url === null) {
        const gerr = groups.find((g) => g.error !== undefined)?.error
        throw new Error(gerr === undefined ? '搜索零命中' : `搜索失败：${gerr.code} ${gerr.message}`)
      }
      stats.searchHits = groups.reduce((n, g) => n + g.hits.length, 0)
      steps.push({ face: 'search', ok: true })

      // ③ toc（非空）
      const toc = await svc.getToc(sourceId, hit.url)
      if (toc.length === 0) throw new Error('目录为空')
      stats.tocChapters = toc.length
      steps.push({ face: 'toc', ok: true })

      // ④ chapter（首章非空文本）
      const text = await svc.getChapter(sourceId, hit.url, 0)
      if (text.length === 0) throw new Error('首章正文为空')
      stats.chapterChars = text.length
      steps.push({ face: 'chapter', ok: true })
    } finally {
      await svc.flush()
    }
  } catch (e) {
    const doneFaces = new Set(steps.map((s) => s.face))
    const nextFace = faceOrder.find((f) => !doneFaces.has(f)) ?? 'chapter'
    fail(nextFace, e)
  }
  return { caseName: c.caseName, ok, steps, stats }
}

/** 报告渲染（按「报告格式」节）：总计行 + 失败原因分布 + 逐源明细。
 *  刻意**不写生成时间**：时间戳会让每次 `pnpm test:compat` 都改写入库文件、把 diff 噪声
  *  带进提交。分母口径写进报告头，避免把「合成 fixture 跑通率」误读为站点兼容率。 */
export function renderReport(results: CaseResult[], keyword?: string): string {
  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const rate = total === 0 ? '—' : `${Math.round((passed / total) * 100)}%`
  const lines: string[] = [
    '# compat 报告',
    '',
    '> 分母 = `compat/fixtures/` 下的**合成 fixture**（离线回放，零网络），**不是真实站点兼容率**。',
    '> 站点可用率请看真机重探：`$env:DSH_REPROBE=\'1\'; pnpm vitest run tests/reprobe.test.ts`。',
    '',
  ]
  if (keyword !== undefined) lines.push(`- 关键词：${keyword}`)
  lines.push(`- 总计：${total} 条源；全链路跑通 ${passed} 条（${rate}）`, '')

  // 失败原因分布（面 × 错误类聚合）
  const dist = new Map<string, { count: number; cases: string[] }>()
  for (const r of results) {
    const failStep = r.steps.find((s) => !s.ok)
    if (failStep === undefined) continue
    const key = `${failStep.face} | ${failStep.error?.code ?? '?'}`
    const entry = dist.get(key) ?? { count: 0, cases: [] }
    entry.count++
    entry.cases.push(r.caseName)
    dist.set(key, entry)
  }
  lines.push('## 失败原因分布', '', '| 面 | 错误类 | 次数 | 涉及源 |', '|---|---|---|---|')
  if (dist.size === 0) lines.push('| — | — | 0 | — |')
  for (const [key, e] of [...dist.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const [face, code] = key.split(' | ')
    lines.push(`| ${face} | ${code} | ${e.count} | ${e.cases.join('、')} |`)
  }
  lines.push('', '## 逐源明细', '', '| 源 | 结果 | 首个失败面 | 错误 | 搜索命中 | 目录章数 | 正文字数 |', '|---|---|---|---|---|---|---|')
  for (const r of results) {
    const failStep = r.steps.find((s) => !s.ok)
    lines.push(`| ${r.caseName} | ${r.ok ? '✅' : '❌'} | ${failStep?.face ?? '—'} | ${failStep === undefined ? '—' : `${failStep.error?.code}: ${failStep.error?.message}`.slice(0, 120)} | ${r.stats.searchHits} | ${r.stats.tocChapters} | ${r.stats.chapterChars} |`)
  }
  return lines.join('\n') + '\n'
}

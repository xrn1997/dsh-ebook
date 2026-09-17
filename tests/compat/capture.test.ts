import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const KEYWORD = process.env.COMPAT_KEYWORD ?? '书'

/** 记录型 fetch：passthrough 真请求，同时把每个响应（最终 URL → utf8 文本）存进内存供落盘 */
function recordFetch() {
  const pages = new Map<string, { body: string; contentType?: string }>()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const res = await globalThis.fetch(input, init)
    const clone = res.clone()
    const buf = Buffer.from(await clone.arrayBuffer())
    const ct = clone.headers.get('content-type') ?? undefined
    pages.set(res.url || url, { body: buf.toString('utf8'), contentType: ct })
    return res
  }) as typeof globalThis.fetch
  return { fetchImpl, pages }
}

/** 脱敏两刀（README 规程）：password input 值 + 凭据模式——自动脱敏是兜底不是证明，入库前人工过目 */
function sanitize(html: string): string {
  return html
    .replace(/(<input\b[^>]*\btype\s*=\s*["']?password["']?[^>]*?\bvalue\s*=\s*["'])[^"']*(['"])/gi, '$1[REDACTED]$2')
    .replace(/((?:cookie|token|password|passwd|secret)\s*[:=]\s*["'])[^"']{8,}(["'])/gi, '$1[REDACTED]$2')
}
function hash8(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

describe.skipIf(process.env.COMPAT_CAPTURE !== '1')('compat 采集', () => {
  it('逐源：真请求四步 → fixture 落盘（脱敏两刀）', { timeout: 300_000 }, async () => {
    const sourcesDir = path.resolve('compat/sources')
    const files = (await fs.readdir(sourcesDir).catch(() => [])).filter((f) => f.endsWith('.json'))
    expect(files.length, `compat/sources 下没有源 JSON——先投放再采集`).toBeGreaterThan(0)
    for (const f of files) {
      const caseName = f.replace(/\.json$/, '')
      const raw = JSON.parse(await fs.readFile(path.join(sourcesDir, f), 'utf8'))
      const { fetchImpl, pages } = recordFetch()
      const dir = await makeTempDir('compat-cap-')
      const svc = trackService(await ReadingService.create({ dir, fetchImpl }))
      const outcome = (await svc.importSource(raw))[0]
      expect(outcome.ok, `${caseName}: 导入规范化失败——${outcome.missing.map((m) => m.field).join(',')}`).toBe(true)
      // 导入不探针——采集口径与回放一致：导入后显式探一次
      const probe = await svc.probe(outcome.sourceId!)
      expect(probe.ok, `${caseName}: 探针失败——${probe.error?.message}`).toBe(true)
      const groups = await svc.search(KEYWORD)
      const hit = groups.flatMap((g) => g.hits).find((h) => h.url !== null)
      expect(hit, `${caseName}: 搜索零命中（关键词 ${KEYWORD}）`).toBeTruthy()
      const toc = await svc.getToc(outcome.sourceId!, hit!.url!)
      expect(toc.length, `${caseName}: 目录为空`).toBeGreaterThan(0)
      const text = await svc.getChapter(outcome.sourceId!, hit!.url!, 0)
      expect(text.length, `${caseName}: 首章正文为空`).toBeGreaterThan(0)
      await svc.flush()

      // 落盘：source.json 快照 + manifest（keyword 快照——采集与回放必须同关键词）+ 脱敏 pages
      const outDir = path.resolve('compat/fixtures', caseName)
      await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })
      await fs.writeFile(path.join(outDir, 'source.json'), JSON.stringify(raw, null, 2), 'utf8')
      const manifest: { keyword: string; capturedAt: number; pages: Record<string, string> } = {
        keyword: KEYWORD, capturedAt: Date.now(), pages: {},
      }
      let i = 0
      for (const [url, { body }] of pages) {
        const rel = `pages/${i++}-${hash8(url)}.html`
        await fs.writeFile(path.join(outDir, rel), sanitize(body), 'utf8')
        manifest.pages[url] = rel
      }
      await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    }
  })
})

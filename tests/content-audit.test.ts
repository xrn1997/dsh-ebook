import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReadingService } from '../src/services/reading.js'
import { readSystemProxy, resolveProxyUrl } from '../src/services/proxy.js'
import { makeTempDir, trackService } from './temp-dir.js'

// 正文链路全量审计（DSH_CONTENT_AUDIT=1 才跑——全量真打网络，十几分钟量级；不进常规集）
//
// 探针（DSH_REPROBE）只验搜索面：「verified」≠ 正文可读。本审计补的是后半条链：
// 每源「搜索 → 目录 → 正文（多章采样）」逐段实测，失败按 stage + 错误类 + 段级定位
// 分桶落盘到 .superpowers/content-audit/（过程产物，不入库）。
//
// **它是审计报告，不是通过率门**：站点侧抖动与规则失效在分桶里靠人看，代码不替读者判
// 「多少算够」——所以本文件唯一的断言是审计完整性（每个注册源都得出 stage），红即工具坏。
// 通过率口径读报告（`stageCount` / `buckets`），README 与 AGENTS 也按「审计报告」描述它。
//
// 出站姿态与生产同口径：resolveProxyUrl（config > 环境变量 > 系统代理 > 直连），
// 否则「浏览器能开、读者打不开」的代理源会被误报成规则失败。

interface ErrInfo {
  name: string
  message: string
  facet?: string
  segmentIndex?: number
  segmentRaw?: string
  url?: string
  status?: number
}

interface ChapterSample { index: number; ok: boolean; length?: number; preview?: string; error?: ErrInfo }

interface SourceAudit {
  id: string | null
  name: string
  baseUrl: string
  stage: 'import' | 'search' | 'no-book-url' | 'toc' | 'content-error' | 'content-partial' | 'ok'
  searchKeyword?: string
  bookTitle?: string
  bookKey?: string
  tocCount?: number
  chapters?: ChapterSample[]
  error?: ErrInfo
}

function errInfo(e: unknown): ErrInfo {
  const any = e as { name?: string; message?: string; facet?: string; segmentIndex?: number; segmentRaw?: string; url?: string; status?: number }
  return {
    name: any?.name ?? 'Unknown',
    message: String(any?.message ?? e).slice(0, 400),
    ...(any?.facet === undefined ? {} : { facet: any.facet }),
    ...(any?.segmentIndex === undefined ? {} : { segmentIndex: any.segmentIndex }),
    ...(any?.segmentRaw === undefined ? {} : { segmentRaw: String(any.segmentRaw).slice(0, 200) }),
    ...(any?.url === undefined ? {} : { url: any.url }),
    ...(any?.status === undefined ? {} : { status: any.status }),
  }
}

/** 错误归一化成桶键：URL/数字/引号内容压掉，保留语义骨架 */
function bucketKey(stage: string, err?: ErrInfo): string {
  if (err === undefined) return stage
  const msg = err.message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d+/g, '#')
    .replace(/"[^"]{8,}"/g, '"…"')
    .slice(0, 120)
  return `${stage} | ${err.name} | ${msg}`
}

describe.skipIf(process.env.DSH_CONTENT_AUDIT !== '1')('正文链路全量审计（search → toc → content）', () => {
  it('sources.json 全量正文审计 → 逐段失败分桶 + 报告落盘', { timeout: 7_200_000 }, async () => {
    const sj = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'sources.json')
    const dir = await makeTempDir('novel-audit-')
    // 审计口径：把真实 sources.json 拷进临时数据根直接加载（生产同口径——不重导 normalize），
    // 并把 enabled 全置 true：用户注册表里 227/228 源被停用（正因为读不出正文），
    // 审计要回答的是「这些源的链路到底通不通」——启停状态不参与判定
    const raws = JSON.parse(await fs.readFile(sj, 'utf8')) as Array<Record<string, unknown>>
    for (const s of raws) s.enabled = true
    await fs.writeFile(path.join(dir, 'sources.json'), JSON.stringify(raws), 'utf8')
    const systemProxy = await readSystemProxy()
    const proxyUrl = resolveProxyUrl({ env: process.env, systemProxy })
    const svc = trackService(await ReadingService.create({ dir, proxyUrl }))
    console.log(`[audit] 源总数 ${raws.length}；出站代理 ${proxyUrl ?? '(直连)'}`)

    // 注册表直读：每条源的 id/name/baseUrl 来自 sources.json 本身（生产同口径）
    const ids: Array<{ id: string | null; name: string; baseUrl: string; raw: unknown }> =
      raws.map((s) => ({
        id: typeof s.id === 'string' ? s.id : null,
        name: typeof s.name === 'string' ? s.name : '(未命名)',
        baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
        raw: s.raw,
      }))
    await svc.flush()

    const audits: SourceAudit[] = []
    const keywords = process.env.DSH_AUDIT_KEYWORDS?.split(',').filter((s) => s !== '') ?? ['小说', '完本', '的']
    const workers = Number(process.env.DSH_AUDIT_WORKERS ?? '5')
    const chapterIdxs = (process.env.DSH_AUDIT_CHAPTERS ?? '0,2,5,mid')
      .split(',').map((s) => s.trim()).filter((s) => s !== '')

    const queue = [...ids.entries()]
    let done = 0
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        const entry = queue.shift()
        if (entry === undefined) return
        const [, src] = entry
        const audit = await auditOne(svc, src, keywords, chapterIdxs)
        audits.push(audit)
        done++
        if (done % 20 === 0 || done === ids.length) console.log(`[audit] 进度 ${done}/${ids.length}`)
      }
    }))

    // ── 分桶汇总 + 报告落盘 ────────────────────────────────────────────────
    const buckets = new Map<string, number>()
    const stageCount = new Map<string, number>()
    for (const a of audits) {
      stageCount.set(a.stage, (stageCount.get(a.stage) ?? 0) + 1)
      if (a.stage === 'ok') continue
      const key = bucketKey(a.stage, a.error)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
    const outDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '.superpowers', 'content-audit')
    await fs.mkdir(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const report = {
      generatedAt: new Date().toISOString(),
      proxy: proxyUrl,
      keywords,
      total: audits.length,
      stageCount: Object.fromEntries(stageCount),
      buckets: Object.fromEntries([...buckets].sort((a, b) => b[1] - a[1])),
      audits: audits.sort((a, b) => a.stage.localeCompare(b.stage) || a.name.localeCompare(b.name)),
    }
    const reportPath = path.join(outDir, `report-${stamp}.json`)
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
    await fs.writeFile(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8')

    console.log('\n=== 正文链路审计 ===')
    console.log(`总计 ${audits.length}`)
    console.log(`阶段分布：${[...stageCount].map(([k, v]) => `${k}=${v}`).join('  ')}`)
    console.log('失败分桶（前 40）：')
    for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  [${v}] ${k}`)
    console.log(`报告：${reportPath}`)
    // 审计完整性：注册表里每个源都必须落进某一个 stage——漏审（循环中断 / 提前 return）
    // 会让「通过率」读数失真，那是本文件唯一能机器判的事。
    expect(audits.length).toBe(ids.length)
  })
})

async function auditOne(
  svc: ReadingService,
  src: { id: string | null; name: string; baseUrl: string },
  keywords: string[],
  chapterIdxs: string[],
): Promise<SourceAudit> {
  const base: SourceAudit = { id: src.id, name: src.name, baseUrl: src.baseUrl, stage: 'ok' }
  if (src.id === null) return { ...base, stage: 'import', error: { name: 'ImportFailed', message: '导入失败（normalize 不 ok）' } }

  // ── 搜索面（逐词重试，口径同 probe）────────────────────────────────────
  let hit: { title: string; url: string | null } | null = null
  let usedKeyword = ''
  for (const kw of keywords) {
    try {
      const groups = await svc.search(kw, { sourceIds: [src.id] })
      const g = groups[0]
      if (g === undefined) continue
      if (g.error !== undefined && g.error !== null) {
        return { ...base, stage: 'search', searchKeyword: kw, error: { name: g.error.code, message: g.error.message.slice(0, 400) } }
      }
      const h = g.hits.find((x) => x.url !== null) ?? null
      if (h !== null) { hit = { title: h.title, url: h.url }; usedKeyword = kw; break }
    } catch (e) {
      return { ...base, stage: 'search', searchKeyword: kw, error: errInfo(e) }
    }
  }
  if (hit === null || hit.url === null) {
    return { ...base, stage: 'no-book-url', searchKeyword: keywords.join('/') }
  }
  const withBook = { ...base, searchKeyword: usedKeyword, bookTitle: hit.title, bookKey: hit.url }

  let toc: Array<{ name: string; url: string }>
  try {
    toc = await svc.getToc(src.id, hit.url)
  } catch (e) {
    return { ...withBook, stage: 'toc', error: errInfo(e) }
  }
  if (toc.length === 0) {
    return { ...withBook, stage: 'toc', tocCount: 0, error: { name: 'EmptyToc', message: '目录 0 章' } }
  }

  // ── 正文面：多章采样 ────────────────────────────────────────────────────
  const samples: number[] = []
  for (const spec of chapterIdxs) {
    const idx = spec === 'mid' ? Math.floor(toc.length / 2) : Number(spec)
    if (Number.isInteger(idx) && idx >= 0 && idx < toc.length && !samples.includes(idx)) samples.push(idx)
  }
  const chapters: ChapterSample[] = []
  for (const idx of samples) {
    try {
      const text = await svc.getChapter(src.id, hit.url, idx)
      chapters.push({ index: idx, ok: true, length: text.length, preview: text.slice(0, 120).replace(/\n/g, '⏎') })
    } catch (e) {
      chapters.push({ index: idx, ok: false, error: errInfo(e) })
    }
  }
  const okCount = chapters.filter((c) => c.ok).length
  if (okCount === chapters.length && chapters.length > 0) {
    return { ...withBook, stage: 'ok', tocCount: toc.length, chapters }
  }
  const firstErr = chapters.find((c) => !c.ok)?.error
  return {
    ...withBook,
    stage: okCount > 0 ? 'content-partial' : 'content-error',
    tocCount: toc.length,
    chapters,
    ...(firstErr === undefined ? {} : { error: firstErr }),
  }
}

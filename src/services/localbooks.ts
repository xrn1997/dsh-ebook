import iconv from 'iconv-lite'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LOCAL_SOURCE_ID } from '../shared/wire.js'
import { readJson, writeJsonAtomic } from './storage.js'

/** 本地书的保留源 id：**单主人是 shared/wire.ts**（跨半契约常量）。服务半可直接 import shared
 *  （services/types.ts、reading.ts 已在做），故此处不再是第二份声明——re-export 保留既有 import 路径。 */
export { LOCAL_SOURCE_ID }

/** 章节偏移表项：字符偏移区间 [start, end)，name 为标题行原文（或兜底「正文」） */
export interface ChapterSpan { name: string; start: number; end: number }

/** bookKey 形态 `local:<uuid>`；严格 uuid 校验兼防路径穿越 */
export const BOOK_KEY_RE = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
export function isLocalBookKey(bookKey: string): boolean {
  return BOOK_KEY_RE.test(bookKey)
}

/**
 * 本地文件解码链（不复用 fetcher.decodeBody——其兜底是 UTF-8，GBK 会乱码；
 * 本地文件也没有 Content-Type）：BOM 优先 → UTF-8 严格探测 → GBK 回退。
 */
export function decodeLocalText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf16-le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), 'utf16-be'), encoding: 'utf-16be' }
  }
  // Buffer.toString('utf8') 会把非法字节静默换成 U+FFFD——必须用 fatal TextDecoder
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  } catch {
    return { text: iconv.decode(buf, 'gbk'), encoding: 'gbk' }   // 启发式固有误差（GBK 猜错即乱码）
  }
}

/** 章节标题行（钉死的正则）：第X章/卷/回/节/集/部/篇（中文数字含大写，含「卷二」单位在前形态）+ 序章楔子番外尾声后记 + Chapter N */
const CHAPTER_RE = /^\s*(?:第[0-9零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億]+[章卷回节集部篇]|[章卷回节集部篇][0-9零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億]+|序章|楔子|番外|尾声|后记|Chapter\s*\d+)\s*[:：.、\s]*(.*)$/

/** 按标题行切章，返回字符偏移表（start=标题行之后，end=下一标题行之前/EOF） */
export function splitChapters(text: string): ChapterSpan[] {
  const spans: ChapterSpan[] = []
  let segStart = 0
  let name: string | null = null
  let offset = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (CHAPTER_RE.test(line)) {
      if (name !== null) spans.push({ name, start: segStart, end: offset - 1 })   // 上一段：结束于本行行首前
      else if (offset > 0 && text.slice(0, offset).trim() !== '') {
        spans.push({ name: '正文', start: 0, end: offset - 1 })                    // 标题前的引言段
      }
      name = line.trim()
      segStart = offset + rawLine.length + 1                                       // 标题行之后（+1 = \n）
    }
    offset += rawLine.length + 1
  }
  if (name !== null) spans.push({ name, start: segStart, end: text.length })
  else spans.push({ name: '正文', start: 0, end: text.length })                    // 无标题 → 单章
  return spans
}

/** 本地书导入失败（文件为空/解析不出章节等）——类目 local-import（错误体不再
 *  自带 HTTP status，映射归分类表 services/errors.classify + api/wire.STATUS_OF 唯一主人） */
export class LocalImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 本地书文件超限——类目 local-too-large（413 PayloadTooLarge 由分类表投影，与空文件的 400 分列） */
export class LocalFileTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

interface LocalMeta {
  title: string
  originalName: string
  importedAt: number
  encoding: string
  chapters: ChapterSpan[]
  length: number
}

const MAX_CACHED_BOOKS = 3

/** 本地 TXT 书库：上传落盘 + 偏移表按需切片 + 解码全文 LRU（3 本） */
export class LocalBooks {
  private readonly localDir: string
  private readonly maxImportBytes: number
  /** bookKey → 解码全文；Map 迭代序 = LRU 序（get 时 delete+set 提升） */
  private readonly textCache = new Map<string, string>()

  private constructor(dir: string, maxImportBytes: number) {
    this.localDir = path.join(dir, 'local')
    this.maxImportBytes = maxImportBytes
  }

  static async create(dir: string, opts?: { maxImportBytes?: number }): Promise<LocalBooks> {
    const lb = new LocalBooks(dir, opts?.maxImportBytes ?? 50 * 1024 * 1024)
    await fs.mkdir(lb.localDir, { recursive: true })
    return lb
  }

  async import(buf: Buffer, name: string): Promise<LocalImportResult> {
    if (buf.length === 0) throw new LocalImportError('文件为空')
    if (buf.length > this.maxImportBytes) {
      throw new LocalFileTooLargeError(`文件超过 ${Math.round(this.maxImportBytes / 1024 / 1024)}MB 上限`)
    }
    const { text, encoding } = decodeLocalText(buf)
    const chapters = splitChapters(text)
    const id = randomUUID()
    const title = name.replace(/\.txt$/i, '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || '未命名'
    const meta: LocalMeta = { title, originalName: name, importedAt: Date.now(), encoding, chapters, length: text.length }
    await fs.writeFile(this.fileOf(id, 'txt'), buf)                      // 原文落盘（重解码路径保留）
    await writeJsonAtomic(this.fileOf(id, 'json'), meta)
    return { bookKey: `local:${id}`, title, chapterCount: chapters.length, encoding }
  }

  async getToc(bookKey: string): Promise<Array<{ name: string; url: string }>> {
    const meta = await this.metaOf(bookKey)
    return meta.chapters.map((c, i) => ({ name: c.name, url: `${bookKey}#${i}` }))
  }

  async getChapter(bookKey: string, index: number): Promise<string> {
    const meta = await this.metaOf(bookKey)
    const span = meta.chapters[index]
    if (span === undefined) throw new Error(`本地书没有第 ${index} 章（共 ${meta.chapters.length} 章）`)
    let text = this.textCache.get(bookKey)
    if (text === undefined) {
      text = decodeLocalText(await fs.readFile(this.fileOf(this.idOf(bookKey), 'txt'))).text
      this.textCache.delete(bookKey)                                       // LRU 提升
      this.textCache.set(bookKey, text)
      while (this.textCache.size > MAX_CACHED_BOOKS) {
        this.textCache.delete(this.textCache.keys().next().value as string)
      }
    }
    // 退化 span（相邻标题行 / 文末孤标题）可能 start > end——夹紧边界，保证只切出 '' 而非负长度
    const start = Math.max(0, Math.min(span.start, text.length))
    const end = Math.max(start, Math.min(span.end, text.length))
    return text.slice(start, end).trim()
  }

  async remove(bookKey: string): Promise<boolean> {
    if (!isLocalBookKey(bookKey)) return false
    const id = this.idOf(bookKey)
    // 存在性只看文件在不在——不解析 meta：损坏的 meta 不该让删除（恢复路径）也炸
    const existed = await fs.stat(this.fileOf(id, 'json')).then(() => true, () => false)
    await fs.rm(this.fileOf(id, 'txt'), { force: true })
    await fs.rm(this.fileOf(id, 'json'), { force: true })
    this.textCache.delete(bookKey)
    return existed
  }

  private idOf(bookKey: string): string {
    const m = BOOK_KEY_RE.exec(bookKey)
    if (m === null) throw new Error(`非法本地书 key: ${bookKey}`)
    return m[1]
  }

  private async metaOf(bookKey: string): Promise<LocalMeta> {
    if (!isLocalBookKey(bookKey)) throw new Error(`非法本地书 key: ${bookKey}`)
    const meta = await readJson<LocalMeta | null>(this.fileOf(this.idOf(bookKey), 'json'), null)
    if (meta === null) throw new Error(`本地书不存在: ${bookKey}`)
    return meta
  }

  private fileOf(id: string, ext: 'txt' | 'json'): string {
    return path.join(this.localDir, `${id}.${ext}`)
  }
}

export interface LocalImportResult { bookKey: string; title: string; chapterCount: number; encoding: string }

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './storage.js'

/** 容量上限默认 200MB */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024

/**
 * 文件名安全键：`encodeURIComponent(bookKey)`；结果 >100 字符时改为
 * 前 60 字符 + '~' + sha1(bookKey) 前 10 位（确定性，规避文件名长度上限）。
 */
export function safeKey(bookKey: string): string {
  const enc = encodeURIComponent(bookKey)
  if (enc.length <= 100) return enc
  const hash = createHash('sha1').update(bookKey).digest('hex').slice(0, 10)
  return `${enc.slice(0, 60)}~${hash}`
}

/**
 * 正文/目录文件缓存（novel 根目录下 `cache/toc` 与 `cache/content`）。
 * 写入后触发 prune：两目录总字节超上限 → 按 mtime 最旧先删（LRU 近似）。
 */
export class PageCache {
  private readonly tocDir: string
  private readonly contentDir: string
  private readonly maxBytes: number

  constructor(private readonly dir: string, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.tocDir = path.join(dir, 'cache', 'toc')
    this.contentDir = path.join(dir, 'cache', 'content')
    this.maxBytes = maxBytes
  }

  async getToc(sourceId: string, bookKey: string): Promise<string | null> {
    return this.read(path.join(this.tocDir, `${sourceId}-${safeKey(bookKey)}.json`))
  }

  async setToc(sourceId: string, bookKey: string, data: string): Promise<void> {
    await writeFileAtomic(path.join(this.tocDir, `${sourceId}-${safeKey(bookKey)}.json`), data)
    await this.prune()
  }

  async getContent(sourceId: string, bookKey: string, chIndex: number): Promise<string | null> {
    return this.read(path.join(this.contentDir, `${sourceId}-${safeKey(bookKey)}-${chIndex}.txt`))
  }

  async setContent(sourceId: string, bookKey: string, chIndex: number, data: string): Promise<void> {
    await writeFileAtomic(path.join(this.contentDir, `${sourceId}-${safeKey(bookKey)}-${chIndex}.txt`), data)
    await this.prune()
  }

  /** 总字节超上限 → 按 mtimeMs 升序删除直到 ≤ 上限；目录不存在直接返回 */
  async prune(): Promise<void> {
    const files: { file: string; size: number; mtimeMs: number }[] = []
    for (const dir of [this.tocDir, this.contentDir]) {
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const file = path.join(dir, name)
        try {
          const st = await fs.stat(file)
          if (st.isFile()) files.push({ file, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          // stat 失败（并发删除等）→ 跳过该文件
        }
      }
    }
    let total = files.reduce((sum, f) => sum + f.size, 0)
    if (total <= this.maxBytes) return
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const f of files) {
      if (total <= this.maxBytes) break
      try {
        await fs.unlink(f.file)
        total -= f.size
      } catch {
        // 删不掉（并发等）→ 继续删更旧的
      }
    }
  }

  private async read(file: string): Promise<string | null> {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
  }
}

import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { decodeLocalText, isLocalBookKey, splitChapters } from '../../src/services/localbooks.js'

describe('decodeLocalText', () => {
  it('UTF-8 无 BOM', () => {
    const r = decodeLocalText(Buffer.from('斗罗大陆正文', 'utf8'))
    expect(r).toEqual({ text: '斗罗大陆正文', encoding: 'utf-8' })
  })
  it('UTF-8 BOM：剥 BOM 并标 utf-8-bom', () => {
    const r = decodeLocalText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('正文', 'utf8')]))
    expect(r).toEqual({ text: '正文', encoding: 'utf-8-bom' })
  })
  it('UTF-16LE BOM', () => {
    const r = decodeLocalText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('正文', 'utf16le')]))
    expect(r.text).toBe('正文')
    expect(r.encoding).toBe('utf-16le')
  })
  it('GBK 回退：UTF-8 严格探测失败 → iconv gbk 解', () => {
    const gbk = iconv.encode('夜里挑灯看剑', 'gbk')
    const r = decodeLocalText(gbk)
    expect(r).toEqual({ text: '夜里挑灯看剑', encoding: 'gbk' })
  })
})

describe('splitChapters', () => {
  it('中文数字/阿拉伯数字/大写数字 + 卷回节 + 序章楔子番外', () => {
    const text = '楔子\nA\n\n第1章 初\nB\n\n第一章 终\nC\n\n卷二·试炼\nD\n\n尾声\nE\n\n番外 一\nF'
    const spans = splitChapters(text)
    expect(spans.map((s) => s.name)).toEqual(['楔子', '第1章 初', '第一章 终', '卷二·试炼', '尾声', '番外 一'])
    // 切片往返：每段内容正确
    expect(text.slice(spans[1].start, spans[1].end).trim()).toBe('B')
    expect(text.slice(spans[5].start, spans[5].end).trim()).toBe('F')
  })
  it('章前有引言 → 补「正文」首段', () => {
    const text = '这是一段引言\n\n第1章 起\n正文内容'
    const spans = splitChapters(text)
    expect(spans.map((s) => s.name)).toEqual(['正文', '第1章 起'])
    expect(text.slice(spans[0].start, spans[0].end).trim()).toBe('这是一段引言')
  })
  it('无章节标题 → 整本单章「正文」（不炸）', () => {
    const text = '只有正文\n没有标题'
    expect(splitChapters(text)).toEqual([{ name: '正文', start: 0, end: text.length }])
  })
  it('Chapter N 英文形态', () => {
    expect(splitChapters('Chapter 1 Start\nx').map((s) => s.name)).toEqual(['Chapter 1 Start'])
  })
})

describe('isLocalBookKey', () => {
  it('合法 uuid 形态 true；其余 false（防路径穿越）', () => {
    expect(isLocalBookKey('local:123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isLocalBookKey('local:../../etc/passwd')).toBe(false)
    expect(isLocalBookKey('local:short')).toBe(false)
    expect(isLocalBookKey('other:123e4567-e89b-12d3-a456-426614174000')).toBe(false)
  })
})

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LocalBooks, LocalFileTooLargeError, LocalImportError } from '../../src/services/localbooks.js'
import { makeTempDir } from '../temp-dir.js'

describe('LocalBooks', () => {
  const mk = async (maxImportBytes?: number): Promise<{ lb: LocalBooks; dir: string }> => {
    const dir = await makeTempDir('novel-lb-')
    return { lb: await LocalBooks.create(dir, maxImportBytes === undefined ? {} : { maxImportBytes }), dir }
  }
  const TXT = '引言\n\n第1章 起\n内容一\n\n第2章 续\n内容二'

  it('import → 落盘两文件 + bookKey 形态 + toc/chapter 往返', async () => {
    const { lb, dir } = await mk()
    const r = await lb.import(Buffer.from(TXT, 'utf8'), '我的书.txt')
    expect(r.bookKey).toMatch(/^local:[0-9a-f-]{36}$/)
    expect(r.title).toBe('我的书')                       // 去扩展名
    expect(r.chapterCount).toBe(3)                        // 正文/第1章/第2章
    expect(r.encoding).toBe('utf-8')
    const files = await fs.readdir(path.join(dir, 'local'))
    expect(files.filter((f) => f.endsWith('.txt'))).toHaveLength(1)
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1)
    const toc = await lb.getToc(r.bookKey)
    expect(toc.map((c) => c.name)).toEqual(['正文', '第1章 起', '第2章 续'])
    expect(await lb.getChapter(r.bookKey, 1)).toBe('内容一')
    expect(await lb.getChapter(r.bookKey, 2)).toBe('内容二')
  })

  it('超限 → LocalFileTooLargeError；空文件 → LocalImportError；都不落盘（HTTP 码归分类表，错误体不携带）', async () => {
    const { lb, dir } = await mk(10)
    await expect(lb.import(Buffer.from('一二三四五六七八九十十一', 'utf8'), 'x.txt')).rejects.toBeInstanceOf(LocalFileTooLargeError)
    await expect(lb.import(Buffer.alloc(0), 'x.txt')).rejects.toBeInstanceOf(LocalImportError)
    expect(await fs.readdir(path.join(dir, 'local'))).toEqual([])
  })

  it('LRU 上限 3 本：第 4 本导入后重读第 1 本不炸（穿透读盘）', async () => {
    const { lb } = await mk()
    const keys: string[] = []
    for (let i = 0; i < 4; i++) keys.push((await lb.import(Buffer.from(`第1章 A${i}\nA${i}`, 'utf8'), `b${i}.txt`)).bookKey)
    expect(await lb.getChapter(keys[0], 0)).toBe('A0')
  })

  it('remove 删两文件；非法 bookKey → false', async () => {
    const { lb, dir } = await mk()
    const r = await lb.import(Buffer.from(TXT, 'utf8'), 'x.txt')
    expect(await lb.remove(r.bookKey)).toBe(true)
    expect(await fs.readdir(path.join(dir, 'local'))).toEqual([])
    expect(await lb.remove('local:../../etc')).toBe(false)
    expect(await lb.remove('local:123e4567-e89b-12d3-a456-426614174000')).toBe(false)   // 不存在
  })

  it('chapter 越界/未知 bookKey → 明确报错（宁炸不猜）', async () => {
    const { lb } = await mk()
    const r = await lb.import(Buffer.from(TXT, 'utf8'), 'x.txt')
    await expect(lb.getChapter(r.bookKey, 99)).rejects.toThrow()
    await expect(lb.getChapter('local:123e4567-e89b-12d3-a456-426614174000', 0)).rejects.toThrow('不存在')
  })

  it('零内容章（两个相邻标题行）→ getChapter 返回空串，不产生负长度切片', async () => {
    const { lb } = await mk()
    const r = await lb.import(Buffer.from('第1章 一\n第2章 二\n内容', 'utf8'), 'adj.txt')
    expect(r.chapterCount).toBe(2)
    expect(await lb.getChapter(r.bookKey, 0)).toBe('')   // 相邻标题行 → 退化 span（start>end）→ 必须为 ''
    expect(await lb.getChapter(r.bookKey, 1)).toBe('内容')
  })
})

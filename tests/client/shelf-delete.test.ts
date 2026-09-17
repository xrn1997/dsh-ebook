import { describe, expect, it } from 'vitest'
import { deleteBookCopy } from '../../src/client/shelf-delete.js'

describe('deleteBookCopy（删除书籍确认文案）', () => {
  it('在线书：确认行含书名，无文件警告', () => {
    const r = deleteBookCopy('斗破苍穹', false)
    expect(r.confirm).toBe('删除《斗破苍穹》？')
    expect(r.warn).toBeNull()
  })
  it('本地书：点名磁盘文件连删（可见后果）', () => {
    const r = deleteBookCopy('我的书', true)
    expect(r.confirm).toBe('删除《我的书》？')
    expect(r.warn).toContain('磁盘')
    expect(r.warn).toContain('txt')
  })
})

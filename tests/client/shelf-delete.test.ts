import { describe, expect, it } from 'vitest'
import { deleteBookCopy } from '../../src/client/shelf-delete.js'

describe('deleteBookCopy（删除书籍确认文案）', () => {
  it('在线书：确认行含书名，无文件警告', () => {
    const r = deleteBookCopy('斗破苍穹', false)
    expect(r.confirm).toBe('删除《斗破苍穹》？')
    expect(r.warn).toBeNull()
  })
  it('本地书：点名删的是 DSH 数据目录副本，并明示原始文件不受影响', () => {
    const r = deleteBookCopy('我的书', true)
    expect(r.confirm).toBe('删除《我的书》？')
    // 服务端真相：删 dataDir/local/ 下的 uuid 副本（导入时落盘），插件不知道原始文件路径。
    // 文案不点名这个区分，用户会误以为动了自己硬盘上的原件。
    expect(r.warn).toContain('副本')
    expect(r.warn).toContain('原始文件不受影响')
  })
})

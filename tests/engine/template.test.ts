import { describe, expect, it } from 'vitest'
import { interpolateUrl } from '../../src/engine/template.js'

describe('URL 模板插值', () => {
  it('基础替换', () => {
    expect(interpolateUrl('/search?q={{key}}&page={{page}}', { key: '凡人', page: 2 }))
      .toBe('/search?q=%E5%87%A1%E4%BA%BA&page=2')
  })
  it('|| 兜底', () => {
    expect(interpolateUrl('https://x/{{key||home}}', {})).toBe('https://x/home')
    expect(interpolateUrl('https://x/{{key||home}}', { key: 'a' })).toBe('https://x/a')
  })
  it('未知变量保留原文', () => {
    expect(interpolateUrl('/s?k={{key}}', {})).toBe('/s?k={{key}}')
  })
  it('特殊字符做 URI 编码', () => {
    expect(interpolateUrl('/s?q={{key}}', { key: 'a b&c' })).toBe('/s?q=a%20b%26c')
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeProxyServer, proxyFromEnv, resolveProxyUrl } from '../../src/services/proxy.js'

describe('normalizeProxyServer（系统/环境代理串归一）', () => {
  it('host:port → 补 http://', () => {
    expect(normalizeProxyServer('127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
  })
  it('分协议形态取 https= 优先，退化 http=', () => {
    expect(normalizeProxyServer('http=1.2.3.4:8080;https=1.2.3.4:8443')).toBe('http://1.2.3.4:8443')
    expect(normalizeProxyServer('http=1.2.3.4:8080')).toBe('http://1.2.3.4:8080')
  })
  it('已带 scheme 原样保留（socks5 等交给 undici 判）', () => {
    expect(normalizeProxyServer('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
  })
  it('空串 / 无 http(s) 段 → null', () => {
    expect(normalizeProxyServer('   ')).toBeNull()
    expect(normalizeProxyServer('ftp=1.2.3.4:21')).toBeNull()
  })
})

describe('proxyFromEnv（环境变量形态）', () => {
  it('HTTPS_PROXY 优先，大小写两形态都认，ALL_PROXY 兜底', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })).toBe('http://a:1')
    expect(proxyFromEnv({ https_proxy: '127.0.0.1:7897' })).toBe('http://127.0.0.1:7897')
    expect(proxyFromEnv({ ALL_PROXY: 'http://c:3' })).toBe('http://c:3')
  })
  it('空环境 → null', () => {
    expect(proxyFromEnv({})).toBeNull()
  })
})

describe('resolveProxyUrl（优先级收口：config > 环境变量 > 系统代理 > 直连）', () => {
  const env = { HTTPS_PROXY: 'http://env:1' }
  it('三级依次生效', () => {
    expect(resolveProxyUrl({ configProxy: 'http://cfg:9', env, systemProxy: 'http://sys:3' })).toBe('http://cfg:9')
    expect(resolveProxyUrl({ env, systemProxy: 'http://sys:3' })).toBe('http://env:1')
    expect(resolveProxyUrl({ env: {}, systemProxy: 'http://sys:3' })).toBe('http://sys:3')
  })
  it("config 'direct' 强制直连（压过环境变量与系统代理）", () => {
    expect(resolveProxyUrl({ configProxy: 'direct', env, systemProxy: 'http://sys:3' })).toBeNull()
  })
  it('都没有 → null（直连）', () => {
    expect(resolveProxyUrl({ env: {}, systemProxy: null })).toBeNull()
  })
})

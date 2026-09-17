import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const patch = readFileSync('cordis.patch.yml', 'utf8')

describe('包形态声明', () => {
  it('入口与 exports', () => {
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.types).toBe('lib/index.d.ts')
    expect(pkg.exports['./client']).toBe('./lib/client.js')
    expect(pkg.exports['.'].default).toBe('./lib/index.js')
  })
  it('dsh 声明（嵌套形态，client-modules 与 plugin add 依赖它）', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(Array.isArray(pkg.dsh.client.inject)).toBe(true)
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
  it('files 含 lib 与 cordis.patch.yml', () => {
    expect(pkg.files).toContain('lib')
    expect(pkg.files).toContain('cordis.patch.yml')
  })
  it('peerDeps 覆盖宿主面：官方 @deepseek-ai/* 一律 peer，不进 dependencies', () => {
    expect(Object.keys(pkg.peerDependencies)).toEqual(
      expect.arrayContaining(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'react', 'react-dom']))
    // 官方包由宿主提供（收录规范：官方 @deepseek-ai/* 用 peerDependencies 声明）
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith('@deepseek-ai/'))).toEqual([])
  })
  it('dsh-tools peer 范围显式列出预发布分支', () => {
    // 无预发布比较符的范围会静默排除 harness 的预发布构建 → 用户 ERESOLVE
    const range = pkg.peerDependencies['@deepseek-ai/dsh-tools']
    expect(range).toContain('||')
    expect(range).toMatch(/^>=\d+\.\d+\.\d+-rc\.\d+/)
  })
  it('cordis.patch.yml：单条 insert，name=包名', () => {
    expect(patch.trimStart().startsWith('- insert:')).toBe(true)
    expect(patch).toContain('id: dsh-novel')
    expect(patch).toContain("name: '@xrn1997/dsh-novel'")
    expect(patch.match(/- insert:/g)).toHaveLength(1)   // 双挂载 = 整树 boot 失败（调研 §风险 5）
  })
})

import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { evalJs } from '../../src/engine/js-sandbox.js'
import type { JsHost } from '../../src/engine/js-sandbox.js'
import { JsSandboxError } from '../../src/engine/errors.js'
import type { EngineValue, EvalContext } from '../../src/engine/types.js'

const ctxOf = (over: Partial<EvalContext> = {}): EvalContext => ({
  baseUrl: 'https://m.example.com/read/1',
  source: 'https://m.example.com',
  vars: {},
  ...over,
})
const hostOf = (over: Partial<JsHost> = {}): JsHost => ({
  result: '',
  baseUrl: 'https://m.example.com/read/1',
  source: 'https://m.example.com',
  ...over,
})
const L = { segmentIndex: 0, segmentRaw: '@js:test' }
const run = (
  code: string,
  host: JsHost = hostOf(),
  ctx: EvalContext = ctxOf(),
  evaluateRef?: (rule: string, data: unknown, baseUrl?: string) => EngineValue,
) => evalJs(code, host, ctx, L, 'content', evaluateRef)

describe('@js 沙箱', () => {
  it('基本求值：字符串/数组/空值/对象 → 四种 EngineValue', async () => {
    expect((await run('return "hi"')).value).toEqual({ kind: 'value', text: 'hi' })
    expect((await run('return ["a","b"]')).value).toEqual({ kind: 'list', items: ['a', 'b'] })
    expect((await run('return null')).value.kind).toBe('miss')
    expect((await run('return undefined')).value.kind).toBe('miss')
    expect((await run('return ""')).value.kind).toBe('miss')
    expect((await run('return {x:1}')).value).toEqual({ kind: 'value', text: '{"x":1}' })
    expect((await run('return 42')).value).toEqual({ kind: 'value', text: '42' })
    expect((await run('return 1 + 1')).value).toEqual({ kind: 'value', text: '2' })
  })

  it('顶层 await 生效（async IIFE）', async () => {
    const v = await run('const x = await Promise.resolve(5); return x * 2')
    expect(v.value).toEqual({ kind: 'value', text: '10' })
  })

  it('宿主变量注入：result/baseUrl/source', async () => {
    const v = await run('return baseUrl + "|" + source')
    expect(v.value).toEqual({ kind: 'value', text: 'https://m.example.com/read/1|https://m.example.com' })
    const v2 = await run('return result.length', hostOf({ result: 'prev-segment-text' }))
    expect(v2.value).toEqual({ kind: 'value', text: '17' })
  })

  it('console 收集进 logs，不外泄', async () => {
    const v = await run('console.log("dbg", 1); console.error("warn: x"); return "ok"')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
    expect(v.logs).toEqual(['dbg 1', 'warn: x'])
  })

  it('同步死循环超时熔断 → JsSandboxError（脚本超时）', async () => {
    await expect(run('while(true){}', hostOf(), ctxOf({ jsTimeoutMs: 200 }))).rejects.toThrow(/脚本超时/)
    await expect(run('while(true){}', hostOf(), ctxOf({ jsTimeoutMs: 200 }))).rejects.toThrow(JsSandboxError)
  })

  it('异步永不 settle 也被 jsTimeoutMs 约束（外层硬超时）', async () => {
    const err = await run('await new Promise(() => {}); return 1', hostOf(), ctxOf({ jsTimeoutMs: 150 }))
      .then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/脚本超时（>150ms）/)
  })

  it('沙箱逃逸：require/process/global 不可见（typeof 返回字符串 undefined）', async () => {
    // 钉死（controller ruling）：typeof 探测未声明全局返回字符串 'undefined'（合法 Value），不是 Miss
    expect((await run('return typeof require')).value).toEqual({ kind: 'value', text: 'undefined' })
    expect((await run('return typeof process')).value).toEqual({ kind: 'value', text: 'undefined' })
    expect((await run('return typeof global')).value).toEqual({ kind: 'value', text: 'undefined' })
    expect((await run('return typeof globalThis.require')).value).toEqual({ kind: 'value', text: 'undefined' })
  })

  it('沙箱逃逸：代码生成被禁（Function 构造器 / eval 均 EvalError）', async () => {
    const v1 = await run('try { Function("return 1"); return "escaped" } catch (e) { return "blocked:" + e.name }')
    expect(v1.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    const v2 = await run('try { eval("1+1"); return "escaped" } catch (e) { return "blocked:" + e.name }')
    expect(v2.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
  })

  it('沙箱逃逸：宿主 realm 不可达（构造器链 / 错误对象 / 返回的 Promise / 引导入口）', async () => {
    // 宿主函数的 .constructor（跨 realm Function）：console/java 均为 vm realm 包装 → EvalError
    const v3 = await run('try { return "escaped:" + console.log.constructor("return 1")() } catch (e) { return "blocked:" + e.name }')
    expect(v3.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    const v3b = await run('try { return "escaped:" + java.get.constructor("return 1")() } catch (e) { return "blocked:" + e.name }')
    expect(v3b.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    // 宿主抛出的错误（如守门 JsSandboxError）跨 realm 后须为 vm Error，其构造器链同样被禁
    const v4 = await run(
      'try { await java.ajax("u") } catch (e) { try { return "escaped:" + e.constructor.constructor("return 1")() } catch (x) { return "blocked:" + x.name + "|" + e.message.includes("网络能力") } }',
      hostOf(),
      ctxOf(),
    )
    expect(v4.value).toEqual({ kind: 'value', text: 'blocked:EvalError|true' })
    // ajax 返回的 Promise 为 vm realm Promise，构造器链被禁
    const v5 = await run('try { return "escaped:" + java.ajax.constructor("return 1")() } catch (e) { return "blocked:" + e.name }')
    expect(v5.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    // 引导入口 __host_call__ 已从全局锁死，不可恢复
    const v6 = await run('return [typeof __host_call__, typeof __init__].join(",")')
    expect(v6.value).toEqual({ kind: 'value', text: 'number,number' })
  })

  it('java.get/put 读写 ctx.vars', async () => {
    const ctx = ctxOf()
    await run('java.put("k","v"); return "x"', hostOf(), ctx)
    expect(ctx.vars!.k).toBe('v')
    expect((await run('return java.get("k")', hostOf(), ctxOf({ vars: { k: 'vv' } }))).value).toEqual({ kind: 'value', text: 'vv' })
    expect((await run('return java.get("nope")')).value.kind).toBe('miss')
  })

  it('java.ajax 走注入 fetch（守门），返回 Promise 可 await', async () => {
    const calls: string[] = []
    const ctx = ctxOf({
      fetch: async (u) => {
        calls.push(u)
        return { body: '<p>ok</p>' }
      },
    })
    const v = await run(
      'const h = await java.ajax("https://m.example.com/x"); return h.length > 0 ? "有内容" : "空"',
      hostOf(),
      ctx,
    )
    expect(calls).toEqual(['https://m.example.com/x'])
    expect(v.value).toEqual({ kind: 'value', text: '有内容' })
  })

  it('java.ajax 无 ctx.fetch → JsSandboxError（该源未提供网络能力）', async () => {
    const err = await run('await java.ajax("https://m.example.com/x")', hostOf(), ctxOf()).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/网络能力/)
  })

  it('脚本抛错 → JsSandboxError 带脚本原文与行号', async () => {
    const err = await run('null.x').then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(err.script).toBe('null.x')
    expect(String(err.message)).toMatch(/脚本/)
    // 多行脚本：错误在用户脚本第 2 行（wrapper 首行偏移 1）
    const err2 = await run('const a = 1\nnull.x').then(() => null, (e) => e)
    expect(err2.line).toBe(2)
  })

  it('语法错误 → JsSandboxError（编译失败）', async () => {
    const err = await run('return )').then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/编译|同步执行失败/)
  })

  it('md5/base64 往返', async () => {
    expect((await run('return java.base64Encode("abc")')).value).toEqual({ kind: 'value', text: 'YWJj' })
    expect((await run('return java.base64Decode("YWJj")')).value).toEqual({ kind: 'value', text: 'abc' })
    expect((await run('return java.md5Encode("abc")')).value)
      .toEqual({ kind: 'value', text: '900150983cd24fb0d6963f7d28e17f72' }) // md5("abc") 标准向量
    expect((await run('return java.md5Encode16("abc")')).value)
      .toEqual({ kind: 'value', text: '3cd24fb0d6963f7d' }) // 32 位 md5 取中 16 位（legado 语义）
  })

  it('java.timeFormat：yyyy/MM/dd HH:mm（本地时区手排）', async () => {
    const ts = 1700000000000
    const d = new Date(ts)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    expect((await run(`return java.timeFormat(${ts})`)).value).toEqual({ kind: 'value', text: expected })
  })

  it('evaluateRef 未注入：getString* 抛清晰 JsSandboxError（接线）', async () => {
    const err = await run('return java.getString("@css:h1")').then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/evaluateRef/)
    const err2 = await run('return java.getStringList("@css:p")').then(() => null, (e) => e)
    expect(err2).toBeInstanceOf(JsSandboxError)
    const err3 = await run('return java.getElements("@css:p")').then(() => null, (e) => e)
    expect(err3).toBeInstanceOf(JsSandboxError)
  })

  it('evaluateRef 注入后：getString/getStringList 经其递归求值并对 result 序列化', async () => {
    const fake = (rule: string, data: unknown): EngineValue => ({ kind: 'value', text: `X(${rule}|${data})` })
    const v = await run('return java.getString("@css:h1")', hostOf({ result: 'prev' }), ctxOf(), fake)
    expect(v.value).toEqual({ kind: 'value', text: 'X(@css:h1|prev)' })
    const fakeList = (): EngineValue => ({ kind: 'list', items: ['a', 'b'] })
    const v2 = await run('return java.getStringList("@css:p")', hostOf(), ctxOf(), fakeList)
    expect(v2.value).toEqual({ kind: 'list', items: ['a', 'b'] })
    // miss → getString 返回 ''（脚本里再 return '' → Miss）
    const fakeMiss = (): EngineValue => ({ kind: 'miss', detail: 'no hit' })
    const v3 = await run('return java.getString("@css:none")', hostOf(), ctxOf(), fakeMiss)
    expect(v3.value.kind).toBe('miss')
  })

  it('getElements：evaluateRef 返回 nodes → 元素包装对象（.text()/.attr()/String()——legado 方法面）', async () => {
    const $ = load('<h1 class="t">标题</h1><p>正文</p>')
    const fake = (): EngineValue => ({ kind: 'nodes', nodes: $('h1') })
    const v = await run(
      'const els = java.getElements("@css:h1"); return els.length + "|" + els[0].text() + "|" + String(els[0]) + "|" + els[0].attr("class") + "|" + els[0].attr("href")',
      hostOf(),
      ctxOf(),
      fake,
    )
    expect(v.value).toEqual({ kind: 'value', text: '1|标题|<h1 class="t">标题</h1>|t|' })
  })

  it('getString(rule, isUrl=true)：v1 守门必炸（宁炸不猜，不静默把 URL 当内容返回）', async () => {
    // 订正：isUrl=true 曾被桥静默忽略，URL 串被当内容返回（静默错误）
    const fake = (): EngineValue => ({ kind: 'value', text: 'X' })
    const err = await run('return java.getString("@css:h1", true)', hostOf(), ctxOf(), fake).then(() => null, (e) => e)
    expect(String(err.message)).toMatch(/isUrl=true 在 v1 不支持/)
    // 段级定位随消息跨界（宿主 UnsupportedRuleError 的 message 含 [facet#段N] 与规则片段；
    // 错误对象本身按沙箱逃逸防御只取 message 字符串，在 evalJs 出口包成 JsSandboxError）
    expect(String(err.message)).toMatch(/\[content#段0\]/)
    // isUrl=false / 省略 → 照常递归求值
    expect((await run('return java.getString("@css:h1", false)', hostOf(), ctxOf(), fake)).value)
      .toEqual({ kind: 'value', text: 'X' })
    expect((await run('return java.getString("@css:h1")', hostOf(), ctxOf(), fake)).value)
      .toEqual({ kind: 'value', text: 'X' })
  })
})

// ── 宿主垫片扩展（616 broken 归因：真实源 @js 依赖这些 API）────────────────

describe('宿主垫片（真实源用到的缺失 API）', () => {
  it('java.log ≡ console.log（53 处使用——缺它整个脚本炸）', async () => {
    const v = await run('java.log("dbg", 2); return "ok"')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
    expect(v.logs).toEqual(['dbg 2'])
  })
  it('java.encodeURI → encodeURIComponent 语义（中文/空格/斜杠）', async () => {
    expect((await run('return java.encodeURI("书")')).value).toEqual({ kind: 'value', text: '%E4%B9%A6' })
    expect((await run('return java.encodeURI("a b/c")')).value).toEqual({ kind: 'value', text: 'a%20b%2Fc' })
  })
  it('java.getElement → 首个元素包装（无命中 → null）', async () => {
    const $ = load('<h1>标题</h1><p>正文</p>')
    const fake = (): EngineValue => ({ kind: 'nodes', nodes: $('h1') })
    const v = await run('const e = java.getElement("@css:h1"); return e === null ? "null" : e.text()', hostOf(), ctxOf(), fake)
    expect(v.value).toEqual({ kind: 'value', text: '标题' })
    const miss = (): EngineValue => ({ kind: 'miss', detail: 'x' })
    const v2 = await run('return java.getElement("@css:none") === null ? "null" : "x"', hostOf(), ctxOf(), miss)
    expect(v2.value).toEqual({ kind: 'value', text: 'null' })
  })
  it('java.setContent：后续 getString 以设定内容为基（而非上一段 result）', async () => {
    const seen: unknown[] = []
    const fake = (_rule: string, data: unknown): EngineValue => { seen.push(data); return { kind: 'value', text: String(data) } }
    const v = await run('java.setContent("<h1>新基</h1>"); return java.getString("@css:h1")', hostOf({ result: '旧result' }), ctxOf(), fake)
    expect(seen[0]).toBe('<h1>新基</h1>')
    expect(v.value).toEqual({ kind: 'value', text: '<h1>新基</h1>' })
  })
  it('source 对象化：source.getKey()/source.key = baseUrl，字符串拼接语义保留', async () => {
    expect((await run('return source.getKey()')).value).toEqual({ kind: 'value', text: 'https://m.example.com' })
    expect((await run('return source.key')).value).toEqual({ kind: 'value', text: 'https://m.example.com' })
    expect((await run('return "" + source')).value).toEqual({ kind: 'value', text: 'https://m.example.com' })
    expect((await run('return source.key + "/api/search"')).value)
      .toEqual({ kind: 'value', text: 'https://m.example.com/api/search' })
  })
  it('cookie 垫片：set/get/remove 往返（按源隔离——最小仿真）', async () => {
    const ctx = ctxOf()
    await run('cookie.setCookie("token", "abc"); return "x"', hostOf(), ctx)
    expect((await run('return cookie.getCookie("token")', hostOf(), ctx)).value).toEqual({ kind: 'value', text: 'abc' })
    await run('cookie.removeCookie("token"); return "x"', hostOf(), ctx)
    expect((await run('return cookie.getCookie("token")')).value.kind).toBe('miss')
  })
  it('纯 UI 副作用方法（toast/copyText/startBrowser/open）→ no-op 不炸脚本', async () => {
    const v = await run('java.toast("hi"); java.longToast("hi"); java.copyText("t"); java.startBrowser("https://a.com"); java.open("x"); return "ok"')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
  })
  it('timeFormatUTC / hexDecodeToString', async () => {
    expect((await run('return java.timeFormatUTC(0)')).value).toEqual({ kind: 'value', text: '1970/01/01 00:00' })
    expect((await run('return java.hexDecodeToString("e4bda0")')).value).toEqual({ kind: 'value', text: '你' })
  })
  it('无法仿真的安卓宿主 API（webView/android.*）→ 如实报不支持（不静默 no-op）', async () => {
    const err = await run('return java.webView("<p/>", "https://a.com", "")').then(() => null, (e) => e)
    expect(String(err.message)).toMatch(/不支持|未知/)
  })
  it('AES 解密桥（legado createSymmetricCrypto().decryptStr / aesBase64DecodeToString——Node crypto 实现）', async () => {
    const crypto = await import('node:crypto')
    const key = '0123456789abcdef'
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(key, 'utf8'))
    const b64 = Buffer.concat([cipher.update(Buffer.from('你好章节', 'utf8')), cipher.final()]).toString('base64')
    const v = await run(
      `return java.createSymmetricCrypto("AES/CBC/PKCS5Padding","${key}","${key}").decryptStr("${b64}")`,
    )
    expect(v.value).toEqual({ kind: 'value', text: '你好章节' })
    const v2 = await run(`return java.aesBase64DecodeToString("${b64}","${key}","AES/CBC/PKCS5Padding","${key}")`)
    expect(v2.value).toEqual({ kind: 'value', text: '你好章节' })
    // 密文/密钥不对 → 如实报 AES 解密失败（宁炸，不返回假明文）；encryptStr v1 不支持
    const err = await run('return java.aesBase64DecodeToString("AAAA","0123456789abcdef","AES/CBC/PKCS5Padding","0123456789abcdef")').then(() => null, (e) => e)
    expect(String(err.message)).toMatch(/AES 解密失败/)
    const err2 = await run(`return java.createSymmetricCrypto("AES/CBC/PKCS5Padding","${key}","${key}").encryptStr("x")`).then(() => null, (e) => e)
    expect(String(err2.message)).toMatch(/不支持/)
  })
  it('source.getVariable/setVariable 垫片（按源隔离——真实源存自定义域名的形态）', async () => {
    const ctx = ctxOf()
    expect((await run('return source.getVariable() || "(空)"', hostOf(), ctx)).value).toEqual({ kind: 'value', text: '(空)' })
    await run('source.setVariable(JSON.stringify({host:"x.com"})); return "ok"', hostOf(), ctx)
    expect((await run('return JSON.parse(source.getVariable()).host', hostOf(), ctx)).value)
      .toEqual({ kind: 'value', text: 'x.com' })
  })
  it('source.get/put 键值读写（与 getVariable 同一存储——legado 变量表同构）', async () => {
    const ctx = ctxOf()
    await run('source.put("token", "t123"); source.put("searchMode", "author"); return "ok"', hostOf(), ctx)
    expect((await run('return source.get("token")', hostOf(), ctx)).value).toEqual({ kind: 'value', text: 't123' })
    // getVariable 视角：整表 JSON 可见（键值互通）
    expect((await run('return JSON.parse(source.getVariable()).searchMode', hostOf(), ctx)).value)
      .toEqual({ kind: 'value', text: 'author' })
    // 未设键 → null（`source.get("x") || ""` 形态自然求值）
    expect((await run('return source.get("missing") || "def"', hostOf(), ctx)).value)
      .toEqual({ kind: 'value', text: 'def' })
  })
  it('source.header / source.bookSourceName 可读（JSON.parse(source.header) 形态）', async () => {
    const host = hostOf({ header: '{"User-Agent":"Bot"}' })
    expect((await run('return JSON.parse(source.header)["User-Agent"]', host)).value)
      .toEqual({ kind: 'value', text: 'Bot' })
  })
})

describe('scriptForm（legado @js 口径：完成值即结果）', () => {
  const runScript = (code: string, host: JsHost = hostOf(), ctx: EvalContext = ctxOf()) =>
    evalJs(code, host, ctx, L, 'search', undefined, { scriptForm: true })

  it('裸表达式结尾（无 return）→ 最后一个表达式的值即结果', async () => {
    const v = await runScript('"https://a.com/s?key=" + encodeURIComponent(key) + "&p=" + page',
      hostOf({ key: '剑来', page: 3 }))
    expect(v.value).toEqual({ kind: 'value', text: 'https://a.com/s?key=%E5%89%91%E6%9D%A5&p=3' })
  })
  it('var 声明 + 多语句 → 完成值', async () => {
    const v = await runScript('var enc = encodeURIComponent(key);\nvar url = "https://a.com/" + enc;\nurl + "?p=" + page',
      hostOf({ key: 'x', page: 2 }))
    expect(v.value).toEqual({ kind: 'value', text: 'https://a.com/x?p=2' })
  })
  it('顶层 return → SyntaxError 回落函数体形态', async () => {
    const v = await runScript('return "https://ret/" + key', hostOf({ key: 'k' }))
    expect(v.value).toEqual({ kind: 'value', text: 'https://ret/k' })
  })
  it('顶层 await → 同样回落函数体形态', async () => {
    const v = await runScript('return await Promise.resolve("ok")')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
  })
  it('result / baseUrl / source 全局可读（脚本形态）', async () => {
    const v = await runScript('result + "|" + baseUrl + "|" + source', hostOf({ result: 'R' }))
    expect(v.value).toEqual({ kind: 'value', text: 'R|https://m.example.com/read/1|https://m.example.com' })
  })
  it('空串结果 → Miss（如实，不产假值）', async () => {
    expect((await runScript('""')).value.kind).toBe('miss')
  })
  it('jsLib 先于用户代码执行：函数定义全局可见（legado 源级函数库口径）', async () => {
    const ctx = ctxOf({ jsLib: 'function host() { return "https://lib.example.com" }\nvar CONST_X = 42;' })
    const v = await evalJs('host() + "/" + key', hostOf({ key: 'k' }), ctx, L, 'search', undefined, { scriptForm: true })
    expect(v.value).toEqual({ kind: 'value', text: 'https://lib.example.com/k' })
    // 常量同样可见（qmSearchUrl.call(this, key, page) 类形态）
    const v2 = await evalJs('String(CONST_X)', hostOf(), ctx, L, 'search', undefined, { scriptForm: true })
    expect(v2.value).toEqual({ kind: 'value', text: '42' })
  })
  it('jsLib 抛错 → JsSandboxError 点名 jsLib（不吞不混）', async () => {
    const ctx = ctxOf({ jsLib: 'null.boom()' })
    await expect(evalJs('return "x"', hostOf(), ctx, L, 'search')).rejects.toThrow(/jsLib/)
  })
})

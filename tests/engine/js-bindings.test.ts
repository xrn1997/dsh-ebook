import { describe, expect, it } from 'vitest'
import { runScript } from '../../src/engine/js-sandbox.js'
import { JsSandboxError } from '../../src/engine/errors.js'

const loc = { segmentIndex: 0, segmentRaw: '<js>test</js>' }

describe('沙箱 legado 绑定与作用域（本轮修复钉子）', () => {
  it('非严格模式：未声明赋值写全局（legado sloppy 语义——真实源 `next = []` 形态）', async () => {
    const out = await runScript({
      code: 'next = [];\nnext.push(1, 2);\nnext.length',
      loc, facet: 'toc', scriptForm: true,
    })
    expect(out.value).toEqual({ kind: 'value', text: '2' })
  })
  it('非严格模式：顶层 return 回落函数体形态后仍未声明赋值不炸', async () => {
    const out = await runScript({
      code: 'list = [1, 2, 3];\nreturn list.join("-");',
      loc, facet: 'toc', scriptForm: true,
    })
    expect(out.value).toEqual({ kind: 'value', text: '1-2-3' })
  })
  it('src 绑定 = 当前页面原文（JSON 页给序列化文本）', async () => {
    // ctx 未注入 html/json → src 为空串：''.length → 0（如实，不炸）
    const out = await runScript({
      code: 'src.length',
      loc, facet: 'toc', scriptForm: true,
      baseUrl: 'https://x.com/api', source: 'https://x.com',
    })
    expect(out.value).toEqual({ kind: 'value', text: '0' })
    // 空串完成值 → Miss（js 返回空口径）
    const out2 = await runScript({ code: 'src', result: '', loc, facet: 'content', scriptForm: true })
    expect(out2.value.kind).toBe('miss')
  })
  it('runScript 入口不注入 book/chapter（空对象——字段串成 "undefined"，注入归 evalJs 面）', async () => {
    const out = await runScript({
      code: 'book.bookUrl + "|" + chapter.title + "|" + chapter.index',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com/b/1',
    })
    // 这条钉的是**边界**：book/chapter 只在服务层按面注入（下一条用例钉注入侧），
    // runScript 这条入口拿不到它们——断整串而非 toContain('|')，否则绑定悄悄变空也照绿。
    expect(out.value.kind).toBe('value')
    expect((out.value as { text: string }).text).toBe('undefined|undefined|undefined')
  })
  it('evalJs 直连：ctx.book/ctx.chapter 可见（沙箱全局注入）', async () => {
    const { evalJs } = await import('../../src/engine/js-sandbox.js')
    const out = await evalJs(
      'book.bookUrl + "|" + chapter.title',
      { result: '', baseUrl: 'https://x.com/b/1', source: 'https://x.com' },
      {
        baseUrl: 'https://x.com/b/1',
        book: { bookUrl: 'https://x.com/b/1', name: '诡秘' },
        chapter: { title: '第3章', index: 3, url: 'https://x.com/b/1/3' },
      },
      loc, 'content', undefined, { scriptForm: true },
    )
    expect(out.value).toEqual({ kind: 'value', text: 'https://x.com/b/1|第3章' })
  })
  it('evalJs 直连：src 取 ctx.html', async () => {
    const { evalJs } = await import('../../src/engine/js-sandbox.js')
    const out = await evalJs(
      'src.match(/id="([\\w-]+)"/)[1]',
      { result: '', baseUrl: 'https://x.com', source: 'https://x.com' },
      { baseUrl: 'https://x.com', html: '<div id="chapter-list">x</div>' },
      loc, 'toc', undefined, { scriptForm: true },
    )
    expect(out.value).toEqual({ kind: 'value', text: 'chapter-list' })
  })
  it('java.ajax 同步语义（worker + SAB RPC 桥——legado runBlocking 口径）', async () => {
    const fetchImpl = async (url: string): Promise<{ body: string }> => ({ body: `BODY:${url}` })
    const out = await runScript({
      code: 'var b = java.ajax("https://x.com/p"); b.indexOf("BODY") + "|" + b.length',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    })
    expect(out.value).toEqual({ kind: 'value', text: '0|20' })
    // 链式同步消费形态（真实源主导写法）
    const out2 = await runScript({
      code: 'java.ajax("https://x.com/q").match(/^BODY:(.*)$/)[1]',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    })
    expect(out2.value).toEqual({ kind: 'value', text: 'https://x.com/q' })
    // 抓取失败 → 如实抛（JsSandboxError 带定位），不静默
    const err = await runScript({
      code: 'java.ajax("https://x.com/boom").length',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com',
      fetch: async () => { throw new Error('站点挂了') },
    }).then(() => null, (e) => e)
    expect(String(err.message)).toContain('站点挂了')
  })
  it('worker 路线自身的逃逸防御与超时（不是主线程用例的复述）', async () => {
    // 只有脚本提到 java.ajax( 才走 worker + SAB RPC（`SYNC_WORKER_RE`）——本用例靠 fetch 计数
    // 自证确实走了这条路：主线程路径不会调 fetch，计数为 0 即说明钉错了地方。
    let ajaxCalls = 0
    const fetchImpl = async (url: string): Promise<{ body: string }> => { ajaxCalls++; return { body: `BODY:${url}` } }
    const viaWorker = {
      loc, facet: 'content' as const, scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    }
    const out = await runScript({
      ...viaWorker,
      code: 'java.ajax("https://x.com/p"); typeof require + "|" + typeof process + "|" + typeof module',
    })
    expect(ajaxCalls).toBe(1)                                            // 证明走的是 worker RPC 桥
    expect(out.value).toEqual({ kind: 'value', text: 'undefined|undefined|undefined' })
    // worker 里的 vm 上下文同样 codeGeneration:false → Function 构造器不可用（拿不到宿主 realm）
    const err = await runScript({
      ...viaWorker,
      code: 'java.ajax("https://x.com/p"); return Function("return process")()',
    }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    // 同步死循环由 worker 内 vm timeout 熔断（外层 race 只是第二道闸）
    await expect(runScript({
      ...viaWorker, jsTimeoutMs: 300,
      code: 'java.ajax("https://x.com/p"); while(true){}',
    })).rejects.toThrow(/脚本超时/)
  })
  it('JSON 页 result 按对象绑定（legado isJSON 口径——result.chapterTitle 字段访问形态）', async () => {
    const { evalJs } = await import('../../src/engine/js-sandbox.js')
    const json = JSON.stringify({ chapterTitle: '第9章', chapterId: 77 })
    const out = await evalJs(
      'result.chapterTitle + "|" + result.chapterId',
      { result: json, resultKind: 'page', baseUrl: 'https://x.com/api', source: 'https://x.com' },
      { baseUrl: 'https://x.com/api', html: json },
      loc, 'toc', undefined, { scriptForm: true },
    )
    expect(out.value).toEqual({ kind: 'value', text: '第9章|77' })
    // HTML 页 result 仍是元素包装（字符串方法照常）
    const out2 = await evalJs(
      'result.replace(/x/g, "y")',
      { result: '<p>x页</p>', resultKind: 'page', baseUrl: 'https://x.com', source: 'https://x.com' },
      { baseUrl: 'https://x.com', html: '<p>x页</p>' },
      loc, 'toc', undefined, { scriptForm: true },
    )
    expect(out2.value).toEqual({ kind: 'value', text: '<p>y页</p>' })
  })
  it('org.jsoup.Jsoup.parse 最小仿真（select/size/get/text 链——白鹿书院形态）', async () => {
    const out = await runScript({
      code: 'var doc = org.jsoup.Jsoup.parse(result); var els = doc.select("a"); els.size() + "|" + els.get(0).text() + "|" + els.get(0).attr("href")',
      result: '<ol><li><a href="/c/1">第一章</a></li><li><a href="/c/2">第二章</a></li></ol>',
      loc, facet: 'toc', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com',
    })
    expect(out.value).toEqual({ kind: 'value', text: '2|第一章|/c/1' })
  })
})

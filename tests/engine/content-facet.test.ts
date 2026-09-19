import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/index.js'
import { splitLiteral, isLiteralForm } from '../../src/engine/literal.js'
import { parseRule } from '../../src/engine/parse.js'
import { applyReplaces } from '../../src/engine/replace.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'

// 本轮正文链路修复的引擎钉子：
// ① default 方言 `text.<串>` 选择语义（legado getElementsContainingOwnText）
// ② 属性终端（legado getResultLast else：链尾未知提取指令 = HTML 属性名）+ 取值用途
// ③ 模板字面段（URL 模板 / {{expr}} 插值 / {$.path} 内嵌）
// ④ `##` 尾 {{chapter.title}} 插值
// ⑤ 中链 jsonpath（JS 返回对象再取字段——上游修复后 legado 语义）

const tocHtml = `<div id="wrap"><ul class="list">
  <li><a href="/b/1.html">第一章 起点</a></li>
  <li><a href="/b/2.html">第二章 转折</a></li>
</ul>
<div class="pages"><a href="/b/1.html?page=2">下一页</a></div>
<div class="card" onclick="window.open('/book/7')" data-src="/cover/7.jpg"></div>
</div>`

describe('① text.<串>：按文本选元素（legado 默认方言选择语义）', () => {
  it('text.下一页@href → 命中含该文本的元素取 href', async () => {
    const v = await evaluate('text.下一页@href', { html: tocHtml, baseUrl: 'https://x.com/b/1.html' }, 'toc', 'value')
    expect(v).toEqual({ kind: 'value', text: '/b/1.html?page=2' })
  })
  it('text 无参数仍是取值终端（全部后代文本）', async () => {
    const v = await evaluate('class.list@tag.a@text', { html: tocHtml }, 'toc', 'value')
    expect(v).toEqual({ kind: 'list', items: ['第一章 起点', '第二章 转折'] })
  })
  it('文本不存在 → Miss（选择失败语义）', async () => {
    const v = await evaluate('text.不存在的文本@href', { html: tocHtml }, 'toc', 'value')
    expect(v.kind).toBe('miss')
  })
})

describe('② 属性终端与取值用途', () => {
  it('取值用途链尾未知词 = HTML 属性名（onclick 真实源形态）', async () => {
    const v = await evaluate('class.card@onclick', { html: tocHtml }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: "window.open('/book/7')" })
  })
  it('属性终端空值丢弃 + 向下兜底（legado else 分支口径）', async () => {
    const v = await evaluate('class.card@data-src', { html: tocHtml }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: '/cover/7.jpg' })
  })
  // isAttrName 放行冒号（命名空间属性 xlink:href 等真实形态），故后代兜底不得走 CSS 属性
  // 选择器拼串——`[xlink:href]` 在 nwsapi 里必炸且炸成逃逸错误分类的裸 Error。
  it('属性终端：命名空间属性名向下兜底取到值', async () => {
    const html = '<div id="w"><p class="np"><span xlink:href="/a.svg">图</span></p></div>'
    const v = await evaluate('class.np@xlink:href', { html }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: '/a.svg' })
  })
  it('属性终端：命名空间属性名全树无该属性 → 空 List（不泄漏裸 Error）', async () => {
    const v = await evaluate('class.np@xlink:href', { html: '<p class="np">无属性</p>' }, 'search', 'value')
    expect(v).toEqual({ kind: 'list', items: [] })
  })
  it('列表用途链尾未知词仍是选择器（getElements 口径——ruleChapterList 形态）', async () => {
    const parsed = parseRule('ul.list li', 'toc', 'list')
    expect(parsed.branches[0].segments[0]).toEqual({ kind: 'css', selector: 'ul.list li' })
  })
  it('词.词形态（nonsense.x）仍解析期抛错——宁炸不猜边界不外扩', () => {
    try { parseRule('nonsense.x', 'toc', 'value'); expect.unreachable() }
    catch (e) { expect(e).toBeInstanceOf(UnsupportedRuleError) }
  })
})

describe('③ 模板字面段', () => {
  it('isLiteralForm 判据：{{}} / http(s):// / {$.path}', () => {
    expect(isLiteralForm('http://api.wzyjxf.com/novel/{{$.novelId}}?isSearch=1')).toBe(true)
    expect(isLiteralForm('{{baseUrl}}catalog/')).toBe(true)
    expect(isLiteralForm('https://b.midukanshu.com/c/{$.bookId}_{$.chapterId}.txt')).toBe(true)
    expect(isLiteralForm('class.read-content@html')).toBe(false)
  })
  it('splitLiteral：js / rule / jsonpath / text / @get 混排 + 平衡括号', () => {
    expect(splitLiteral('https://x.com/novel/{{$.novelId}}?isSearch=1')).toEqual([
      { kind: 'text', text: 'https://x.com/novel/' },
      { kind: 'rule', text: '$.novelId' },
      { kind: 'text', text: '?isSearch=1' },
    ])
    // 平衡括号：JS 里带 { } 不截断
    const parts = splitLiteral('{{page*2}}p/{{(function(){return 1})()}}')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toEqual({ kind: 'js', text: 'page*2' })
    expect(parts[2]).toEqual({ kind: 'js', text: '(function(){return 1})()' })
    // 单括号 JSONPath 内嵌（米读看书形态）
    expect(splitLiteral('https://b.com/{$.bookId}.txt')).toEqual([
      { kind: 'text', text: 'https://b.com/' },
      { kind: 'jsonpath', text: '$.bookId' },
      { kind: 'text', text: '.txt' },
    ])
  })
  it('evaluate：URL 模板 + JSONPath 插值（条目 JSON 上下文）', async () => {
    const item = JSON.stringify({ novelId: 421, title: '诡秘' })
    const v = await evaluate('http://api.x.com/novel/{{$.novelId}}?isSearch=1', { html: item, baseUrl: 'https://x.com/' }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: 'http://api.x.com/novel/421?isSearch=1' })
  })
  // 取值规约：Miss 与空值是两种值，绝不折叠。插值成空串会产出**语法合法的残 URL**
  // （`http://api.x.com/novel/?isSearch=1`），拿它去请求比报错更坏——可能命中另一本书。
  it('字面段插值命中 Miss → 整段 Miss（不把 Miss 洗成残 URL）', async () => {
    const v = await evaluate('http://api.x.com/novel/{{$.novelId}}?isSearch=1',
      { html: JSON.stringify({ other: 1 }), baseUrl: 'https://x.com/' }, 'search', 'value')
    expect(v.kind).toBe('miss')
  })
  it('evaluate：{{baseUrl}} 与 {{result}}（链值引用）与 {{page-1}}', async () => {
    const v1 = await evaluate('{{baseUrl}}catalog/', { html: '', baseUrl: 'https://x.com/book/7' }, 'detail', 'value')
    expect(v1).toEqual({ kind: 'value', text: 'https://x.com/book/7catalog/' })
    const v2 = await evaluate('$.id<js>1100000000+parseInt(result)</js>https://q.com/intro?bookid={{result}}',
      { html: JSON.stringify({ id: 5 }), baseUrl: 'https://x.com/' }, 'search', 'value')
    expect(v2).toEqual({ kind: 'value', text: 'https://q.com/intro?bookid=1100000005' })
    const v3 = await evaluate('https://x.com/list/{{page-1}}', { html: '' }, 'search', 'value')
    expect(v3).toEqual({ kind: 'value', text: 'https://x.com/list/0' }) // page 缺省 1（legado 同款）
  })
  it('evaluate：链中模板段替换链值（$.path 后接 URL 模板——多看阅读形态）', async () => {
    const item = JSON.stringify({ source_id: '9527' })
    const v = await evaluate('$.source_id@js:"https://www.duokan.com/hs/v0/android/fiction/book/"+result',
      { html: item, baseUrl: 'https://x.com/' }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: 'https://www.duokan.com/hs/v0/android/fiction/book/9527' })
  })
})

describe('④ ## 替换尾 {{chapter.title}} 插值', () => {
  it('净化 pattern 里的点路径按 bindings 插值（章标题行剔除形态）', async () => {
    const html = '<div id="c"><p>第3章 坏了</p><p>正文一</p><p>请记住本书首发域名</p></div>'
    const v = await evaluate('#c@p@text##第3章 坏了|请记住.*|{{chapter.title}}##',
      { html, chapter: { title: '第3章 坏了' } }, 'content', 'value')
    // 替换结果为空串的项保留（替换净化不删条目——钉死口径）
    expect(v).toEqual({ kind: 'list', items: ['', '正文一', ''] })
  })
  it('bindings 查不到的 {{}} 保持字面（不猜不炸）', () => {
    const v = applyReplaces({ kind: 'value', text: '甲\n{{unknown.path}}' },
      [{ pattern: '{{unknown.path}}', flags: '', replacement: '' }], false, undefined, { baseUrl: 'https://x.com' })
    expect(v).toEqual({ kind: 'value', text: '甲\n' })
  })
})

describe('⑤ 中链 jsonpath（JS 返回对象再取字段）', () => {
  it('list 上游逐项求值 + js 产出 JSON 后取字段', async () => {
    const page = JSON.stringify({ rows: [{ t: '甲' }, { t: '乙' }] })
    const v = await evaluate('$.rows[*]@$.t', { html: page }, 'toc', 'list')
    expect(v).toEqual({ kind: 'list', items: ['甲', '乙'] })
    // js 段产出 JSON 文本 → 中链 jsonpath 按 JSON 求值（上游修复后 legado 语义）
    const v2 = await evaluate('<js>JSON.stringify({a:{b:7}})</js>$.a.b', { html: '' }, 'search', 'value')
    expect(v2).toEqual({ kind: 'value', text: '7' })
  })
})

describe('⑥ 二轮补齐（元素包装 / AllInOne 行内标志 / 方括号索引 / cache 垫片）', () => {
  it('result 元素包装：@js 首段对 html 上下文 result.select().attr()', async () => {
    const item = '<div class="card"><a href="/book/7" title="诡秘">诡秘</a></div>'
    const v = await evaluate('@js:result.select("a").first().attr("href")',
      { html: item, baseUrl: 'https://x.com/' }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: '/book/7' })
  })
  it('java.getElements 产物经 js 序列化后条目仍按 JSON 可取字段', async () => {
    const page = JSON.stringify({ data: { list: [{ chapterName: '第一章' }, { chapterName: '第二章' }] } })
    const v = await evaluate('<js>java.getElements("$.data.list[*]")</js>$.chapterName',
      { html: page, baseUrl: 'https://x.com/' }, 'toc', 'list')
    expect(v).toEqual({ kind: 'list', items: ['第一章', '第二章'] })
  })
  it('AllInOne 行内标志 (?s) 剥离 → dotAll（若夏 toc 形态）', async () => {
    const page = 'a\nhref="/c/1.html">第一章'
    const v = await evaluate(':(?s)a\\nhref="([^"]*)"', { html: page }, 'toc')
    expect(v.kind).toBe('matches')
    expect((v as { rows: string[][] }).rows).toEqual([['/c/1.html']])
  })
  it('方括号索引：[-1:0] 整表倒序；[n] 取位；[!n] 排除（legado ElementsSingle 口径）', async () => {
    const html = '<ul><li>一</li><li>二</li><li>三</li></ul>'
    expect(await evaluate('li[-1:0]@text', { html }, 'toc', 'list'))
      .toEqual({ kind: 'list', items: ['三', '二', '一'] })
    expect(await evaluate('li[1]@text', { html }, 'toc', 'value'))
      .toEqual({ kind: 'value', text: '二' })
    expect(await evaluate('li[!0]@text', { html }, 'toc', 'list'))
      .toEqual({ kind: 'list', items: ['二', '三'] })
  })
  it('cache 垫片：搜索面 put、目录面 get（按源隔离——快看漫画跨面形态）', async () => {
    const { runScript, createSourceSession } = await import('../../src/engine/js-sandbox.js')
    const session = createSourceSession()
    const loc = { segmentIndex: 0, segmentRaw: 'x' }
    await runScript({ code: 'cache.put("k","V1"); "ok"', loc, facet: 'search', source: 'https://x.com', session })
    const v = await runScript({ code: 'cache.get("k") || "(空)"', loc, facet: 'toc', source: 'https://x.com', session })
    expect(v.value).toEqual({ kind: 'value', text: 'V1' })
    // 隔离：另一源读不到
    const v2 = await runScript({ code: 'cache.get("k") || "(空)"', loc, facet: 'toc', source: 'https://y.com', session })
    expect(v2.value).toEqual({ kind: 'value', text: '(空)' })
  })
})


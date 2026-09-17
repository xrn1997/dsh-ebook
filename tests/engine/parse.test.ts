import { describe, expect, it } from 'vitest'
import { parseRule } from '../../src/engine/parse.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'

describe('② ## 替换尾剥离', () => {
  it('净化形态：取值规则 + 两个替换步', () => {
    const p = parseRule('@css:.articleDiv p@textNodes##搜索.*手机访问|##')
    expect(p.branches[0].segments).toHaveLength(2)
    expect(p.replaces).toEqual([{ pattern: '搜索.*手机访问|', flags: '', replacement: '' }])
    expect(p.onlyOne).toBe(false)
  })
  it('OnlyOne 形态以 ### 结尾', () => {
    const p = parseRule('##:author"[^"]+"([^"]*)##$1###')
    expect(p.onlyOne).toBe(true)
    expect(p.replaces).toEqual([{ pattern: ':author"[^"]+"([^"]*)', flags: '', replacement: '$1' }])
    // 以 ## 开头 → 前面没有取值规则，词法层记为「独立净化」（branches 为空，求值时对 all 结果替换）
    expect(p.branches).toHaveLength(0)
  })
  it('连续多个替换步', () => {
    const p = parseRule('all##a##b##c##d')
    expect(p.replaces).toHaveLength(2)
  })
})

describe('③ - 反序前缀', () => {
  it('链首 - 剥为 reverse 标志，且不误伤负索引', () => {
    const p = parseRule('-class.item@text')
    expect(p.reverse).toBe(true)
    expect(p.branches[0].segments[0]).toEqual({ kind: 'default', mode: 'class', arg: 'item', index: null })
    const p2 = parseRule('class.item.-1@text')   // 段内负索引不是反序
    expect(p2.reverse).toBe(false)
    expect((p2.branches[0].segments[0] as any).index).toEqual({ kind: 'index', value: -1 })
  })
})

describe('④⑤ 分支与段切分', () => {
  it('|| 切分两分支', () => {
    const p = parseRule('class.odd.0@tag.a.0@text||tag.dd.0@tag.h1@text')
    expect(p.combinator).toBe('first')
    expect(p.branches).toHaveLength(2)
    expect(p.branches[1].segments[0]).toEqual({ kind: 'default', mode: 'tag', arg: 'dd', index: { kind: 'index', value: 0 } })
  })
  it('&& → and，%% → zip', () => {
    // 组合符分支测试用白名单词（text）作操作数——裸词透传例外已废除
    expect(parseRule('text&&text').combinator).toBe('and')
    expect(parseRule('text%%text').combinator).toBe('zip')
  })
  it('混用算符抛 UnsupportedRuleError', () => {
    expect(() => parseRule('a||b&&c')).toThrow(UnsupportedRuleError)
  })
})

describe('⑥ 段识别', () => {
  it('default 选择与取值段', () => {
    const s = parseRule('@css:.x@class.odd.2@text').branches[0].segments
    expect(s[1]).toEqual({ kind: 'default', mode: 'class', arg: 'odd', index: { kind: 'index', value: 2 } })
    expect(s[2]).toEqual({ kind: 'default', mode: 'text', arg: null, index: null })
  })
  it('位置后缀：all / 负索引 / 切片半开区间', () => {
    const segs = parseRule('tag.a.all@tag.a.-2@tag.a.1:5').branches[0].segments
    expect((segs[0] as any).index).toEqual({ kind: 'all' })
    expect((segs[1] as any).index).toEqual({ kind: 'index', value: -2 })
    expect((segs[2] as any).index).toEqual({ kind: 'slice', from: 1, to: 5 })
  })
  it('css / jsonpath / AllInOne 识别', () => {
    expect(parseRule('@css:li.clearfix').branches[0].segments[0].kind).toBe('css')
    expect(parseRule('$.info.Datas').branches[0].segments[0]).toEqual({ kind: 'jsonpath', path: '$.info.Datas' })
    expect(parseRule('$.chapter.body').branches[0].segments[0].kind).toBe('jsonpath')
    const a = parseRule(':href="(/read[^"]*html)">([^<]*)').branches[0].segments[0] as any
    expect(a.kind).toBe('allinone')
    expect(a.pattern).toBe('href="(/read[^"]*html)">([^<]*)')
  })
  it('put / getvar 识别', () => {
    expect(parseRule('@put:{bid:"123"}').branches[0].segments[0]).toEqual({ kind: 'put', pairsRaw: '{bid:"123"}' })
    expect(parseRule('@get:bid').branches[0].segments[0]).toEqual({ kind: 'getvar', name: 'bid' })
  })
  it('js 三种形态；@js: 吞链尾、<js> 块可非末位', () => {
    const s = parseRule('@css:.x@text@js:result.replace(/a/,"b")').branches[0].segments
    expect(s[2]).toMatchObject({ kind: 'js', form: 'at-js' })
    const s2 = parseRule('<js>result + "!"</js>').branches[0].segments[0]
    expect(s2).toMatchObject({ kind: 'js', form: 'inline' })
    // @js: 在链首 → 吞掉整条链（代码里的 @ / || / && 是 JS 代码不是段界/连接符——真实源形态）
    const s3 = parseRule('@js:var k = key || "";\nreturn k + "@" + page;').branches[0].segments
    expect(s3).toHaveLength(1)
    expect(s3[0]).toMatchObject({ kind: 'js', form: 'at-js' })
    // <js> 块后接选择段（无 @ 分隔）→ 块独立成段，后续起新段（真实源 `<js>…</js>.card-body` 形态）
    const s4 = parseRule('<js>result.replace(/x/,"")</js>.card-body').branches[0].segments
    expect(s4).toHaveLength(2)
    expect(s4[0]).toMatchObject({ kind: 'js', form: 'inline' })
    expect(s4[1]).toMatchObject({ kind: 'css', selector: '.card-body' })
  })
  it('不认识的段抛错且带段索引与原文', () => {
    try { parseRule('@css:.x@frobnicate.thing', 'toc'); expect.unreachable() }
    catch (e) {
      expect(e).toBeInstanceOf(UnsupportedRuleError)
      expect((e as UnsupportedRuleError).segmentIndex).toBe(1)
      expect((e as UnsupportedRuleError).segmentRaw).toBe('frobnicate.thing')
      expect((e as UnsupportedRuleError).facet).toBe('toc')
    }
  })
  it('未知裸词在解析期必炸（裸词透传例外已废除，不留到 eval）', () => {
    // 订正：'nonsense' 曾作为透传 mode 放行到 eval 才炸（错错误类/错阶段）
    try { parseRule('nonsense.x', 'toc'); expect.unreachable() }
    catch (e) {
      expect(e).toBeInstanceOf(UnsupportedRuleError)
      expect((e as UnsupportedRuleError).segmentIndex).toBe(0)
      expect((e as UnsupportedRuleError).segmentRaw).toBe('nonsense.x')
      expect((e as UnsupportedRuleError).facet).toBe('toc')
    }
  })
})

// ── 真实源方言扩展（官方文档+社区知识库考证；616 broken 归因驱动）──────────

describe('大小写不敏感特殊前缀（真实源有 @CSS:/@JS: 大写形态）', () => {
  it('@CSS: / @Json: / @JS: 与小写同义', () => {
    expect(parseRule('@CSS:table.x tr').branches[0].segments[0].kind).toBe('css')
    expect(parseRule('@JSON:$.a.b').branches[0].segments[0].kind).toBe('jsonpath')
    expect(parseRule('@css:.x@JS:result+"!"').branches[0].segments[1]).toMatchObject({ kind: 'js', form: 'at-js' })
  })
})

describe('隐式 CSS 回落（官方简写：class.x≡.x、id.x≡#x；社区考证裸词=tag 选择器）', () => {
  it('#id / .class 简写 → css 段', () => {
    expect(parseRule('#page@div[itemscope]').branches[0].segments[0]).toEqual({ kind: 'css', selector: '#page' })
    expect(parseRule('.txt-list@li').branches[0].segments[0]).toEqual({ kind: 'css', selector: '.txt-list' })
  })
  it('裸 tag 词（li/a/div）→ css 段（class.list@a ≡ .list a——59 条失败的根因）', () => {
    expect(parseRule('class.list@a').branches[0].segments[1]).toEqual({ kind: 'css', selector: 'a' })
    expect(parseRule('li').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'li' })
  })
  it('tag+属性选择器 → css 段', () => {
    expect(parseRule('div[itemscope]@text').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'div[itemscope]' })
  })
  it('tag.类 组合 → css 段（189 条真实规则；首词是合法 HTML 标签）', () => {
    expect(parseRule('li.chapter').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'li.chapter' })
    expect(parseRule('div.ncp3li_title@text').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'div.ncp3li_title' })
    expect(parseRule('a.list-group-item||a[href*=x]').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'a.list-group-item' })
  })
  it('tag+伪类/空白组合 → css 段（a:contains(x)、li:first-child a——Jsoup/legado 常用）', () => {
    expect(parseRule('a:contains(在线阅读)@href').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'a:contains(在线阅读)' })
    expect(parseRule('li:first-child a').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'li:first-child a' })
    expect(parseRule('div:has(img)@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'div:has(img)' })
  })
  it('词.词形态仍炸（首词非标签——与 default 方言歧义，宁炸不猜的边界）', () => {
    expect(() => parseRule('weirdsyntax.x@text')).toThrow(UnsupportedRuleError)
  })
  it('非标签首词的伪类形态仍炸（nonsense:x——宁炸不猜边界不外扩）', () => {
    expect(() => parseRule('nonsense:x@text')).toThrow(UnsupportedRuleError)
  })
})

describe('隐式 CSS 新形态（642 源重探归因驱动）', () => {
  it('选择器 + 位置后缀 → css 段带 index（a.0 = 选 a 再取第 0 个——16 条首条书名为空的根因）', () => {
    expect(parseRule('a.0@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'a', index: { kind: 'index', value: 0 } })
    expect(parseRule('class.odd.0@tag.a@text').branches[0].segments[0])
      .toEqual({ kind: 'default', mode: 'class', arg: 'odd', index: { kind: 'index', value: 0 } })
    expect(parseRule('td.1:3').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'td', index: { kind: 'slice', from: 1, to: 3 } })
  })
  it('后代/子代组合链 → css 段（tbody>tr、dd>h3>a、li.chapter span——Jsoup 常用）', () => {
    expect(parseRule('tbody>tr@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'tbody>tr' })
    expect(parseRule('dd>h3>a@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'dd>h3>a' })
    expect(parseRule('li.chapter span').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'li.chapter span' })
  })
  it('纯属性选择器 → css 段（[class="col-12 col-md-6"]）', () => {
    expect(parseRule('[class="col-12 col-md-6"]@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: '[class="col-12 col-md-6"]' })
  })
  it('词.词形态仍炸（首词非标签——与 default 方言歧义，宁炸不猜的边界不外扩）', () => {
    expect(() => parseRule('tplData.books@text')).toThrow(UnsupportedRuleError)
  })
})

describe('! 排除语法（官方：!是排除，序号用 : 隔开，-1 为倒数）', () => {
  it('li!0 → css li + 排除第 1 个', () => {
    expect(parseRule('.txt-list@li!0').branches[0].segments[1]).toEqual({ kind: 'css', selector: 'li', exclude: [0] })
  })
  it('class.x!0:2 多值排除 + 负数', () => {
    const s = parseRule('class.item!0:2@text').branches[0].segments[0] as any
    expect(s).toMatchObject({ mode: 'class', arg: 'item', exclude: [0, 2] })
    const s2 = parseRule('tag.a!-1').branches[0].segments[0] as any
    expect(s2.exclude).toEqual([-1])
  })
})

describe('XPath 识别（// 开头与 @XPath:/@xpath: 前缀——274 条真实规则）', () => {
  it('// 路径 → xpath 段', () => {
    expect(parseRule('//div[@id="x"]/a/@href').branches[0].segments[0])
      .toEqual({ kind: 'xpath', path: '//div[@id="x"]/a/@href' })
  })
  it('@XPath: 前缀（大小写不敏感）→ xpath 段；.// 相对路径保留', () => {
    expect(parseRule('@XPath:.//a/text()').branches[0].segments[0])
      .toEqual({ kind: 'xpath', path: './/a/text()' })
    expect(parseRule('@xpath://dd[2]/text()').branches[0].segments[0])
      .toEqual({ kind: 'xpath', path: '//dd[2]/text()' })
  })
  it('xpath 段与 ## 替换尾组合（真实样本：…text()##作者：）', () => {
    const p = parseRule('//span[@class="a"]/text()##作者：')
    expect(p.branches[0].segments[0].kind).toBe('xpath')
    expect(p.replaces).toEqual([{ pattern: '作者：', flags: '', replacement: '' }])
  })
})

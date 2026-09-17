# 规则引擎（engine）

本文是引擎的现状真相（single source）；领域词汇见 `CONTEXT.md`——取值链、净化尾、规则文法、面、段、取值规约、方言、搜索面、请求组装一律用那里的词，别自造。

引擎的边界：`src/engine/**` 零 Cordis、零 `@deepseek-ai/*`、零网络——网络只以 `EvalContext.fetch` 注入函数出现。规则串 → 词法（`parseRule`）→ 求值（`evaluate`）→ `EngineValue`。

## 模块地图

| 文件 | 职责 | 关键导出 | owner 语义 |
| --- | --- | --- | --- |
| `engine/types.ts` | 值形状与 AST | `Facet`、`EngineValue`、`Segment`、`Branch`、`ParsedRule`、`EvalContext`、`DEFAULT_JS_TIMEOUT_MS`(2000) | `EngineValue` 五态（miss/value/list/nodes/matches）的唯一定义处。`Facet` 比文档多一个 `explore`（无生产调用方，见「已知开口」） |
| `engine/errors.ts` | 三类引擎错误 | `EngineError`、`UnsupportedRuleError`、`RuleEvalError`(+`hits`)、`JsSandboxError`(+`script`/`line`)、`isEngineError` | 段级定位文案的唯一格式化点：`[facet#段N] msg（规则片段: "raw"）` |
| `engine/parse.ts` | 词法流水线：字符串 → AST（零 IO） | `parseRule(rule, facet='rule')` | 切分次序、段识别白名单、隐式 CSS 回落、位置后缀、「不认识就炸」的唯一位置 |
| `engine/grammar.ts` | 规则文法：构词与解析同属一处 | `parseTails`、`appendTail`、`withImplicitText`、`jsRegionEnd`、`isJsForm`、`splitVarExpr`、`isPureVarExpr` | `##` 净化尾与 JS 区域语法的唯一认知点；normalize 的方言拼串只能经 `appendTail` |
| `engine/template.ts` | URL 模板插值 | `interpolateUrl(template, vars)` | `{{name||缺省}}` 的替换口；词法拆分借 `grammar.splitVarExpr` |
| `engine/dom.ts` | cheerio 封装与纯文本契约 | `loadHtml`、`cleanText`、`nodeText`、`htmlToText`、`looksLikeHtml`、`isNodeValue` | 「块级边界落成 `\n`」的正文契约唯一实现（不是 cheerio `.text()`） |
| `engine/select.ts` | default 选择段/取值段 | `reducePicked`、`applyIndex`、`applyExclude`、`evalDefault` | **取值规约的唯一实现**：`reducePicked` 管取位与空态裁决，`getValue` 管「元素在、取值全空 → 空 List」 |
| `engine/css.ts` | `@css:` 段 | `evalCss` | 只做 `cur.find(selector)` + 消费 `reducePicked`；显式形态带 `!` 排除，位置后缀仅隐式回落形态携带 |
| `engine/xpath.ts` | XPath 子集求值器 | `evalXPath` | 直接在 domhandler 节点树上求值；轴/谓词/函数白名单与「位置谓词按父分组」都只在这里 |
| `engine/jsonpath.ts` | JSONPath 子集 | `evalJsonPath` | 手写 tokenizer；下标/切片负数从尾数与「取位失败 → Miss、空数组 → 空 List」的 JSONPath 侧口径 |
| `engine/allinone.ts` | AllInOne 整页正则 | `evalAllInOne` | 二维 `matches` 产物（条目×捕获组）唯一产地，永不压平 |
| `engine/variables.ts` | 变量段与 JSON 数据源 | `evalPut`、`evalGetVar`、`resolveJsonData` | `ctx.json` 优先、缺席回退解析 `ctx.html` 的口径 |
| `engine/combine.ts` | 组合符与反序 | `combine`、`reverseList` | `||` / `&&` / `%%` 的语义唯一实现 |
| `engine/replace.ts` | 净化尾求值 | `applyReplaces` | `##pattern##replacement` 与 OnlyOne(`###`) 的唯一执行点 |
| `engine/evaluate.ts` | 总装与 trace | `evaluate`、`evaluateWithTrace`、`TraceStep`、`TraceResult` | 链语义（generator `ruleGen`/`branchGen`）+ 两个驱动器 + 链衔接状态机 |
| `engine/js-sandbox.ts` | `@js` 沙箱 | `evalJs`、`runScript`、`JsHost`、`SourceSession`、`processSession`、`createSourceSession`、`ensureUnhandledGuard` | vm 逃逸防御、超时、日志收集、进程级 unhandledRejection 防线 |
| `engine/js-protocol.ts` | JavaBridge 协议表 | `JAVA_PROTOCOL`、`invokeJavaMethod`、`SANDBOX_MOUNTS`、`JavaBridge`(推导) | 加一个 `java.*` 方法 = 表加一行；BOOTSTRAP 名单/分派/类型面全部派生 |
| `engine/js-utils.ts` | 沙箱宿主纯工具 | `engineValueToString(v, 'inner'\|'outer')`、`engineValueToStrings`、`md5Hex(16)`、`base64*`、`uriEncode`、`hexDecodeToString`、`fmtTime` | `EngineValue → 单串` 的唯一实现（nodes 两种口径由参数区分） |
| `engine/index.ts` | 公开面（收窄后仅此七项） | `evaluate`、`evaluateWithTrace`、`interpolateUrl`、`isEngineError`、四个错误类、`EngineValue`/`EvalContext`/`Facet` 类型 | 服务半的**唯一**对外承诺；其余 module 深路径直引只是自测 seam |

服务半只能 import `engine/index.ts` 的七项，其余内部 module 的深路径直引一律视为**自测 seam**（`tests/engine/*` 直引 `parse.ts`/`select.ts`/`grammar.ts`/`js-sandbox.ts` 是测试需要，不是对外承诺）。新增服务消费点前先问「这是引擎公开面吗」——是则加进 barrel，否则说明耦合放错了位置。

## 取值规约（最重要的一条）

**取位失败 → Miss；解析到空集合 → 空 List。**

- 选择段（`default` 的 class/id/tag/child/children 与 `css` 段）：`engine/select.ts` 的 `reducePicked` 把 `exclude` 过滤 → `index` 取位 → 空态裁决串成一处，四种失败态 `zero`/`excluded`/`oob`/`sliced` **一律判「选择失败」→ Miss**。
- 取值段（`engine/select.ts` 的 `getValue`）：同样消费 `reducePicked` 做取位；只有「元素在、取值全空」（`texts.length === 0`）才给空 List。`textNodes` 是唯一恒产 List 的取值段（`select.ts` 的 `textNodes` 分支）。
- JSONPath 同口径（`engine/jsonpath.ts` 的 `evalJsonPath`）：零命中/取到 `null`/下标越界/切片裁空 → Miss；**解析到空集合**（`[*]` 与 `[]` 是同一通配的两种写法，打在空数组上）→ 空 List。集合型末段（`[*]`、`[a:b]`、`..name`）哪怕只收一项也恒产 List（`jsonpath.ts` 的 `collection` 判定）。
- 组合符消费这个区分：`||` 认为空 List 是「未取到」继续向右（`combine.ts` 的 `combineFirst`，注释「空 List = 未取到，继续向右」），全 Miss → Miss，**全空 List（无 Miss）→ 空 List**（同函数尾的 `所有分支未命中` 与「全空 List 或零分支 → 空 List」注释）——绝不把空 List 折叠成 Miss。

**为什么**：legado 的 `||` 短路语义建立在「没取到」是一个可继续的值之上。若把「取到空」也当失败，兜底分支会连带失效并静默拉回错误内容（android-ebook 血训）。

**链上空的两种穿透行为**：Miss 在选择/取值段被原样透传（`evalNonJs` 各 case 的 `if (cur?.kind === 'miss') return cur`），不会变成「上游不是节点集」的求值错——这是 `||` 兜底能成立的前提。`requireNodes`（`evaluate.ts`）另外约定：链首未起链 → 根节点集 `$('*')`；上游是 Value（js 段产物或取值段产物）→ 按 HTML 重新解析为新上下文（legado `String → JSoup` 语义，`<js>…</js>@css:.x` 成立）；其余 → `RuleEvalError`。

**`nodes` 不许到达链终点**：选择段产 `nodes` 供后续段消费；若规则以节点集收尾，服务层的 `firstValue`/`listValue` 抛 `RuleEvalError('结果不是取值而是节点集')`（`services/bridge.ts` 的 `nodesError`，`segmentIndex: -1`）。这也是 Native 方言要补隐式 `@text` 的原因——不补就会以节点集收尾。

**被否决的替代方案**：① 选择段切片裁空给空 List——曾如此（default 给空 List、css 给 Miss，同一 `x.5:9` 后缀两种结果），而空 List 不是节点集，中链必抛「上游结果不是节点集」；裁决为选择段四态一律 Miss（`tests/engine/reduce.test.ts` 的 `describe('选择段空态裁决统一（分叉①修复）')`）。② 取值段拥有自己的一份空态逻辑（`@text.5:9` 给空 List 而 `.5:9@text` 给 Miss）——已收拢到 `reducePicked` 单点。③ `&&` 用 Miss 冒充「合并失败」——改为抛 `UnsupportedRuleError`（`combine.ts` 的 `UnsupportedRuleError('&& 混合 AllInOne(matches) 二维结果无法合并')`，`tests/engine/combine.test.ts`）。④ `@text!0` 的排除被静默丢弃——排除现已在取值段生效（`select.ts` 的 `getValue` 消费 `reducePicked(arr, seg.exclude, seg.index)`）。

## 取值链文法

- **切分次序**（`parse.ts` 顶注「切分次序（钉死）」与 `parseRule`，顺序固定）：② 剥 `##` 净化尾（`parseTails`，`###` 先记 OnlyOne 再剥尾部一个 `#`）→ ③ 剥链首 `-` 反序前缀 → ① 剥完上面两步仍以 `:` 开头 → 整链一个 allinone 段 → ④ 按 `||`/`&&`/`%%` 从左到右分支切分（**混用抛错**）→ ⑤⑥ 段切分与识别（`globalIndex` 全规则连续编号，写进错误定位）→ ⑦ 链尾 `(jsCode)` 与 `js` 末位限制。
- **分支切分跳过 JS 区域**（`splitTop` → `grammar.jsRegionEnd`）：`js:` 在链首或段界 `@` 后吃到链尾；`<js>…</js>` 块整体是一段。
- **段切分**（`splitElements`）：单 `@` 是段界，`@@` 是字面 `@`（显式声明形态，段内剥一个 `@`）。XPath 主导规则（`@xpath:`/`//`/`.//`/`/` 开头）的谓词 `@class` 与属性步 `@href` **不切段**，只在 `@已知特殊前缀` 处切；切过一段后回归普通模式（`//x@css:y@text` 成立）。
- **段识别**（`classifySegment`）：前缀大小写不敏感（真实源有 `@CSS:`/`@JS:`）。白名单 `KNOWN_MODES`（`parse.ts`）之外、又不构成选择器形态 → 解析期 `UnsupportedRuleError`。
- **终端**：`text`（**全部后代文本**，块级边界落 `\n`）、`textAll`（归一单行）、`ownText`（严格直系文本）、`textNodes`（逐文本节点一条）、`html`（内层）、`all`（outerHTML）、`href`/`src`（自身属性，空则向下兜底第一个含该属性的后代，但 `html`/`body` 包装元素一律不兜底）、`content`（自身属性，兜底第一个 `meta[content]`）。
- **位置后缀与排除**：`splitIndexSuffix` 从**最后一个** `.` 起取第一个能解析为 `IndexSpec` 的后缀（`all`/整数/`a:b` 切片，均支持负数）；解析不了则整串是名称（`class.note.clearfix` → arg `note.clearfix`）。`!0:2:-1` 是排除，只对选择段（`default` 选择段与 `css`）合法，且与位置索引**不并存**（解析期抛错）。
- **位置后缀的落点差异**：`default` 段的位置后缀挂在**名称**上（`class.item.5:9` → 选择 5:9 个 `.item`）；隐式 CSS 回落把后缀带进 `css` 段（`a.0` = 选 `a` 再取第 0 个——真实源高频形态，曾被并进选择器 `a.0` 当 class 选择 → 恒零命中 → 首条书名为空）；显式 `@css:` 形态**没有**位置后缀概念，恒整集（`css.ts` 注释「css 显式形态无位置后缀（恒整集）」）。取值段后缀挂在终端后（`@text.5:9`），与选择段同口径裁决。
- **排除语法与 JS 段的边界**：排除切分用 `/^(.+?)!(-?\d+(?::-?\d+)*)$/`，只对选择段生效；`js:` 段代码里的 `!0`（布尔取反）在段前缀识别时先行返回，不受影响（`parse.ts` 的 `classifySegment`：`js:` 分支先于 `splitExclude`）。
- **隐式 CSS 回落**（`parse.ts` 的 `isImplicitCss`）：`#id`/`.class` 简写、裸 tag 词、`tag[attr]`、纯属性选择器、`tag.类` 组合、`tag+伪类/组合链`（首词须是 `HTML_TAGS` 成员）。首词非标签的「词.词」形态（`weirdsyntax.x`、`nonsense:x`）与 default 方言有歧义 → **仍抛错**。
- **构词与解析同属一处**：`normalize` 三个方言分支与 `search-template`/`template` 的 `||` 拆分一律不可自写。`appendTail` 拼串后**用 `parseTails` 回读自校验**（round-trip）：pattern/replacement 含 `##`、与拼接边界 `#` 粘连、追加到 `###` 结尾的 OnlyOne 规则等情况，当场拒绝返回原 rule + warning，由调用方进 `normalize.warnings`。`withImplicitText` 也复用 `jsRegionEnd`，不再按 `||` 盲切 JS 体。

**为什么**：normalize 拼出来的必须正是 parse 认的。此前构词散在三个跨半 module 的硬拼串里，文法一改靠注释同步（已实际分叉：`<js>return a||b</js>` 被撕成 `<js>return a@text||b</js>@text`——正文规则一旦命中即整本书读不出正文且不报错）。

**JS 区域探测是文法的一半**（`grammar.ts` 的 `jsRegionEnd`，parser 的 `splitTop`/`splitElements` 与构词侧 `withImplicitText` **共用同一份认知**）：`<js>…</js>` 块整体是一个段、块内 `||`/`&&`/`%%`/`@` 是 JS 代码；`js:` 只在链首或段界 `@` 后成立，且**吃到链尾**（真实源 `@js` 代码里大量 `||`/`&&`/字符串里的 `@`）。构词侧此前裸 `split('||')` 会把 JS 体当连接符撕开，两侧对同一文法认知不一致。

**被否决的替代方案**：① 构词侧自持一份词法——否，改走 round-trip 自校验。② 遇到越界尾静默跳过——否，warning 进 `normalize.warnings`（宁吵不瞒）。③ 裸词透传留到求值期——否，解析期即炸（否则 compat 工具链按 parse 预检时漏掉，错误类与阶段全错）。④ `##` 落在正则/JS 代码内部靠朴素切分——仍是已知方言限制，但构词侧由 round-trip 拦下，不再产出求值期谜之结果。

## 方言与 normalize

`services/normalize.ts` 是三种方言（legado 平铺 / legado 对象 / Native）到模型字段的唯一映射点：`isNativeSource`（顶层字符串 `name`+`url` 且无 `bookSourceName`）判别 → `flattenDialect`（`ruleSearch` 落搜索面、`ruleBookInfo` 落 `ruleDetail*`、`ruleToc.chapterList` 落 `ruleChapterList`；`replaceRegex` 经 `appendTail` 追加净化尾）或 `flattenNative`（list/name/url 三件套、`replaceRules[]` 逐条 `appendTail`、`authorPrefix` → `##^前缀##`、`{{keyword}}` 改写为内部 `{{key}}`）。两条路都把拼串交给 `engine/grammar.ts`，越界当场进 warning。

Native 特有的**隐式终端构词**：`NATIVE_TEXT_FIELDS`（`normalize.ts`）里的取值字段裸选择器补 `@text`（`withImplicitText`）。`ruleBookList`/`ruleChapterList`/`ruleCoverUrl`/`ruleBookUrl` **不在列**——它们要节点集或属性，补了就取不到。

`services/request.ts` 持有「URL 模板 + 变量 + baseUrl → 可执行请求计划」的请求组装语义（`assembleRequest`/`fetchInitOf`）；模板内 `{{...}}` 的 JS 形态（`{{java.encodeURI(key)}}`、`{{page*2}}`）由 `services/search-template.ts` 经 `runScript` 预求值，纯变量形态留给 `interpolateUrl`（`encodeURIComponent` 编码，未知变量保留原文）。

**拼串与终端的施加次序**（`normalize.ts` 注释「终端语义收口：取值字段裸选择器补隐式 @text」钉死）：先在链体上追加净化尾（`authorPrefix` / `replaceRules[]`），**再**补隐式 `@text`——`withImplicitText` 只处理链体、尾部不动，反序会污染 `##` 段。`ruleDetail*` 与 `ruleChapterList` 是 `ruleBookInfo`/`ruleToc` 的落位目标，平铺方言缺失时在服务层回退（详情面回退 `rule*`，目录列表回退 `ruleBookList`；`reading.ts` 的 `getDetail` 里 `rules.ruleDetailName ?? rules.ruleBookName`、`getTocInner` 里 `s.rules.ruleChapterList ?? s.rules.ruleBookList`）——**回退发生在调用点，不在 normalize**。

## 面与段

- **面（facet）**：`search`/`detail`/`toc`/`content` 由服务半在调用点传入——搜索面 `search-face.ts` 的 `subEval(ruleBookList, …, 'search')`、详情/目录/正文 `reading.ts` 的 `getDetail`/`getTocInner`/`getChapter`（分别传 `'detail'`/`'toc'`/`'content'`）。face 只进错误定位与 trace，不改变求值语义。`rule` 是缺省面（`parseRule`/`evaluate` 的第二参缺省），用于 `loginUrl` 脚本等无面规则；`explore` 无生产调用方。
- **段（segment）**：`SegmentLoc = { segmentIndex, segmentRaw }`；`segmentIndex` 是跨分支的全规则连续编号（parse 的 `counter` 与 evaluate 的 `offset` 同口径）。错误消息形如 `[content#段0] …（规则片段: "@css:.con@text"）`。
- 服务层规约出的错误（链终点剩节点集、正文规则零命中）用 `segmentIndex: -1` + `segmentRaw: '(服务层规约)'`（`services/bridge.ts` 的 `nodesError`、`reading.ts` 的 `RuleEvalError('正文规则没取到内容')`）。

## 数据流（书源规则 + 面 → 取值结果 / 错误）

1. `normalize` 出 `rules.*`（链字符串，含 `##` 尾）。
2. 面入口：`fetchSearchPage`（`services/search-face.ts`）先 `resolveSearchTemplate` → `buildSearchRequest`/`assembleRequest` → `fetchTextPage`（超时单点）→ `extractItems(await subEval(ruleBookList, …, 'search'))`。
3. `makeSubEval`（`bridge.ts`）→ `engineContextOf` 组装 `EvalContext`（`html`/`json`/`baseUrl`/`source`/`vars`/`fetch: engineFetch`/`jsLib`）→ `evaluate(rule, ctx, facet)`。
4. `evaluate`：`parseRule`（字符串形态）→ `ruleGen`/`branchGen`（链语义单点）→ `evalNonJs` 按段 kind 分派（css/xpath/default/jsonpath/allinone/getvar）→ js 段 `yield` 给驱动器 → `combine` → `reverseList` → `applyReplaces`。
5. 值回服务半：`firstValue`/`listValue`/`extractItems`（`bridge.ts`）。`nodes` 到达链终点 → `RuleEvalError('结果不是取值而是节点集')`（`bridge.ts` 的 `nodesError`）。
6. `evaluateWithTrace` 同一 runner，额外收集每段一行 `TraceStep`（`hits`/`preview`/`jsLogs`/`error`）；错误段先 push error Step 再照抛。

### 链语义单点（改引擎的第一站）

链衔接、`@put` 效果、js 段特判、trace 组装、错误步**只此一份**，以 generator `ruleGen`/`branchGen`（`evaluate.ts`）表达：非 js 段同步推进，js 段 `yield` 出完整 `evalJs` 入参。两个驱动器零链知识——`driveAsync`（主路径）`await evalJs` 后回喂，`driveSync`（`java.getString*` 的 `evaluateRef` 专用，沙箱宿主桥是同步接口）遇第一次 `yield` 即判「子规则内不支持 js 段」并抛错。

**为什么**：此前是 `runParsed`/`runParsedSync` 两个约 60 行逐条镜像的孪生函数，特判段（js/put）必须双写，且同步环路长期零测试。**被否决的替代方案**：① 保留双 runner 靠注释同步——已实际分叉；② 让同步驱动器异步化——沙箱宿主桥 `__host_call__` 是同步接口，改不动；③ 遇 js 段在同步环路里返回 Miss——否（用 Miss 冒充失败）。

**段链衔接的显式检查**：`checkChainStart`（`evaluate.ts`）只许 `jsonpath` 与 `allinone` 出现在分支首位；`@get:` 段产出 Value/Miss，是合法的链值替换点（`evaluate.ts` 的 `case 'getvar'`）；`@put:` 是副作用段——写 `ctx.vars` 后链值**透传**（`evaluate.ts` 的 `seg.kind === 'put'` 分支），不替换 `cur`。

**trace 的已知限制**：错误段会先 push 一行 error Step 再抛，而 `evaluateWithTrace` 随错误 reject，调用方拿不到这段部分 trace——只有带段级定位的 typed error 浮出。若「试跑器」需要失败时的部分 trace，`TraceResult` 契约得扩展（例如返回 `{value?, steps, error}` 而不是抛）。

## 宁炸不猜的清单（每条都是显式裁决）

| 位置 | 行为 | 为什么 |
| --- | --- | --- |
| `parse.ts` 的 `UnsupportedRuleError('位置索引与 ! 排除语法不并存（legado 二选一）')`（default 与隐式 CSS 两处） | 位置索引与 `!` 排除并存 → 抛 | legado 二选一，语义冲突 |
| `parse.ts` 的 `UnsupportedRuleError('无法识别的段类型（default 段白名单之外）')` | 白名单外且非选择器形态 → 解析期抛 | 空结果冒充失败是最高罪 |
| `jsonpath.ts` 的 `reject(…, '过滤器 [?()] 不支持')` / `'脚本表达式 [()] 不支持'` / `'@ 特殊符号'` / `'& 特殊符号'` | 过滤器 `[?()]`、脚本 `[()]`、`@`/`&` → 抛 | 子集边界外不猜 |
| `jsonpath.ts` 的 `reject(…, '路径必须以 $ 开头')` | 路径非 `$` 开头 → 抛 | 无根路径无语义 |
| `xpath.ts` 的 `'XPath 轴不支持'` / `'XPath 函数不支持'` | 白名单外轴（ancestor 等）与函数（count/sum）→ 抛 | 274 条真实规则实测边界 |
| `combine.ts` 的 `'&& 混合 AllInOne(matches) 二维结果无法合并'` / `'%% 交叉合并不支持 AllInOne(matches) 二维结果'` | `&&`/`%%` 遇多分支 `matches`(2-D) → 抛 | 二维无法摊平；不得用 Miss 冒充 |
| `variables.ts` 的 `'@put 值不支持该规则形态（v1 仅支持普通字符串或 JSONPath）'` | `@put` 值非普通串/非 JSONPath（XPath、`@css:`、`<js>`、`#{`）→ 抛 | v1 只支持两种值形态 |
| `variables.ts` 的 `'@put 的 JSONPath 求值结果为列表，v1 变量只存单值'` | `@put` 的 JSONPath 求值结果是 List → 抛 | 变量只存单值 |
| `js-protocol.ts` 的 `'getString 的 isUrl=true 在 v1 不支持（不支持取 URL 后自动抓取）'` | `java.getString(rule, isUrl=true)` → 抛 | 不在桥内做 fetch，静默把 URL 当内容返回是错误结果 |
| `evaluate.ts` 的 `driveSync`：`'子规则（java.getString 等递归求值）内不支持 js 段——沙箱宿主桥为同步接口'` | 子规则（`java.getString*`）内含 js 段 → 抛 | 沙箱宿主桥是同步接口，无法递归 await |
| `js-sandbox.ts` 的 no-op 名单：`需要安卓宿主环境` | `java.webView`/crypto/`android.*`/`org.*` → 报「需要安卓宿主环境」 | 不静默 no-op；纯 UI 副作用（toast/copyText/startBrowser/open）则明确 no-op |
| `xpath.ts` + `js-protocol.ts` | 解析不到、宿主桥未接线（`evaluateRef` 缺失）→ 抛 | 缺接线不降级 |

**例外（规则承认的静默）**：位置越界、切片越界**不抛**（`applyIndex` 静默裁剪），越界定位取不到值 → Miss。这是 legado 行为，也是「越界不抛、语法不认识才抛」的边界。同类静默还有三处，都是**如实**而非掩盖：`@put` 的 JSONPath 求值 Miss → 变量不落盘（`@get` 时自然 Miss，`variables.ts` 的 `putJsonPath`：`if (res.kind === 'miss') return`）；`resolveJsonData` 解析失败 → `undefined` → JSONPath 如实 Miss（`variables.ts` 的 `resolveJsonData` 注释「非法 JSON → undefined」）；`normalize` 对未映射子字段与 v1 未支持字段聚合 warning（宁吵不瞒，不拦导入）。

**字符串化口径**（`EngineValue → 串` 只有一个实现 `js-utils.engineValueToString`）：`value`→text、`list`→`\n` 拼接、`matches`→行内 `\t`、`miss`→`''`，`nodes` 由参数区分 `inner`（`html()`，`java.getString` 口径）与 `outer`（`toString()`，`@js` 的 `host.result` 口径）。`engineValueToStrings`（`java.getStringList`）另把 `value` 按换行切分并滤空行。

## @js 沙箱与宿主垫片

`evalJs`（`js-sandbox.ts`）的机制与理由：

- **逃逸防御**：宿主绝不把函数/对象直接交给用户代码。唯一入口 `__host_call__` 被 vm-realm 闭包捕获后即从全局锁死（`typeof` 得 `number`），`java`/`console`/`cookie`/`source` 全是 vm realm 的包装函数，参数与返回值 JSON 双向序列化，宿主错误只取 `.message` 后以 vm realm `Error` 重抛。vm 上下文 `codeGeneration:{strings:false,wasm:false}` → `eval`/`Function` 一律 `EvalError`。**为什么**：此前把宿主函数直接注入 → `console.log.constructor("return process")()` 可直达宿主 realm（vm 的 `codeGeneration` 不约束宿主 realm 的 `Function`）。
- **禁用能力及理由**：`require`/`process`/`fs`/`global` 不注入（`typeof` 得 `'undefined'`）；字符串代码生成禁用——这是 `jsLib` 用 `eval`/`new Function` 的源报「Code generation from strings disallowed」的原因，**明确不支持**而非降级；webView/crypto/字体/`android.*`/`org.*` 报「需要安卓宿主环境」。
- **超时**：`jsTimeoutMs`（缺省 `DEFAULT_JS_TIMEOUT_MS = 2000`）双闸——`vm.runInContext` 的 timeout 杀同步死循环，外层 `Promise.race` 硬超时约束异步总时长（timer 已 unref）。
- **脚本形态**：`scriptForm:true`（`@js` 与 searchUrl 形态的缺省）＝代码作为脚本执行、**最后一个表达式的值即结果**；顶层 `return`/`await` 触发 SyntaxError 时回落 async IIFE 函数体形态。返回值映射：string→Value、array→List（元素 `String()`）、`null`/`undefined`/`''`→Miss、对象→JSON.stringify 的 Value。
- **`host.result`**：上一段结果的序列化，**首段 → 整页原文**（`pageText()` = `html ?? String(json)`，JSON-only 页不再拿到空串）；nodes 口径是 outerHTML（`engineValueToString(v,'outer')`），与 `java.getString` 的 innerHTML 口径由参数显式区分。上游是 List 时，js 串结果按 `\n` 拆回 List（`evaluate.ts` 的 `prev?.kind === 'list'` 分支）。
- **`java.ajax` 与 unhandledRejection**：`java.ajax` 走 `ctx.fetch`（服务半注入 `engineFetch`：源 header 打底 + `assembleRequest` 选项语义 + 解码）。脚本常 fire-and-forget，其 rejection 在 ajax settle 之后才悬空触发，Node 20+ 默认当致命错误直接干掉进程 → 三层防线：① 引导层 ajax 包装挂空 catch（受 `DSH_NOVEL_NO_GUARD=1` 开关控制，便于排障）；② 协议表实现只管发起并如实失败；③ `ensureUnhandledGuard()` 进程级常驻 `unhandledRejection` 监听（插件 dispose 时摘）。
- **宿主垫片**：`java.get/put`、`getString/getStringList/getElements/getElement`（经 `evaluateRef` 递归求值，基内容 `contentBase ?? result`）、`setContent`、`timeFormat/UTC`、`base64*/md5Encode*/encodeURI/hexDecodeToString`、`cookie` get/set/remove（按源隔离的最小仿真，不做真实 CookieJar——那是无头浏览器的活）、`source.getVariable/setVariable/get/put`（同一变量表）、`source.header`/`source.key`/`source.getKey()`/字符串拼接语义、`java.log ≡ console.log`。`cookie` 与源变量按 `SourceSession` 隔离：生产缺省 `processSession`（跨调用存活），测试注入 `createSourceSession()`（跨源污染用例才写得出来）。
- **`jsLib`**：源级全局函数库，**先于**用户代码在同一 vm 上下文执行（函数定义落全局）；它本身不是求值目标，抛错如实上报（jsLib 坏了整源 js 都不可信）。
- **已知不可解**（源码注释已声明）：`await null; while(true){}` 这类「异步续体里的同步死循环」在 `runInContext` 返回后才跑，两道超时都拦不住 → 宿主事件循环饿死。v1 明确接受为限制（沙箱的安全义务——不可逃逸——已满足；同步死循环仍被拦），未上 worker_thread。

**改沙箱时的纪律**：加宿主能力只改 `JAVA_PROTOCOL` 一行（含实现），`SANDBOX_MOUNTS`（挂载清单）、`invokeJavaMethod`（分派）与 `JavaBridge`（类型面）全部派生——不存在第二份手写名字清单，`tests/engine/js-protocol.test.ts` 用「方法名唯一」与「表 ↔ 挂载清单完备」两条钉死这条派生关系。给不了 Android 的能力**只许报「需要安卓宿主环境」**，不许静默 no-op 或返回假数据。

## JSONPath 口径

自实现子集（禁 npm 依赖）：`$`、`.name`、`..name`（递归下降，按文档序收集）、`[n]`（下标，**负数从尾数**）、`[a:b]`（半开切片，负数从尾数）、`[*]`/`[]`（同义）、`.*`（属性通配：对象取全部值、数组取全部元素）、`.[*]` 冗余点。解析到 `null`/`undefined` 的分支直接丢弃。数据源：`ctx.json` 优先；缺席且 `ctx.html` 是合法 JSON 时回退解析（legado `isJSON` 口径——搜索链路只传 html 不传 json，不回退则所有 `$.` 规则对 JSON API 源恒 Miss）。

**明确拒绝并抛错**：过滤器 `[?(…)]`、脚本表达式 `[(…)]`、`@`/`&` 特殊符号、路径不以 `$` 开头、递归下降缺属性名、方括号未闭合、下标内容不合法——错误都带路径原文与段定位。

**为什么自实现**：`$.data.*` 属性通配、`.[*]` 冗余点、负数从尾数这些 legado 真实源形态不在任何小库的子集里，而完整 JSONPath 库会带进过滤器/脚本这些我们**明确不想支持**的语义——自实现才能把「不支持的语法」变成带定位的抛错而不是静默错值。

**元素字符串化钉死**：字符串原样；number/boolean → `String()`；对象/数组 → `JSON.stringify`（所以 `$.info.Datas` 的 List 元素是 JSON 文本，服务层再按面去 parse）。

## 测试钉子

| 测试文件 | 钉死的口径 |
| --- | --- |
| `tests/engine/reduce.test.ts` | 取值规约单点：`reducePicked` 四态、选择段/取值段同口径、取值段 `!` 排除生效、「取到空」仍是空 List |
| `tests/engine/select.test.ts` | default 段选择/取值、位置与切片、`text`(后代) vs `ownText`(直系) vs `textAll` vs `textNodes`、块级换行、属性缺失→空 List |
| `tests/engine/css.test.ts` | `@css` 段在当前节点集内 find、`!` 排除、非法选择器 → `RuleEvalError`(hits=0) |
| `tests/engine/parse.test.ts` | 切分次序、位置后缀、`!` 识别、大小写不敏感前缀、隐式 CSS 全形态、未知段/裸词解析期抛错、`<js>` 块可非末位、`@js:` 吞链尾 |
| `tests/engine/grammar.test.ts` | `parseTails`/`appendTail` round-trip 自校验与全部越界 warning、`withImplicitText` 不动 JS 区域、`isJsForm`/`splitVarExpr`/`isPureVarExpr` 词法 |
| `tests/engine/combine.test.ts` | `||` 短路与空 List 继续、`&&` 合并/跳空/多分支 matches 抛错、`%%` 交叉驱动、反序四种值 |
| `tests/engine/replace.test.ts` | 净化循环替换、OnlyOne 剥 `g`、`$1` 原生语义、替换为空保留条目、非法正则段级定位 |
| `tests/engine/jsonpath.test.ts` | 负下标/负切片从尾数、切片裁空→Miss、空数组→空 List、集合型末段恒 List、属性通配、拒绝过滤器/`@`/`&` |
| `tests/engine/allinone.test.ts` | 二维 `matches` 不压平、零匹配→空 List（非 Miss）、无捕获组单元素行、零长度匹配不死循环 |
| `tests/engine/xpath.test.ts` | 谓词按父分组、`//text()` vs `/text()`、末段 `@attr`、`preceding-sibling` **逆文档序**编号、白名单外轴/函数抛错 |
| `tests/engine/variables.test.ts` | `@put` pairs 手写解析、值引号强制、JSONPath 值路由与 Miss/List 裁决、失败不半截写入 |
| `tests/engine/js-sandbox.test.ts` | 逃逸防御（代码生成禁、宿主 realm 不可达、引导入口锁死）、双超时、日志收集、垫片全清单、`jsLib` 先执行且抛错点名 |
| `tests/engine/js-protocol.test.ts` | 协议表方法名唯一、表↔`SANDBOX_MOUNTS` 完备、分派无 switch |
| `tests/engine/evaluate-sync-loop.test.ts` | `java.getString*` 真实环路（evaluate → evalJs → evaluateRef → 同步 runner）、子规则含 js 段抛错 |
| `tests/engine/trace.test.ts` | trace 每段一行、错误段定位（`/段1/`）、独立净化基值（html 原文 / `String(ctx.json)`）、JSON-only 页首段 `@js` 的 result、`evaluate(ParsedRule)` 直通不重 parse、`ctx.json` 缺席回退解析 html |
| `tests/engine/template.test.ts` / `types.test.ts` / `js-utils.test.ts` / `run-script.test.ts` / `source-session.test.ts` | `{{}}` 插值（含 `encodeURIComponent`）、错误三元定位、`EngineValue → 串` 五分支口径、`runScript` 完成值语义、会话按源隔离 |
| `tests/services/error-taxonomy.test.ts` | 引擎三类错误（`UnsupportedRuleError`/`RuleEvalError`/`JsSandboxError`）与抓取两类按 `e.name` 投影成 wire 错误码——错误类**改名即改 wire 码** |
| `tests/services/normalize.test.ts` | 三方言展平映射、Native 隐式 `@text`、`appendTail` 越界进 warning |
| `tests/services/search-face.test.ts` / `request.test.ts` / `probe.test.ts` | 搜索面编排、请求组装、探针实测结论——引擎公开面的下游契约 |
| `tests/compat/replay.test.ts` + `compat/fixtures/demo-site/` | 合成书源在 `@js`/JSONPath/XPath 等形态上的离线全链路回放（分母是 fixture，**不是站点兼容率**） |
| `tests/packaging-*.test.ts` | 引擎构建产物（`lib/`）能按真实安装链路挂载——引擎改动要能过 `pnpm build` |

## 已知开口

**历史里已被推翻的结论（别按它们改回去）**

本仓早期开发过程文档（逐任务计划 / 审查报告 / 任务简报）已出库，且**不再保留副本**。下面这些结论曾写在那些文档里，**与现在的代码相反**——若从旧笔记、旧会话或别处翻到，照抄即回归：

| 早期文档里的旧结论 | 现在的代码 |
| --- | --- |
| `&&`/`%%`「任一分支 Miss → 整体 Miss」 | 空/Miss 分支静默跳过、只合并非空结果（legado 并集语义；`combine.ts` 注释「此前实现为『任一 Miss → 整体 Miss』」记着这是曾发布的 bug） |
| `text` = 严格直系文本 | `text` = 全部后代文本（`select.ts` 的 `case 'text'` 注释「实测打不动真实源」记着旧实现为何被推翻——正文整本读不出）；直系文本是 `ownText` |
| JSONPath 不接受负号 | 下标与切片都支持负数从尾数（`jsonpath.ts` 的 `/^-?\d+$/` 与 `/^(-?\d+)?:(-?\d+)?$/` 两条解析分支） |
| `<js>…</js>` 只能作为分支末段 | 可出现在任意位置、块后无 `@` 直接续段（`grammar.ts` 的 `jsRegionEnd`、`parse.ts` 的 `splitElements` 内 `<js>` 分支，注释「块起始即隐式段界」） |
| `evaluate(rule: ParsedRule, ctx): EngineValue`（同步、只收 AST） | `async evaluate(rule: string \| ParsedRule, ctx, facet='rule')`（`evaluate.ts` 的 `evaluate`）；`parseRule` 不在公开面 |
| AllInOne 零匹配 → `List{rows:[]}` | `List{items:[]}`（`allinone.ts` 的 `evalAllInOne` 尾返回） |
| facet 表没有 `rule` | `Facet` 含 `rule`（缺省面）与无生产调用方的 `explore`（`types.ts`） |
| `preceding-sibling` 按文档序编号 | 已按逆文档序修正（`xpath.ts` 的 `axisPool` `case 'bwd'`：`sibs.slice(0, i).reverse()`，测试改判 `[1]`=最近前序） |
| XPath 只认 `@XPath:` 前缀 | 裸 `//`/`.//`/`/` 前导同样识别（`parse.ts` 的 `raw.startsWith('//')` 分支）；`init` 段仍未实现——真源驱动，无实现即抛错 |

**代码内仍开口的**

10. `engine/types.ts` 的 `Facet` 含 `'explore'`，全仓无生产者/消费者（`normalize.ts` 的 `field: 'ruleExplore'` warning）。`engine/combine.ts` 的 `combine`/`combineAnd`/`combineZip` 三处 `loc` 参数都复制了 facet 字面量联合而不是引 `Facet`——加面时四处要改。
11. `engine/template.ts` 的 `name in vars` 走原型链：`{{toString}}` 会命中继承成员并回报函数源码。正确写法是 `Object.hasOwn`。
12. `engine/evaluate.ts` 的 `evalNonJs` 里 `case 'allinone'` 与 `case 'getvar'` 不校验链位（只有 `jsonpath`/`allinone` 经 `evaluate.ts` 的 `checkChainStart` 判「必须是分支首位」），但 `allinone` 实际靠 parse 的「整链以 `:` 开头」保证唯一性；`@get:name` 允许出现在链中段并替换链值（`evaluate.ts` 的 `case 'getvar'`）。
13. `engine/js-protocol.ts` 的 `BridgeDeps.contentBase` 是可变捕获状态：`java.setContent` 写它（`js-protocol.ts` 的 `method('setContent')`：`d.contentBase = …`）、`java.getString*` 读它（`js-protocol.ts` 的 `d.contentBase ?? d.result`）——同一次求值内多次 `setContent` 会互相影响（legado 同款，但未写进任何文档）。
14. 两项**需要拍板的未决口径**（`AuthRequiredError` 声明未落地、探针「分段 trace」无结构化字段）属服务层与 wire 面——不在本文重复，见 `docs/design/services.md` 的「已知开口」。引擎侧相关事实只有一条：`TraceStep` 目前只被 `evaluateWithTrace` 的生产者内部消费，没有第二个消费者。
15. `tests/reprobe.test.ts` 是「改动引擎/抓取后实测书源可用率」的唯一自动化验证，默认跳过（`DSH_REPROBE=1` 才跑）；`pnpm test` 全绿不构成真实站点兼容性证据。
16. 引擎的无回归门禁是「`tests/engine/**` 全绿 + `pnpm typecheck` 干净」两条；`vitest.config.ts` 把 `tests/compat/**` 与 `packaging-build.test.ts` 排除在常规集外（分别由 `pnpm test:compat` / `pnpm test:pack` 驱动）。改引擎后若只跑常规集，`compat` 回放与构建产物两条链是**没被验证**的。
17. `src/engine/` 19 个文件里只有 `index.ts` 有对外承诺；`parse.ts` 的 `KNOWN_MODES`、`HTML_TAGS` 与 `xpath.ts` 的白名单都是**手写清单**——扩方言时它们不会因为别处改动而自动跟随，测试是唯一守卫。

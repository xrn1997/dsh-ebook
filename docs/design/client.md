# 浏览器半（client）

本文是浏览器半的现状真相（single source）；领域词汇见 `CONTEXT.md`（阅读会话、bookKey、启停、书源注册表、wire 契约……一律用那里的词）。面向下一个改前端的人或 AI：只讲口径与理由，不讲操作步骤（操作步骤见 `README.md`）。

## 模块地图

入口与装载面：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/client/index.tsx` | 浏览器半插件入口：注册「小说」视图与宿主设置区块 | `inject = ['slots','sessions']`、`apply` |
| `src/client/styles.tsx` | 唯一 token 层 + 组件类（`<style data-novel-style>` 注入） | `NOVEL_CSS`、`NovelStyles` |

视图环（每个文件只做渲染与接线，含 `deps` 缺省）：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `views/NovelView.tsx` | 根：按 `routeStore` 分发三分支（reader / search / 兜底 shelf） | `NovelView` |
| `views/ShelfView.tsx` | 首页：居中搜索框 + 封面网格 + TXT 导入 + 删除确认 | `ShelfView` |
| `views/SearchView.tsx` | 搜索：分批进度 + 逐源分组（失败源折叠）+ 命中行双动作 | `SearchView` |
| `views/ReaderView.tsx` | 阅读器：渲染会话状态 + 实现 `ReaderPort` + 事件喂给会话 | `ReaderView`、`PrefsPanel`、`CTRL_Z` |
| `views/SettingsSection.tsx` | 设置区块壳：手风琴 + 任务轮询单实例 + 试跑下钻 | `SettingsSection`、`ProbePane` |
| `views/SettingsSourceList.tsx` | 源列表现场：chips 过滤、两态、行内开关、选中动作条、危险区、登录面板 | `SourceList`、`ProbeRunCard` |
| `views/SettingsImportPane.tsx` | 导入现场：拖放主入口 + 粘贴小道 + 三态汇总 | `ImportPane`、`ImportRunCard` |
| `views/SettingsStatusBar.tsx` | 全局状态条（瞬态层的呈现端） | `GlobalStatusBar` |
| `views/bits.tsx` | 共用小组件 | `StatusBadge`、`ErrorBanner`、`EmptyState`、`ProgressBar`、`RunCard`、`jobPct`、`coverFallbackChar` |
| `views/types.ts` | 再导出桶（wire 值形状）——**别在这里加第二份声明** | 全部为 type re-export |

逻辑（无 React、无 IO，可直接单测）：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `reader-session.ts` | 阅读会话：时序编排持有者 + `ReaderPort` 定义 | `ReaderSession`、`ReaderSessionDeps`、`ReaderPort` |
| `api.ts` | `/novel-api` 同源 fetch：信封解析单点 | `apiGet`、`apiSend`、`apiUpload`、`ApiClientError` |
| `deps.ts` | 三束依赖 seam（core / settings / reader） | `ClientCoreDeps`、`SettingsDeps`、`ReaderDeps`、`prodCoreDeps`、`prodDeps`、`prodReaderDeps` |
| `store.ts` | 轻量 store + 视图内路由 + 阅读偏好 | `createStore`、`useStore`、`routeStore`、`navigate`、`prefsStore`、`setPref` |
| `progress.ts` | 进度数学（锚点 ↔ 章 + 比例） | `locateChapter`、`anchorTop` |
| `reader-load.ts` | 懒加载决策（哨兵口径 + 前向流水） | `nextChapterIndex`、`nextLoadTarget` |
| `scrollport.ts` | 真实滚动容器探测（宿主 resident scrollport 适配层） | `isScrollport`、`findScrollport`、`portScrollTop` 等 |
| `search-batch.ts` | 分批搜索 + 并发池 + 增量回调 + 失败隔离 | `runBatchedSearch` |
| `source-list.ts` | 源过滤纯函数 + 列表现场 store | `filterSources`、`filterByStatus`、`filterByGroup`、`groupIcon`、`sourceListUi` |
| `source-list-view.ts` | 列表派生 view-model（纯函数） | `deriveSourceListView` |
| `source-batch.ts` | 批量确认强度 + 按状态收 id | `batchConfirmKind`、`collectIdsByStatus` |
| `jobs.ts` | 后台任务面：提交 + 轮询 hook | `startImportJob`、`startBatchProbeJob`、`useJobStatus`、`getLastImportJob` |
| `transient.ts` | 全局瞬态层（pending / ok / error） | `pushError`、`pushOk`、`pushPending`、`useTransient`、`useTransientFlag` |
| `toggle-feedback.ts` | 单源启停的反馈策略 + 行锚点 | `toggleFeedback`、`rowAnchorOf`、`ToggleFeedback` |
| `export-run.ts` | 整本导出时序（start / cancel / dispose） | `createExportRun`、`IDLE_EXPORT` |
| `download.ts` | 流式导出（字节进度）+ Blob 落盘 | `streamExport`、`saveBlob` |
| `importer.ts` | 粘贴预检 + cookie 串解析 | `validateSourceJson`、`parseCookieString` |
| `sections.ts` | 手风琴折叠态（localStorage）+ 意图守卫 | `loadSections`、`saveSections`、`toggleSection`、`applyRouteIntent` |
| `shelf-delete.ts` | 删除确认文案（本地书连删文件点名） | `deleteBookCopy` |
| `prefs-ui.ts` | 阅读偏好常量 | `FONT_STEPS`、`LINE_HEIGHTS`、`PAPER_PRESETS` |
| `util.ts` | 中立小工具 | `debounce`、`ls`、`paperInk` |

## 装载面

- 视图：`slots.inject('conversation.view')` + `slots.register({ id:'novel', order:20, label:'小说' })`（slot-only 路线）。**不**走老 spec 的 `uiConversation.views.register`——独立应用 view 不需要它，壳层对未注册 target 宽容。
- 设置区块：`slots.inject('settings.section')` + `slots.register({ id:'novel', order:100 })`；书源管理整体迁入宿主设置页。宿主设置是**另一棵 React 树**，拿不到 `NovelView` 的根节点，因此 `NovelStyles` 与 `data-novel-scope`（token 锚点）必须两处各渲染一次。
- 视图内路由（`routeStore`，无 URL 路由）：`shelf | reader | search` 三成员，`reader` 带 `sourceId/bookKey/title`，`search` 可带 `keyword`。「小说」tab 打开即首页，tab 栏已退役。

## 阅读会话：时序唯一持有者

「目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘」的编排全部住 `reader-session.ts`；视图只做三件事：渲染会话状态、把 DOM 测量实现成 `ReaderPort`、把 scroll/resize 事件喂进会话。

- **为什么**：`progress` / `reader-load` / `scrollport` 三个纯函数模块只是把复杂度挪走——真 bug（在途被占、两帧未落定、切章强制存 vs 防抖存、陈旧闭包）原住在视图的 ref 协调里，无 seam 可测。会话持有状态与策略后，这些时序第一次能被单测驱动（`tests/client/reader-session.test.ts`）。
- **被否决**：把时序留在视图 + 只抽纯函数。历史上视图里五个「防陈旧闭包」ref 就是这条路线的产物。
- **DOM 测量经 `ReaderPort` 注入**：`measureAnchors / scrollTop / setScrollTop / viewHeight / scrollHeight / sentinelOffset / chapterOffset`。视图实现它（两套坐标系只在这一个对象里换算），测试给可编程假 port。会话不碰 DOM ⇒ 无需 jsdom 即可测时序。
- **单在途槽**（`inflight`）：滚动风暴/同章并发只发一次请求；在途期间的目录直达只置 `pendingJump`，在途释放后由 `settlePendingLoad()` 补拉（否则该次点击无声消失、`pendingJump` 永挂）。刚失败过的同一章不自动重试——等用户点「重试」。
- **恢复定位**：存档章 + `offsetRatio` → 双帧（`afterFrames`，视图 = rAF 双帧）后按 `anchorTop` 落滚动位。两帧是必需的：首帧只保证 DOM 在，第二帧才保证布局落定、锚点可测。
- **进度落盘**：切章**强制存**（不等防抖），同章滚动**2s 防抖存**（窗口属会话构造参数，测试收紧）。两者不同是因为「读到哪一章」是用户可感知的导航事件，「读到章内哪儿」是连续量。
- **错误**：加载成功即清 `error`；`retry()` 分叉——章失败重拉该章（`failedIndex`），进入/目录失败则重开。视图的 `onRetry` 必须接 `session.retry()`，**不能**接导出态复位（那对会话错误是空操作，红条会永久粘屏）。
- **`totalChapters` 幂等回写**：只在书在架且缺该字段时补一次，走 `shelfBody.patch` 只发一个字段。
- 书架拉不到不阻断进入（`catch` 后从头读）。

## 持久化与状态归属

- **业务数据不进 store**：书架、源列表、目录、正文每次挂载经 `/novel-api` 拉取，组件内 `useState` 持有。`store.ts` 只承担三类**跨卸载要活下来**的现场：视图内路由（`routeStore`）、阅读偏好（`prefsStore`）、以及各 module 自建的现场 store（`sourceListUi`、transient 队列）。**为什么**：复制一份服务端数据到本地 store 就会产生第二真相与一致性维护成本；而「工作现场」（642 源的过滤/勾选、字号、错误条目）卸载即清零才是不可接受的。
- 阅读偏好持久化在 localStorage（键 `dsh-novel.prefs`），**进度不进 prefs**——进度归服务端书架（`ShelfBook.progress`），这样换浏览器/换机器仍从同一处读。手风琴折叠态另有 `dsh-novel.sections`。
- localStorage 读写统一走 `util.ls`（无 DOM / 坏 JSON 退内存 Map，不炸）：`renderToString`、SSR 与测试环境都得活。
- **SSR 快照**：三处 `useSyncExternalStore`（`store.ts`、`ReaderView` 读会话、`transient.useTransientFlag`）都传了第三参 `getServerSnapshot`——缺了 `renderToString` 直接抛；`useTransientFlag` 的 SSR 快照是 `false`（无标记）。

## 属性与可访问性

视觉之外的口径（改这些选择器/属性会打掉测试或宿主钩子）：

- 数据属性是**钩子**不是装饰：`data-novel-view="shelf|search|reader"`（样式层 `:has` 判在场性）、`data-novel-root`（收 composer 用）、`data-novel-scope`（token 层锚点，设置区块必需）、`data-novel-sentinel`（预取边界）、`data-chapter=<i>`（章块）、`data-novel-source-row=<id>`（错误锚点，与 `rowAnchorOf` 同源）、`data-novel-job-status`（状态条任务泳道）、`data-novel-run-card` / `data-novel-source-list`（状态条跳转目标）、`data-novel-dropzone` / `data-novel-source-filter` / `data-novel-group-filter` / `data-novel-chip=<key>` / `data-novel-edit-toggle`。
- 语义属性：chips `aria-pressed`、开关 `role="switch"` + `aria-checked`、区块头 `aria-expanded`、进度条 `role="progressbar"` + `aria-valuenow`（只写在 `bits.ProgressBar` 一份里）、删除按钮带 `aria-label`。
- 颜色一律读 `--novel-*` 局部 token（视觉规则里不散写宿主 token，也不写死品牌 hex）；只有 token 定义处与「正文层」色值允许字面量。

## 控制器层与正文层

- **正文层永不接宿主 token**：纸张色由 prefs 固定，字色由 `paperInk(paper)` 按感知亮度（WCAG 线性化 + Rec.709，阈值 0.35）择深/浅二值。**为什么**：皮肤 token 是半透明玻璃值，压在自选纸张色上没有对比；写死深色字在自选深纸上等于隐形。**被否决**：正文层跟随主题（`--novel-*` 参考的是宿主层板，不是纸张）。
- **深浅主题靠引用宿主语义 token**（`--dsw-alias-*`），光/暗由宿主 `body[data-ds-dark-theme]` 覆盖，本层不做深浅判断。踩过的坑：`--dsw-alias-border-l` 是不存在的假名（宿主只有 `l1..l4`），引用它不报错、只静默落回硬编码 fallback。
- `darkController` 是用户显式选择，因此 `.novel-dark` 允许字面量钉暗底值，且必须重钉 `--novel-layer-1` 与四个 brand 派生色（自定义属性在声明处算完即继承，换 brand 不会回填上层派生值）。`novel-dark` 挂**工具栏根**而不只挂 Aa 面板——否则是「暗面板 + 亮工具栏」。
- **Aa 面板 z 序不变量**（`CTRL_Z = { toolbar: 12, mask: 10, panel: 11 }`）：sticky 工具栏自建 stacking context，面板的 z-index 只在工具栏内部有效；工具栏 ≤ 遮罩时，透明遮罩反压整层，点击被吞 = 「Aa 能弹出但点不了」。
- 正文承载在宿主 resident scrollport 上（阅读器自己的容器 `clientHeight == scrollHeight`，永不滚）：工具栏 sticky 要求祖先链无其他滚动容器，故 `.novel-root/.novel-main:has([data-novel-view="reader"])` 放开 overflow；滚动事件在 `document` 的 capture 阶段收（scroll 不冒泡但捕获经过 document），rAF 合帧。
- 样式层还用 `:has` 做两件事：小说 view 在场时收掉宿主常驻 composer 的**默认层**（只藏 `[data-chain-overlay-fallback]` 那一层——整座 `display:none` 会吞掉提问/审批等兄弟接管件）与配套的列宽拖拽把手（兄弟选择器 `~`，不误伤对话视图）。

## 书架 + 进度

- 网格：`repeat(auto-fill, minmax(96px,1fr))`，封面 2:3 + `loading="lazy"`；无封面或 `onError` → 书名首字色块（`coverFallbackChar`，空标题回退「书」）。
- 进度条只在 `totalChapters > 0` 时渲染，比例 = `(chapterIndex + offsetRatio) / totalChapters` clamp 到 1。
- 删除：卡片 ✕ → 确认条 → `DELETE shelf/:key`；**成功才本地过滤**，失败保留卡片并显示错误（乐观删除的回滚半场归接线测试钉死）。本地书确认文案点名「同时删除磁盘上的 txt 与元数据文件」——可见后果要在点确认前说清。
- 加载失败不伪装成空架：`setBooks([])` + `loadError` 双写，空态文案按有无错误分叉。
- 本地 TXT 导入：隐藏 file input → `POST local/import?name=<文件名>`（octet-stream）→ 服务端返回 `{ bookKey, title, sourceId }` → 直接进阅读器。文件名只作 query 参数，正文以字节流上行；本地书的源身份与解析全归服务端。
- 本地书在书架上有专属呈现：封面位直接写「本地」而不是取首字（源身份固定，与在线书区分），删除确认文案另点名磁盘文件连删。

## 搜索：分批、进度、失败折叠

- 参与集归服务端：先 `GET search/plan` 拿本次真实参搜源 ids（启停 invariant 单一定义在服务端），客户端不再自拉源表重推导。
- 分批：`batchSize = 20`（批内服务端 5 并行）、`concurrency = 3`（对目标站点保持克制）。逐批增量回调 → 命中的源边搜边出，进度按**源数**计（不是批数）。
- 单批网络失败 → 合成一个错误组如实上报，其余批次不受影响（整体 reject 会让用户盯着 spinner 到天荒地老）。
- `runId` 闸：新一轮搜索作废旧一轮的迟到批次，三道出口（onProgress / catch / finally）逐处校验，防止旧回包污染新结果。
- 渲染：有命中的源成组列出（源名 + status + 本数），失败源折叠进 `<details>`（点名 code / message / statusDetail）。
- `plan` 返回 0 源 → 显式空态「没有参与搜索的书源」，与「搜了没命中」区分开（否则只剩一条 0% 进度条）。
- 命中行两个动作：点行 = 先加架（进度保存依赖书架条目）再进阅读器；「＋加书架」`stopPropagation` 只加架。`hit.url` 为空时该行只展示标题。
- 从首页带关键词跳进来时，`route.keyword` 作为初始 state 并在首个 effect 里自动搜一次（只认挂载时那一次，不订阅后到的路由变化）。

## 设置页源管理的 IA

- **表格是末位元素**（chips → 过滤框 → 选中动作条 → 运行卡 → 确认条 → 验证入口 → 危险区 → 表格 +「显示更多」）。**为什么**：源一多（642 + 多次「显示更多」）表格撑高后，沉在表格之下的所有操作都摸不着——「危险操作下沉到底部」在长列表下等于失踪。
- 手风琴两区持久化（localStorage `dsh-novel.sections`）；默认策略：有源 → 列表展开/导入收起，零源 → 两区展开（引导去导入）。坏 JSON / 无 DOM 回退默认不炸。`applyRouteIntent` 保留为「深链意图赢过默认策略」的守卫（当前生产调用恒传 `undefined`）。
- 列表现场（query / statusFilter / groupFilter / selection / editMode）是**模块级 store**：试跑下钻返回、设置区重开都不丢现场。
- 派生计算全归 `deriveSourceListView`（纯函数），视图只接线。钉死的语义决策：分组下拉的选项集按**全库**聚合计数，**不随状态/文本过滤缩水**（否则选了「坏源」后其他分组就从下拉里消失，组合过滤无法成立）；chip 计数也是全库分布；`'disabled'` 维度是 `enabled` 布尔而非 status（停用与坏源正交）。
- 过滤管线：状态 → 分组 → 文本，三者取交集；前端分页 `PAGE_SIZE = 100`，「显示更多」只加 limit。
- 两态：浏览态**不渲染**复选框与行操作（不是隐藏）；编辑态由表头「编辑/完成」显式进入，表头复选框 = 全选**当前过滤结果**（不止当前渲染页）。行级删除已取消——删除只有「删除所选」一个入口。
- 危险区默认收起；`> 20` 条要求手输「删除」二字，带登录态的源点名「删除后 cookie 失效」；作用对象 ids 在**点击时快照**，不随列表变化重算。
- 分组列只显示图标（hover 出全名，无符号组回退全名，不造图标）；表头「?」图例由 `groupLegend` 生成；「未分组」是哨兵值伪选项，计数 0 时不渲染。
- 行内启停开关常驻右对齐、两态都渲染（启停是高频决策，不进编辑态）；停用行由单元格内联 opacity + 名称去粗体表达。**停用 ≠ 删除**：停用只表示不参与聚合搜索，探针/试跑不受影响。
- 「验证全部未验证」是导入后的常用路径，常驻按钮；其余场景走「chip 过滤 + 编辑态全选 + 验证所选」。
- 任务反馈分层：状态条 = 可见性兜底（`running` 才出现、点击跳转对应区块并展开），运行卡 = 细节面板且**kind 分家**（导入卡在导入区、验证卡在源列表区）。`useJobStatus` 只在 `SettingsSection` 顶层实例化一次，job 经 props 下发，避免双轮询；任务收尾按 `job.id` 记账一次 reload，不重复拉。
- 导入区：文件为主入口（拖放/多选，读原文后一次性提交，MB 级文本零进出 React）；粘贴降级为折叠小道（仅小体量/调试，>200KB 提示改用文件）；导入后「去验证 N 个未验证源」把导入与验证串成一条路。

## 开关的乐观更新与回滚

- 行：点击即翻转本地 `optimistic`；在途用 `savingN` 计数装饰（降透明 + `cursor:wait` + title「保存中…」）；失败即刻 `setOptimistic(null)` 回滚，成功与失败都调 `onChanged()` 让服务端结果二次校准。**为什么**：642 行列表的全量 reload 有一拍延迟，没有乐观反馈用户会以为「点不动」。
- 反馈策略（`toggle-feedback.ts`）：**秒级乐观操作不进瞬态泳道**——`inFlight()` 故意留空，成功也静默（开关翻转本身即反馈）；只有失败进 error 泳道并挂行锚点。**为什么**：状态条原先是流内元素，挂上就把下面整块顶下去 35px、settle 弹回，单源启停往返只 13~20ms ⇒ 用户看到「一帧下沉回弹」= 闪烁（真机逐帧量过）。配套第二半修复：状态条改成 absolute 浮层 + 宿主 relative 锚点，泳道来去不再参与布局。
- 行锚点（`rowAnchorOf(id)` = `[data-novel-source-row="<id>"]`）是错误条目「定位 →」跳转与行内 `.row-err` 红边共用的同一个选择器：行内从内容层降为装饰层，文案全部归条。
- 行内 `.row-err` 的显隐走 `useTransientFlag`（原始值快照）——642 行逐条订阅，快照翻转才唤醒对应行，全量重渲染不可接受。

## 瞬态层

一个模块级有序队列（`transient.ts`），三种生命周期：`pending`（settle 即移除、多条聚合计数）、`ok`（少而淡，TTL 2.5s 自动退场；只有显式保存类进条）、`error`（sticky，手动 dismiss，携带 anchor）。**范围**：这是通用层；书架/搜索的散落错误（`loadError`/`delError`/`importError`/`searchError`）服务于场景内重试，尚未接入。

## API 客户端与错误呈现

- `api.ts` 是信封解析单点：`{ok:true,value}` → value；`{ok:false,error}` → 抛 `ApiClientError`（带 `code` / `status` / 可选 `segment`）；非 JSON 或网络层 → `ApiClientError('NetworkError', …)`。`apiUpload` 走 octet-stream（本地 TXT），响应仍走信封。
- query 构造不在此处：参数名与序列化归 `shared/wire.ts` 的 `queries` / `encodeQuery`（此前四处各拼一份，改名无处编译报错）。
- 段级定位呈现：`ErrorBanner` 在有 `segment` 时渲染「`facet`#段`segmentIndex`」徽标 + `code: message` 红字 + 「重试」。规则求值失败因此能指到出错的段，而不是只说「解析失败」。
- 进度不做整体 reject：搜索的分批失败合成错误组，状态条/运行卡用同一 `jobPct` 与同一 `ProgressBar` 元素。

## 三束依赖注入（seam）

`ClientCoreDeps`（`apiGet/apiSend/apiUpload/pushError`）→ `SettingsDeps`（+ 任务面 + `pushOk`）→ `ReaderDeps`（+ 导出流）。ShelfView / SearchView 吃核心束，ReaderView 吃阅读束，SettingsSection 吃设置束并向下透传；生产缺省 `prod*Deps` 让接线零变化。

**为什么**：视图此前硬 import 真实现（「自造依赖」），历史上真正的 bug——乐观态不回滚、陈旧回调、误导性空态、探针失败假死——全住在接线层且无法被测试驱动。现在 interface 即测试面，`tests/client/views-wiring.test.tsx` 等用假 adapter 驱动**真实组件**。

## 跨半契约的消费面

- 客户端只依赖 `src/shared/wire.ts` 的**路由名与值形状**；`views/types.ts` 只是再导出桶，加字段/改形状去 wire 改，别在客户端加第二份。
- 常量也归 wire：`LOCAL_SOURCE_ID`（本地书保留源 id），客户端不再手抄 `'__local__'`。
- `SHELF_META` + `pickShelfMeta` 是书目 7 字段「名称 × 类型判别 × 归一化」的唯一主人：`shelfBody.addBook` 与 `shelfBody.patch` 都从 pick 派生 ⇒ 加一个书目字段只改这张表。
- 写侧三形态（全在 `shelfBody`）：带 `title` = **加书**；带 `progress` = **更新进度**（不在架 400）；带 `patch` = 对在架书打补丁（缺席键保值 ⇒ ReaderView 回写 `totalChapters` 只发一个字段）。`progress` 服务端校验 `chapterIndex` 非负整数、`offsetRatio ∈ [0,1]`。
- 「加书」与「进阅读器」是两段：点行直接阅读时先 PUT 加书（失败 `catch` 掉）再 `navigate`，因为进度落盘依赖书架条目。
- bookKey 是 URL 或 `local:<uuid>`，进路径前必须 `encodeURIComponent`（归 `paramRoutes.shelfKey`）。

## 热更新与装载

- 产物：`lib/client.js` 是 CJS 单文件闭包工厂（`window.__ModuleLoader__.load({ id:'@xrn1997/dsh-novel', factory })`），平台模块表内的 specifier（react / react-dom / `@deepseek-ai/dsh-client-*`）留给注入的 `require`，其余全 inline。构建期纯度门拦 Node 内建与平台表外的 `@deepseek-ai/*` **值** import ⇒ `shared/wire.ts` 必须零运行时依赖（它会被整个 inline 进 client bundle）。
- 热更新链路：`dsh-client-hmr` 每 500ms `stat` 一遍各插件 client bundle，按 **mtime + size** 判变 → `clientModuleHost.rebuilt(id)` → `/plugins/events` SSE 推 `rebuilt` 帧 → 浏览器半的 HMR 接收器重载。
- **生效条件**：`lib/client.js` 这个文件本身要变（即需 `pnpm dev` / `tsdown --watch` 或手动 `pnpm build`）；Node 半（其余 `src/`）不在热重载链路内，改完要重启 `dsh web`。样式住 bundle 内的 `<style>`，随 bundle 整体替换。

## 测试钉子（`tests/client/`）

| 测试 | 钉死什么 |
|---|---|
| `reader-session.test.ts` | 时序全集：无存档/有存档恢复+双帧定位、`totalChapters` 幂等回写、目录失败进 error、单在途槽去重、切章强制存 vs 同章防抖存、哨兵预取与读尽不动、目录直达（未载先拉 / 未渲染不清 `pendingJump` / 在途挡下后补拉）、成功清 error 与两种 retry |
| `views-wiring.test.tsx` | ProbePane 失败不再假死；书架加载失败不伪装空架、删除失败保留卡片；搜索 `runId` 防陈旧回调、0 源显式空态；设置整壳注入（子组件不吃 prodDeps）、加载失败显式化、「去验证」失败上报；ReaderView 取数/导出走注入 deps、导出错误带 code |
| `settings-toggle.test.tsx` | 开关点即翻转、失败即刻回滚 + error 挂行锚点、**在途不进泳道**（零条目、无 progressbar）；「未分组」伪选项出现/计数 0 不渲染 |
| `toggle-feedback.test.ts` | 反馈策略：`inFlight` 零条目、成功静默、失败带锚点、连点不累积；`rowAnchorOf` 与行 data 属性同源 |
| `transient.test.ts` | pending 结算幂等/转错误、ok TTL 退场、error sticky、聚合计数；状态条四条渲染分支 + 空闲零占用 + 浮层类名 |
| `search-batch.test.ts` | 分批切分与进度按源数、逐批增量回调、单批失败合成错误组不整体 reject、空集零请求 |
| `reader-load.test.ts` | 前向流水（跳章后不回头补洞）、单在途、哨兵严格小于 `(1+2) 屏`、滚过头仍加载 |
| `scrollport.test.ts` | 「谁在滚」判据（可滚 + 内容超出）、向上落到宿主 scrollport、无容器 → null |
| `progress.ts` / `logic.test.ts` | `locateChapter`/`anchorTop` 往返与边界、debounce、store 语义、api 信封与 `NetworkError`、`streamExport` 单调字节进度 |
| `paper-ink.test.ts` | 纸张色 → 字色的阈值行为（含 3 位 hex、非 hex 回退、L=0.35 分水岭） |
| `reader-ctrl-z.test.ts` | 工具栏 stacking context 压过遮罩，且组件真的用这套常量 |
| `source-list-view.test.ts` | chip 计数口径（全库）、分组选项集不缩水、过滤管线交集、分页、全选作用域、`authCountOf`、快捷批量 id 集 |
| `source-list-batch.test.tsx` | 选中动作条三写口的载荷与半场（成功 refresh / 失败上报不 refresh / 在途禁重复提交）、删除确认两种强度与登录态点名、危险区快照 ids |
| `smoke.test.tsx` | SSR 可渲染三分支、空态与「不渲染」类断言、表格末位顺序、样式层随视图注入、宿主 composer/把手的收口选择器、未载章不进 DOM |
| `theme-tokens.test.ts` | 词表守卫（`--dsw-*` 必须是宿主真名，含「假 token 不存在」的自证）+ hex 字面量守卫（视图内联品牌 hex 即红，白名单只放 token 定义处与正文层色值） |
| `jobs-poll.test.tsx` | 挂载即拉、refresh 重拉、取数失败保留旧值但置 `stale`、1s 节拍与卸载停轮询（假时钟） |
| `import-pane.test.tsx` / `importer.test.ts` | 文件/粘贴两条提交路径与失败上报、预检（对象方言不误杀、一好一坏不连坐）、cookie 串解析、过滤/分组纯函数、列表 store 语义 |
| `export-run.test.ts` | 导出三态：进度投影、错误类目投影（不伪造 code）、取消/卸载 abort 静默、在途重入忽略 |
| `sections.test.ts` / `shelf-delete.test.ts` / `run-card.test.tsx` | 折叠态默认策略与坏数据回退、意图守卫、删除文案、运行卡插槽与条件行 |

## 已知开口

1. **登录脚本（`runLogin`）在 UI 上不可达**。服务端已实现两形态：`POST sources/:id/auth { runLogin:true }` 会返回 `{ mode:'manual', loginUrl }`（URL 形态，不注入 WebView）或沙箱执行 JS 形态的 `loginUrl`（空产出 → 422 `LoginFailed`，不写登录态）；但 `views/SettingsSourceList.tsx` 的 `SourceAuthPane` 里那个「去登录」按钮（`window.open(source.baseUrl, '_blank')`）既没走 `runLogin` 取真正的 `loginUrl`，也没有触发 JS 形态。`README.md` 已宣称「cookie 录入与 `loginUrl` 脚本执行」。
2. **`hit.url` 是空串时会用空 bookKey 加书**：`views/SearchView.tsx` 里 `HitRow` 的守卫 `hit.url === undefined || hit.url === null` 只挡 `undefined` / `null`（这两者渲染成不可点行），**空串 `''` 会走进可点分支**——`HitRow.add()` 与 `HitRow.read()` 都用 `hit.url ?? ''` 当 bookKey，于是发出 `PUT /novel-api/shelf/`（空路径段）并带着空 bookKey 跳阅读路由。修法二选一：守卫改成 falsy 判断，或在 wire 层保证 `url` 用 `null` 而不是空串。
3. **hex 守卫可绕过**：`tests/client/theme-tokens.test.ts` 的 `scanHex` 里那条 `text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)` 只认 hex 写法，`rgba(...)` / `color-mix(...)` / 颜色名不会被抓。当前实测：`src/client` 源码有 11 处 `color-mix`（其中 4 处在 `views/`）、3 处 `rgba()`（全在 `styles.tsx` 的 token 定义层，即白名单允许的住址）。这些内联值引用的是 `--novel-*` token（换 brand 会跟随），故与历史 bug 不同，属口径宽松。
4. **百分比到整数有三处算式**：`views/bits.tsx` 的 `jobPct` 不 clamp，`views/SearchView.tsx` 的 `SearchView` 里内联了一份 `Math.min(100, Math.round((progress.done / progress.total) * 100))` 的；`views/ShelfView.tsx` 的 `ShelfView` 里还有第三处 `Math.min(1, (b.progress.chapterIndex + b.progress.offsetRatio) / b.totalChapters)` 从 0..1 比例算。行为无可见差异，但同一语义三处算式。
5. **状态条「点此查看 →」在试跑子视图里是 no-op**：`views/SettingsSection.tsx` 的 `jumpToJob` 只改手风琴 state + `querySelector` 滚动；试跑页里 `[data-novel-run-card]` / `[data-novel-source-list]` 都不存在（返回列表后展开才生效）。
6. **`pushPending` 当前无生产消费者**：`transient.ts` 的 `pushPending` 保留为通用层能力（`toggle-feedback.ts` 的 `toggleFeedback.inFlight()` 故意留空），「正在保存 N 项…」聚合泳道无生产者；直测在 `transient.test.ts`。
7. **`applyRouteIntent` 的生产实参恒为 `undefined`**：`views/SettingsSection.tsx` 唯一的调用点 `applyRouteIntent(loadSections(…)` 里，第二个实参写死 `undefined`（等价恒等函数），只有测试喂 `'import'`。保留为深链意图防回归守卫。
8. **早期设计与计划文档里的这几条已被代码推翻**（那些文档已出库、不再保留副本；照抄即回归）：
   - 旧文档记视图环注册走 `ctx.uiConversation.views.register({ target:'novel' })`；代码是 `slots.inject('conversation.view')` + `slots.register({ id:'novel' })`（`src/client/index.tsx` 的 `apply`）。
   - 旧文档记 `--dsw-alias-border-l` 是宿主真 token 并在测试里断言它在位；该 token **不存在**（宿主别名层是 `l1..l4`），代码已改用 `--dsw-alias-border-l2/l4/l1`。守卫在 `tests/client/theme-tokens.test.ts`：一条用例断言 client 源码引用的每个 `--dsw-*` 都在宿主词表内，另一条反向断言假 token 不在词表内（`HOST_TOKENS.has('--dsw-alias-border-l') === false`；`border-l` / `bg-layer-4` 是两个踩过的坑）。
   - 旧文档记正文懒加载用 `IntersectionObserver` 触发；代码用「未载边界哨兵相对视口 top + 2 屏余量」的纯函数判据（`scrollport.ts` 测过：阅读器自己的容器 `clientHeight == scrollHeight`，靠容器 scrollTop/scrollHeight 的两个方向都失效）。
   - 旧文档（信息架构 v2 之前的视图树）记有「书籍详情」视图与 `detail` 路由、以及 `sources` 全局路由深链；代码已删除 `DetailView`，`Route` 只有 `shelf | reader | search` 三成员，源管理整体迁入宿主设置页。
   - 旧文档记搜索失败源组「组头显示源状态徽标」；代码的失败折叠区只点名 `code` 与 `message`（`views/SearchView.tsx` 的 `renderGroups` 里失败源的 `<details>` 块），有命中的组头显示的是 `status` 文字 + 本数。

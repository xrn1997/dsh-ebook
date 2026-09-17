# DSH out-of-tree 插件 API 调研

- 日期：2026-09-14
- 证据来源（均为本机已安装产物，路径可复核）：
  - 官方样例插件：`C:\Users\57224\.dsh\profiles\web\node_modules\{dsh-context,dsh-better-sidebar,dsh-better-archive}\`
  - Host checkout（dsh CLI + 全部官方运行时包）：`C:\Users\57224\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`
  - 官方包类型定义：`…\@deepseek-ai\dsh\node_modules\@deepseek-ai\{dsh-host-webserver,dsh-tools,dsh-client-ui-conversation,dsh-client-ui-chat,dsh-client-ui-trajectory,dsh-client-modules}\lib\types\**\*.d.ts`
  - CLI 插件管理源码：`…\@deepseek-ai\dsh\lib\plugin-Ddi42qoW.js`
  - 上游 tsdown/tsconfig 配置（GitHub raw，作为构建形态的补充证据）：
    - https://raw.githubusercontent.com/bowenliang123/dsh-context/main/tsdown.config.ts
    - https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/tsdown.config.ts
    - https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/tsconfig.json
- 本机版本快照：host checkout `@deepseek-ai/dsh` 0.1.5-rc.1；profile 里官方包 devDependency 多为 0.1.5-rc.2（样例插件编译期）。API 以 0.1.5-rc 系为准。

---

## 1. 插件包形态（package.json / cordis.patch.yml / 安装链路）

### 结论

一个 out-of-tree 插件是一个普通 npm 包，双面（Node 半 + 浏览器半）同包。必需/关键字段：

| 字段 | 作用 | 必需性 |
|---|---|---|
| `main: "lib/index.js"` | Node 半入口（Cordis 插件） | 必需 |
| `types` | Node 半类型（可选但推荐） | 推荐 |
| `exports["."]` | 同 main；`exports["./client"]` 指向浏览器半 bundle | 客户端面必需 |
| `dsh.client.platform: "web"` | 宣告浏览器半；非 `"web"` 的包被 client-modules 扫描忽略 | 客户端面必需 |
| `dsh.client.inject: string[]` | 浏览器半启动前需就绪的其他 client 包（信息性依赖边，参与 boot graph 排序） | 推荐 |
| `dsh.client.external: string[]`（可选）、`dsh.client.immediately: boolean`（可选） | 额外的模块表请求 / 立即加载 | 可选 |
| `dsh.bundle.patch: "./cordis.patch.yml"` | 指向随包发布的挂载层；`dsh plugin add` 靠它识别「这是一个 profile layer」 | 自动挂载必需 |
| `files` | 必须包含 `lib/**`、`cordis.patch.yml` | 发布必需 |
| `peerDependencies` | `@deepseek-ai/cordis` 等官方包 + react/react-dom | 必需（见 §2） |

**注意：规范里猜测的顶层 `dsh.bundle.patch` / `dsh.client` 平铺写法实际是嵌套对象 `dsh: { bundle: { patch }, client: { … } }`。**

### 证据 1a：dsh-context 的 package.json（`…\profiles\web\node_modules\dsh-context\package.json`）

```json
"type": "module",
"main": "lib/index.js",
"types": "lib/index.d.ts",
"exports": {
  ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
  "./client": "./lib/client.js",
  "./package.json": "./package.json"
},
"files": ["lib/client.js", "lib/index.js", "lib/index.d.ts", "cordis.patch.yml", "README.md", "LICENSE"],
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-sidebar-right"
    ],
    "platform": "web"
  },
  "compatibility": { "dshReleases": { "0.1.5-rc.1": "compatible", ... } }
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.2",
  "@deepseek-ai/dsh-client-ui-primitives": ">=0.1.2-rc.1",
  "@deepseek-ai/dsh-session": ">=0.1.2-rc.1",
  "@deepseek-ai/dsh-settings": ">=0.1.2-rc.1",
  "@deepseek-ai/schemastery": "^3.18.2",
  "react": "^18.3.1"
},
"peerDependenciesMeta": { "@deepseek-ai/dsh-client-ui-primitives": { "optional": true }, "react": { "optional": true } }
```

dsh-better-archive 的最小形态（`…\dsh-better-archive\package.json`）更精简：`main`/`exports`/`dsh.bundle.patch`/`dsh.client{inject,platform}`，peer 只有 `@deepseek-ai/dsh-client-locale` + `@deepseek-ai/cordis`。

### 证据 1b：cordis.patch.yml 真实格式

dsh-context（`…\dsh-context\cordis.patch.yml`）——顶层是 YAML **数组**，每项是 loader patch 条目，bundle patch 就是一条 `insert`：

```yaml
- insert:
    - id: dsh-context
      name: dsh-context
```

dsh-better-sidebar（`…\dsh-better-sidebar\cordis.patch.yml`）——insert 行可带 `config:`（传给 apply 的配置，经插件导出的 Config schema 校验/填默认值），还可用 `!!js` 表达式做条件禁用（防双挂载）：

```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)"
```

profile 根的 cordis.patch.yml（`…\profiles\web\cordis.patch.yml`）同样是「顶层 YAML 数组」，注释写明：`The tree is composed as patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays`。

profile 清单（`…\profiles\web\package.json`）：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-context", "dsh-better-sidebar", ...], "patchReload": "live" } }
```

### 证据 1c：`dsh plugin --profile web add <pkg>` 的行为

源码 `…\@deepseek-ai\dsh\lib\plugin-Ddi42qoW.js`（模块注释）：

> `dsh plugin --profile <name> <args...>` — profile plugin management as a thin pnpm forwarder: initialize the profile on first use, run `pnpm <args...>` in the profile directory, then reconcile the `dsh.profile.bundles` layer list against the installed state (a dependency resolving to a package that declares `dsh.bundle` joins the layer stack; a removed or bundle-less dependency leaves it).

要点：

- 它就是 **pnpm 转发器**：在 profile 目录跑 `pnpm add …`；相对路径 spec（`.`、`../plugin`、`file:`/`link:` 形式）会按调用者 cwd 锚定绝对化（`anchorPathSpec`，防 `add .` 把 profile 自链接）。
- 装完后 `reconcilePlugins`：逐个检查已安装依赖是否 `dsh.bundle.patch !== undefined`（`exportsPatch`），是则把**真实包名**追加进 `dsh.profile.bundles`；无 `dsh.bundle` 声明的包只警告「installed as a plain dependency」。
- 卸载（`remove`）后同一 reconcile 把它从 bundles 移除。
- 生效时机：下次 profile boot 合并 patch（`patchReload: "live"` 时可热重载）。
- git 托管插件 install 时 prepare 脚本需 pnpm allowBuilds 放行（错误信息有提示）。

### 对 dsh-novel 的直接含义

- package.json 照抄 dsh-context 骨架：`main: lib/index.js`、`exports["./client"]: ./lib/client.js`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client: { inject: [...], platform: "web" }`。
- `cordis.patch.yml` 两行：`- insert: [{ id: dsh-novel, name: dsh-novel }]`（name 必须等于 package.json `name`，client-modules 以包名作为 bundle id 组图）。
- 安装验证命令就是 `dsh plugin --profile web add <本地路径>`（绝对化后 pnpm link 式安装），一次到位，无手工编辑。

---

## 2. Node 半入口（Cordis 插件）

### 结论

Node 半是一个 ESM 模块，导出三件套：`name`（可选标识）、`inject`（字符串数组，挂载前必须就绪的服务名）、`apply(ctx, config)`。`ctx` 是 `@deepseek-ai/cordis` 的 `Context`；服务通过 `ctx.webServer`、`ctx.tools`、`ctx.sessions` 等属性访问（Cordis 服务注入模型）。配置由插件**导出的 Config schema**（zod 或 schemastery）校验——cordis loader 拿 `export Config` 校验 patch 行的 `config:` 并填默认值。

### 证据 2a：dsh-context 编译产物类型（`…\dsh-context\lib\index.d.ts:726-730`）

```ts
//#region src/host/index.d.ts
export declare const name = "dsh-context";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
```

其 Config 是 zod schema（同文件 26-33 行：`export declare const Config: z.ZodPreprocess<…>`，注释：「The cordis `Config` validator: strict on keys, defaults on the schema fields; tolerates `undefined` (a patch row without a `config:` block — defaults win)」）。`Context` 来自 `import { Context } from "@deepseek-ai/cordis"`。

### 证据 2b：dsh-better-sidebar 源码（`…\dsh-better-sidebar\src\index.ts:79-83, 722`）

```ts
/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-better-sidebar'
/** Services required before mounting: the webserver routes, the session store, the web runtime's trusted hosts, and the tool registry. */
export const inject = ['webServer', 'sessions', 'webRuntime', 'tools']
…
export function apply(ctx: Context, config?: SidebarConfig): void { … }
```

其 Config 用 schemastery（`src\config.ts:8`：`import z from 'schemastery'`；`SidebarConfig` 全字段可选，`resolveSidebarConfig` 为绕过 loader 的直调方填默认值）。

可选服务用 `ctx.inject(['settings'], (sctx) => {…})` 惰性挂接（`src\index.ts:801`）；`ctx.effect(() => disposer, label)` 管理生命周期；`ctx.get('sessionPersistence')` 做非侵入读取（`src\index.ts:132`）。

### 证据 2c：类型冲突的规避（`…\dsh-better-sidebar\src\context-types.ts:1-14`）

官方包已经对 `@deepseek-ai/cordis` 做 declare module 增强，且同一服务名在 host/client 两侧类型不同（`sessions: SessionStore` vs `ISessions`）；better-sidebar 的做法是「vendored cordis Context + 结构镜像接口求交集」而非 module augmentation，避免 TS2717。**直接含义**：dsh-novel 若单包双半共用类型，采用同样策略（或干脆 host/client 类型分开，client 只 import type）。

### 证据 2d：peerDependencies 惯例

三个样例全部把 `@deepseek-ai/cordis`、用到的 `@deepseek-ai/dsh-*` 服务包、`react`/`react-dom` 放 peerDependencies；npm 侧普通依赖（`ws`、`clsx`、`mermaid` 等）放 dependencies。**直接含义**：dsh-novel peer 至少声明 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-primitives`、`react`、`react-dom`；`cheerio`/`iconv-lite` 放 dependencies。

---

## 3. HTTP 路由（`ctx.webServer`）

### 结论

`@deepseek-ai/dsh-host-webserver` 提供 `ctx.webServer.register(route)`：

```ts
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
    kind: WebRouteKind;                    // 'exact' 精确匹配 pathname；'prefix' 匹配 p 和 p/<anything>
    path: string;                          // 绝对路径，无尾斜杠
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;  // Node 原生 http 类型
}
register(route: WebRoute): () => void;     // 返回 disposer；重复 (kind, path) 直接 throw
```

- **req/res 就是 Node 原生 `http.IncomingMessage` / `ServerResponse`**，handler 拥有完整响应生命周期（可 SSE、可流式）。
- 读 query：`new URL(req.url ?? '/', 'http://dsh.internal').searchParams`；读 body：自己 `for await (const chunk of req)` 聚合后 `JSON.parse`（官方样例全部手写 bounded readJsonBody，无内建 body parser）。
- 返回 JSON：`res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body))`。
- 注册一律包在 `ctx.effect(() => ctx.webServer.register(…), label)` 里，卸载自动摘路由。

### 证据 3a：类型定义（`…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-webserver\lib\types\index.d.ts:30-46,85-97`）

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
…
/** Register a named route. Duplicate (kind, path) throws … @returns the disposer removing the route. */
register(route: WebRoute): () => void;
```

（同文件 `import type { IncomingMessage, ServerResponse } from 'node:http'`；`declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }`。）

### 证据 3b：prefix 路由真实用例（`…\dsh-better-sidebar\src\index.ts:884-913`）

```ts
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/sidebar/api',
  handler: async (req, res) => {
    if (!fence(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden', … } }); return }
    if (req.method !== 'POST') { writeJson(res, 405, …); return }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const method = pathname.startsWith('/sidebar/api/') ? pathname.slice('/sidebar/api/'.length) : undefined
    …
    const payload = await readJsonBody(req)      // for await (const chunk of req) 聚合，1MiB 上限
    writeOk(res, await handler(payload))          // { ok: true, value }
  },
}), 'dsh-better-sidebar: /sidebar/api routes')
```

`exact` 路由 + query 读法（同文件 921-954 行 `/sidebar/upload`）：`kind: 'exact'`，`url.searchParams.get('sessionId')`。JSON/body 帮手在 `src\wire.ts`：`readJsonBody`（`for await` + 1MiB 上限）、`writeJson(res, status, body)`、`writeOk`（`{ok:true,value}` 200）、`writeError`（`SidebarError(code, message, status)` → `{ok:false,error:{code,message}}`）。

### 证据 3c：最小版 exact 路由（`…\dsh-better-archive\lib\index.js:371-404`）

```js
function registerRoute(ctx, { path, method = 'POST', fields = [], run }) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== method) return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      …
      sendJson(res, 200, await run(params, body))
    },
  }), `better-archive: ${path} route`)
}
```

其信任检查是最简同源判定（55-63 行）：`new URL(req.headers.referer).host === req.headers.host`。better-sidebar 则用更严的 `webRuntime.trustedHosts` fence（`src\index.ts:736`，Host 头 loopback 或 `--trusted-host` 白名单）。

### 对 dsh-novel 的直接含义

- `/novel-api/*` 用 `kind: 'prefix', path: '/novel-api'` 一条路由 + 内部分发（或按子面拆多条 exact）。**前缀重复会 throw，整棵插件树 boot 失败——前缀命名是组合级契约**。
- query/body/JSON 全手写：拷 `wire.ts` 的 readJsonBody/writeJson 三件套即可；错误统一 `{code,message,segment?}` 信封映射到 HTTP 状态码。
- **必须加同源/信任 fence**（referer/host 判定即可起步），否则同机任意网页可 POST 你的路由。
- 注册裹 `ctx.effect`，工具注册同理（disposer 模式全插件通用）。

---

## 4. agent 工具注册（`defineTool` + `ctx.tools.register`）

### 结论

从 `@deepseek-ai/dsh-tools` import `defineTool`，`ctx.tools.register(tool)` 返回 disposer。工具定义（`DefineToolOptions<S, O>`）：

- `name: string`（唯一）、`description: string`（发给模型）
- `parameters: ParameterSchemaSpec`——**每属性一个值 schema spec**：`{ type: 'string'|'number'|'integer'|'boolean'|'null'|'array'|'object'|'json', required?: true, description?, enum?, … }`；根对象隐式开放，必填靠属性上 `required: true`（不是 JSON Schema 的 required 数组）
- `output: { schema: O（同一套值 schema DSL）, render(args, value): ContentBlock[], presentationMeta?(args, value) }`——**强制**声明规范输出 schema；`execute` 返回符合 schema 的纯 JSON 值，`render` 是纯文本投影
- `execute(args, exec: ToolRunContext): Promise<unknown>`——`args` 已校验冻结；`exec.agent`（调用 agent，可 undefined）、`exec.signal`（AbortSignal，spawn 前 `throwIfAborted()`）、`exec.deferContext()`/`exec.concludeTurn()`
- 可选 `timeoutMs`、`isConcurrencySafe`、`presentCall`/`presentResult`

### 证据 4a：类型（`…\dsh-tools\lib\types\schema.d.ts:177-193`；`…\dsh-tools\lib\types\index.d.ts:97-119,284-301`）

```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string;
    readonly description: string;
    readonly parameters: S;
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    readonly timeoutMs?: number;
    …
}
// ToolDefinition:
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
// ToolRunContext extends ToolExecution:
    readonly agent?: Agent;          // 调用方 agent（agent loop 设置）
    readonly signal: AbortSignal;    // 调用方取消
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
// Context augmentation:
    interface Context { tools: ToolRuntime }
    register(definition: ToolDefinition): () => void;   // ToolRuntime.register，index.d.ts:601
```

### 证据 4b：真实用例（`…\dsh-better-sidebar\src\tools.ts:15-16, 83-138`）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
…
const register = (tool: ReturnType<typeof defineTool>): void => { disposers.push(ctx.tools.register(tool)) }
register(defineTool({
  name: 'terminal_create',
  description: 'Open a persistent terminal in the sidebar and run a command in it. …',
  parameters: {
    title: { type: 'string', required: true, description: '…' },
    command: { type: 'string', required: true, description: '…' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      uuid: { type: 'string', required: true, description: '…' },
      title: { type: 'string', required: true, description: '…' } } },
    render: textRender((v: { uuid: string; title: string }) => `Opened terminal "${v.title}" (uuid: ${v.uuid}). …`),
  },
  execute: async (args: { title: string; command: string }, exec) => {
    exec.signal.throwIfAborted()
    const sessionId = requireAgent(exec.agent).session.id   // 绑定调用方 session，模型不传 sessionId
    …
    return { uuid, title: args.title }                       // 返回符合 output.schema 的纯 JSON
  },
}))
```

同文件注释总结了官方约定（引 plugin-development-guide.md §3）：C1 参数先校验后 execute；C4 execute 返回唯一规范 JSON，render 只做投影；C6 spawn 前 `exec.signal.throwIfAborted()`；C10 规范值不带 UI/传输词汇。`render` 返回 `ContentBlock[]`（`[{ type: 'text', text }]`，来自 `@deepseek-ai/dsh-llm`）。

### 对 dsh-novel 的直接含义

- 5 个工具全走 `defineTool`；**返回值是规范 JSON**（正文长就让它长，description 里说明），模型面文本由 `render` 投影。
- 工具内不要模型传 sessionId——用 `exec.agent.session.id`（better-sidebar 全部工具如此）；这正是「阅读状态进 session」的正确挂点。
- 注册函数返回 disposer：把 5 个工具的注册包一个 `registerTools(ctx, service)` 返回 `() => void`，apply 里 `ctx.effect(() => registerTools(…))`。
- 输出 schema 用同一套 spec DSL（`oneOf` 也支持，见 terminal_wait_for 的四分支输出）。

---

## 5. 对话视图环注册（浏览器半）

### 结论

设计规格里猜的 `ctx.uiConversation.views.register({ target: 'novel', … })` **部分正确但不完整**——对话区顶部 tab 的注册走的是 **slots 系统**，不是 uiConversation。完整拼图（第一方 Chat/Trajectory 的做法，两步都在浏览器半 client 入口里做）：

**第 1 步（tab + 组件挂载）**：`ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id, order, label, locale?, children?, store?, inject: (sessionId) => ({ hooks, …props }) }, ViewComponent))`。tab 列表就是 `slots.entries('conversation.view')` 各 entry 的 `{ id, label }` 投影；壳层 `renderSlot("conversation.view", { viewRequest, openView, completeViewRequest }, { only: active.id })` 渲染当前激活 tab 的组件。

**第 2 步（会话事件 → 快照投影，可选）**：如果 view 要消费会话事件流，注册 `ctx.uiConversation.events.register(nodeDefinition)`（事件→节点状态机）和 `ctx.uiConversation.views.register({ target, create: () => builder })`（per-session 增量快照 builder：`{ empty, replace({nodes, timeline}), apply({upserts, timeline}) }`）。数据经 `ctx.uiConversation.binding(sessionId).target(target)` 的 `ObservableSnapshot` 读取。**若 novel view 是独立应用（数据来自 /novel-api，不投影会话事件），第 2 步可整体跳过**——`activateTarget` 对未注册 target 宽容（见证据 5c）。

### 证据 5a：Trajectory 的两步注册（`…\dsh-client-ui-trajectory\lib\client.js:1522-1533, 8224-8251`）

```js
// 第 2 步：快照 builder
const trajectoryViewDefinition = { target: "trajectory", create: () => new TrajectorySnapshotBuilder() };
function registerTrajectoryConversationView(ctx) { ctx.uiConversation.views.register(trajectoryViewDefinition); }

// 第 1 步：tab + 组件
ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "trajectory",
    order: 10,
    locale: NS,
    label: () => t("view.trajectory"),
    children: { "conversation.trajectory.images": { kind: "single", scope: "session" } },
    inject: (sessionId) => {
        const session = ctx.sessions.binding(sessionId)?.session;
        const trajectory = ctx.uiConversation.binding(sessionId).target("trajectory");
        return { hooks: { duration }, loadOlder: async () => {…}, loadImage: …, setActualDuration: … };
    }
}, TrajectoryView));
```

Chat 同构（`…\dsh-client-ui-chat\lib\client.js:8288-8312`：`id: "chat", order: 0`）；Chat 另注册十几条 `ctx.uiConversation.events.register(…)` 事件定义（4630-6675 行）。

### 证据 5b：类型（`…\dsh-client-ui-conversation\lib\types\client\index.d.ts:28-35`；`…\conversation\assembly.d.ts:31-49`；`…\contract\conversation.d.ts:215-247`）

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        conversation: IConversation;             // send/cancel/loadOlder 等会话动作
        uiConversation: UiConversation;          // { events: ConversationEventRegistry, views: ConversationViewRegistry, binding(sessionId) }
    }
}
class UiConversation extends Service {
    readonly events: ConversationEventRegistry;
    readonly views: ConversationViewRegistry;    // views.register(def) → disposer
    binding(source): ConversationBinding;        // { snapshot, activate(target), target(target) }
}
interface ConversationViewDefinition<Node, Snapshot> {
    readonly target: string;
    create(): ConversationViewBuilder<Node, Snapshot>;   // { empty, replace({nodes,timeline}), apply({upserts,timeline}) }
    isActive?(snapshot: Snapshot): boolean;
}
```

组件 props：`ConvViewProps = PropsRuntime<'conversation.view'>`（`…\contract\slots.d.ts:290-297`，含 `viewRequest: ConversationViewRequest | null`、`openView: (view, focus) => void`、`completeViewRequest`）。

### 证据 5c：壳层如何消费 tab（`…\dsh-client-ui-conversation\lib\client.js:15085-15129, 16542-16557, 1731-1739`）

```js
// tab 列表 = conversation.view slot entries
for (const entry of slots.entries("conversation.view")) { tabs.push({ id: entry.options.id, label: resolveSlotLabel(entry.options.label) ?? entry.options.id }) }
// 选中时激活 target（未注册 views 定义的 target 也被容忍：view === undefined 直接返回）
activateView = (sessionId, preferred) => { const active = resolveActiveView(viewTabs(), preferred); if (active !== void 0) uiConversation.binding(sessionId).activate(active.id) }
// 渲染当前 tab 的组件
children: active !== void 0 && renderSlot("conversation.view", { viewRequest, openView, completeViewRequest }, { only: active.id })
```

`activateTarget(target)`（1731-1739 行）：`const view = this.views.get(target); … if (view === void 0) return published;`——**只注册 slot、不注册 views 定义完全合法**。

### 对 dsh-novel 的直接含义

- 「小说」tab = client 入口里 `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'novel', order: 20, label: () => '小说' }, NovelView))`。`label` 可以是函数（走 locale）也可以直接字符串。
- **不需要** `uiConversation.views.register` / `events.register`——novel view 是独立应用，从 `/novel-api` 拉数据；`activateTarget` 对无定义 target 宽容已被第一方代码证实。规范 §10 的「snapshot builder 空投影」开放问题可以关掉：走 slot-only 路线。
- 从 view 内部发起会话动作用 `ctx.conversation.send(text)`（`IConversation`，`…\service.d.ts:38`）——「阅读状态进 session」如需反向注入可用它或 agent 工具面。
- 全局阅读进度不随 session 切换：view 组件自持 store，slot 的 `inject: (sessionId) => …` 只在需要 session-scoped 数据时用。

---

## 6. 浏览器半入口（加载机制与可用模块）

### 结论

- 客户端 bundle（`lib/client.js`）是 **CJS closure-factory 单文件脚本**，首行 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {…} })`，尾部 `return module.exports; } });`。bundle 内所有 `require('…')` 由宿主冻结模块表解答。
- 运行时链路（`@deepseek-ai/dsh-client-modules`，host 侧服务 `clientModules`）：扫描 Loader 里所有声明 `dsh.client` 且 `platform === 'web'` 的包 → 读 `exports['./client']` 拿 bundle 路径（**声明了 dsh.client 但 exports 没有 './client' 直接 throw**）→ 组 `window.__DSH_BOOT__` 图（按 `dsh.client.inject` 拓扑排序）→ 在 webserver 注册 `kind:'prefix', path:'/plugins'` 路由供浏览器拉 bundle（immutable 缓存 + 12 位 hash 版本）→ index-inject 注入 boot 脚本。
- 浏览器半入口同样导出 `apply(ctx)`（+ 可选 `inject` 字符串数组），以浏览器 Cordis 插件身份运行；可用服务即客户端运行时提供的：`slots`、`sessions`、`locale`、`modules`、`connection`、`conversation`、`uiConversation`、`settings` 等。
- **可 import 的运行时值被「纯度门」限制**：模块表种子 = `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`（或 `cordis`）、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`（+ 本包 `dsh.client.external` 声明）。其余 `@deepseek-ai/*` 值 import 是**构建错误**（跨插件协作走 cordis 服务，type-only import 可自由用）；白名单内少数 wire 层（`dsh-session`/`dsh-llm`/`dsh-tools`/`dsh-brand`/`dsh-file-reference`/`util-workspace-path` 等）允许 inline。npm 依赖（clsx、marked、xterm…）一律 inline 进 bundle。

### 证据 6a：client-modules 扫描与校验（`…\dsh-client-modules\lib\index.js:139-166, 481-491, 649-655`）

```js
function parseDshClient(pkgName, value) {
    if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
    …
}
…
const decl = parseDshClient(packageName, dsh?.client);
if (decl === void 0 || decl.platform !== "web") { …return null }
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
…
webCtx.webServer.register({ kind: "prefix", path: "/plugins", handler: this.serveBundle })
ctx.on("webserver/index-inject", (table) => { table.push(...bootInjections(this.composed)) })
```

### 证据 6b：bundle 形态与模块表（`…\dsh-better-sidebar\lib\client.js:1-33`）

```js
window.__ModuleLoader__.load({
	id: "dsh-better-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		…
		let react = require("react");
		let react_dom_client = require("react-dom/client");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
```

（tsdown 配置确认 banner/intro/footer 三段式与 external 名单，见上游 tsdown.config.ts；注释明言 PLATFORM_MODULES「Mirrors packages/client/web/src/platform.ts in deepseek-harness: the shell seeds these specifiers into the frozen browser module table」。）

### 证据 6c：client 入口的 inject 与 apply（`…\dsh-better-sidebar\src\client\index.tsx:44, 57`）

```ts
export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection']
…
export function apply(ctx: Context): void {
  ctx.effect(() => { const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh); … return () => { offZh(); offEn() } }, 'dsh-better-sidebar: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: "settings.section", id: … }, Component))
```

### 对 dsh-novel 的直接含义

- client 入口 `src/client/index.tsx` 导出 `apply(ctx)`（本插件不碰 locale/connection 可只 inject `['slots','sessions']`）。
- React 组件直接 `import { … } from '@deepseek-ai/dsh-client-ui-primitives'`（模块表解答）；**不要**从任何第三方 dsh 插件包 import 运行时值——纯度门会拒绝，且这是设计红线。
- 自己的 npm 依赖（若有浏览器端用的）会被 inline，无需声明。
- tsdown 配置必须复刻三段式 banner/footer；照抄 dsh-context/tsdown.config.ts 是最稳路线（含 CSS 通道与 define 注入）。

---

## 7. 构建形态

### 结论

- **构建工具：tsdown**（rolldown 内核），三件套：
  1. host 半：`entry: { index: 'src/index.ts' }`，`format: ['esm']`，`platform: 'node'`，`target: 'es2024'`，`dts: true`（dsh-context）——产物 `lib/index.js`（+ `lib/index.d.ts`）。
  2. client 半：`entry: { client: 'src/client/index.tsx' }`，`format: 'cjs'`，`platform: 'browser'`，`dts: false`，`sourcemap: true`，banner/footer 包成 `__ModuleLoader__.load` 工厂，`codeSplitting: false`，`define` 注入 `process.env.NODE_ENV`/`import.meta.env`，external=PLATFORM_MODULES 其余全 inline——产物 `lib/client.js`。
  3. （可选）懒 chunk：`lib/client-<name>.js`，`globalThis.__dshChunks__[name] = (require) => {…}` 形态，经插件自己的 bundle 路由按需 fetch（better-sidebar 的 terminal/editor/mermaid/locale 四个 chunk）。
- 类型产物：dsh-context 用 tsdown `dts: true` 直出；better-sidebar 用 `tsc -p tsconfig.build.json` 出 `lib/types/**/*.d.ts`（types 字段指过去），再 tsdown。
- **tsconfig 基线**（better-sidebar，GitHub raw）：`target ES2023, module esnext, moduleResolution bundler, jsx react-jsx, strict, noUncheckedIndexedAccess, verbatimModuleSyntax, allowImportingTsExtensions, noEmit, types: ["node"]`。源码 import 一律写全扩展名（`./config.ts`）。
- 脚本惯例：`build: tsdown`（better-sidebar 为 `rm lib && tsc -p tsconfig.build.json && tsdown`）、`watch: tsdown --watch`、`typecheck: tsc --noEmit`、`test: vitest run`。

### 证据 7a：dsh-context package.json scripts

```json
"scripts": { "build": "tsdown", "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.tests.json", "test": "pnpm run typecheck && vitest run --coverage" },
"devDependencies": { "tsdown": "^0.23.0", "typescript": "^7.0.2", "vitest": "^4.1.11", … }
```

### 证据 7b：产物文件名（`…\dsh-context\` 目录清单）

```
lib\client.js   lib\index.d.ts   lib\index.js   cordis.patch.yml
```

better-sidebar 产物：`lib\index.js` + `lib\client.js` + `lib\client-{editor,mermaid,registry,terminal}.js` + `lib\types\**\*.d.ts`。

### 对 dsh-novel 的直接含义

- 规范定的「tsdown 构建，lib/index.js + client.js」与官方一致；tsdown 配置直接抄 dsh-context 的（它的 purity gate/PLATFORM_MODULES/define 注释就是官方 preset 的镜像）。
- `pnpm run build` 必须在 `dsh web` 启动前跑——client-modules 找不到 `lib/client.js` 会聚合报错「client bundle not found; run `pnpm run build` before launch」（`…\dsh-client-modules\lib\index.js:91-104`）。

---

## 8. 运行时注入：浏览器半如何知道 API base

### 结论

**不需要知道任何 base——同源根相对路径直接 fetch。** web GUI 与插件路由同属一个 webServer（同一 origin），浏览器半直接 `fetch('/novel-api/sources')` 即可。没有 API base 注入机制，也没有前缀发现 API：前缀是插件与自己 client 半之间的**代码级约定**（双方都写死 `/novel-api`）。CORS 不存在（同源）。宿主对你的 HTTP 面唯一做的是 client-modules 把 client bundle 挂在 `/plugins/*`；插件自己的路由挂在自己声明的前缀下。

### 证据 8a：better-sidebar client 直接 fetch 根相对路径（`…\dsh-better-sidebar\src\client\api.ts:1-7, 154`）

```ts
/** Typed fetch wrapper over the /sidebar JSON API. Every call posts to `/sidebar/api/<method>` … */
response = await fetch(`/sidebar/api/${method}`, { … })
```

### 证据 8b：better-archive client 同样（`…\dsh-better-archive\lib\client.js:373, 610`）

```js
return fetch('/archived/unarchive', { … })
return fetch('/archived/pending')
```

Node 半头注释（`…\dsh-better-archive\lib\index.js:30-32`）：「The browser half (lib/client.js) is discovered by client-modules through the `dsh.client` declaration in package.json and calls these routes with plain fetch (same origin as the web app).」

### 对 dsh-novel 的直接含义

- client 侧写一个 `api.ts`：`fetch('/novel-api/' + path, …)` + 统一错误信封解析，照抄 better-sidebar `src/client/api.ts` 的形态。
- 无需读取任何运行时配置；唯一约定是前缀字符串两边一致。若担心前缀冲突，`/novel-api` 已足够独特。

---

## 风险与不确定项

1. **版本漂移**：host checkout 是 0.1.5-rc.1，样例插件编译于 0.1.5-rc.2；`ui-slots`/`slots` 服务的包体未在本机两个 node_modules 中找到独立目录（`@deepseek-ai/dsh-client-ui-slots` 在 host `@deepseek-ai\` 清单中缺席，推断已被并入 web shell 平台基线、只以模块表种子存在——dsh-context tsdown.config 注释「Since dsh 0.1.2 the preloaded-client-externals channel is gone … dsh-client-store joined the platform baseline」支持该推断）。若 dsh-novel 的 client 要 `import { … } from '@deepseek-ai/dsh-client-ui-slots'` 的类型，需从 devDependency 装同版本包拿 d.ts。
2. **`conversation.view` slot 的确切 props 运行时形状**只从 d.ts（`PropsRuntime<'conversation.view'>`）与编译产物反推；`ConvViewProps` 的完整展开（hooks 注入面）没逐字段展开。实施时先写最小组件（忽略 props）验证 tab 出现，再按需取 `viewRequest`/`openView`。
3. **order 语义**：chat=0、trajectory=10，order 小者在前（推断）；novel 用 20 排最后。未在源码中找到 order 相同值时的次序保证。
4. **信任 fence**：样例插件全部自带同源/trustedHosts 检查，但没有官方统一 helper 包；dsh-novel 需自写（better-archive 的 referer/host 判定 6 行足够起步）。若 API 只服务自己的 client 半，这是必须项而非可选项。
5. **`dsh.bundle.patch` 与手工 cordis.patch.yml 双挂载**：better-sidebar 的 `disabled: !!js` 守卫表明「同一包被 aggregate bundle 与自身 bundle 双挂载 = 整树 boot 失败（duplicate prefix route）」。dsh-novel 单包单挂载无此风险，但如果将来进 aggregate 需加同款守卫。
6. **`webRuntime` 服务**（trustedHosts 提供者）类型面只从 better-sidebar 的结构镜像看到（`src\context-types.ts:100+`），未读其实现包；dsh-novel 若不用它的 fence 可不 inject 该服务。
7. **apply 的 config 校验**：loader 拿插件 `export Config` 校验 patch 行 `config:`；dsh-novel 用 zod（dsh-context 式）或 schemastery（better-sidebar 式）皆可，但必须真的导出——否则 loader 无 schema 可校（推断：未找到「无 Config 导出时行为」的直接证据，样例两族都导出了）。
8. **Windows 本地路径安装**：`dsh plugin add` 的 anchorPathSpec 处理了相对路径；本机尚未实测 `dsh plugin --profile web add C:\develop\GitHub\dsh-novel`（DoD 第一条），实施阶段首要验证。
9. **`patchReload: "live"`** 的热重载语义（web profile 现配）意味着改 cordis.patch.yml/插件版本后可能免重启，但 client bundle 变更仍需浏览器刷新 + 服务端 rebuild（DSH 自身 system prompt 亦提示 client 插件 HMR 的限制）。

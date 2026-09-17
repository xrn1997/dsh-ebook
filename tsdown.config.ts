import { builtinModules } from 'node:module'
import { defineConfig } from 'tsdown'

/** 官方平台模块表（tsdown-config-reference.md 存证：镜像 deepseek-harness packages/client/web/src/platform.ts；
 *  shell 把这些 specifier 种进冻结浏览器模块表，client bundle 一律留给注入的 require，不得 inline）。
 *  两份官方样例清单不一致（dsh-context 有 @deepseek-ai/cordis；better-sidebar 有裸 'cordis'）——取并集。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const isRequested = (s: string): boolean => PLATFORM_MODULES.includes(s)
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)])
const NODE_ENV = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    // host 半：ESM node，peerDeps 留 import（真实安装里在盘上），npm 依赖 inline，dts 直出
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      // 归属已由 neverBundle/alwaysBundle 全量表定，onlyBundle 关闭其白名单过滤并消掉构建期 hint
      onlyBundle: false,
      neverBundle: (s) => s.startsWith('@deepseek-ai/'),
      alwaysBundle: (s) => !s.startsWith('@deepseek-ai/'),
    },
  },
  {
    // client 半：CJS 单文件闭合工厂（三段式 banner/intro/footer——官方 ./client 导出契约）
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,                 // dts 会把 banner/footer 包进 .d.cts 弄坏解析（官方注释）
    sourcemap: true,
    clean: false,               // host 已 clean；两个配置同写 lib/
    deps: {
      onlyBundle: false,                      // 归属已由下面两个谓词全量表定；关闭白名单过滤，消掉构建期 hint
      neverBundle: isRequested,               // 模块表能答的 require 留 import
      alwaysBundle: (s) => !isRequested(s),   // 其余全 inline（npm 依赖）
    },
    define: {
      // 四键缺一，inline 的 node 习惯依赖在浏览器 boot 抛 ReferenceError（官方注释）
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
      // browser CJS 无模块加载器——杜绝 stray 引用解析到 Node loader（better-sidebar 同款加固）
      'import.meta.resolve': 'undefined',
    },
    // CJS 输出会让部分传递依赖解析到它们的 Node 入口——浏览器条件导出必须权威（better-sidebar 同款）
    inputOptions: {
      resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
    },
    // （better-sidebar 的 noExternal 双保险不需要——tsdown 0.23 的 deps.alwaysBundle 已是全量 inline 语义，
    //   noExternal 与之互斥，实测直接构建报错）
    plugins: [{
      // 构建期纯度门（官方同款机制）：@deepseek-ai/* 值 import 不在平台表 → 构建失败
      //（type-only import 已被擦除，到不了这道门）；Node builtin 闯进浏览器 bundle 同理必炸
      name: 'dsh-novel-bundle-purity',
      resolveId(source: string) {
        if (NODE_BUILTINS.has(source)) {
          throw new Error(`client bundle purity: Node 内建 "${source}" 不能进浏览器模块表——选依赖的 browser 导出或提供浏览器实现`)
        }
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        throw new Error(
          `client bundle purity: "${source}" 不在平台模块表——跨插件值 import 被禁；跨插件协作走 cordis 服务（type-only import 不受此门限制）`,
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // dsh.client 包 ./client 导出必须用的闭合工厂（官方三段式）
      // id 必须等于 package.json 的 name（scoped 包同款：@anionex/dsh-vision-toolkit 的 banner 即全名）
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@xrn1997/dsh-novel')}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])

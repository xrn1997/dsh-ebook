import type { ReactNode } from 'react'

/** 基础样式层：视图环各视图 + 宿主设置区块共用的 design token 与组件类（口径详见 `docs/design/client.md`）。
 *
 *  ── 配色契约（宿主 `@deepseek-ai/dsh-client-ui-theme` 的 alias 语义层）─────────────
 *  宿主把调色板与语义层都挂在 `body` / `body[data-ds-dark-theme]` 上（两套同名 token，
 *  暗态靠选择器特异性覆盖），所以本插件**只需引用语义 token**，光/暗自动跟随，不必自己
 *  判深浅、不该写死任何主题色。踩过的坑（本次修复的病根）：
 *    ① `--dsw-alias-border-l` 在宿主里**根本不存在**（宿主是 l1/l2/l3/l4 四级）——
 *       引用它 = 永远落到硬编码 fallback，边框在光/暗两态都不跟随宿主（暗态还偏浅）。
 *    ② `rgba(255,255,255,.0x)` 这类写死的白色叠层只在暗底成立，光态下 hover/表头/进度槽
 *       全部与底色无对比（实测对比度 ≈ 1.00，肉眼不可见）。
 *    ③ 状态色（可用/不可用）写死 `#3fb950/#f85149` = 钉死一套主题的观感。
 *  本文件因此把用到的 token 先收进 `.novel-root, [data-novel-scope]` 一层局部变量：
 *  视觉规则只读局部变量（读起来是自解释的语义名），token→宿主、fallback→暗底老观感。
 *  宿主设置区块渲染在**独立 React 树**（`SettingsSection`），拿不到 `NovelView` 的根节点，
 *  故自定义属性必须两个根都覆盖——「宿主设置是独立 React 树，样式到不了」这个坑见 ab2391d。
 *
 *  以 <style data-novel-style> 注入（renderToString 友好；HMR 重载随 bundle 整体替换）。 */
export const NOVEL_CSS = `
.novel-root, [data-novel-scope] {
  /* 层级：底(页面) → 层1(容器/工具栏) → 层2(面板/浮层/抽屉) → 层3(输入件)。宿主层板只到 layer-3。 */
  --novel-bg: var(--dsw-alias-bg-base, #1e1e1e);
  --novel-layer-1: var(--dsw-alias-bg-layer-1, #1e1e1e);
  --novel-layer-2: var(--dsw-alias-bg-layer-2, #242426);
  --novel-layer-3: var(--dsw-alias-bg-layer-3, #2b2b2e);
  /* 描边：容器 l2 / 输入件 l4 / 行内发丝 l1（宿主自己的描边也是 .5px 起步，别用 1px 实心灰） */
  --novel-border: var(--dsw-alias-border-l2, #ffffff1f);
  --novel-border-strong: var(--dsw-alias-border-l4, #fff3);
  --novel-border-faint: var(--dsw-alias-border-l1, #ffffff0f);
  /* 交互与文字 */
  --novel-hover: var(--dsw-alias-interactive-bg-hover, #ffffff14);
  --novel-active: var(--dsw-alias-interactive-bg-active, #ffffff24);
  --novel-text: var(--dsw-alias-label-primary, #f9fafb);
  --novel-text-2: var(--dsw-alias-label-secondary, #cfd3d6);
  --novel-text-3: var(--dsw-alias-label-tertiary, #adb2b8);
  --novel-fg: var(--dsw-alias-label-primary-foreground, #0f1115);
  --novel-brand: var(--dsw-alias-brand-primary, #2f6feb);
  --novel-primary-fill: var(--dsw-alias-button-primary-fill, #2f6feb);
  --novel-primary-hover: var(--dsw-alias-button-primary-hover, #3b7bf0);
  /* brand 派生色：视图此前内联 #2f6feb14/1f/44 与 #79a8ff——brand 一换色即全部失联。
     alpha 值按 --novel-brand 用 color-mix 派生（宿主换 brand / 主按钮换色自动跟随）；
     strong 走宿主「亮蓝语义文字」alias（无派生对应），fallback 即原内联色。 */
  --novel-brand-soft: color-mix(in srgb, var(--novel-brand) 8%, transparent);   /* 选中动作条底 */
  --novel-brand-tint: color-mix(in srgb, var(--novel-brand) 12%, transparent);  /* 选中 chip / 编辑态底 */
  --novel-brand-line: color-mix(in srgb, var(--novel-brand) 27%, transparent);  /* 运行卡 / 选中条描边 */
  --novel-brand-strong: var(--dsw-alias-label-primary-bluish, #79a8ff);         /* 亮蓝强调字 */
  --novel-skeleton: var(--dsw-alias-bg-skeleton, #ffffff14);
  /* 状态：成功/错误/警告 + 其弱底（错误底用宿主 interactive-*-danger 而非自调 alpha） */
  --novel-ok: var(--dsw-alias-state-success-primary, #3fb950);
  --novel-err: var(--dsw-alias-state-error-primary, #f85149);
  --novel-warn: var(--dsw-alias-state-warn-primary, #d29922);
  --novel-err-weak: var(--dsw-alias-interactive-bg-hover-danger, rgba(248,81,73,.08));
  /* 源状态三色（徽标内联用）：可用/不可用/未验证——未验证=次要文字色，不是自造灰 */
  --novel-status-verified: var(--dsw-alias-state-success-primary, #3fb950);
  --novel-status-broken: var(--dsw-alias-state-error-primary, #f85149);
  --novel-status-unverified: var(--dsw-alias-label-tertiary, #8b949e);
  /* 字面量（无宿主对应）：纯白字压在主按钮/错误徽标上 */
  --novel-on-solid: #fff;
  /* 焦点环：照宿主惯例用 label-secondary，避免与主色按钮糊在一起 */
  --novel-focus: var(--dsw-alias-label-secondary, #cfd3d6);
  color: var(--novel-text);
}
/* ── 布局与宿主壳收口（与配色无关，别在改主题时弄丢：commit e25ff8e / ab2391d）──────
   .novel-root 定高滚动；阅读器正文由宿主 resident scrollport 承载（会话视图区在 data-phase=active
   下内容撑高，阅读器自己的容器 clientHeight == scrollHeight 永不滚动——见 src/client/reader-load.ts
   头注）。工具栏要 sticky 就得让祖先链上没有别的滚动容器：这两层在本视图下放开 overflow。
   其余视图（书架/搜索）保持原样：内容撑高时它们照样由宿主滚，定高时仍自带滚动条。 */
.novel-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.novel-main { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.novel-root:has([data-novel-view="reader"]) { overflow: visible; }
.novel-main:has([data-novel-view="reader"]) { overflow-y: visible; }
/* 「小说」视图在场时收掉宿主常驻 composer（AI 输入框）：它是会话壳的固定座位
   （scrollBody > [data-composer-seat]，data-phase=active 下 sticky bottom），view 环切换不卸载它，
   所以切到小说 tab 后它仍贴在底部、还压在正文上。宿主没有「本视图不需要输入框」的钩子
   （轨迹视图用的是 data-conversation-composer-overlay 浮层），故由本样式层用 :has 判在场性：
   只有 data-novel-root 进了 DOM（= 小说 tab 被选中渲染）才命中，切回「对话」样式随之卸载、输入框即时恢复。
   只藏「默认 composer」那一层（chain 的 overlay fallback 包裹层）而不是整个 [data-composer-seat]——
   未选中接管时宿主给该层写的是 inline display:contents，故必须 !important；而 ui-approval /
   ui-user-questions / ui-subagent 的接管组件是它的**兄弟节点**，照样渲染：小说 tab 里 agent 提问与
   审批提示不会因为本规则被吞掉（整座 display:none 会吞掉，用户在等待中看不到提问 → 卡死）。
   宿主 DOM 钩子 [data-conversation-scroll]/[data-composer-seat]/[data-chain-overlay-fallback]
   与 src/client/scrollport.ts 的 [data-conversation-scroll] 同源。 */
[data-conversation-scroll]:has([data-novel-root]) [data-chain-overlay-fallback="conversation.composer"] { display: none !important; }
/* 配套控件：会话列宽拖拽把手。宿主在 .wSkVaW_body 里 [data-conversation-scroll] 之后渲染左右两条
   div[data-width-handle]（宿主自己的覆盖场景也是 hide 它：:has([data-conversation-composer-overlay]) → display:none）。
   它是 40px 透明 col-resize 条，hover 出竖光条，拖动写 --dsh-chat-user-width → --dsh-composer-card-max-width
   = 「调 AI 输入框宽度」；输入框收掉后它没对象可调，留着只剩一条会在正文上冒光标的假控件。
   用兄弟选择器而非后代：对话视图（chat）里的同名把手不受影响。 */
[data-conversation-scroll]:has([data-novel-root]) ~ [data-width-handle] { display: none; }
/* 「控制器层跟随深色」：勾上即把本层局部 token 钉成暗底值（正文纸张色不受影响）。
   宿主没有「强制暗层」的现成 token，故这一处允许字面量——它表达的是用户显式选择，不是主题推导。
   层-1（工具栏底）也在此重钉：工具栏挂的是 --novel-layer-1，不重钉就会「暗面板 + 亮工具栏」
   novel-dark 现挂在工具栏根，整个控制器层同底。 */
.novel-dark {
  --novel-layer-1: #1b1b1d;
  --novel-layer-2: #232325;
  --novel-border: #ffffff1f;
  --novel-border-strong: #fff3;
  --novel-hover: #ffffff14;
  --novel-active: #ffffff24;
  --novel-text: #f9fafb;
  --novel-text-2: #cfd3d6;
  --novel-text-3: #adb2b8;
  --novel-fg: #0f1115;
  --novel-brand: #f9fafb;
  --novel-primary-fill: #f9fafb;
  --novel-primary-hover: #e5e5e5;
  /* 派生色在此层必须重钉：自定义属性在声明处算完就继承下去，暗层换 --novel-brand 不会回填上层派生值 */
  --novel-brand-soft: color-mix(in srgb, #f9fafb 8%, transparent);
  --novel-brand-tint: color-mix(in srgb, #f9fafb 12%, transparent);
  --novel-brand-line: color-mix(in srgb, #f9fafb 27%, transparent);
  --novel-brand-strong: #f9fafb;
  --novel-skeleton: #ffffff14;
  color: var(--novel-text);
}
[data-novel] { font-size: 14px; }
.novel-view { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
/* ── 全局状态条＝浮层（真机逐帧实测）─────────────────────────
   病根：状态条原本是区块里的**普通流内**元素。一次启停就推一条泳道 → 挂上即把下面所有内容
   顶下去、settle 再弹回（实测区块头 y 116→151、源列表首行 y 361→396，整块 **+35px**，每次
   启停 2 条 layout-shift）。单源启停往返本机只有 13~20ms（≈1 帧），于是肉眼看到的是「一帧的
   下沉回弹」＝闪烁；服务端事件循环被占（LLM 流式/导入验证）时往返变长，就变成整块下移几百
   毫秒再弹回（节流 400ms 实测：泳道连续绘制 26 帧 ≈ 416ms）。
   修法：宿主容器 position:relative + 状态条 position:absolute —— 泳道来去不再参与布局，
   慢操作与错误条也不再顶动内容。代价：条目在场时它浮在区块头上方一小条（自带底/描边/投影
   以便与正文分离），条目仍可点（任务条=跳转、错误条=定位/忽略）。 */
.novel-status-host { position: relative; }
.novel-status-bar {
  position: absolute; top: 6px; left: 8px; right: 8px; z-index: 5;
  display: flex; flex-direction: column;
  background: var(--novel-layer-2); border: 1px solid var(--novel-border);
  border-radius: 8px; overflow: hidden;
  /* 投影无宿主 token（宿主浮层走 mask 层），这里只做浮层与正文的分离——暗态下不可见也无害 */
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
}
.novel-toolbar { display: flex; gap: 8px; align-items: center; }
.novel-btn {
  font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 6px;
  border: 1px solid var(--novel-border); cursor: pointer;
  background: transparent; color: inherit;
}
.novel-btn:hover { background: var(--novel-hover); }
.novel-btn:active { background: var(--novel-active); }
.novel-btn:disabled { opacity: .45; cursor: default; }
.novel-btn:focus-visible { outline: 2px solid var(--novel-focus); outline-offset: 1px; }
.novel-btn.primary {
  background: var(--novel-primary-fill); border-color: var(--novel-primary-fill);
  color: var(--novel-fg);
}
.novel-btn.primary:hover { background: var(--novel-primary-hover); }
.novel-btn.sm { font-size: 12px; padding: 1px 8px; }
.novel-input, .novel-textarea {
  font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px;
  border: 1px solid var(--novel-border-strong); color: inherit;
  background: var(--novel-layer-3);
}
.novel-input::placeholder, .novel-textarea::placeholder { color: var(--novel-text-3); }
.novel-textarea { width: 100%; font-family: ui-monospace, Consolas, monospace; }
.novel-panel { border: 1px solid var(--novel-border); border-radius: 8px; padding: 10px 12px; background: var(--novel-layer-2); }
.novel-muted { color: var(--novel-text-3); font-size: 12px; }
.novel-ok { color: var(--novel-ok); } .novel-err { color: var(--novel-err); } .novel-warn { color: var(--novel-warn); }
.novel-badge { font-size: 12px; white-space: nowrap; }
.novel-badge-pill {
  display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 12px;
  background: var(--novel-err); color: var(--novel-on-solid);
}
/* 分组徽丸（图标态）：分组列只显示图标（hover 出全名，无图标组回退全名，
   表头「?」有图例）；flex-wrap 兜底——极多组/病态长名折行不撑破列 */
.novel-grouppill {
  display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 1.7;
  background: var(--novel-skeleton); color: var(--novel-text-2); white-space: nowrap;
}
.novel-table { border: 1px solid var(--novel-border); border-radius: 8px; overflow: hidden; }
.novel-tr {
  display: grid; grid-template-columns: minmax(130px, 1.3fr) 68px minmax(0, 2fr) auto;
  gap: 8px; align-items: center; padding: 5px 12px; font-size: 13px;
  border-top: 1px solid var(--novel-border-faint);
}
.novel-tr:first-child { border-top: none; }
.novel-tr:hover { background: var(--novel-hover); }
.novel-tr.head { background: var(--novel-skeleton); font-size: 12px; color: var(--novel-text-2); }
/* 批量确认条等自绘底色的行：给宿主 token 留口（内联色仍可覆盖，但不再只能写死 rgba） */
.novel-tr.danger { background: var(--novel-err-weak); }
/* 行级失败锚点（全局状态条的行内装饰层，transient.ts）：文案归条，行内只留红左边标记——
   错误条目的定位按钮 scrollIntoView 跳到这里，标记随错误 dismiss 消失 */
.novel-tr.row-err { box-shadow: inset 3px 0 0 var(--novel-err); }
.novel-td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-actions { display: flex; gap: 6px; justify-content: flex-end; }
.novel-row {
  border: 1px solid var(--novel-border); border-radius: 8px; padding: 8px 12px; cursor: pointer;
  display: flex; align-items: center; gap: 4px;
}
.novel-row:hover { background: var(--novel-hover); }
.novel-progress { height: 6px; border-radius: 3px; background: var(--novel-skeleton); overflow: hidden; }
.novel-progress > i { display: block; height: 100%; width: 0; background: var(--novel-brand); transition: width .25s; }
.novel-empty { text-align: center; padding: 48px 16px; color: var(--novel-text-2); }
.novel-list { display: flex; flex-direction: column; gap: 6px; }
.novel-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.novel-group { display: flex; flex-direction: column; gap: 4px; }
.novel-drawer {
  flex: 0 0 260px; overflow-y: auto;
  background: var(--novel-layer-2); border-left: 1px solid var(--novel-border); padding: 8px;
}
.novel-drawer-item { padding: 6px 8px; cursor: pointer; font-size: 14px; border-radius: 4px; }
.novel-drawer-item:hover { background: var(--novel-hover); }
.novel-section-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: none; border: none; color: inherit; font: inherit; font-size: 14px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left;
}
.novel-section-head:hover { background: var(--novel-hover); }
.novel-section-head:focus-visible { outline: 2px solid var(--novel-focus); outline-offset: -2px; }
.novel-caret { width: 1em; color: var(--novel-text-3); }
.novel-section-body { display: flex; flex-direction: column; gap: 10px; padding: 2px 8px 8px; }
.novel-hero { display: flex; justify-content: center; padding: 28px 12px 10px; }
.novel-hero-input { width: min(480px, 90%); font-size: 15px; padding: 9px 14px; border-radius: 999px; }
.novel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 12px; }
.novel-card { display: flex; flex-direction: column; gap: 4px; cursor: pointer; border-radius: 8px; overflow: hidden; border: 1px solid var(--novel-border); }
.novel-card:hover { background: var(--novel-hover); }
.novel-cover { aspect-ratio: 2 / 3; width: 100%; object-fit: cover; display: block; background: var(--novel-skeleton); }
.novel-cover-fallback {
  aspect-ratio: 2 / 3; display: flex; align-items: center; justify-content: center;
  font-size: 28px; font-weight: 600; color: var(--novel-text);
  background: var(--novel-layer-3); border: 1px solid var(--novel-border);
}
.novel-card-title { font-size: 12px; line-height: 1.3; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-card { position: relative; }
.novel-card-x { position: absolute; top: 4px; right: 4px; z-index: 1; width: 22px; height: 22px; padding: 0; line-height: 1; border-radius: 999px; opacity: 0; }
.novel-card:hover .novel-card-x, .novel-card-x:focus { opacity: 1; }
`

/** 样式注入组件（NovelView 与宿主设置区块各渲染一次） */
export function NovelStyles(): ReactNode {
  return <style data-novel-style>{NOVEL_CSS}</style>
}

import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { paramRoutes, queries, ROUTES, shelfBody } from '../../shared/wire.js'
import { prodReaderDeps } from '../deps.js'
import type { ReaderDeps } from '../deps.js'
import { createExportRun, IDLE_EXPORT } from '../export-run.js'
import type { ExportRunState } from '../export-run.js'
import { navigate, prefsStore, setPref, useStore } from '../store.js'
import { FONT_STEPS, LINE_HEIGHTS, MEASURES, PAPER_PRESETS } from '../prefs-ui.js'
import type { ChapterAnchor } from '../progress.js'
import { ReaderSession } from '../reader-session.js'
import type { ReaderPort } from '../reader-session.js'
import { nextChapterIndex } from '../reader-load.js'
import {
  contentOriginTop, findScrollport, portScrollHeight, portScrollTop, portViewHeight, portViewTop, setPortScrollTop,
} from '../scrollport.js'
import { paperInk } from '../util.js'
import { ErrorBanner } from './bits.js'
import type { ChapterEntry, ShelfBook } from './types.js'

/** 正文层字色由纸张色算：纯函数住址在 util.ts，此处只接线。 */

/** 控制器层 z 序（不变量：**工具栏 > 遮罩**，面板在工具栏内）：
 *  面板嵌在 sticky 工具栏里，而 position:sticky + z-index 的工具栏**自成 stacking context**——
 *  面板自己的 z-index 只在工具栏内部有效，对外整层按工具栏的 z 参与排序。工具栏若 ≤ 遮罩，
 *  透明遮罩反压整层：面板看得见，但 elementFromPoint 打到的是遮罩，每个点击都被它吞掉直接
 *  关面板 = 「Aa 能弹出但点不了」（f0a0b0e 把工具栏改 sticky 时引入的真回归；无头 Edge 实测：
 *  工具栏 z5 → HIT=mask，z12 → HIT=opt。守卫见 tests/client/reader-ctrl-z.test.ts）。
 *  目录抽屉同用 panel 值（抽屉与 Aa 面板互斥、永不同场；遮罩只在 ctrlOpen 时渲染）。 */
export const CTRL_Z = { toolbar: 12, mask: 10, panel: 11 } as const

/** 阅读控制器面板（android-ebook 同款概念）：悬浮于工具栏下（挂 sticky 工具栏内，
 *  定位与滚动都锚在工具栏上；z 序不变量见 CTRL_Z）；点遮罩关闭——遮罩在 reader 根容器。
 *  简约版：chip 式控件（novel-chip/.on），布局归样式类 .novel-prefs；
 *  行内只留定位与 z（ctrl-z 守卫断言面板渲染含 z-index:11）。
 *  role=dialog + aria-label：这层是能开能关的浮层，不是页面上普通一块（Esc 关，见 ReaderView）。 */
export function PrefsPanel(): ReactNode {
  const prefs = useStore(prefsStore)
  const step = (delta: number): void => {
    const i = FONT_STEPS.indexOf(prefs.fontSize)
    const next = FONT_STEPS[Math.min(FONT_STEPS.length - 1, Math.max(0, (i === -1 ? 3 : i) + delta))]
    setPref({ fontSize: next })
  }
  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label="阅读设置"
      className={prefs.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 40, zIndex: CTRL_Z.panel }}
    >
      <div>
        <div className="novel-prefs-label">字号（当前 {prefs.fontSize}px）</div>
        <div className="novel-chips">
          <button className="novel-chip" onClick={() => step(-1)} aria-label="减小字号">A−</button>
          <button className="novel-chip" onClick={() => step(1)} aria-label="增大字号">A＋</button>
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">行距</div>
        <div className="novel-chips">
          {LINE_HEIGHTS.map((lh) => (
            <button key={lh} className={prefs.lineHeight === lh ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.lineHeight === lh}
              onClick={() => setPref({ lineHeight: lh })}>{lh}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">栏宽（每行约 {prefs.measure} 字）</div>
        <div className="novel-chips">
          {MEASURES.map((m) => (
            <button key={m.em} className={prefs.measure === m.em ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.measure === m.em}
              onClick={() => setPref({ measure: m.em })}>{m.label}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">纸张色（正文层，不随深色主题）</div>
        <div className="novel-chips">
          {PAPER_PRESETS.map((p) => (
            <button key={p.color} title={p.name} aria-label={p.name} aria-pressed={prefs.paperColor === p.color}
              className={prefs.paperColor === p.color ? 'novel-chip novel-paper-swatch on' : 'novel-chip novel-paper-swatch'}
              style={{ background: p.color, color: paperInk(p.color) }}
              onClick={() => setPref({ paperColor: p.color })} />
          ))}
          {/* 正文层的唯一取色入口：行内只有值本身，外观归 .novel-prefs-color
              （原生 color 控件不套标度会在面板里显得突兀） */}
          <input type="color" className="novel-prefs-color" aria-label="自定义纸张色"
            value={prefs.paperColor} onChange={(e) => setPref({ paperColor: e.target.value })} />
        </div>
      </div>
      <label>
        <input type="checkbox" checked={prefs.darkController} onChange={(e) => setPref({ darkController: e.target.checked })} />
        控制器层跟随深色
      </label>
    </div>
  )
}

/**
 * 阅读器：连续滚动流（章章首尾相接）。
 *
 * 时序编排归「阅读会话」（reader-session.ts）：目录→存档恢复→懒加载→预取→
 * 进度落盘全在会话里并可单测；本视图只做三件事——渲染会话状态、把 DOM 测量实现成 ReaderPort、
 * 把 scroll/resize 事件喂给会话。正文承载在宿主的 resident scrollport 上（见 scrollport.ts 头注）：
 * 滚动、进度、回跳一律按「真正在滚的容器」算；只渲染已载章节，预取自限。
 *
 * 呈现层（简约版）：细工具栏（‹书架 · 居中书名 · ⤓/Aa/目录）+ 正文居中窄列
 * （布局归 .novel-rdr-body；prefs 色/字号/行距仍行内——正文层永不接宿主 token）
 * + 目录抽屉 = 正文的 flex 兄弟（sticky + 视口上限，锚视口不锚正文）。z 序仍归 CTRL_Z 常量行内。
 *
 * deps 注入：apiGet/apiSend/streamExport/saveBlob 全走 ReaderDeps——与 ShelfView/
 * SearchView 口径齐平；整本导出的时序编排归 export-run.ts，此处只接线。
 */
export function ReaderView({ sourceId, bookKey, title, deps = prodReaderDeps }: {
  sourceId: string; bookKey: string; title: string; deps?: ReaderDeps
}): ReactNode {
  const prefs = useStore(prefsStore)
  const bodyRef = useRef<HTMLDivElement | null>(null)                  // 正文层：锚点测量基准
  const sentinelRef = useRef<HTMLDivElement | null>(null)              // 未载边界哨兵：进预取区 → 加载下一章
  const portRef = useRef<HTMLElement | null>(null)                     // 真实滚动容器缓存（内容变化时刷新）
  const chapterRefs = useRef<Array<HTMLDivElement | null>>([])

  /** DOM 测量口：会话只读不碰 DOM——测量语义（两套坐标系不许混用）全在这一个对象里 */
  const readerPort = useMemo<ReaderPort>(() => ({
    measureAnchors: (): ChapterAnchor[] => {
      // 锚点 = 章块相对「滚动内容原点」的偏移。不能用 offsetTop：宿主的滚动容器在阅读器之外，
      // 两套坐标系混用会让 locateChapter 恒判第 0 章（进度不落地）
      const origin = contentOriginTop(portRef.current)
      const list: ChapterAnchor[] = []
      chapterRefs.current.forEach((el, i) => {
        if (el !== null && el !== undefined) list.push({ index: i, start: el.getBoundingClientRect().top - origin })
      })
      return list
    },
    scrollTop: () => portScrollTop(portRef.current),
    setScrollTop: (px) => setPortScrollTop(portRef.current, px),
    viewHeight: () => portViewHeight(portRef.current),
    scrollHeight: () => portScrollHeight(portRef.current),
    sentinelOffset: () => {
      const sentinel = sentinelRef.current
      if (sentinel === null) return null
      return sentinel.getBoundingClientRect().top - portViewTop(portRef.current)
    },
    chapterOffset: (index) => {
      const el = chapterRefs.current[index]
      if (el === null || el === undefined) return null
      return el.getBoundingClientRect().top - portViewTop(portRef.current)
    },
  }), [])

  /** 会话依赖束：网络 + 帧调度（rAF 双帧 = 等布局落定再测量）；网络走注入 deps */
  const session = useMemo(() => new ReaderSession({
    fetchToc: (s, b) => deps.apiGet<ChapterEntry[]>(queries.toc({ sourceId: s, url: b })),
    fetchChapter: (s, b, i) => deps.apiGet<string>(queries.chapter({ sourceId: s, url: b, index: i })),
    fetchShelf: () => deps.apiGet<ShelfBook[]>(ROUTES.shelf.path),
    saveProgress: (chapterIndex, offsetRatio) => {
      void deps.apiSend('PUT', paramRoutes.shelfKey(bookKey), shelfBody.progress(chapterIndex, offsetRatio)).catch(() => undefined)
    },
    saveTotalChapters: (total) => {
      // 幂等补数据：缺 totalChapters 才回写；patch 形态只发这一个字段——
      // 保值语义在 Shelf.update 的 interface 上，不再被迫重发 sourceId+title
      void deps.apiSend('PUT', paramRoutes.shelfKey(bookKey),
        shelfBody.patch({ totalChapters: total })).catch(() => undefined)
    },
    afterFrames: (cb) => { requestAnimationFrame(() => requestAnimationFrame(cb)) },
  }, readerPort), [readerPort, deps, sourceId, bookKey, title])

  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  const st = useSyncExternalStore(session.subscribe, () => session.state, () => session.state)
  const { toc, chapters, loadingIdx, error, currentChapter } = st

  const [drawer, setDrawer] = useState(false)
  const [ctrlOpen, setCtrlOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  /** 抽屉条目：元素引用只在目录变化时重建。**不是微优化**：抽屉挂在 ReaderView 里，
   *  会话每次 notify（载章 / 清错 / 跨章）都会重跑本组件；逐条现造 = 每次 notify 白造
   *  toc.length 个 React 元素（千章书 = 每跨一章多一次 912 元素的构造 + 比对），
   *  而多数时候抽屉是关着的。当前章高亮因此不进元素（会把依赖搅浑），
   *  走下面的 aria-current 单点移动。 */
  const drawerItems = useMemo<ReactNode[]>(() => (toc ?? []).map((c, i) => (
    <button key={c.url} data-idx={i} className="novel-drawer-item"
      onClick={() => { setDrawer(false); session.requestJump(sourceId, i) }}>
      {c.name}
    </button>
  )), [toc, session, sourceId])
  // 浮层（Aa 面板 / 目录抽屉）共用一条 Esc：两者互斥，永不同场
  useEffect(() => {
    if (!ctrlOpen && !drawer) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setCtrlOpen(false)
      setDrawer(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ctrlOpen, drawer])
  /** 当前章：把 aria-current 移到那一条（样式与语义同一个源）。
   *  scrollIntoView 存在性判断不是防生产：jsdom 无排版引擎、该方法缺席（与 util.ls
   *  挡「无 DOM」同一类环境守卫）——缺了它，任何开抽屉的组件测试都会炸在 effect 里。 */
  useEffect(() => {
    if (!drawer) return
    const root = drawerRef.current
    root?.querySelector('[aria-current="true"]')?.removeAttribute('aria-current')
    const cur = root?.querySelector<HTMLElement>(`[data-idx="${currentChapter}"]`)
    if (cur === null || cur === undefined) return
    cur.setAttribute('aria-current', 'true')
    cur.scrollIntoView?.({ block: 'center' })
  }, [drawer, currentChapter])
  // 整本导出：编排归 export-run.ts——start/cancel/状态三态 + 卸载 abort
  // 在那边可单测；本视图只接线：状态经 onChange 进 state，按钮按 running 分流 start/cancel。
  // 导出失败单独一条（会话 error 归阅读链路）
  const [exportState, setExportState] = useState<ExportRunState>(IDLE_EXPORT)
  const exportRun = useMemo(() => createExportRun({
    sourceId, bookKey, title, deps, onChange: setExportState,
  }), [deps, sourceId, bookKey, title])
  useEffect(() => () => exportRun.dispose(), [exportRun])   // 卸载即取消——不许孤儿抓取

  /** 刷新滚动容器缓存（内容变化/视口变化时） */
  const refreshPort = (): void => { portRef.current = findScrollport(bodyRef.current) }

  // 进入：开会话（目录→恢复→懒加载）；卸载：关会话（清防抖定时器）
  useEffect(() => {
    chapterRefs.current = []
    refreshPort()
    void session.open(sourceId, bookKey)
    return () => session.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // 已载表变化：刷新滚动容器与锚点 → 补足预取（哨兵出区即自限，不会全书风暴）
  useEffect(() => {
    refreshPort()
    session.recalcAnchors()
    session.checkPreload(sourceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters])

  // 视口变化：capture 阶段收「任意容器」的 scroll（scroll 不冒泡，但捕获阶段会经过 document——
  // 宿主 resident scrollport 的滚动因此也收得到）；rAF 合帧
  useEffect(() => {
    let raf = 0
    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        refreshPort()
        session.handleViewportChange(sourceId)
      })
    }
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // 目录直达：目标章渲染落地后定位（未落地：会话保有 pendingJump，下轮 chapters 变化再试）
  useEffect(() => {
    session.settleJump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, st.pendingJump])

  const shownError = error ?? exportState.error
  return (
    <div data-novel-view="reader" className="novel-rdr">
      {/* 偏好面板遮罩：挂 reader 根容器（position:relative 定位参照）盖满整个阅读区——只盖工具栏条时点正文关不掉面板（T4 修复） */}
      {ctrlOpen && <div data-novel-ctrl-mask onClick={() => setCtrlOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: CTRL_Z.mask }} />}
      {/* 控制器层（主题变量；darkController 决定是否跟随深色）——sticky：正文由宿主 scrollport 承载，
          工具栏不 sticky 会随正文一起滚走（目录/Aa 够不着）。布局归 .novel-rdr-bar（样式层），
          行内只留 sticky 定位与 z（CTRL_Z 常量，ctrl-z 守卫断言）；novel-dark 挂工具栏根。 */}
      <div className={prefs.darkController ? 'novel-dark novel-rdr-bar' : 'novel-rdr-bar'}
        style={{ position: 'sticky', top: 0, zIndex: CTRL_Z.toolbar }}>
        <button className="novel-btn sm" onClick={() => navigate({ name: 'shelf' })}>‹ 书架</button>
        <div className="novel-rdr-title">
          <span className="novel-rdr-book">{title}</span>{toc === null ? '' : ` · 共 ${toc.length} 章`}
        </div>
        <div className="novel-rdr-acts">
          <button
            className="novel-btn sm"
            onClick={exportState.running ? exportRun.cancel : exportRun.start}
            title={exportState.total === '' ? '整本导出' : `整本导出（共 ${exportState.total} 章）`}
          >
            {exportState.running ? `⤓ ${exportState.kb} KB · 取消导出` : '⤓ 下载'}
          </button>
          <button className="novel-btn sm" aria-expanded={ctrlOpen} aria-label="阅读设置"
            onClick={() => setCtrlOpen(!ctrlOpen)} title="阅读设置">Aa</button>
          {/* 目录与 Aa 互斥：工具栏已在遮罩之上（CTRL_Z），点目录不再被遮罩顺手关面板——自己关 */}
          <button className="novel-btn sm" aria-expanded={drawer} aria-label="目录"
            onClick={() => { setCtrlOpen(false); setDrawer(!drawer) }}
            title={toc === null ? '目录' : `目录（${toc.length}）`}>目录</button>
          {ctrlOpen && <PrefsPanel />}
        </div>
        {/* 章进度细线：跨章才动（会话只在 chapterIndex 变化时写 currentChapter）。
            章内百分比刻意不做——那是每帧量，会让整棵阅读器每帧重渲染。 */}
        <i className="novel-rdr-trail" aria-hidden="true"
          style={{ '--novel-pct': String(toc === null ? 0 : (currentChapter + 1) / toc.length) } as CSSProperties} />
      </div>
      {/* 会话错误的重试必须真的重拉（此前 onRetry 接到 setExportState(IDLE_EXPORT)——导出态专用，
          对会话错误是空操作，红色错误条永久粘屏）；导出错误才走导出态复位。 */}
      {shownError !== null && (
        <ErrorBanner error={shownError} onRetry={() => {
          if (error !== null) session.retry()
          else setExportState(IDLE_EXPORT)
        }} />
      )}
      {/* 阅读区（纸张色铺满这一层 = full-bleed）：正文列 + 0 宽 sticky 抽屉槽同在此行。
          抽屉三版死法与现方案的理由见样式层 .novel-drawer-slot 注释。 */}
      <div className="novel-rdr-main" style={{ background: prefs.paperColor }}>
        {/* 正文层：字色/字号/行距/栏宽由 prefs 行内固定——永不接宿主 token；纸张色在**外层
            .novel-rdr-main** 上（full-bleed：纸铺满阅读区，正文列只管文字排到哪儿为止） */}
        <div
          ref={bodyRef}
          className="novel-rdr-body"
          style={{
            color: paperInk(prefs.paperColor),
            fontSize: prefs.fontSize, lineHeight: prefs.lineHeight,
            '--novel-measure': `${prefs.measure}em`,
          } as CSSProperties}
        >
          {toc === null && <div className="novel-rdr-loading">目录加载中…</div>}
          {/* 只渲染已载章节：未载章节不进 DOM——scrollHeight 才等于「已读内容高」，预取判据才成立 */}
          {chapters.map((text, i) => text === null
            ? null
            : (
              <div
                key={i}
                ref={(el) => { chapterRefs.current[i] = el }}
                data-chapter={i}
              >
                {/* h2 不是 h3：阅读器这一屏没有更高的标题占位，从 h3 起等于给读屏一份断了头的大纲 */}
                <h2>{toc?.[i]?.name ?? `第 ${i + 1} 章`}</h2>
                {text.split('\n').map((para, j) => <p key={j}>{para}</p>)}
              </div>
            ))}
          {toc !== null && (
            <div ref={sentinelRef} data-novel-sentinel className="novel-sentinel">
              {loadingIdx !== null ? '加载中…' : nextChapterIndex(chapters) === -1 ? '— 全书完 —' : '…'}
            </div>
          )}
        </div>
        {/* 抽屉：0 宽 sticky 槽 + absolute 本体（锚视口、且不切走正文宽度；三版死法见样式层注释） */}
        {drawer && (
          <div className="novel-drawer-slot">
            <div ref={drawerRef} className="novel-drawer" role="dialog" aria-label="目录">
              {drawerItems}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

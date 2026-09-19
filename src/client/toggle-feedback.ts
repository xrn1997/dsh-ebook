import { pushError } from './transient.js'

/** 启停反馈只需要错误入口——依赖束的最小投影（测试注入假 pushError 即可断言进条语义） */
export interface ToggleFeedbackDeps {
  pushError: typeof pushError
}

/**
 * 单源启停的瞬态反馈策略。
 *
 * 病根（真机逐帧量过，不是推测）：启停原本走 `pushPending` → 全局状态条挂载。状态条当时是
 * 设置区里的**普通流内**元素，一挂上就把下面所有内容顶下去（实测区块头 y 116→151、首行
 * 361→396，整块 **+35px**），settle 后弹回 —— 每次启停 2 条 layout-shift。单源启停的往返
 * 本机只有 13~20ms（≈1 帧），所以用户看到的是「一帧的下沉回弹」= 闪烁；服务端事件循环被占
 * （LLM 流式输出 / 导入验证任务）时往返变长，就变成整块下移几百毫秒再弹回。
 *
 * 策略：**秒级乐观操作不进泳道**。行内已有在途装饰（开关降透明 + `cursor: wait` + title
 * 「保存中…」），「点击位置即反馈位置」在这一档由行内承担；只有**失败**才进 error 泳道
 * （带行锚点 = 全局条「定位 →」跳转 + 行内 `.row-err` 红左边）。这与瞬态层自己的
 * 「ok 少而淡——开关翻转本身即成功反馈不进条」是同一条原则的延伸。
 *
 * 抽成纯函数是本仓库 client 惯例（见 source-inbox.ts 头注）：策略可单测，视图只做接线。
 * 配套第二半修复在 styles.tsx：状态条自身改成不吃布局的浮层（慢操作/错误条也不再顶动内容）。
 * 口径详见 `docs/design/client.md`。
 */
export interface ToggleFeedback {
  /** 请求在途：**零占用**（不进泳道——挂载即顶动布局，秒级操作会闪） */
  inFlight(): void
  /** 收工：成功静默（开关已翻转即反馈）；失败进 error 泳道并挂行锚点 */
  settle(ok: boolean, failureText?: string): void
}

/** 单源启停的行锚点（error 条目「定位 →」与行内红边共用同一个选择器） */
export function rowAnchorOf(id: string): string {
  return `[data-novel-source-row="${id}"]`
}

export function toggleFeedback(anchor: string, deps: ToggleFeedbackDeps = { pushError }): ToggleFeedback {
  return {
    inFlight(): void {
      // 故意留空：这里**不许** pushPending（挂上就顶动设置区布局 → 闪烁，见文件头注）
    },
    settle(ok: boolean, failureText?: string): void {
      if (ok) return
      deps.pushError(failureText ?? '启停失败', anchor)
    },
  }
}

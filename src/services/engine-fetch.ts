import { decodeBody, headerOf } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { assembleRequest, fetchInitOf } from './request.js'

/**
 * 引擎 EvalContext.fetch 守门注入：@js 里的 java.ajax 也走守门抓取 + 解码链。
 * legado 语义（AnalyzeUrl 考证）：java.ajax 的 URL 可带 `url,{json}` 请求选项——
 * 不解析的话整串（含 `,{...}`）被当 URL 发出，站点直接 403/404（实测 wcxsw 源：
 * 脚本拼 `search.php,{'body':...}` 传给 java.ajax，我们原样 fetch → 403）。
 *
 * 请求语义不再自持一份：选项解释 / POST 表单默认头 / init 姿态全部走 assembleRequest + fetchInitOf
 * （此前这里手写一遍「与 buildSearchRequest 同口径」——注释同步的分叉，现已收口）。
 * 本模块只负责「源级 header 打底 + 解码 + 落地地址丢弃」这三件引擎桥特有的事。
 */
export function engineFetch(
  fetcher: Fetcher, headers: Record<string, string>, vars?: Record<string, string | number>,
): (url: string) => Promise<{ body: string; contentType?: string }> {
  return async (rawUrl) => {
    // baseUrl = null：java.ajax 的 URL 由脚本自己拼好，不做绝对化（与原实现一致）
    const plan = assembleRequest(rawUrl, vars ?? {}, null)
    const page = await fetcher.fetchPage(plan.url, fetchInitOf(plan, headers))
    return { body: decodeBody(page, plan.charset), contentType: page.contentType }
  }
}

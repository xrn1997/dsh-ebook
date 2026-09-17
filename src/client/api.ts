import type { ApiEnvelope } from '../shared/wire.js'
import { NOVEL_API_PREFIX } from '../shared/wire.js'

/**
 * /novel-api 同源 fetch 封装。前缀与信封形状归 wire 契约（src/shared/wire.ts，双半唯一真相）。
 * 信封：{ ok:true, value } → value；{ ok:false, error } → ApiClientError；非 JSON/网络层 → NetworkError。
 */
export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  readonly segment?: { facet: string; segmentIndex: number; segmentRaw: string }
  constructor(code: string, status: number, message: string, segment?: ApiClientError['segment']) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.segment = segment
  }
}

/** query 构造归 wire 契约（shared/wire.ts 的 encodeQuery / queries）——此处不再持有第二份 qs */

const PREFIX = `${NOVEL_API_PREFIX}/`

/** 响应体 → JSON（失败 = NetworkError，消息与旧实现一字不差） */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new ApiClientError('NetworkError', res.status, `响应不是 JSON（HTTP ${res.status}）`)
  }
}

/** 信封解析单点（旧实现 request/apiUpload 各一份，已合并）：ok → value；否则抛 ApiClientError */
function unwrap<T>(body: unknown, status: number): T {
  const env = body as ApiEnvelope<T>
  if (env.ok === true) return env.value as T
  const err = env.error
  throw new ApiClientError(err?.code ?? 'Unknown', status, err?.message ?? `HTTP ${status}`, err?.segment)
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(PREFIX + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    throw new ApiClientError('NetworkError', 0, `网络请求失败: ${(e as Error).message}`)
  }
  return unwrap<T>(await jsonOf(res), res.status)
}

export function apiGet<T>(path: string): Promise<T> { return request<T>(path, 'GET') }
export function apiSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(path, method, body)
}

/** 原始字节上传（本地 TXT 导入，UI）：octet-stream body，响应仍走信封 */
export async function apiUpload<T>(pathWithQuery: string, body: Blob): Promise<T> {
  let res: Response
  try {
    res = await fetch(PREFIX + pathWithQuery, { method: 'POST', body })
  } catch (e) {
    throw new ApiClientError('NetworkError', 0, `网络请求失败: ${(e as Error).message}`)
  }
  return unwrap<T>(await jsonOf(res), res.status)
}

/**
 * 沙箱宿主纯工具（「JavaBridge 协议知识散四处」之「纯工具出走」）。
 *
 * 此前 fmtTime/md5/base64/engineValueToString(s) 埋在 js-sandbox 的 makeJavaBridge 附近，
 * 是模块私有函数——只能整体过 vm 测试，无法直测。本文件把它们抽成无状态纯函数：
 * 无 vm、无 EvalContext、无会话状态，直接可测（tests/engine/js-utils.test.ts）。
 *
 * 纪律：本文件**不进** engine barrel（src/engine/index.ts）——仅由 js-protocol/js-sandbox 内部引用。
 */
import crypto from 'node:crypto'
import type { EngineValue } from './types.js'

/** md5 → 32 位小写十六进制 */
export function md5Hex(s: string): string {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex')
}

/** legado md5Encode16 语义：32 位 md5 取中 16 位（slice(8, 24)） */
export function md5Hex16(s: string): string {
  return md5Hex(s).slice(8, 24)
}

/** base64 编码（UTF-8 字节） */
export function base64Encode(s: string): string {
  return Buffer.from(String(s), 'utf8').toString('base64')
}

/** base64 解码（→ UTF-8 字符串） */
export function base64Decode(s: string): string {
  return Buffer.from(String(s), 'base64').toString('utf8')
}

/** java.encodeURI 垫片：legado 实际语义 = encodeURIComponent（中文/空格/斜杠全部转义） */
export function uriEncode(s: string): string {
  return encodeURIComponent(String(s))
}

/** 十六进制串 → UTF-8 字符串；空串/奇数长/含非 hex 字符 → ''（宁空不猜，与旧实现逐字一致） */
export function hexDecodeToString(hex: string): string {
  const clean = String(hex).trim()
  if (clean === '' || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return ''
  return Buffer.from(clean, 'hex').toString('utf8')
}

/** 时间格式化：yyyy/MM/dd HH:mm（utc 标志决定取 UTC 还是本地分量；非法输入 → ''） */
export function fmtTime(ts: number | string, utc: boolean): string {
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  const y = utc ? d.getUTCFullYear() : d.getFullYear()
  const mo = utc ? d.getUTCMonth() : d.getMonth()
  const da = utc ? d.getUTCDate() : d.getDate()
  const h = utc ? d.getUTCHours() : d.getHours()
  const mi = utc ? d.getUTCMinutes() : d.getMinutes()
  return `${y}/${p2(mo + 1)}/${p2(da)} ${p2(h)}:${p2(mi)}`
}

/** EngineValue → 单串（**唯一实现**；nodes 两种宿主口径由参数显式区分，不再是两份抄本）。
 *  nodesMode：'inner' = `html()`（java.getString 口径，默认）；'outer' = `toString()`（@js host.result 口径）。
 *  其余分支：list 换行拼接、matches 行内 tab、miss → ''。（此前 evaluate.serialize 与
 *  本函数五分支里四个逐字相同、nodes 分叉——同一段 HTML 在 @js 里经两种 API 读到两种文本。） */
export function engineValueToString(v: EngineValue, nodesMode: 'inner' | 'outer' = 'inner'): string {
  switch (v.kind) {
    case 'value':
      return v.text
    case 'list':
      return v.items.join('\n')
    case 'matches':
      return v.rows.map((r) => r.join('\t')).join('\n')
    case 'nodes':
      return (nodesMode === 'outer' ? v.nodes.toString() : v.nodes.html()) ?? ''
    case 'miss':
      return ''
  }
}

/** EngineValue → 串数组（java.getStringList 口径：value 按换行切分并滤空行） */
export function engineValueToStrings(v: EngineValue): string[] {
  switch (v.kind) {
    case 'value':
      return v.text.split('\n').filter((s) => s !== '')
    case 'list':
      return v.items
    case 'matches':
      return v.rows.map((r) => r.join('\t'))
    case 'nodes': {
      const html = v.nodes.html() ?? ''
      return html ? [html] : []
    }
    case 'miss':
      return []
  }
}

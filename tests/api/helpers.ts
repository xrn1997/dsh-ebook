import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReadingService } from '../../src/services/reading.js'
import { createApiHandler } from '../../src/api/dispatch.js'
import type { ApiHandlerOptions } from '../../src/api/dispatch.js'

/** 起真 http.Server（127.0.0.1:0）承载 dispatch——忠实覆盖 Node 原生 req/res 语义 */
export async function startServer(service: ReadingService, opts?: ApiHandlerOptions): Promise<{ base: string; close: () => Promise<void> }> {
  const handler = createApiHandler(service, opts)
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => { /* handler 内部已 writeError 兜底 */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

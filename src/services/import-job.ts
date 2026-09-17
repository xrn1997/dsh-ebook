import { randomUUID } from 'node:crypto'
import { SourceIntake } from './intake.js'
import type { ProbeResult } from './probe.js'
import type { SourceRegistry } from './sources.js'
import type { NovelSource } from './types.js'

/**
 * 书源后台任务：导入/批量验证跑在服务端进程内，单任务槽——
 * 运行中互斥、结束后结果保留（关设置/刷新页面后 UI 重挂载即可恢复展示）。
 * 任务态只在内存：DSH 重启即丢，但源已按批落盘不丢数据——导入幂等可重跑，不做任务持久化（YAGNI）。
 */
/** JobState/JobIssue 定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持 import 路径可用 */
export type { JobState, JobIssue } from '../shared/wire.js'
import type { JobIssue, JobState } from '../shared/wire.js'

export type JobKind = JobState['kind']
export type ImportFile = { name: string; text: string }

/** 运行中重复提交：路由层映射 409 JobRunning（services 不 import api 层） */
export class JobRunningError extends Error {
  constructor(running: JobState) {
    super(`已有任务在运行（${running.kind === 'import' ? '导入' : '验证'} ${running.done}/${running.total}）`)
    this.name = 'JobRunningError'
  }
}

/** 去重键归 intake（入库规则唯一实现）；re-export 保持 import 路径可用 */
export { dedupKey } from './intake.js'

const ISSUE_CAP = 200
const PROBE_CONCURRENCY = 5
// 落盘粒度已内聚进注册表（edit 合并写：每 20 次变更强制落盘 + 尾沿防抖）——
// 任务运行器不再持有 persist 节流常量

export class SourceJobs {
  private current: JobState | null = null
  constructor(private readonly deps: {
    registry: SourceRegistry
    probe(source: NovelSource): Promise<ProbeResult>
    now?: () => number
    uuid?: () => string
  }) {}

  status(): JobState | null { return this.current }

  startImport(files: ImportFile[]): { jobId: string } {
    const state = this.begin('import')
    void this.runImport(state, files).catch((e: unknown) => {
      state.phase = 'failed'
      state.error = e instanceof Error ? e.message : String(e)
      state.finishedAt = this.now()
    })
    return { jobId: state.id }
  }

  startBatchProbe(ids: string[]): { jobId: string } {
    const state = this.begin('batch-probe')
    state.total = ids.length
    void this.runBatchProbe(state, ids).catch((e: unknown) => {
      state.phase = 'failed'
      state.error = e instanceof Error ? e.message : String(e)
      state.finishedAt = this.now()
    })
    return { jobId: state.id }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private begin(kind: JobKind): JobState {
    if (this.current !== null && this.current.phase === 'running') throw new JobRunningError(this.current)
    const state: JobState = {
      id: (this.deps.uuid ?? randomUUID)(), kind, phase: 'running',
      total: 0, done: 0,
      counts: { ok: 0, failed: 0, dupSkipped: 0, replaced: 0 },
      issues: [], fileErrors: [], startedAt: this.now(),
    }
    this.current = state
    return state
  }

  private issue(state: JobState, kind: JobIssue['kind'], name: string, detail: string): void {
    if (state.issues.length < ISSUE_CAP) state.issues.push({ kind, name, detail })
  }

  /**
   * 导入：逐文件 parse（坏文件记 fileErrors 继续）→ 逐条交 SourceIntake 入库
   * （normalize / 批内留首条 / 按址去重 / replace 清脏——入库规则唯一实现在 intake.ts，
   * 本方法只把 IntakeDecision 映射成任务词汇：counts 与 issues）。
   * 逐条落库（注册表内部合并落盘）；**导入不探针**——验证归批量验证任务；任务末 flush 等齐落盘。
   */
  private async runImport(state: JobState, files: ImportFile[]): Promise<void> {
    const items: unknown[] = []
    for (const f of files) {
      let parsed: unknown
      try { parsed = JSON.parse(stripBom(f.text)) } catch { state.fileErrors.push({ file: f.name, error: 'JSON 解析失败' }); continue }
      if (Array.isArray(parsed)) items.push(...parsed)
      else items.push(parsed)
    }
    state.total = items.length
    const intake = new SourceIntake(this.deps.registry)
    for (const item of items) {
      const d = await intake.intake(item)
      switch (d.kind) {
        case 'failed':
          state.counts.failed++
          this.issue(state, 'failed', d.name, d.missing.map((m) => `${m.field}：${m.message}`).join('；') || 'normalize 失败')
          break
        case 'added':
          state.counts.ok++
          break
        case 'replaced':
          state.counts.replaced++
          this.issue(state, 'replaced', d.source.name, d.clearedRest > 0 ? '已替换旧源（同地址其余条目一并清除）' : '已替换旧源')
          break
        case 'skipped':
          state.counts.dupSkipped++
          this.issue(state, 'dup', d.name, d.reason === 'batch'
            ? '重复跳过：与批内前一条同地址'
            : `重复跳过：与已有可用源同地址（${d.existing?.name ?? '?'}）`)
          break
      }
      state.done++
    }
    await this.deps.registry.flush()                       // 任务完成 ⇒ 结果已落盘（既有语义不变）
    state.phase = 'done'
    state.finishedAt = this.now()
  }

  /**
   * 批量验证：有效 id 并发 5 路探针（限流敬畏——对齐 searchParallel 口径）。
   * 单条失败即结果（broken/异常记 counts）不中断。落盘粒度已收进注册表（每 20 次变更强制落盘
   * + 100ms 尾沿防抖，见 sources.ts），任务运行器不再持「每 N 条 persist」的常量。
   */
  private async runBatchProbe(state: JobState, ids: string[]): Promise<void> {
    const valid: string[] = []
    for (const id of ids) {
      if (this.deps.registry.get(id) === undefined) this.issue(state, 'failed', id, '源不存在（已跳过）')
      else valid.push(id)
    }
    state.total = valid.length
    let cursor = 0
    let settled = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++
        if (i >= valid.length) return
        const id = valid[i]
        // 重查（洞3 修复）：任务运行期间源可能被删——取不到就点名跳过，不产生 TypeError 垃圾失败
        const s = this.deps.registry.get(id)
        if (s === undefined) {
          this.issue(state, 'failed', id, '源不存在（运行中被删除，已跳过）')
          state.done++
          settled++
          continue
        }
        try {
          const r = await this.deps.probe(s)
          await this.deps.registry.edit((tx) => tx.setStatus(id, r.ok ? 'verified' : 'broken', r.error?.message, r.probedAt))
          if (r.ok) state.counts.ok++
          else { state.counts.failed++; this.issue(state, 'failed', s.name, r.error?.message ?? '探针未通过') }
        } catch (e) {
          state.counts.failed++
          this.issue(state, 'failed', s.name, e instanceof Error ? e.message : String(e))
        }
        state.done++
        settled++
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(valid.length, 1)) }, worker))
    await this.deps.registry.flush()                       // 任务完成 ⇒ 结果已落盘（既有语义不变）
    state.phase = 'done'
    state.finishedAt = this.now()
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

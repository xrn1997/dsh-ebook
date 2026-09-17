import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiSend } from './api.js'
import { ROUTES } from '../shared/wire.js'
import type { JobIssue, JobState } from './views/types.js'

/**
 * 后台任务面：导入/批量验证跑在服务端，客户端只是提交者与观察者——
 * 关设置、刷新页面都不影响任务；UI 挂载时查一次 job-status 即恢复展示。
 */

export async function startImportJob(files: Array<{ name: string; text: string }>): Promise<{ jobId: string }> {
  return apiSend<{ jobId: string }>('POST', ROUTES.sourcesImport.path, { files })
}

export async function startBatchProbeJob(ids: string[]): Promise<{ jobId: string }> {
  return apiSend<{ jobId: string }>('POST', ROUTES.sourcesBatchProbe.path, { ids })
}

export async function fetchJobStatus(): Promise<JobState | null> {
  return (await apiGet<{ job: JobState | null }>(ROUTES.sourcesJobStatus.path)).job
}

/** 最近一次导入任务的模块级缓存：
 *  服务端单任务槽被 probe 任务覆盖后，导入汇总条仍要可看——轮询见到 import 任务即缓存。
 *  模块级：设置区卸载重挂载也不丢。 */
let lastImportJob: JobState | null = null
export function getLastImportJob(): JobState | null { return lastImportJob }

/** 轮询取数依赖（SettingsDeps.fetchJobStatus 的最小面，补完 seam）：
 *  生产缺省真实现；测试注入假取数 + 假时钟——轮询节拍第一次变得可测。
 *  本地声明而不引 deps.ts 的类型：避免 deps.ts(值) ↔ jobs.ts 的环。 */
export interface JobStatusDeps {
  fetchJobStatus: () => Promise<JobState | null>
}

/** 生产取数依赖：模块级真实现打包——hook 缺省即它，接线零变化 */
const prodJobStatusDeps: JobStatusDeps = { fetchJobStatus }

/** 任务轮询 hook：挂载即拉 + 1s interval；网络抖动保留旧值下轮重试（不崩不闪空）。
 *  抖动时如实置 `stale`（连接异常）→ 状态条给「连接异常，重试中」提示——此前 catch 静默
  *  保留旧值，任务卡会永远停在最后一帧毫无提示（「连接异常，重试中」未兑现）。
 *  SettingsSection 顶层单实例，状态条与两区运行卡经 props 共享——避免双轮询。
 *  取数走注入 deps（useLatest ref 进 effect）：deps 若是每 render 新字面量，直接进
 *  依赖数组会每帧重启轮询，故 effect 仍只认 [tick]。 */
export function useJobStatus(deps: JobStatusDeps = prodJobStatusDeps): { job: JobState | null; refresh: () => void; stale: boolean } {
  const [job, setJob] = useState<JobState | null>(null)
  const [stale, setStale] = useState(false)
  const [tick, setTick] = useState(0)
  const depsRef = useRef(deps)
  depsRef.current = deps
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const loop = async (): Promise<void> => {
      try {
        const j = await depsRef.current.fetchJobStatus()
        if (j !== null && j.kind === 'import') lastImportJob = j   // 顺带喂缓存（probe 任务不覆盖）
        if (alive) { setJob(j); setStale(false) }
      } catch {
        // 抖动：保留旧值，下轮重试——但标注 stale（不静默）
        if (alive) setStale(true)
      }
      if (!alive) return
      timer = setTimeout(() => { void loop() }, 1000)
    }
    void loop()
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
  }, [tick])
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { job, refresh, stale }
}

export function jobKindLabel(kind: JobState['kind']): string {
  return kind === 'import' ? '导入' : '验证'
}

export const JOB_ISSUE_LABEL: Record<JobIssue['kind'], string> = {
  failed: '失败', warning: '警告', dup: '重复跳过', replaced: '已替换',
}

import { AgentError } from '../agent/contracts/error.js'
import type { ContextItem } from '../agent/context/context-item.js'
import type { RunBoundaryGuard } from '../agent/run/RunBoundary.js'
import { parseContextDependencyProof, type ContextDependencyProof, type MemoryDependency } from '../agent/context/ContextDependency.js'

export function changedContextError (): AgentError {
  return new AgentError({ code: 'authorization_changed', stage: 'run.context_authority', retryable: false,
    userMessage: '当前资料或权限已发生变化，请重新提问。' })
}

export type MemoryAuthoritySource = (refs: readonly MemoryDependency[], signal: AbortSignal) => Promise<string | null>

export async function captureMemoryContextProof (
  initial: readonly ContextItem[], authority: MemoryAuthoritySource | undefined,
  signal: AbortSignal, inherited?: ContextDependencyProof
): Promise<ContextDependencyProof> {
  const refs = [...(inherited?.memories ?? []), ...initial.map(item => item.memoryRecord)]
  if (refs.some(ref => ref === undefined)) throw changedContextError()
  const unique = new Map<string, MemoryDependency>()
  for (const ref of refs as MemoryDependency[]) {
    const key = `${ref.namespaceRef}\0${ref.memoryId}`
    const previous = unique.get(key)
    if (previous !== undefined && previous.revisionHash !== ref.revisionHash) throw changedContextError()
    unique.set(key, ref)
  }
  const memories = [...unique.values()]
  const authorityStamp = memories.length === 0 ? null : await authority?.(memories, signal)
  if (memories.length > 0 && authorityStamp == null) throw changedContextError()
  return parseContextDependencyProof({ schemaVersion: 1, memories, authorityStamp })
}

export function provenMemoryContextBoundary (
  proof: ContextDependencyProof, authority: MemoryAuthoritySource | undefined
): RunBoundaryGuard {
  return async (_boundary, signal) => {
    if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
    if (proof.memories.length === 0) return
    let stamp: string | null | undefined
    try { stamp = await authority?.(proof.memories, signal) } catch { throw changedContextError() }
    if (stamp == null || stamp !== proof.authorityStamp) throw changedContextError()
  }
}

/** Keep all original dependencies: dropping a prompt block cannot untaint earlier model/tool output. */
export function memoryContextBoundary (
  initial: readonly ContextItem[], reload: (signal: AbortSignal) => Promise<readonly ContextItem[]>
): RunBoundaryGuard {
  const dependencies = initial.map(item => item.memoryRecord)
  return async (_boundary, signal) => {
    if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
    if (dependencies.length === 0) return
    let current: readonly ContextItem[]
    try { current = await reload(signal) } catch {
      if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
      throw changedContextError()
    }
    if (dependencies.some(dependency => dependency === undefined || !current.some(item => {
      const record = item.memoryRecord
      return record !== undefined && record.namespaceRef === dependency.namespaceRef &&
        record.memoryId === dependency.memoryId && record.revision === dependency.revision &&
        record.revisionHash === dependency.revisionHash
    }))) throw changedContextError()
  }
}

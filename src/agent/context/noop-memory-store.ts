import { AgentError } from '../contracts/error.js'
import type { MemoryCandidate, MemoryQuery, MemoryStore } from '../contracts/memory.js'

const emptyMemories: readonly MemoryCandidate[] = Object.freeze([])

export class NoopMemoryStore implements MemoryStore {
  async retrieve (
    _query: MemoryQuery,
    signal?: AbortSignal
  ): Promise<readonly MemoryCandidate[]> {
    if (signal?.aborted === true) {
      throw new AgentError({
        code: 'cancelled',
        stage: 'memory.retrieve',
        retryable: false,
        userMessage: '操作已取消。'
      })
    }
    return emptyMemories
  }
}

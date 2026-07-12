import type { AgentMessage } from './content.js'
import type { ActorIdentity } from './identity.js'

export interface MemoryQuery {
  readonly botId: string
  readonly namespace: { readonly kind: 'personal'; readonly userId: string } |
    { readonly kind: 'group'; readonly groupId: string }
  readonly requester: ActorIdentity
  readonly limit: number
  readonly maxTokens: number
}

export interface MemoryCandidate {
  readonly memoryId: string
  readonly message: AgentMessage
  readonly createdAt: string
  readonly confidence: number
  readonly sensitivity: 'public' | 'group' | 'private' | 'sensitive'
  readonly conflict: 'none' | 'possible' | 'confirmed'
}

export interface MemoryStore {
  retrieve(query: MemoryQuery, signal?: AbortSignal): Promise<readonly MemoryCandidate[]>
}

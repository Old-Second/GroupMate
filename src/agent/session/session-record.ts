import type { ConversationScope, SessionAddress } from '../contracts/identity.js'

export interface SessionRecord<TState> {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly botId: string
  readonly scope: ConversationScope
  readonly startedBy: { readonly userId: string; readonly displayName?: string }
  readonly createdAt: string
  readonly updatedAt: string
  readonly turnCount: number
  readonly state: TState
}
export interface SessionCodec<TState> {
  encode(record: SessionRecord<TState>): string
  decodeCanonical(raw: string, address: SessionAddress): SessionRecord<TState>
  decodeLegacy(raw: string, input: {
    readonly address: SessionAddress
    readonly now: Date
    readonly sessionId: string
  }): SessionRecord<TState>
}

export interface SessionSummary {
  readonly address: SessionAddress
  readonly sessionId: string
  readonly startedBy: SessionRecord<unknown>['startedBy']
  readonly createdAt: string
  readonly updatedAt: string
  readonly turnCount: number
  readonly source: 'canonical' | 'legacy'
}

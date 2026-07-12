import type { SessionAddress } from '../contracts/identity.js'
import type { AbortOptions, ListOptions, SaveOptions } from '../contracts/storage.js'
import type { SessionRecord, SessionSummary } from './session-record.js'

export interface SessionStore<TState> {
  get(address: SessionAddress, options?: AbortOptions): Promise<SessionRecord<TState> | null>
  save(record: SessionRecord<TState>, options?: SaveOptions): Promise<void>
  delete(address: SessionAddress, options?: AbortOptions): Promise<boolean>
  list(query: { readonly botId: string }, options?: ListOptions): AsyncIterable<SessionSummary>
  deleteAll(query: { readonly botId: string }, options?: AbortOptions): Promise<number>
  fork(
    source: SessionAddress,
    target: SessionAddress,
    startedBy: SessionRecord<TState>['startedBy'],
    options?: SaveOptions
  ): Promise<SessionRecord<TState>>
}

import type { ToolErrorCode, ToolSuccessEffect } from './tool-result.js'

export interface IdempotencyRecord {
  readonly schemaVersion: 1
  readonly key: string
  readonly toolName: string
  readonly toolVersion: 1
  readonly runIdHash: string
  readonly callIdHash: string
  readonly startedAt: string
}

export type StoredToolOutcome =
  | {
      readonly status: 'success'
      readonly effect: ToolSuccessEffect
      readonly completedAt: string
    }
  | {
      readonly status: 'failed'
      readonly effect: 'none'
      readonly errorCode: ToolErrorCode
      readonly completedAt: string
    }

export type IdempotencyReservation =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'running' }
  | { readonly kind: 'completed'; readonly outcome: StoredToolOutcome }
  | { readonly kind: 'indeterminate' }

export interface IdempotencyStore {
  reserve(record: IdempotencyRecord, ttlSeconds: number): Promise<IdempotencyReservation>
  complete(key: string, result: StoredToolOutcome, ttlSeconds: number): Promise<void>
  markIndeterminate(key: string, ttlSeconds: number): Promise<void>
}

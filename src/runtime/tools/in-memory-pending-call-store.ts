import type { PendingCallStore, PendingToolCall } from '../../agent/tools/pending-call-store.js'

export interface InMemoryPendingCallStoreOptions {
  readonly now: () => number
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxTotalBytes: number
  readonly ttlMs: number
}

interface StoredPendingCall {
  readonly call: PendingToolCall
  readonly bytes: number
  readonly expiresAtMs: number
}

function positiveInteger (value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function deepFreeze (value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    value.forEach(deepFreeze)
    return Object.freeze(value)
  }
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function clonePendingCall (raw: string): PendingToolCall {
  const value = JSON.parse(raw) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('pending call is invalid')
  const call = value as Record<string, unknown>
  const keys = [
    'schemaVersion', 'pendingCallId', 'toolName', 'toolVersion', 'profile', 'call',
    'input', 'intent', 'argumentHash', 'createdAt', 'expiresAt'
  ]
  if (Object.keys(call).length !== keys.length || Object.keys(call).some(key => !keys.includes(key)) ||
    call.schemaVersion !== 1 || call.toolVersion !== 1 || typeof call.pendingCallId !== 'string' ||
    typeof call.argumentHash !== 'string') throw new TypeError('pending call is invalid')
  return deepFreeze(value) as PendingToolCall
}

export class InMemoryPendingCallStore implements PendingCallStore {
  readonly #now: () => number
  readonly #maxEntries: number
  readonly #maxEntryBytes: number
  readonly #maxTotalBytes: number
  readonly #ttlMs: number
  readonly #entries = new Map<string, StoredPendingCall>()
  #totalBytes = 0

  constructor (options: InMemoryPendingCallStoreOptions) {
    this.#now = options.now
    this.#maxEntries = positiveInteger(options.maxEntries, 'max entries')
    this.#maxEntryBytes = positiveInteger(options.maxEntryBytes, 'max entry bytes')
    this.#maxTotalBytes = positiveInteger(options.maxTotalBytes, 'max total bytes')
    this.#ttlMs = positiveInteger(options.ttlMs, 'TTL')
  }

  put (call: PendingToolCall): void {
    this.#purgeExpired()
    let raw: string
    try {
      raw = JSON.stringify(call)
    } catch {
      throw new TypeError('pending call is not serializable')
    }
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (bytes > this.#maxEntryBytes || bytes > this.#maxTotalBytes) {
      throw new RangeError('pending call exceeds byte limit')
    }
    const cloned = clonePendingCall(raw)
    this.delete(cloned.pendingCallId)
    while (this.#entries.size >= this.#maxEntries || this.#totalBytes + bytes > this.#maxTotalBytes) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.delete(oldest)
    }
    this.#entries.set(cloned.pendingCallId, {
      call: cloned,
      bytes,
      expiresAtMs: this.#now() + this.#ttlMs
    })
    this.#totalBytes += bytes
  }

  take (pendingCallId: string, argumentHash: string): PendingToolCall | null {
    this.#purgeExpired()
    const stored = this.#entries.get(pendingCallId)
    if (stored === undefined || stored.call.argumentHash !== argumentHash) return null
    this.delete(pendingCallId)
    return stored.call
  }

  delete (pendingCallId: string): boolean {
    const stored = this.#entries.get(pendingCallId)
    if (stored === undefined) return false
    this.#entries.delete(pendingCallId)
    this.#totalBytes -= stored.bytes
    return true
  }

  #purgeExpired (): void {
    const now = this.#now()
    for (const [id, stored] of this.#entries) {
      if (stored.expiresAtMs <= now) this.delete(id)
    }
  }
}

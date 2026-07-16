import { randomUUID } from 'node:crypto'
import { AgentError } from '../contracts/error.js'
import type { SessionAddress } from '../contracts/identity.js'
import {
  canonicalSessionKey,
  parseCanonicalSessionKey
} from '../session/conversation-scope.js'
import { parseRunCheckpoint, type RunCheckpoint } from './run-checkpoint.js'
import {
  acquireAdmissionClaim,
  redisAdmissionKey,
  recoverAdmissionClaim,
  releaseAdmissionClaim,
  type RedisRunClient
} from './redis-run-store.js'
import { isTerminalRunStatus } from './run-state.js'

export interface RunLease {
  readonly leaseId: string
  readonly sessionAddress: SessionAddress
  release(): Promise<void>
}

export interface RunAdmissionOptions {
  readonly client: RedisRunClient
  readonly generateId?: () => string
  readonly leaseTtlSeconds?: number
}

interface AdmissionWaiter {
  readonly address: SessionAddress
  readonly sessionKey: string
  readonly signal?: AbortSignal
  readonly recovery: boolean
  readonly resolve: (lease: RunLease) => void
  readonly reject: (error: unknown) => void
  onAbort?: () => void
}

const MAX_ACTIVE_RUNS = 2
const MAX_QUEUED_RUNS = 3
const DEFAULT_LEASE_TTL_SECONDS = 600
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export class RunAdmissionRejectionError extends AgentError {
  readonly rejectionReason: 'queue_full' | 'queue_aborted'

  constructor (rejectionReason: 'queue_full' | 'queue_aborted') {
    super({
      code: rejectionReason === 'queue_full' ? 'run_budget_exceeded' : 'cancelled',
      stage: 'run.admission',
      retryable: false,
      userMessage: rejectionReason === 'queue_full'
        ? '当前任务队列已满，请稍后重试。'
        : '操作已取消。'
    })
    this.name = 'RunAdmissionRejectionError'
    this.rejectionReason = rejectionReason
  }
}

function cancelled (): RunAdmissionRejectionError {
  return new RunAdmissionRejectionError('queue_aborted')
}

function queueFull (): RunAdmissionRejectionError {
  return new RunAdmissionRejectionError('queue_full')
}

function invalidCheckpoint (cause: unknown): AgentError {
  return new AgentError({
    code: 'checkpoint_invalid',
    stage: 'run.admission',
    retryable: false,
    userMessage: '任务状态已损坏或不兼容，请重新发起。',
    cause
  })
}

export class RunAdmission {
  readonly #client: RedisRunClient
  readonly #generateId: () => string
  readonly #leaseTtlSeconds: number
  readonly #active = new Map<string, { readonly sessionKey: string; readonly lease: RunLease }>()
  readonly #activeSessions = new Set<string>()
  readonly #queue: AdmissionWaiter[] = []
  #starting = 0
  #draining = false

  constructor (options: RunAdmissionOptions) {
    this.#client = options.client
    this.#generateId = options.generateId ?? randomUUID
    this.#leaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
    if (!Number.isSafeInteger(this.#leaseTtlSeconds) ||
      this.#leaseTtlSeconds < 300 || this.#leaseTtlSeconds > 86_400) {
      throw new TypeError('run admission lease TTL is invalid')
    }
  }

  get activeCount (): number {
    return this.#active.size
  }

  get queuedCount (): number {
    return this.#queue.length
  }

  async acquire (
    address: SessionAddress,
    signal?: AbortSignal
  ): Promise<RunLease> {
    if (signal?.aborted === true) throw cancelled()
    const normalizedAddress = this.#normalizeAddress(address)
    const sessionKey = redisAdmissionKey(normalizedAddress)
    if (this.#canStart(sessionKey)) {
      const lease = await this.#tryStart(normalizedAddress, sessionKey)
      if (lease !== null) return lease
    }
    return await this.#enqueue(normalizedAddress, sessionKey, false, signal)
  }

  async recover (
    checkpoint: RunCheckpoint,
    signal?: AbortSignal
  ): Promise<RunLease> {
    let parsed: RunCheckpoint
    try {
      parsed = parseRunCheckpoint(checkpoint)
      if (isTerminalRunStatus(parsed.status)) {
        throw new TypeError('terminal runs cannot recover an admission lease')
      }
    } catch (error) {
      throw invalidCheckpoint(error)
    }
    if (signal?.aborted === true) throw cancelled()
    const normalizedAddress = this.#normalizeAddress(parsed.sessionAddress)
    const sessionKey = redisAdmissionKey(normalizedAddress)
    if (this.#canStart(sessionKey)) {
      const lease = await this.#tryStart(normalizedAddress, sessionKey, true)
      if (lease !== null) return lease
    }
    return await this.#enqueue(normalizedAddress, sessionKey, true, signal)
  }

  #normalizeAddress (address: SessionAddress): SessionAddress {
    const parsed = parseCanonicalSessionKey(canonicalSessionKey(address))
    if (parsed === null) throw new TypeError('run admission address is invalid')
    return Object.freeze({
      botId: parsed.botId,
      scope: Object.freeze({ ...parsed.scope })
    })
  }

  #canStart (sessionKey: string): boolean {
    return this.#active.size + this.#starting < MAX_ACTIVE_RUNS &&
      !this.#activeSessions.has(sessionKey)
  }

  async #tryStart (
    address: SessionAddress,
    sessionKey: string,
    recovery = false
  ): Promise<RunLease | null> {
    if (!this.#canStart(sessionKey)) return null
    const leaseId = this.#generateId()
    if (!LEASE_ID.test(leaseId) || this.#active.has(leaseId)) {
      throw new TypeError('run lease ID is invalid')
    }
    this.#starting += 1
    try {
      if (recovery) {
        await recoverAdmissionClaim(
          this.#client,
          sessionKey,
          leaseId,
          this.#leaseTtlSeconds
        )
      } else {
        const claimed = await acquireAdmissionClaim(
          this.#client,
          sessionKey,
          leaseId,
          this.#leaseTtlSeconds
        )
        if (!claimed) return null
      }
      let released = false
      const lease: RunLease = Object.freeze({
        leaseId,
        sessionAddress: address,
        release: async (): Promise<void> => {
          if (released) return
          released = true
          let releaseError: unknown
          try {
            await releaseAdmissionClaim(this.#client, sessionKey, leaseId)
          } catch (error) {
            releaseError = error
          } finally {
            this.#active.delete(leaseId)
            this.#activeSessions.delete(sessionKey)
            await this.#drain()
          }
          if (releaseError !== undefined) throw releaseError
        }
      })
      this.#active.set(leaseId, { sessionKey, lease })
      this.#activeSessions.add(sessionKey)
      return lease
    } finally {
      this.#starting -= 1
    }
  }

  async #enqueue (
    address: SessionAddress,
    sessionKey: string,
    recovery: boolean,
    signal?: AbortSignal
  ): Promise<RunLease> {
    if (this.#queue.length >= MAX_QUEUED_RUNS) throw queueFull()
    return await new Promise<RunLease>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        address, sessionKey, recovery, signal, resolve, reject
      }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter)
          if (index >= 0) this.#queue.splice(index, 1)
          reject(cancelled())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#queue.push(waiter)
      if (signal?.aborted === true) waiter.onAbort?.()
    })
  }

  async #drain (): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      while (this.#queue.length > 0 &&
        this.#active.size + this.#starting < MAX_ACTIVE_RUNS) {
        const waiter = this.#queue[0]
        if (waiter === undefined) return
        if (waiter.signal?.aborted === true) {
          this.#queue.shift()
          waiter.signal.removeEventListener('abort', waiter.onAbort ?? (() => undefined))
          waiter.reject(cancelled())
          continue
        }
        if (this.#activeSessions.has(waiter.sessionKey)) return
        this.#queue.shift()
        if (waiter.onAbort !== undefined) {
          waiter.signal?.removeEventListener('abort', waiter.onAbort)
        }
        try {
          const lease = await this.#tryStart(
            waiter.address,
            waiter.sessionKey,
            waiter.recovery
          )
          if (lease === null) {
            if (waiter.onAbort !== undefined) {
              waiter.signal?.addEventListener('abort', waiter.onAbort, { once: true })
            }
            this.#queue.unshift(waiter)
            return
          }
          waiter.resolve(lease)
        } catch (error) {
          waiter.reject(error)
        }
      }
    } finally {
      this.#draining = false
    }
  }
}

import { randomBytes } from 'node:crypto'
import { ACTIVITY_LIMITS, ActivityStore, pruneActivities, type GroupActivity } from './ActivityStore.js'
import { activityNotification } from './GroupActivityService.js'

export interface ActivityDispatchLease {
  authorize(signal: AbortSignal): Promise<'allowed' | 'revoked' | 'unavailable'>
  deliver(text: string, signal: AbortSignal): Promise<'sent' | 'failed_definite' | 'outcome_unknown'>
  release(): Promise<void>
}
export interface ActivityWorkerOptions {
  store: ActivityStore
  now?: () => number
  acquire(record: Readonly<GroupActivity>, signal: AbortSignal): Promise<ActivityDispatchLease | null>
  onFailure?: () => void
}

/** Bounded durable dispatch. A persisted dispatch marker is never replayed after a crash. */
export class ActivityWorker {
  readonly #now: () => number
  readonly #abort = new AbortController()
  #timer: ReturnType<typeof setInterval> | null = null
  #active: Promise<number> | null = null
  #closed = false
  constructor (readonly options: ActivityWorkerOptions) { this.#now = options.now ?? Date.now }
  start (): void {
    if (this.#closed || this.#timer !== null) return
    this.#timer = setInterval(() => { void this.tick() }, 5000)
    this.#timer.unref()
    void this.tick()
  }
  async close (): Promise<void> {
    this.#closed = true
    this.#abort.abort()
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    await this.#active
  }
  async tick (): Promise<number> {
    if (this.#closed) return 0
    if (this.#active !== null) return await this.#active
    this.#active = this.#run().catch(() => { try { this.options.onFailure?.() } catch {} return 0 })
    try { return await this.#active } finally { this.#active = null }
  }
  async #run (): Promise<number> {
    const now = this.#now()
    const current = await this.options.store.read()
    // Future tasks dominate production. Do not reserialize or CAS an unchanged key.
    if (!current.records.some(r => (r.state === 'pending' && r.dueAt <= now) ||
      ((r.state === 'claimed' || r.state === 'dispatching') && r.leaseUntil <= now) ||
      (!['pending', 'claimed', 'dispatching'].includes(r.state) && now - r.updatedAt >= ACTIVITY_LIMITS.retentionMs))) return 0
    const due = await this.options.store.update(data => {
      pruneActivities(data, now)
      for (const r of data.records) {
        if ((r.state === 'claimed' || r.state === 'dispatching') && r.leaseUntil <= now) {
          r.state = r.state === 'claimed' ? 'pending' : 'indeterminate'
          r.updatedAt = now
          r.token = ''
        }
        if (r.kind === 'reminder' && r.state === 'pending' && r.dueAt < now - 86400000) {
          // Do not surprise a group with notifications more than a day old.
          r.state = 'expired'
          r.updatedAt = now
        }
      }
      const groups = new Set<string>()
      return [...data.records].sort((a, b) => a.dueAt - b.dueAt).filter(r => {
        const group = `${r.botId}:${r.groupId}`
        if (r.state !== 'pending' || r.dueAt > now || groups.has(group)) return false
        groups.add(group)
        return true
      }).slice(0, 1).map(r => r.id)
    }, this.#abort.signal)
    let sent = 0
    for (const id of due) {
      if (this.#closed) break
      const token = randomBytes(16).toString('hex')
      const r = await this.options.store.update(data => {
        const record = data.records.find(r => r.id === id)
        if (record?.state !== 'pending' || record.dueAt > this.#now()) return null
        record.state = 'claimed'
        record.token = token
        record.leaseUntil = this.#now() + ACTIVITY_LIMITS.leaseMs
        record.updatedAt = this.#now()
        return structuredClone(record)
      }, this.#abort.signal)
      if (r === null) continue
      let lease: ActivityDispatchLease | null = null
      let dispatched = false
      try {
        const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(45000)])
        lease = await this.options.acquire(r, signal)
        if (lease === null) { await this.#finish(id, token, 'pending'); continue }
        const authority = await lease.authorize(signal)
        if (authority !== 'allowed') { await this.#finish(id, token, authority === 'revoked' ? 'cancelled' : 'pending'); continue }
        signal.throwIfAborted()
        dispatched = await this.options.store.update(data => {
          const current = data.records.find(r => r.id === id)
          if (current?.state !== 'claimed' || current.token !== token || current.leaseUntil <= this.#now()) return false
          current.state = 'dispatching'
          current.updatedAt = this.#now()
          return true
        }, signal)
        if (!dispatched) continue
        const outcome = await lease.deliver(activityNotification(r), signal)
        await this.#finish(id, token, outcome === 'sent' ? 'completed' : outcome === 'failed_definite' ? 'failed' : 'indeterminate')
        if (outcome === 'sent') sent++
      } catch {
        // The CAS itself may have committed before transport failure. Never reset a possible dispatch.
        await this.#finish(id, token, dispatched ? 'indeterminate' : 'pending').catch(() => undefined)
      } finally { await lease?.release().catch(() => undefined) }
    }
    return sent
  }
  async #finish (id: string, token: string, state: GroupActivity['state']): Promise<void> {
    await this.options.store.update(data => {
      const r = data.records.find(r => r.id === id)
      if (r === undefined || r.token !== token || !['claimed', 'dispatching'].includes(r.state)) return
      let nextState = state
      if (r.state === 'dispatching' && nextState === 'pending') nextState = 'indeterminate'
      if (nextState === 'completed' && r.kind === 'reminder' && r.intervalMs > 0 && r.remaining > 1) {
        const elapsed = Math.max(1, Math.floor((this.#now() - r.dueAt) / r.intervalMs) + 1)
        r.remaining = Math.max(0, r.remaining - elapsed)
        r.dueAt += r.intervalMs * elapsed
        nextState = r.remaining > 0 ? 'pending' : 'completed'
      } else if (nextState === 'completed') nextState = r.remaining === 0 ? 'cancelled' : 'completed'
      r.state = nextState
      r.token = ''
      r.leaseUntil = 0
      r.updatedAt = this.#now()
    })
  }
}

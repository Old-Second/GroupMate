import { isTrustedParticipationEvent, type ParticipationEvent } from './ParticipationContract.js'

export const PARTICIPATION_LIMITS = Object.freeze({ scopes: 64, candidates: 32, bytes: 512 * 1_024, scopeTtlMs: 600_000, candidateTtlMs: 15_000, continuationMs: 120_000 })
export interface ParticipationCandidate {
  readonly scopeRef: string
  readonly actorRef: string
  readonly messageRef: string
  readonly revision: number
  readonly expiresAt: number
  readonly source: 'direct' | 'continuation' | 'sampled'
}
interface ScopeState {
  touchedAt: number
  access: number
  recentActor: string | null
  repliedAt: number | null
  candidate: ParticipationCandidate | null
}

export class ParticipationState {
  readonly #scopes = new Map<string, ScopeState>()
  #candidateCount = 0
  #revision = 0
  #closed = false
  #lastNow = 0
  #lastPrunedAt = -1
  #access = 0

  constructor (readonly now: () => number) {}

  #time (): number {
    const time = this.now()
    if (!Number.isSafeInteger(time) || time < this.#lastNow) throw new TypeError('participation clock invalid')
    this.#lastNow = time
    return time
  }

  #prune (time: number): void {
    if (time === this.#lastPrunedAt) return
    this.#lastPrunedAt = time
    for (const [key, value] of this.#scopes) {
      if (time - value.touchedAt >= PARTICIPATION_LIMITS.scopeTtlMs) this.#drop(key)
      else if (value.candidate !== null && value.candidate.expiresAt <= time) {
        value.candidate = null
        this.#candidateCount--
      }
    }
  }

  #drop (key: string): void {
    if (this.#scopes.get(key)?.candidate != null) this.#candidateCount--
    this.#scopes.delete(key)
  }

  observe (event: ParticipationEvent): boolean {
    if (this.#closed || !isTrustedParticipationEvent(event)) return false
    const time = this.#time()
    this.#prune(time)
    if (event.at > time || time - event.at >= PARTICIPATION_LIMITS.candidateTtlMs) return false
    const existing = this.#scopes.get(event.scopeRef)
    const state = existing ?? { touchedAt: time, access: 0, recentActor: null, repliedAt: null, candidate: null }
    const continuation = state.recentActor === event.actorRef && state.repliedAt !== null &&
      time - state.repliedAt < PARTICIPATION_LIMITS.continuationMs
    // A later ordinary message supersedes only a passive candidate, never an explicit task.
    if (state.candidate !== null && state.candidate.source !== 'direct' && state.candidate.messageRef !== event.messageRef) {
      state.candidate = null
      this.#candidateCount--
    }
    state.touchedAt = time
    state.access = ++this.#access
    this.#scopes.set(event.scopeRef, state)
    if (this.#scopes.size > PARTICIPATION_LIMITS.scopes) {
      let victim = event.scopeRef
      let access = state.access
      for (const [key, value] of this.#scopes) {
        if (value.access < access) { victim = key; access = value.access }
      }
      this.#drop(victim)
    }
    return continuation
  }

  offer (event: ParticipationEvent, source: ParticipationCandidate['source']): ParticipationCandidate | null {
    if (this.#closed || !isTrustedParticipationEvent(event)) return null
    const time = this.#time()
    this.#prune(time)
    const scope = this.#scopes.get(event.scopeRef)
    if (scope === undefined || event.at > time || time - event.at >= PARTICIPATION_LIMITS.candidateTtlMs) return null
    if (scope.candidate?.source === 'direct') return scope.candidate
    if (scope.candidate?.messageRef === event.messageRef) return scope.candidate
    if (this.#revision === Number.MAX_SAFE_INTEGER) return null
    if (scope.candidate === null && this.#candidateCount >= PARTICIPATION_LIMITS.candidates) {
      let evicted = false
      for (const [key, value] of this.#scopes) {
        if (value.candidate !== null && value.candidate.source !== 'direct') {
          value.candidate = null
          this.#candidateCount--
            evicted = true
          break
        }
      }
      if (!evicted) return null
    }
    const candidate = Object.freeze({ scopeRef: event.scopeRef, actorRef: event.actorRef, messageRef: event.messageRef,
      revision: ++this.#revision, expiresAt: event.at + PARTICIPATION_LIMITS.candidateTtlMs, source })
    if (scope.candidate === null) this.#candidateCount++
    scope.candidate = candidate
    return candidate
  }

  current (candidate: ParticipationCandidate): 'current' | 'obsolete' | 'unavailable' {
    if (this.#closed) return 'unavailable'
    const time = this.#time()
    this.#prune(time)
    const scope = this.#scopes.get(candidate.scopeRef)
    if (scope === undefined) return 'unavailable'
    return candidate.expiresAt > time && scope.candidate === candidate ? 'current' : 'obsolete'
  }

  replied (candidate: ParticipationCandidate): void {
    if (this.current(candidate) !== 'current') return
    const scope = this.#scopes.get(candidate.scopeRef)!
    scope.recentActor = candidate.actorRef
    scope.repliedAt = this.#time()
    scope.candidate = null
    this.#candidateCount--
  }

  /** Release only this exact candidate; a late completion must not erase a newer route. */
  discard (candidate: ParticipationCandidate): void {
    const scope = this.#scopes.get(candidate.scopeRef)
    if (scope?.candidate !== candidate) return
    scope.candidate = null
    this.#candidateCount--
  }

  stats (): Readonly<{ scopes: number; candidates: number; bytes: number }> {
    this.#prune(this.#time())
    return Object.freeze({ scopes: this.#scopes.size,
      candidates: this.#candidateCount,
      // Conservative UTF-8 serialized bound: exact 64-byte refs, safe integer clocks,
      // fixed field names and enum strings. Avoid serializing all scopes per message.
      bytes: this.#scopes.size * 320 + this.#candidateCount * 384 + 2 })
  }

  close (): void { this.#closed = true; this.#scopes.clear(); this.#candidateCount = 0 }
}

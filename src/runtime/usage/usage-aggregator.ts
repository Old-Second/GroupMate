import type { ConversationScope } from '../../agent/contracts/identity.js'
import {
  parsePresentationCost,
  type PresentationModelCostV1
} from '../../agent/contracts/presentation-trace.js'
import type { RunContentJournalEvent } from '../../agent/run/run-content-journal.js'
import { parseRunUsageSummary, type RunUsageSummaryV1 } from '../../agent/run/run-usage.js'
import type { ObservabilityLevel } from '../observability/trace-policy.js'

/**
 * Token and reference-cost totals grouped by billing day, group and actor.
 *
 * This module deliberately sits outside `observability/`: that directory is the
 * redacted surface audited against identity fields, while aggregation needs the
 * real group and user identifiers as map keys. The boundary is kept here instead —
 * identity never reaches a metric label, never leaves this bounded in-memory
 * window, and every projected row carries a masked identifier, so a snapshot can
 * be rendered to the owner or written to a log without leaking one.
 */
export const USAGE_AGGREGATE_LIMITS = Object.freeze({
  maxDays: 7,
  maxGroupsPerDay: 32,
  maxActorsPerDay: 64,
  maxRows: 16,
  maxIdentifierLength: 64
})

const MASK_PREFIX = '****'
const MASK_VISIBLE_CHARS = 4
const BEIJING_OFFSET_MS = 8 * 3_600_000

export function usageAggregationEnabled (
  config: Readonly<Record<string, unknown>>
): boolean {
  return config.usageAggregationEnabled !== false
}

export interface UsageAggregateInputV1 {
  readonly occurredAt: string
  readonly botId: string
  /** `group_user` is folded into `group`: the speaker is carried by `actorId`. */
  readonly scope:
    | { readonly kind: 'group'; readonly groupId: string }
    | { readonly kind: 'private'; readonly userId: string }
  /** Group speaker; `null` when the run has no attributable actor. */
  readonly actorId: string | null
  readonly usage: RunUsageSummaryV1
}

export interface UsageTotalsV1 {
  readonly runs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheHitTokens: number
  readonly cacheMissTokens: number
  readonly availability: RunUsageSummaryV1['availability']
  readonly cost: PresentationModelCostV1
}

export interface UsageDayRowV1 {
  readonly day: string
  readonly totals: UsageTotalsV1
}

export interface UsageScopeRowV1 {
  readonly day: string
  readonly maskedId: string
  readonly totals: UsageTotalsV1
}

export interface UsageAggregateSnapshotV1 {
  readonly schemaVersion: 1
  readonly windowStartedAt: string
  readonly windowResetCount: number
  readonly observedRuns: number
  readonly rejectedRuns: number
  readonly droppedGroupRuns: number
  readonly droppedActorRuns: number
  /**
   * Every run observed since the window opened, including days that have already
   * rolled out of `days`, so it is a true running total rather than the sum of the
   * rows below.
   */
  readonly total: UsageTotalsV1
  readonly days: readonly UsageDayRowV1[]
  readonly groups: readonly UsageScopeRowV1[]
  readonly actors: readonly UsageScopeRowV1[]
  /** Rows the row cap left out of `groups` and `actors`, so truncation is visible. */
  readonly omittedGroupRows: number
  readonly omittedActorRows: number
}

/**
 * Keeps the trailing characters only. The owner can still tell two groups apart
 * while neither a reply nor a log line carries a complete identifier.
 */
export function maskUsageIdentifier (value: string): string {
  if (typeof value !== 'string' || value.length <= MASK_VISIBLE_CHARS) return MASK_PREFIX
  return `${MASK_PREFIX}${value.slice(-MASK_VISIBLE_CHARS)}`
}

/** Billing day in Asia/Shanghai, matching the DeepSeek peak and off-peak calendar. */
export function usageBillingDay (occurredAt: string): string {
  const instant = Date.parse(occurredAt)
  if (!Number.isFinite(instant)) throw new TypeError('usage occurrence is invalid')
  return new Date(instant + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

function boundedIdentifier (value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 ||
    value.length > USAGE_AGGREGATE_LIMITS.maxIdentifierLength) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function safeSum (left: number, right: number, label: string): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new RangeError(`${label} exceeded safe integer range`)
  return sum
}

function unavailableCost (catalogVersion: string | null): PresentationModelCostV1 {
  return Object.freeze({ kind: 'unavailable', catalogVersion, billingAuthority: false })
}

/**
 * Same degradation rules as the per-run accumulation in `run-usage.ts`: a missing
 * quote or a different catalog version makes the whole total unavailable rather
 * than silently mixing incomparable prices, and any upper bound dominates.
 */
function mergeCost (
  prior: PresentationModelCostV1 | undefined,
  next: PresentationModelCostV1 | undefined
): PresentationModelCostV1 {
  if (next === undefined || next.kind === 'unavailable') {
    return unavailableCost(next?.catalogVersion ?? prior?.catalogVersion ?? null)
  }
  if (prior === undefined) return next
  if (prior.kind === 'unavailable' || prior.catalogVersion !== next.catalogVersion) {
    return unavailableCost(prior.kind === 'unavailable' ? prior.catalogVersion : null)
  }
  return parsePresentationCost({
    kind: prior.kind === 'upper_bound' || next.kind === 'upper_bound' ? 'upper_bound' : 'exact',
    currency: 'CNY',
    billingAuthority: false,
    catalogVersion: next.catalogVersion,
    picoYuan: (BigInt(prior.picoYuan) + BigInt(next.picoYuan)).toString(10)
  })
}

function mergeAvailability (
  prior: RunUsageSummaryV1['availability'],
  next: RunUsageSummaryV1['availability']
): RunUsageSummaryV1['availability'] {
  if (prior === 'unavailable' || next === 'unavailable') return 'unavailable'
  return prior === 'partial' || next === 'partial' ? 'partial' : 'complete'
}

interface MutableTotals {
  runs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  availability: RunUsageSummaryV1['availability']
  cost: PresentationModelCostV1 | undefined
}

function createTotals (): MutableTotals {
  return {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    availability: 'complete',
    cost: undefined
  }
}

function accumulate (target: MutableTotals, usage: RunUsageSummaryV1): void {
  const merged = target.runs === 0
    ? mergeCost(undefined, usage.cost)
    : mergeCost(target.cost, usage.cost)
  target.runs = safeSum(target.runs, 1, 'usage run count')
  target.inputTokens = safeSum(target.inputTokens, usage.inputTokens, 'usage input tokens')
  target.outputTokens = safeSum(target.outputTokens, usage.outputTokens, 'usage output tokens')
  target.totalTokens = safeSum(target.totalTokens, usage.totalTokens, 'usage total tokens')
  target.cacheHitTokens = safeSum(
    target.cacheHitTokens,
    usage.cacheHitTokens,
    'usage cache hit tokens'
  )
  target.cacheMissTokens = safeSum(
    target.cacheMissTokens,
    usage.cacheMissTokens,
    'usage cache miss tokens'
  )
  target.availability = mergeAvailability(target.availability, usage.availability)
  target.cost = merged
}

function freezeTotals (totals: MutableTotals): UsageTotalsV1 {
  const { cost, ...counts } = totals
  return Object.freeze({ ...counts, cost: cost ?? unavailableCost(null) })
}

/**
 * Projects the one journal event that carries identity, terminal token counts and
 * reference cost together. Returns `null` for every other event type.
 */
export function projectUsageAggregateInput (
  event: RunContentJournalEvent
): UsageAggregateInputV1 | null {
  if (event?.type !== 'run.terminal_committed') return null
  const checkpoint = event.checkpoint
  const scope: ConversationScope = checkpoint.sessionAddress.scope
  const routedActor = checkpoint.presentationRoute?.actorId
  const scopedActor = scope.kind === 'group' ? undefined : scope.userId
  const actorId = routedActor !== undefined && routedActor.length > 0
    ? routedActor
    : scopedActor ?? null
  return Object.freeze({
    occurredAt: event.occurredAt,
    botId: boundedIdentifier(checkpoint.sessionAddress.botId, 'usage bot ID'),
    scope: scope.kind === 'private'
      ? Object.freeze({
          kind: 'private' as const,
          userId: boundedIdentifier(scope.userId, 'usage user ID')
        })
      : Object.freeze({
          kind: 'group' as const,
          groupId: boundedIdentifier(scope.groupId, 'usage group ID')
        }),
    actorId: actorId === null ? null : boundedIdentifier(actorId, 'usage actor ID'),
    usage: parseRunUsageSummary(checkpoint.usage)
  })
}

class BoundedKeySet {
  readonly #values = new Set<string>()
  readonly #capacity: number

  constructor (capacity: number) {
    this.#capacity = capacity
  }

  accept (value: string): boolean {
    if (this.#values.has(value)) return false
    this.#values.add(value)
    if (this.#values.size > this.#capacity) {
      const oldest = this.#values.values().next().value
      if (oldest !== undefined) this.#values.delete(oldest)
    }
    return true
  }

  clear (): void {
    this.#values.clear()
  }
}

interface ScopeEntry {
  readonly day: string
  readonly botId: string
  readonly id: string
  readonly totals: MutableTotals
}

export class UsageAggregator {
  readonly #now: () => Date
  readonly #days = new Map<string, MutableTotals>()
  readonly #groups = new Map<string, ScopeEntry>()
  readonly #actors = new Map<string, ScopeEntry>()
  readonly #seenRuns = new BoundedKeySet(256)
  #total = createTotals()
  #currentLevel: ObservabilityLevel = 'basic'
  #windowStartedAt: string
  #windowResetCount = 0
  #observedRuns = 0
  #rejectedRuns = 0
  #droppedGroupRuns = 0
  #droppedActorRuns = 0

  constructor (options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date())
    this.#windowStartedAt = this.#safeNow()
  }

  /** Best-effort projection hook; a rejected event never reaches the totals. */
  record (event: RunContentJournalEvent): void {
    if (this.#currentLevel === 'off') return
    let input: UsageAggregateInputV1 | null
    try {
      input = projectUsageAggregateInput(event)
    } catch {
      this.#rejectedRuns += 1
      return
    }
    if (input === null) return
    this.accept(input, event.runRef)
  }

  accept (input: UsageAggregateInputV1, dedupeKey: string): void {
    if (this.#currentLevel === 'off') return
    let day: string
    try {
      day = usageBillingDay(input.occurredAt)
    } catch {
      this.#rejectedRuns += 1
      return
    }
    if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) {
      this.#rejectedRuns += 1
      return
    }
    if (!this.#seenRuns.accept(dedupeKey)) return
    const dayTotals = this.#acceptDay(day)
    if (dayTotals === null) {
      this.#rejectedRuns += 1
      return
    }
    this.#observedRuns += 1
    accumulate(this.#total, input.usage)
    accumulate(dayTotals, input.usage)
    const groupId = input.scope.kind === 'private' ? null : input.scope.groupId
    if (groupId !== null) {
      const totals = this.#acceptScope(
        this.#groups,
        USAGE_AGGREGATE_LIMITS.maxGroupsPerDay,
        day,
        input.botId,
        groupId
      )
      if (totals === null) this.#droppedGroupRuns += 1
      else accumulate(totals, input.usage)
    }
    if (input.actorId !== null) {
      const totals = this.#acceptScope(
        this.#actors,
        USAGE_AGGREGATE_LIMITS.maxActorsPerDay,
        day,
        input.botId,
        input.actorId
      )
      if (totals === null) this.#droppedActorRuns += 1
      else accumulate(totals, input.usage)
    }
  }

  setCurrentLevel (level: ObservabilityLevel): void {
    if (level === 'off' && this.#currentLevel !== 'off') this.#clear()
    this.#currentLevel = level
  }

  snapshot (): UsageAggregateSnapshotV1 {
    const groups = scopeRows(this.#groups)
    const actors = scopeRows(this.#actors)
    return Object.freeze({
      schemaVersion: 1,
      windowStartedAt: this.#windowStartedAt,
      windowResetCount: this.#windowResetCount,
      observedRuns: this.#observedRuns,
      rejectedRuns: this.#rejectedRuns,
      droppedGroupRuns: this.#droppedGroupRuns,
      droppedActorRuns: this.#droppedActorRuns,
      total: freezeTotals(this.#total),
      days: Object.freeze([...this.#days.entries()]
        .sort((left, right) => right[0].localeCompare(left[0]))
        .map(([day, totals]) => Object.freeze({ day, totals: freezeTotals(totals) }))),
      groups: groups.rows,
      actors: actors.rows,
      omittedGroupRows: groups.omitted,
      omittedActorRows: actors.omitted
    })
  }

  #acceptDay (day: string): MutableTotals | null {
    const existing = this.#days.get(day)
    if (existing !== undefined) return existing
    if (this.#days.size >= USAGE_AGGREGATE_LIMITS.maxDays) {
      const oldest = [...this.#days.keys()].sort()[0]
      if (oldest === undefined || day < oldest) return null
      this.#days.delete(oldest)
      this.#forgetDay(oldest)
    }
    const created = createTotals()
    this.#days.set(day, created)
    return created
  }

  #acceptScope (
    entries: Map<string, ScopeEntry>,
    limit: number,
    day: string,
    botId: string,
    id: string
  ): MutableTotals | null {
    const key = `${day}\u0000${botId}\u0000${id}`
    const existing = entries.get(key)
    if (existing !== undefined) return existing.totals
    let sameDay = 0
    for (const entry of entries.values()) if (entry.day === day) sameDay += 1
    if (sameDay >= limit) return null
    const totals = createTotals()
    entries.set(key, { day, botId, id, totals })
    return totals
  }

  #forgetDay (day: string): void {
    for (const [key, entry] of this.#groups) {
      if (entry.day === day) this.#groups.delete(key)
    }
    for (const [key, entry] of this.#actors) {
      if (entry.day === day) this.#actors.delete(key)
    }
  }

  #clear (): void {
    this.#days.clear()
    this.#groups.clear()
    this.#actors.clear()
    this.#seenRuns.clear()
    this.#total = createTotals()
    this.#observedRuns = 0
    this.#rejectedRuns = 0
    this.#droppedGroupRuns = 0
    this.#droppedActorRuns = 0
    this.#windowResetCount += 1
    this.#windowStartedAt = this.#safeNow()
  }

  #safeNow (): string {
    try {
      return this.#now().toISOString()
    } catch {
      return new Date(0).toISOString()
    }
  }
}

function scopeRows (entries: ReadonlyMap<string, ScopeEntry>): Readonly<{
  rows: readonly UsageScopeRowV1[]
  omitted: number
}> {
  const sorted = [...entries.values()]
    .map(entry => Object.freeze({
      day: entry.day,
      maskedId: maskUsageIdentifier(entry.id),
      totals: freezeTotals(entry.totals)
    }))
    .sort((left, right) => (
      right.totals.totalTokens - left.totals.totalTokens ||
      right.day.localeCompare(left.day) ||
      left.maskedId.localeCompare(right.maskedId)
    ))
  return Object.freeze({
    rows: Object.freeze(sorted.slice(0, USAGE_AGGREGATE_LIMITS.maxRows)),
    omitted: Math.max(0, sorted.length - USAGE_AGGREGATE_LIMITS.maxRows)
  })
}

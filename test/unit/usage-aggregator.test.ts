import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunContentJournalEvent } from '../../src/agent/run/run-content-journal.js'
import type { RunUsageSummaryV1 } from '../../src/agent/run/run-usage.js'
import {
  USAGE_AGGREGATE_LIMITS,
  UsageAggregator,
  maskUsageIdentifier,
  projectUsageAggregateInput,
  usageBillingDay,
  type UsageAggregateInputV1,
  type UsageAggregateSnapshotV1,
  type UsageDayRowV1,
  type UsageScopeRowV1
} from '../../src/runtime/usage/usage-aggregator.js'

/**
 * Compile-time boundary: no projected row may grow an identity field. Adding one
 * degrades the declared type to `false` and `tsc` refuses the assignment, so the
 * runtime assertions below are never the only guard.
 */
type ForbiddenProjectedField = Extract<
keyof (UsageScopeRowV1 & UsageDayRowV1 & UsageAggregateSnapshotV1),
'botId' | 'groupId' | 'userId' | 'actorId' | 'displayName' | 'scope'
>
const FORBIDDEN_PROJECTED_FIELDS_EXCLUDED: ForbiddenProjectedField extends never
  ? true
  : false = true

const CATALOG = 'deepseek-cny-2026-10-10'
const GROUP_ID = '987654321012'
const ACTOR_ID = '123456789034'
const BOT_ID = '555500007777'

function usage (input: {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly picoYuan?: string | null
  readonly kind?: 'exact' | 'upper_bound'
  readonly catalogVersion?: string
  readonly partial?: boolean
} = {}): RunUsageSummaryV1 {
  const prompt = input.inputTokens ?? 100
  const completion = input.outputTokens ?? 50
  const partial = input.partial === true
  return Object.freeze({
    schemaVersion: 1,
    availability: partial ? 'partial' : 'complete',
    inputTokens: prompt,
    outputTokens: completion,
    totalTokens: prompt + completion,
    cacheHitTokens: partial ? 0 : Math.floor(prompt / 2),
    cacheMissTokens: partial ? 0 : prompt - Math.floor(prompt / 2),
    turnsWithUsage: 1,
    turnsWithoutUsage: partial ? 1 : 0,
    cacheUsageComplete: !partial,
    ...(input.picoYuan === null ? {} : {
      cost: Object.freeze({
        kind: input.kind ?? 'exact',
        currency: 'CNY',
        picoYuan: input.picoYuan ?? '1000',
        catalogVersion: input.catalogVersion ?? CATALOG,
        billingAuthority: false
      })
    })
  }) as RunUsageSummaryV1
}

function groupInput (input: {
  readonly occurredAt?: string
  readonly groupId?: string
  readonly actorId?: string | null
  readonly usage?: RunUsageSummaryV1
} = {}): UsageAggregateInputV1 {
  return Object.freeze({
    occurredAt: input.occurredAt ?? '2026-10-29T02:00:00.000Z',
    botId: BOT_ID,
    scope: Object.freeze({ kind: 'group', groupId: input.groupId ?? GROUP_ID }),
    actorId: input.actorId === undefined ? ACTOR_ID : input.actorId,
    usage: input.usage ?? usage()
  }) as UsageAggregateInputV1
}

test('aggregates runs by billing day group and actor from an offline fixture', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })

  aggregator.accept(groupInput(), 'run-1')
  aggregator.accept(groupInput({ usage: usage({ inputTokens: 20, outputTokens: 10 }) }), 'run-2')
  aggregator.accept(groupInput({
    groupId: '111122223333',
    actorId: '444455556666',
    occurredAt: '2026-10-28T02:00:00.000Z'
  }), 'run-3')

  const snapshot = aggregator.snapshot()
  assert.equal(snapshot.observedRuns, 3)
  assert.equal(snapshot.rejectedRuns, 0)
  assert.equal(snapshot.total.runs, 3)
  assert.equal(snapshot.total.totalTokens, 330)
  assert.deepEqual(snapshot.days.map(row => [row.day, row.totals.runs, row.totals.totalTokens]), [
    ['2026-10-29', 2, 180],
    ['2026-10-28', 1, 150]
  ])
  assert.deepEqual(
    snapshot.groups.map(row => [row.day, row.maskedId, row.totals.totalTokens]),
    [['2026-10-29', '****1012', 180], ['2026-10-28', '****3333', 150]]
  )
  assert.deepEqual(
    snapshot.actors.map(row => [row.day, row.maskedId, row.totals.totalTokens]),
    [['2026-10-29', '****9034', 180], ['2026-10-28', '****6666', 150]]
  )
  assert.deepEqual(snapshot.days[0]?.totals.cost, {
    kind: 'exact',
    currency: 'CNY',
    picoYuan: '2000',
    catalogVersion: CATALOG,
    billingAuthority: false
  })
})

test('a snapshot carries masked identifiers only and never a complete one', () => {
  assert.equal(FORBIDDEN_PROJECTED_FIELDS_EXCLUDED, true)
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  aggregator.accept(groupInput(), 'run-1')
  aggregator.accept(Object.freeze({
    occurredAt: '2026-10-29T02:00:00.000Z',
    botId: BOT_ID,
    scope: Object.freeze({ kind: 'private', userId: ACTOR_ID }),
    actorId: ACTOR_ID,
    usage: usage()
  }) as UsageAggregateInputV1, 'run-2')

  const serialized = JSON.stringify(aggregator.snapshot())
  for (const identifier of [GROUP_ID, ACTOR_ID, BOT_ID]) {
    assert.equal(serialized.includes(identifier), false)
  }
  assert.equal(serialized.includes('****1012'), true)
  assert.equal(serialized.includes('****9034'), true)
  assert.doesNotMatch(serialized, /botId|groupId|userId|displayName/)
})

test('masking keeps four trailing characters and hides anything shorter', () => {
  assert.equal(maskUsageIdentifier('987654321012'), '****1012')
  assert.equal(maskUsageIdentifier('12345'), '****2345')
  assert.equal(maskUsageIdentifier('1234'), '****')
  assert.equal(maskUsageIdentifier(''), '****')
})

test('the billing day follows Asia/Shanghai so it matches the price calendar', () => {
  assert.equal(usageBillingDay('2026-10-28T15:59:59.000Z'), '2026-10-28')
  assert.equal(usageBillingDay('2026-10-28T16:00:00.000Z'), '2026-10-29')
  assert.throws(() => usageBillingDay('not-a-timestamp'), TypeError)
})

test('a private scope contributes to the actor view but to no group row', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  aggregator.accept(Object.freeze({
    occurredAt: '2026-10-29T02:00:00.000Z',
    botId: BOT_ID,
    scope: Object.freeze({ kind: 'private', userId: ACTOR_ID }),
    actorId: ACTOR_ID,
    usage: usage()
  }) as UsageAggregateInputV1, 'run-1')

  const snapshot = aggregator.snapshot()
  assert.deepEqual(snapshot.groups, [])
  assert.equal(snapshot.actors.length, 1)
  assert.equal(snapshot.days[0]?.totals.runs, 1)
})

test('cost degrades instead of mixing a missing quote or another catalog version', () => {
  const missing = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  missing.accept(groupInput(), 'run-1')
  missing.accept(groupInput({ usage: usage({ picoYuan: null }) }), 'run-2')
  assert.deepEqual(missing.snapshot().days[0]?.totals.cost, {
    kind: 'unavailable',
    catalogVersion: CATALOG,
    billingAuthority: false
  })

  const mixed = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  mixed.accept(groupInput(), 'run-1')
  mixed.accept(groupInput({ usage: usage({ catalogVersion: 'deepseek-cny-2026-07-19' }) }), 'run-2')
  assert.equal(mixed.snapshot().days[0]?.totals.cost.kind, 'unavailable')

  const bounded = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  bounded.accept(groupInput(), 'run-1')
  bounded.accept(groupInput({ usage: usage({ kind: 'upper_bound', picoYuan: '7' }) }), 'run-2')
  const cost = bounded.snapshot().days[0]?.totals.cost
  assert.equal(cost?.kind, 'upper_bound')
  assert.equal(cost?.kind === 'upper_bound' ? cost.picoYuan : null, '1007')
})

test('a partial run makes the aggregate availability partial', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  aggregator.accept(groupInput(), 'run-1')
  assert.equal(aggregator.snapshot().days[0]?.totals.availability, 'complete')
  aggregator.accept(groupInput({ usage: usage({ partial: true }) }), 'run-2')
  assert.equal(aggregator.snapshot().days[0]?.totals.availability, 'partial')
})

test('a repeated run reference is counted exactly once', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  aggregator.accept(groupInput(), 'run-1')
  aggregator.accept(groupInput(), 'run-1')

  const snapshot = aggregator.snapshot()
  assert.equal(snapshot.observedRuns, 1)
  assert.equal(snapshot.days[0]?.totals.runs, 1)
})

test('the window keeps the newest days and refuses one that already fell out', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  for (let index = 0; index < USAGE_AGGREGATE_LIMITS.maxDays; index += 1) {
    aggregator.accept(groupInput({
      occurredAt: `2026-10-${String(10 + index).padStart(2, '0')}T02:00:00.000Z`
    }), `run-${index}`)
  }
  assert.equal(aggregator.snapshot().days.length, USAGE_AGGREGATE_LIMITS.maxDays)

  aggregator.accept(groupInput({ occurredAt: '2026-10-20T02:00:00.000Z' }), 'run-new')
  const rolled = aggregator.snapshot()
  assert.equal(rolled.days.length, USAGE_AGGREGATE_LIMITS.maxDays)
  assert.equal(rolled.days[0]?.day, '2026-10-20')
  assert.equal(rolled.days.some(row => row.day === '2026-10-10'), false)
  assert.equal(rolled.groups.some(row => row.day === '2026-10-10'), false)
  assert.equal(rolled.total.runs, USAGE_AGGREGATE_LIMITS.maxDays + 1)
  assert.equal(
    rolled.days.reduce((sum, row) => sum + row.totals.runs, 0),
    USAGE_AGGREGATE_LIMITS.maxDays
  )

  aggregator.accept(groupInput({ occurredAt: '2026-01-01T02:00:00.000Z' }), 'run-old')
  const refused = aggregator.snapshot()
  assert.equal(refused.rejectedRuns, 1)
  assert.equal(refused.days.some(row => row.day === '2026-01-01'), false)
})

test('a per-day scope overflow is counted rather than silently merged', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  const total = USAGE_AGGREGATE_LIMITS.maxGroupsPerDay + 2
  for (let index = 0; index < total; index += 1) {
    aggregator.accept(groupInput({
      groupId: `9000000000${String(index).padStart(2, '0')}`,
      actorId: null
    }), `run-${index}`)
  }

  const snapshot = aggregator.snapshot()
  assert.equal(snapshot.observedRuns, total)
  assert.equal(snapshot.droppedGroupRuns, 2)
  assert.equal(snapshot.days[0]?.totals.runs, total)
  assert.equal(snapshot.groups.length, USAGE_AGGREGATE_LIMITS.maxRows)
  assert.equal(
    snapshot.omittedGroupRows,
    USAGE_AGGREGATE_LIMITS.maxGroupsPerDay - USAGE_AGGREGATE_LIMITS.maxRows
  )
  assert.equal(snapshot.omittedActorRows, 0)
})

test('switching observability off clears the window and stops collecting', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  aggregator.accept(groupInput(), 'run-1')
  aggregator.setCurrentLevel('off')

  const cleared = aggregator.snapshot()
  assert.deepEqual(cleared.days, [])
  assert.deepEqual(cleared.groups, [])
  assert.deepEqual(cleared.actors, [])
  assert.equal(cleared.observedRuns, 0)
  assert.equal(cleared.windowResetCount, 1)

  aggregator.accept(groupInput(), 'run-2')
  assert.equal(aggregator.snapshot().observedRuns, 0)

  aggregator.setCurrentLevel('basic')
  aggregator.accept(groupInput(), 'run-3')
  assert.equal(aggregator.snapshot().observedRuns, 1)
  assert.equal(aggregator.snapshot().windowResetCount, 1)
})

/**
 * Only the identity and usage projection is asserted here; the full checkpoint
 * contract is already covered by the run-checkpoint tests.
 */
function terminalEvent (checkpoint: Readonly<Record<string, unknown>>): RunContentJournalEvent {
  return Object.freeze({
    type: 'run.terminal_committed',
    occurredAt: '2026-10-29T02:00:00.000Z',
    runRef: 'a'.repeat(32),
    requestRef: 'b'.repeat(32),
    checkpoint,
    receipt: Object.freeze({})
  }) as unknown as RunContentJournalEvent
}

test('the projection reads identity and usage from a committed terminal event', () => {
  const projected = projectUsageAggregateInput(terminalEvent({
    sessionAddress: Object.freeze({
      botId: BOT_ID,
      scope: Object.freeze({ kind: 'group_user', groupId: GROUP_ID, userId: ACTOR_ID })
    }),
    presentationRoute: Object.freeze({ actorId: ACTOR_ID }),
    usage: usage()
  }))

  assert.equal(projected?.botId, BOT_ID)
  assert.equal(projected?.actorId, ACTOR_ID)
  assert.equal(projected?.scope.kind === 'group' ? projected.scope.groupId : null, GROUP_ID)
  assert.equal(projected?.usage.totalTokens, 150)
})

test('a merged group scope without a route has no attributable actor', () => {
  const projected = projectUsageAggregateInput(terminalEvent({
    sessionAddress: Object.freeze({
      botId: BOT_ID,
      scope: Object.freeze({ kind: 'group', groupId: GROUP_ID })
    }),
    presentationRoute: null,
    usage: usage()
  }))

  assert.equal(projected?.actorId, null)
})

test('a non-terminal journal event is projected to nothing', () => {
  const event = Object.freeze({
    type: 'model.resolution',
    occurredAt: '2026-10-29T02:00:00.000Z',
    runRef: 'a'.repeat(32),
    requestRef: 'b'.repeat(32),
    capabilitySource: 'catalog',
    priceStatus: 'missing_or_expired'
  }) as unknown as RunContentJournalEvent
  assert.equal(projectUsageAggregateInput(event), null)
})

test('an invalid checkpoint is rejected without changing the totals', () => {
  const aggregator = new UsageAggregator({ now: () => new Date('2026-10-29T00:00:00.000Z') })
  aggregator.record(terminalEvent({
    sessionAddress: Object.freeze({ botId: BOT_ID, scope: Object.freeze({ kind: 'group' }) }),
    presentationRoute: null,
    usage: usage()
  }))

  const snapshot = aggregator.snapshot()
  assert.equal(snapshot.observedRuns, 0)
  assert.equal(snapshot.rejectedRuns, 1)
})

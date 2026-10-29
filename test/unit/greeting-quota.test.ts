import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GreetingQuota,
  GREETING_QUOTA_KEY,
  GREETING_QUOTA_LIMITS,
  type GreetingQuotaDecision
} from '../../src/runtime/activities/GreetingQuota.js'
import { ACTIVE_PARTICIPATION_LIMITS } from '../../src/agent/participation/ActiveParticipationPolicy.js'
import { runScheduledGreetings } from '../../src/runtime/ScheduledGreeting.js'
import { ProactiveCoordination } from '../../src/runtime/participation/ProactiveCoordination.js'

/** Single-key compare-and-set store with the same contract as the activity store's client. */
function fakeRedis () {
  let stored: string | null = null
  return {
    get: async (key: string): Promise<string | null> => key === GREETING_QUOTA_KEY ? stored : null,
    eval: async (_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> => {
      if (options.keys[0] !== GREETING_QUOTA_KEY) return 0
      if ((stored ?? '') !== options.arguments[0]) return 0
      if (Buffer.byteLength(options.arguments[1]) > GREETING_QUOTA_LIMITS.bytes) return -1
      stored = options.arguments[1]
      return 1
    },
    value: (): string | null => stored
  }
}

const outcome = (decision: GreetingQuotaDecision): string =>
  decision.kind === 'rejected' ? decision.reason : 'allowed'

test('the daily group window stops sending after its limit and releases a day later', async () => {
  let time = 1_700_000_000_000
  const client = fakeRedis()
  const quota = new GreetingQuota({ client, now: () => time, dailyPerGroup: () => 2 })
  assert.deepEqual(await quota.charge('10000', '90000'),
    { kind: 'allowed', dailyUsed: 1, dailyLimit: 2, hourlyUsed: 1, hourlyLimit: 30 })
  time += 60_000
  assert.equal(outcome(await quota.charge('10000', '90000')), 'allowed')
  time += 60_000
  assert.deepEqual(await quota.charge('10000', '90000'),
    { kind: 'rejected', reason: 'daily_group', dailyUsed: 2, dailyLimit: 2, hourlyUsed: 2, hourlyLimit: 30 })
  // Another group in the same round is independent of the exhausted one.
  assert.equal(outcome(await quota.charge('10000', '90001')), 'allowed')
  time += GREETING_QUOTA_LIMITS.dayMs - 120_001
  assert.equal(outcome(await quota.charge('10000', '90000')), 'daily_group')
  time += 1
  assert.equal(outcome(await quota.charge('10000', '90000')), 'allowed')
})

test('the global hourly window is shared across groups and bots', async () => {
  let time = 1_700_000_000_000
  const client = fakeRedis()
  const quota = new GreetingQuota({ client, now: () => time, dailyPerGroup: () => 8, hourlyGlobal: () => 3 })
  for (let n = 0; n < 3; n++) {
    assert.equal(outcome(await quota.charge(String(10_000 + n), String(90_000 + n))), 'allowed')
  }
  const rejected = await quota.charge('10009', '90009')
  assert.equal(outcome(rejected), 'hourly_global')
  assert.equal(rejected.hourlyUsed, 3)
  time += GREETING_QUOTA_LIMITS.hourMs
  assert.equal(outcome(await quota.charge('10009', '90009')), 'allowed')
})

test('a configured limit of zero stops the path entirely and out-of-range values fall back to the default', async () => {
  const client = fakeRedis()
  const off = new GreetingQuota({ client, now: () => 1_000, dailyPerGroup: () => 0 })
  assert.equal(outcome(await off.charge('10000', '90000')), 'daily_group')
  assert.equal(client.value(), null)
  const clamped = new GreetingQuota({ client, now: () => 1_000, dailyPerGroup: () => 4_096 })
  assert.equal((await clamped.charge('10000', '90000')).dailyLimit, GREETING_QUOTA_LIMITS.maxDailyPerGroup)
  const invalid = new GreetingQuota({ client, now: () => 1_000, dailyPerGroup: () => 'two' })
  assert.equal((await invalid.charge('10000', '90001')).dailyLimit, GREETING_QUOTA_LIMITS.defaultDailyPerGroup)
})

test('counters survive a restart and a store failure fails closed', async () => {
  const time = 1_700_000_000_000
  const client = fakeRedis()
  const before = new GreetingQuota({ client, now: () => time, dailyPerGroup: () => 1 })
  assert.equal(outcome(await before.charge('10000', '90000')), 'allowed')
  // A new process reads the same Redis document, so the daily allowance is not reissued.
  const after = new GreetingQuota({ client, now: () => time, dailyPerGroup: () => 1 })
  assert.equal(outcome(await after.charge('10000', '90000')), 'daily_group')
  const unreadable = new GreetingQuota({
    client: { get: async () => { throw new Error('redis down') }, eval: async () => 1 },
    now: () => time
  })
  assert.equal(outcome(await unreadable.charge('10000', '90002')), 'store_unavailable')
  const unwritable = new GreetingQuota({
    client: { get: async () => null, eval: async () => { throw new Error('redis down') } },
    now: () => time
  })
  assert.equal(outcome(await unwritable.charge('10000', '90002')), 'store_unavailable')
  const contended = new GreetingQuota({ client: { get: async () => null, eval: async () => 0 }, now: () => time })
  assert.equal(outcome(await contended.charge('10000', '90002')), 'conflict')
  const oversized = new GreetingQuota({ client: { get: async () => null, eval: async () => -1 }, now: () => time })
  assert.equal(outcome(await oversized.charge('10000', '90002')), 'store_unavailable')
})

test('a rejected identity or a full scope table never charges and never allows', async () => {
  let time = 1_700_000_000_000
  const client = fakeRedis()
  const quota = new GreetingQuota({ client, now: () => time })
  for (const [botId, groupId] of [['', '90000'], ['10000', ''], ['bot', '90000'], ['10000', '9e4']]) {
    assert.equal(outcome(await quota.charge(botId, groupId)), 'identity')
  }
  assert.equal(client.value(), null)
  // Fill every scope inside one day while keeping the hourly window under its own bound.
  for (let n = 0; n < GREETING_QUOTA_LIMITS.scopes; n++) {
    if (n > 0 && n % GREETING_QUOTA_LIMITS.maxHourlyGlobal === 0) time += GREETING_QUOTA_LIMITS.hourMs + 1
    assert.equal(outcome(await quota.charge('10000', String(90_000 + n))), 'allowed')
  }
  assert.equal(outcome(await quota.charge('10000', '99999')), 'scope_pressure')
  const document = JSON.parse(client.value()!)
  assert.equal(document.scopes.length, GREETING_QUOTA_LIMITS.scopes)
  assert.equal(Buffer.byteLength(client.value()!) <= GREETING_QUOTA_LIMITS.bytes, true)
})

test('a clock that moves backwards cannot un-prune a charged window', async () => {
  let time = 1_700_000_000_000
  const quota = new GreetingQuota({ client: fakeRedis(), now: () => time, dailyPerGroup: () => 1 })
  assert.equal(outcome(await quota.charge('10000', '90000')), 'allowed')
  time -= GREETING_QUOTA_LIMITS.dayMs * 2
  assert.equal(outcome(await quota.charge('10000', '90000')), 'daily_group')
})

test('the greeting hourly bound matches the proactive candidate bound', () => {
  assert.equal(GREETING_QUOTA_LIMITS.maxHourlyGlobal, ACTIVE_PARTICIPATION_LIMITS.globalPerHour)
  assert.equal(GREETING_QUOTA_LIMITS.defaultHourlyGlobal, ACTIVE_PARTICIPATION_LIMITS.globalPerHour)
})

test('a cron round over quota performs no model call and no send', async () => {
  let time = 1_700_000_000_000
  const quota = new GreetingQuota({ client: fakeRedis(), now: () => time, dailyPerGroup: () => 2 })
  const coordination = new ProactiveCoordination(() => time)
  const generated: number[] = []
  const sent: number[] = []
  const bot = { uin: '10000', gl: new Map([[90_000, {}], [90_001, {}]]) }
  const ports = {
    groups: ['90000', '90001'],
    probability: 100,
    bots: [bot],
    random: () => 0,
    claim: async (_bot: Record<string, any>, groupId: number) => {
      const ticket = coordination.begin('10000', String(groupId), 'cron')
      if (ticket === null) return null
      const decision = await quota.charge('10000', String(groupId))
      if (decision.kind !== 'allowed') { await ticket.finish(false); return null }
      return ticket
    },
    generate: async (_bot: Record<string, any>, groupId: number) => { generated.push(groupId); return 'hello' },
    render: async (text: string) => text,
    send: async (_bot: Record<string, any>, groupId: number) => { sent.push(groupId); return true }
  }
  for (let round = 0; round < 6; round++) {
    time += 3 * GREETING_QUOTA_LIMITS.hourMs
    assert.equal(await runScheduledGreetings(ports), true)
  }
  // Six rounds at 100% probability over two groups: the daily cap allows two sends per group.
  assert.deepEqual(generated, [90_000, 90_001, 90_000, 90_001])
  assert.deepEqual(sent, generated)
  time += GREETING_QUOTA_LIMITS.dayMs
  assert.equal(await runScheduledGreetings(ports), true)
  assert.equal(generated.length, 6)
  assert.equal(sent.length, 6)
})

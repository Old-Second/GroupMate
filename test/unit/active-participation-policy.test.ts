import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ActiveParticipationPolicy } from '../../src/agent/participation/ActiveParticipationPolicy.js'
import { hostParticipationEvent, parseParticipationEvent, type ParticipationEvent } from '../../src/agent/participation/ParticipationContract.js'
import type { ParticipationCandidate } from '../../src/agent/participation/ParticipationState.js'

const ref = (value: string): string => createHash('sha256').update(value).digest('hex')
function harness () {
  let now = 1_000_000, enabled = true, sequence = 0
  const policy = new ActiveParticipationPolicy(() => now, () => enabled)
  const event = (overrides: Partial<ParticipationEvent> = {}): ParticipationEvent => hostParticipationEvent({
    schemaVersion: 1, origin: 'current', eligible: true, addressed: false, acknowledgement: false,
    at: now, scopeRef: ref('scope'), actorRef: ref('actor'), messageRef: ref(String(++sequence)), ...overrides
  })
  const select = (value: ParticipationEvent): ParticipationCandidate => {
    const selected = policy.select(value, { sampled: true, gateAllows: true })
    assert.equal(selected.kind, 'candidate')
    if (selected.kind !== 'candidate') throw new Error('candidate missing')
    return selected.candidate
  }
  return { policy, event, select, advance: (ms: number) => { now += ms }, disable: () => { enabled = false }, enable: () => { enabled = true } }
}

test('active selection rejects parsed provenance and uncertain gates without granting a candidate', () => {
  const h = harness()
  assert.deepEqual(h.policy.select(parseParticipationEvent(h.event()), { sampled: true, gateAllows: true }), { kind: 'ignore', reason: 'untrusted' })
  for (const gateAllows of [false, null]) {
    assert.deepEqual(h.policy.select(h.event(), { sampled: true, gateAllows }), { kind: 'ignore', reason: 'gate_rejected' })
  }
  assert.deepEqual(h.policy.select(h.event({ acknowledgement: true }), { sampled: true, gateAllows: true }), { kind: 'ignore', reason: 'acknowledgement' })
  assert.deepEqual(h.policy.select(h.event(), { sampled: false, gateAllows: true }), { kind: 'ignore', reason: 'sample_miss' })
})

test('direct tasks bypass sampling and passive TTL while disable/shutdown still deny them', () => {
  const h = harness(), value = h.event({ addressed: true })
  const selected = h.policy.select(value, { sampled: false, gateAllows: null })
  assert.equal(selected.kind, 'candidate')
  if (selected.kind !== 'candidate') return
  assert.equal(h.policy.admit(selected.candidate), true)
  assert.equal(h.policy.admit(selected.candidate), false)
  h.advance(120_000)
  h.policy.select(h.event(), { sampled: false, gateAllows: false })
  assert.equal(h.policy.current(selected.candidate), true)
  assert.equal(h.policy.current(JSON.parse(JSON.stringify(selected.candidate))), false)
  h.disable()
  assert.equal(h.policy.current(selected.candidate), false)
  h.enable()
  assert.equal(h.policy.current(selected.candidate), false)
  assert.equal(h.policy.select(h.event({ addressed: true }), { sampled: false, gateAllows: null }).kind, 'ignore')
  h.policy.close()
  assert.equal(h.policy.current(selected.candidate), false)
})

test('failed and unadmitted direct tasks release immediately without erasing a newer route', () => {
  const h = harness(), first = h.select(h.event({ addressed: true }))
  h.policy.finish(first, false)
  const second = h.select(h.event({ addressed: true }))
  assert.equal(h.policy.admit(second), true)
  h.policy.finish(second, false)
  const third = h.select(h.event({ addressed: true }))
  h.policy.finish(first, false)
  assert.equal(h.policy.current(third), true)
  assert.equal(h.policy.admit(third), true)
  h.policy.finish(third, true)
  assert.equal(h.policy.stats().candidates, 0)
  assert.equal(h.select(h.event({ addressed: true })).source, 'direct')
})

test('late passive completion cannot release or establish continuation for a newer candidate', () => {
  const h = harness(), old = h.select(h.event())
  assert.equal(h.policy.admit(old), true)
  const next = h.select(h.event({ addressed: true }))
  h.policy.finish(old, true)
  assert.equal(h.policy.current(next), true)
  assert.equal(h.policy.select(h.event(), { sampled: false, gateAllows: true }).kind, 'ignore')
  h.policy.finish(next, false)
  assert.equal(h.policy.select(h.event(), { sampled: false, gateAllows: true }).kind, 'ignore')
})

test('a new direct route never acquires an earlier direct event candidate', () => {
  const h = harness(), first = h.select(h.event({ addressed: true }))
  assert.deepEqual(h.policy.select(h.event({ addressed: true }), { sampled: true, gateAllows: true }), { kind: 'ignore', reason: 'unavailable' })
  assert.equal(h.policy.admit(first), true)
})

test('only live issued candidates project trusted participation facts into model instructions', () => {
  const h = harness(), direct = h.select(h.event({ addressed: true }))
  assert.equal(h.policy.instructions(JSON.parse(JSON.stringify(direct))), null)
  const instructions = h.policy.instructions(direct)
  assert.ok(instructions?.[0].startsWith('当前发言已由宿主识别为发给你的明确请求。'))
  assert.equal(Object.isFrozen(instructions), true)
  h.advance(20_000)
  assert.deepEqual(h.policy.instructions(direct), instructions)
  h.policy.finish(direct, false)
  assert.equal(h.policy.instructions(direct), null)
  const passive = h.select(h.event())
  assert.ok(h.policy.instructions(passive)?.[0].includes('是否有必要答话仍需判断'))
  h.advance(15_000)
  assert.equal(h.policy.instructions(passive), null)
  const next = h.select(h.event({ addressed: true }))
  h.disable()
  assert.equal(h.policy.instructions(next), null)
})

test('delivered direct replies establish only same actor/scope bounded continuation', () => {
  const h = harness(), direct = h.select(h.event({ addressed: true }))
  assert.equal(h.policy.admit(direct), true)
  h.advance(20_000)
  h.policy.finish(direct, true)
  const next = h.policy.select(h.event(), { sampled: false, gateAllows: true })
  assert.equal(next.kind, 'candidate')
  if (next.kind === 'candidate') assert.equal(next.candidate.source, 'continuation')
  assert.equal(h.policy.select(h.event({ actorRef: ref('other') }), { sampled: false, gateAllows: true }).kind, 'ignore')
  assert.equal(h.policy.select(h.event({ scopeRef: ref('other-group') }), { sampled: false, gateAllows: true }).kind, 'ignore')
  h.advance(120_000)
  assert.equal(h.policy.select(h.event(), { sampled: false, gateAllows: true }).kind, 'ignore')
})

test('passive freshness invalidates at the exact TTL and on superseding messages', () => {
  const h = harness(), first = h.select(h.event())
  assert.equal(h.policy.admit(first), true)
  h.policy.select(h.event(), { sampled: false, gateAllows: false })
  assert.equal(h.policy.current(first), false)
  const next = h.select(h.event())
  h.advance(15_000)
  assert.equal(h.policy.current(next), false)
  assert.equal(h.policy.admit(next), false)
})

test('failed/unknown delivery consumes cooldown and cannot be retried or establish continuation', () => {
  const h = harness(), first = h.select(h.event())
  assert.equal(h.policy.admit(first), true)
  h.policy.finish(first, false)
  assert.equal(h.policy.current(first), false)
  assert.equal(h.policy.admit(first), false)
  assert.equal(h.policy.select(h.event(), { sampled: false, gateAllows: true }).kind, 'ignore')
  const blocked = h.select(h.event())
  assert.equal(h.policy.admit(blocked), false)
  h.advance(30_000)
  assert.equal(h.policy.admit(h.select(h.event())), true)
})

test('group quota stays six/hour and never blocks a direct task', () => {
  const h = harness()
  for (let n = 0; n < 6; n++) {
    const value = h.select(h.event())
    assert.equal(h.policy.admit(value), true)
    h.policy.finish(value, false)
    h.advance(30_000)
  }
  assert.equal(h.policy.admit(h.select(h.event())), false)
  assert.equal(h.policy.admit(h.select(h.event({ addressed: true }))), true)
  h.advance(3_600_000)
  assert.equal(h.policy.admit(h.select(h.event())), true)
})

test('global quota stays thirty/hour across scopes', () => {
  const h = harness()
  for (let n = 0; n < 30; n++) {
    const value = h.select(h.event({ scopeRef: ref(`group-${n}`) }))
    assert.equal(h.policy.admit(value), true)
    h.policy.finish(value, false)
  }
  assert.equal(h.policy.admit(h.select(h.event({ scopeRef: ref('group-31') }))), false)
  assert.equal(h.policy.stats().globalAdmitted, 30)
})

test('hourly budgets use rolling time rather than resetting all reservations at a window edge', () => {
  const h = harness()
  const first = h.select(h.event())
  assert.equal(h.policy.admit(first), true)
  h.policy.finish(first, false)
  h.advance(3_450_000)
  for (let n = 0; n < 5; n++) {
    const candidate = h.select(h.event())
    assert.equal(h.policy.admit(candidate), true)
    h.policy.finish(candidate, false)
    h.advance(30_000)
  }
  assert.equal(h.policy.admit(h.select(h.event())), true) // Only the first admission expired.
  h.advance(30_000)
  assert.equal(h.policy.admit(h.select(h.event())), false)
})

test('scope pressure cannot reset charged group quotas and remains bounded', () => {
  const h = harness()
  for (let n = 0; n < 6; n++) {
    const candidate = h.select(h.event())
    assert.equal(h.policy.admit(candidate), true)
    h.policy.finish(candidate, false)
    h.advance(30_000)
  }
  for (let n = 0; n < 300; n++) h.policy.select(h.event({ scopeRef: ref(`burst-${n}`) }), { sampled: true, gateAllows: true })
  assert.equal(h.policy.admit(h.select(h.event())), false)
  assert.equal(h.policy.stats().scopes, 64)
  assert.ok(h.policy.stats().candidates <= 32)
  assert.ok(h.policy.stats().bytes < 512 * 1024)
})

test('unknown passive scopes fail closed without evicting known work; direct requests keep priority', () => {
  const h = harness(), known = h.select(h.event())
  assert.equal(h.policy.admit(known), true)
  for (let n = 0; n < 63; n++) h.policy.select(h.event({ scopeRef: ref(`known-${n}`) }), { sampled: false, gateAllows: null })
  for (let n = 0; n < 300; n++) {
    assert.equal(h.policy.select(h.event({ scopeRef: ref(`unknown-${n}`) }), { sampled: true, gateAllows: true }).kind, 'ignore')
  }
  assert.equal(h.policy.current(known), true)
  const direct = h.select(h.event({ scopeRef: ref('unknown-direct'), addressed: true }))
  assert.equal(h.policy.admit(direct), true)
  assert.equal(h.policy.stats().scopes, 64)
  assert.equal(h.policy.stats().globalAdmitted, 1)
})

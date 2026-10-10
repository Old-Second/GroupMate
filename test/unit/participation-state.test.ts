import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostParticipationEvent, type ParticipationEvent } from '../../src/agent/participation/ParticipationContract.js'
import { candidateFreshness } from '../../src/agent/participation/FreshnessFence.js'
import { ParticipationState, PARTICIPATION_LIMITS } from '../../src/agent/participation/ParticipationState.js'

function event (n: number, overrides: Partial<ParticipationEvent> = {}) {
  return hostParticipationEvent({ schemaVersion: 1, scopeRef: n.toString(16).padStart(64, '0'), actorRef: 'a'.repeat(64),
    messageRef: n.toString(16).padStart(64, '0'), at: 1_000, origin: 'current', addressed: false, acknowledgement: false, eligible: true, ...overrides })
}

test('scope and candidate pressure stay bounded, evictions cannot revive old callbacks', () => {
  const state = new ParticipationState(() => 1_000)
  let oldest
  for (let i = 1; i <= 1_000; i++) {
    const e = event(i)
    state.observe(e)
    const candidate = state.offer(e, 'sampled')
    if (i === 1) oldest = candidate
  }
  const stats = state.stats()
  assert.equal(stats.scopes, 64)
  assert.equal(stats.candidates, 32)
  assert.ok(stats.bytes < PARTICIPATION_LIMITS.bytes)
  assert.equal(candidateFreshness(state, oldest!), 'unavailable')
  state.observe(event(1))
  const replacement = state.offer(event(1), 'sampled')!
  assert.ok(replacement.revision > oldest!.revision)
  assert.equal(candidateFreshness(state, oldest!), 'obsolete')
})

test('new passive events replace only passive candidates; direct tasks, TTL and shutdown have explicit semantics', () => {
  let now = 1_000
  const state = new ParticipationState(() => now)
  const first = event(1)
  state.observe(first)
  const candidate = state.offer(first, 'sampled')!
  const next = event(1, { messageRef: 'f'.repeat(64) })
  state.observe(next)
  assert.equal(candidateFreshness(state, candidate), 'obsolete')
  const direct = state.offer(next, 'direct')!
  state.observe(event(1, { messageRef: 'b'.repeat(64) }))
  assert.equal(candidateFreshness(state, direct), 'current')
  assert.equal(state.offer(first, 'sampled'), direct)
  assert.equal(candidateFreshness(state, { ...direct }), 'obsolete')
  now = direct.expiresAt
  assert.equal(candidateFreshness(state, direct), 'obsolete')
  assert.equal(state.offer(first, 'sampled'), null)
  now += PARTICIPATION_LIMITS.scopeTtlMs
  assert.equal(candidateFreshness(state, direct), 'unavailable')
  state.close()
  assert.equal(state.observe(event(1, { at: now })), false)
  assert.equal(state.stats().scopes, 0)
})

test('only current observed replies establish same-actor continuation; clocks fail closed', () => {
  let now = 1_000
  const state = new ParticipationState(() => now)
  const e = event(1)
  state.observe(e)
  state.replied(state.offer(e, 'direct')!)
  now += 1
  assert.equal(state.observe(event(1, { at: now, messageRef: 'b'.repeat(64) })), true)
  assert.equal(state.observe(event(1, { at: now, actorRef: 'c'.repeat(64), messageRef: 'd'.repeat(64) })), false)
  now += 120_000
  assert.equal(state.observe(event(1, { at: now })), false)
  now -= 1
  assert.equal(candidateFreshness(state, {} as any), 'unavailable')
})

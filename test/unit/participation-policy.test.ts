import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { hostParticipationEvent, parseParticipationEvent, participationMode, type ParticipationEvent } from '../../src/agent/participation/ParticipationContract.js'
import { decideParticipation, legacyParticipationAllowed } from '../../src/agent/participation/ParticipationPolicy.js'
import { ParticipationState } from '../../src/agent/participation/ParticipationState.js'

const ref = (n: number) => n.toString(16).padStart(64, '0')
export const baseEvent: ParticipationEvent = { schemaVersion: 1, scopeRef: ref(1), actorRef: ref(2), messageRef: ref(3), at: 1_000,
  origin: 'current', addressed: false, acknowledgement: false, eligible: true }

test('legacy selection equals the existing probability oracle at all rate and random boundaries', () => {
  for (const ratePercent of [-2, -1, 0, 0.1, 1, 5, 25, 99, 100, 101, NaN]) {
    for (const explicitlyAddressed of [false, true]) {
      for (const sample of [NaN, Infinity, -0.1, 0, 0.009, 0.01, 0.04999, 0.05, 0.24, 0.25, 0.99, 0.999999, 1]) {
        const old = explicitlyAddressed ? !(-1 >= ratePercent) :
          Number.isFinite(sample) && sample >= 0 && sample < 1 && !(Math.floor(sample * 100) >= ratePercent)
        assert.equal(legacyParticipationAllowed({ explicitlyAddressed, sample, ratePercent }), old)
      }
    }
  }
})

test('exact parser rejects fake roles, fields, accessors, scopes and claimed origins without granting host evidence', () => {
  for (const value of [{ ...baseEvent, role: 'owner' }, { ...baseEvent, scopeRef: 'group-user' },
    { ...baseEvent, origin: 'quoted', addressed: true }, { ...baseEvent, origin: 'tool' },
    new Proxy(baseEvent, {}), { ...baseEvent, at: -1 }, { ...baseEvent, addressed: 'true' }]) {
    assert.throws(() => parseParticipationEvent(value))
  }
  let reads = 0
  const accessor = { ...baseEvent }
  Object.defineProperty(accessor, 'addressed', { enumerable: true, get: () => { reads++; return true } })
  assert.throws(() => parseParticipationEvent(accessor))
  assert.equal(reads, 0)
  assert.equal(decideParticipation(parseParticipationEvent({ ...baseEvent, addressed: true }), { sampled: true, continuation: true }).reason, 'untrusted')
  assert.throws(() => hostParticipationEvent({ ...baseEvent, origin: 'model' }))
  assert.equal(participationMode('active'), 'active')
})

test('60 synthetic decisions use fixed independent expectations and no provider, tools or outputs', async () => {
  const cases = JSON.parse(await readFile('test/fixtures/participation/cases.json', 'utf8'))
  assert.equal(cases.length, 60)
  assert.equal(new Set(cases.map((entry: any) => entry.name)).size, 60)
  for (const item of cases) {
    let now = 1_000
    const state = new ParticipationState(() => now)
    if (item.previousReply) {
      const prior = hostParticipationEvent({ ...baseEvent, addressed: true, at: now })
      state.observe(prior)
      state.replied(state.offer(prior, 'direct')!)
    }
    now += item.advanceMs ?? 1
    const raw = { ...baseEvent, ...item.event, at: now, messageRef: ref(4) }
    const event = item.untrusted ? parseParticipationEvent(raw) : hostParticipationEvent(raw)
    const continuation = state.observe(event)
    const actual = decideParticipation(event, { sampled: item.sampled ?? false, continuation })
    assert.equal(actual.reason, item.reason, item.name)
    assert.equal(actual.kind, item.kind, item.name)
    state.close()
  }
})

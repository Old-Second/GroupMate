import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemorySemanticCircuitBreakerV1
} from '../../src/agent/memory/memory-semantic-circuit-breaker.js'

test('semantic circuit breaker opens without timers and admits one cooldown probe', () => {
  let nowMs = 1_000
  const breaker = createMemorySemanticCircuitBreakerV1({
    failureThreshold: 2,
    cooldownMs: 500,
    now: () => nowMs
  })
  const first = breaker.acquire()
  assert.equal(first.status, 'allowed')
  if (first.status !== 'allowed') assert.fail('expected first permit')
  first.settle('failure')
  const second = breaker.acquire()
  assert.equal(second.status, 'allowed')
  if (second.status !== 'allowed') assert.fail('expected second permit')
  second.settle('failure')
  assert.deepEqual(breaker.snapshot(), {
    state: 'open', failures: 2, retryAtMs: 1_500, probeInFlight: false
  })
  assert.deepEqual(breaker.acquire(), { status: 'blocked' })

  nowMs = 1_500
  const probe = breaker.acquire()
  assert.equal(probe.status, 'allowed')
  if (probe.status !== 'allowed') assert.fail('expected cooldown probe')
  assert.deepEqual(breaker.acquire(), { status: 'blocked' })
  probe.settle('success')
  assert.deepEqual(breaker.snapshot(), {
    state: 'closed', failures: 0, retryAtMs: null, probeInFlight: false
  })
})

test('semantic circuit breaker treats one permit settlement as immutable', () => {
  const breaker = createMemorySemanticCircuitBreakerV1({
    failureThreshold: 1,
    cooldownMs: 1_000,
    now: () => 5_000
  })
  const permit = breaker.acquire()
  assert.equal(permit.status, 'allowed')
  if (permit.status !== 'allowed') assert.fail('expected permit')
  permit.settle('failure')
  permit.settle('success')
  assert.equal(breaker.snapshot().state, 'open')
})

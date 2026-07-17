import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFrozenObservationPolicy } from '../../src/agent/run/run-observation.js'
import { decideTraceRetention } from '../../src/runtime/observability/trace-policy.js'

const basicUnsampled = Object.freeze({
  schemaVersion: 1 as const,
  levelAtStart: 'basic' as const,
  sampledSuccess: false
})

test('trace retention uses the stricter frozen/current level and never promotes off', () => {
  assert.deepEqual(decideTraceRetention({
    policy: basicUnsampled,
    currentLevel: 'off',
    terminalStatus: 'failed',
    presentation: 'anomaly'
  }), { kind: 'drop', reason: 'off' })

  assert.deepEqual(decideTraceRetention({
    policy: Object.freeze({ ...basicUnsampled, levelAtStart: 'diagnostic' }),
    currentLevel: 'basic',
    terminalStatus: 'failed',
    presentation: 'not_observed'
  }), { kind: 'retain', reason: 'failed' })

  assert.deepEqual(decideTraceRetention({
    policy: Object.freeze({ ...basicUnsampled, levelAtStart: 'diagnostic' }),
    currentLevel: 'diagnostic',
    terminalStatus: 'completed',
    presentation: 'not_observed'
  }), { kind: 'retain', reason: 'diagnostic' })
})

test('basic success is deterministic across resume and awaits only unsampled presentation', () => {
  const sampled = Object.freeze({ ...basicUnsampled, sampledSuccess: true })
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(decideTraceRetention({
      policy: sampled,
      currentLevel: 'diagnostic',
      terminalStatus: 'completed',
      presentation: 'not_observed'
    }), { kind: 'retain', reason: 'sampled_success' })
  }

  assert.deepEqual(decideTraceRetention({
    policy: basicUnsampled,
    currentLevel: 'basic',
    terminalStatus: 'completed',
    presentation: 'not_observed'
  }), { kind: 'await_presentation', reason: 'unsampled_success' })
  assert.deepEqual(decideTraceRetention({
    policy: basicUnsampled,
    currentLevel: 'basic',
    terminalStatus: 'completed',
    presentation: 'normal'
  }), { kind: 'drop', reason: 'normal_success' })
  assert.deepEqual(decideTraceRetention({
    policy: basicUnsampled,
    currentLevel: 'basic',
    terminalStatus: 'completed',
    presentation: 'anomaly'
  }), { kind: 'retain', reason: 'presentation_anomaly' })
})

test('trace retention exact-rejects unknown policy inputs', () => {
  for (const value of [
    { policy: basicUnsampled, currentLevel: 'debug', terminalStatus: 'completed', presentation: 'normal' },
    { policy: basicUnsampled, currentLevel: 'basic', terminalStatus: 'running', presentation: 'normal' },
    { policy: basicUnsampled, currentLevel: 'basic', terminalStatus: 'completed', presentation: 'unknown' },
    { policy: { ...basicUnsampled, extra: true }, currentLevel: 'basic', terminalStatus: 'completed', presentation: 'normal' }
  ]) {
    assert.throws(() => decideTraceRetention(value as never), TypeError)
  }
})

test('trace policy boundaries reject symbols and accessors without invoking getters', () => {
  const symbol = Symbol('private')
  assert.throws(() => parseFrozenObservationPolicy({
    ...basicUnsampled,
    [symbol]: true
  }), TypeError)

  let policyGetterCalls = 0
  const accessorPolicy = Object.defineProperties({}, {
    schemaVersion: { enumerable: true, value: 1 },
    levelAtStart: {
      enumerable: true,
      get: () => {
        policyGetterCalls += 1
        return 'basic'
      }
    },
    sampledSuccess: { enumerable: true, value: false }
  })
  assert.throws(() => parseFrozenObservationPolicy(accessorPolicy), TypeError)
  assert.equal(policyGetterCalls, 0)

  let inputGetterCalls = 0
  const accessorInput = Object.defineProperties({}, {
    policy: {
      enumerable: true,
      get: () => {
        inputGetterCalls += 1
        return basicUnsampled
      }
    },
    currentLevel: { enumerable: true, value: 'basic' },
    terminalStatus: { enumerable: true, value: 'completed' },
    presentation: { enumerable: true, value: 'normal' }
  })
  assert.throws(() => decideTraceRetention(accessorInput as never), TypeError)
  assert.equal(inputGetterCalls, 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createFrozenProviderGenerationV1,
  providerRequestWireIdentity,
  providerRequestScopeFingerprint,
  parseFrozenProviderGenerationV1
} from '../../src/agent/run/provider-generation.js'

const HASH = 'a'.repeat(64)

test('provider generation freezes a bounded request identity without exposing scope metadata', () => {
  const scope = providerRequestScopeFingerprint(Object.freeze({
    cacheIsolationId: `gm_g_${'a'.repeat(43)}`
  }))
  const generation = createFrozenProviderGenerationV1(Object.freeze({
    generation: 3,
    kind: 'normal',
    planHash: HASH,
    requestHash: 'b'.repeat(64),
    requestBytes: 12_345,
    requestProtocolVersion: 'openai-chat-completions-v1',
    scopeFingerprint: scope,
    ambiguityRecoveryUsed: false
  }))

  assert.deepEqual(parseFrozenProviderGenerationV1(generation), generation)
  assert.match(scope, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(generation).includes('gm_g_'), false)
})

test('request wire identity hashes the exact serialized OpenAI-compatible body', () => {
  const first = providerRequestWireIdentity(Object.freeze({
    model: 'fixture',
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'e\u0301' })])
  }))
  const same = providerRequestWireIdentity(Object.freeze({
    model: 'fixture',
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'e\u0301' })])
  }))
  const normalized = providerRequestWireIdentity(Object.freeze({
    model: 'fixture',
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'é' })])
  }))

  assert.deepEqual(first, same)
  assert.notEqual(first.requestHash, normalized.requestHash)
  assert.equal(first.requestBytes, Buffer.byteLength(JSON.stringify({
    model: 'fixture', messages: [{ role: 'user', content: 'e\u0301' }]
  }), 'utf8'))
})

test('provider generation distinguishes normal, correction and explicit recovery generations', () => {
  for (const kind of ['normal', 'correction', 'context_recovery'] as const) {
    assert.equal(createFrozenProviderGenerationV1(Object.freeze({
      generation: 1,
      kind,
      planHash: HASH,
      requestHash: 'b'.repeat(64),
      requestBytes: 1,
      requestProtocolVersion: 'openai-chat-completions-v1',
      scopeFingerprint: 'c'.repeat(64),
      ambiguityRecoveryUsed: kind === 'context_recovery'
    })).kind, kind)
  }
})

test('provider generation codec rejects unknown keys, invalid hashes and unbounded identities', () => {
  const valid = Object.freeze({
    generation: 1,
    kind: 'normal' as const,
    planHash: HASH,
    requestHash: 'b'.repeat(64),
    requestBytes: 1,
    requestProtocolVersion: 'openai-chat-completions-v1' as const,
    scopeFingerprint: 'c'.repeat(64),
    ambiguityRecoveryUsed: false
  })

  assert.throws(() => createFrozenProviderGenerationV1(Object.freeze({
    ...valid,
    requestHash: 'not-a-hash'
  })), TypeError)
  assert.throws(() => createFrozenProviderGenerationV1(Object.freeze({
    ...valid,
    requestBytes: 512 * 1_024 + 1
  })), TypeError)
  assert.throws(() => parseFrozenProviderGenerationV1(Object.freeze({
    schemaVersion: 1,
    ...valid,
    extra: true
  })), TypeError)
})

test('scope fingerprint distinguishes absent metadata without serializing a raw isolation id', () => {
  const absent = providerRequestScopeFingerprint(undefined)
  const present = providerRequestScopeFingerprint(Object.freeze({
    cacheIsolationId: `gm_u_${'z'.repeat(43)}`
  }))

  assert.match(absent, /^[0-9a-f]{64}$/)
  assert.match(present, /^[0-9a-f]{64}$/)
  assert.notEqual(absent, present)
})

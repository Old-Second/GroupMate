import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  MAX_CONTEXT_CANONICAL_MESSAGE_BYTES,
  canonicalizeModelMessages,
  estimateModelMessagesTokens,
  serializeModelMessages,
  serializedModelMessagesBytes
} from '../../src/agent/context/context-token-estimator.js'

function deepFreeze<T> (value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

test('the context estimator is versioned and uses canonical UTF-8 message JSON', () => {
  const messages = deepFreeze([{ role: 'user' as const, content: 'A你😀e\u0301' }])
  const canonical = canonicalizeModelMessages(messages)

  assert.equal(CONTEXT_TOKEN_ESTIMATOR_VERSION, 'context-byte-quarter-v1')
  assert.deepEqual(canonical, [{ role: 'user', content: 'A你😀é' }])
  assert.equal(serializeModelMessages(messages), '[{"role":"user","content":"A你😀é"}]')
  assert.equal(
    serializedModelMessagesBytes(messages),
    Buffer.byteLength('[{"role":"user","content":"A你😀é"}]', 'utf8')
  )
  assert.equal(
    estimateModelMessagesTokens(messages),
    Math.max(1, Math.ceil(serializedModelMessagesBytes(messages) / 4))
  )
  assert.equal(estimateModelMessagesTokens(deepFreeze([])), 0)
  assert.notEqual(canonical, messages)
  assert.equal(Object.isFrozen(canonical), true)
  assert.equal(Object.isFrozen(canonical[0]), true)
})

test('canonical message bytes accept exactly 512 KiB and reject one byte more', () => {
  const empty = deepFreeze([{ role: 'user' as const, content: '' }])
  const overhead = serializedModelMessagesBytes(empty)
  const exact = deepFreeze([{
    role: 'user' as const,
    content: 'x'.repeat(MAX_CONTEXT_CANONICAL_MESSAGE_BYTES - overhead)
  }])
  assert.equal(serializedModelMessagesBytes(exact), MAX_CONTEXT_CANONICAL_MESSAGE_BYTES)
  assert.throws(() => serializedModelMessagesBytes(deepFreeze([{
    role: 'user' as const,
    content: `${exact[0].content}x`
  }])), TypeError)
})

test('canonical message JSON recursively sorts arbitrary tool and provider-state keys', () => {
  const first = deepFreeze([{
    role: 'assistant' as const,
    content: null,
    toolCalls: [{ callId: 'call-1', name: 'fixture', arguments: { z: [3, { b: 2, a: 1 }], a: true } }],
    providerState: {
      profileId: 'fixture',
      profileVersion: 1,
      payload: { z: 2, a: { d: 4, c: 3 } }
    }
  }])
  const second = deepFreeze([{
    role: 'assistant' as const,
    content: null,
    toolCalls: [{ callId: 'call-1', name: 'fixture', arguments: { a: true, z: [3, { a: 1, b: 2 }] } }],
    providerState: {
      profileId: 'fixture',
      profileVersion: 1,
      payload: { a: { c: 3, d: 4 }, z: 2 }
    }
  }])

  assert.equal(serializeModelMessages(first), serializeModelMessages(second))
  assert.deepEqual(canonicalizeModelMessages(first), canonicalizeModelMessages(second))
})

test('canonical JSON uses ASCII key order even for integer-shaped keys', () => {
  const messages = deepFreeze([{
    role: 'assistant' as const,
    content: null,
    toolCalls: [{
      callId: 'call-1',
      name: 'fixture',
      arguments: { a: 5, _: 4, A: 3, 2: 2, 10: 1 }
    }]
  }])

  assert.match(
    serializeModelMessages(messages),
    /"arguments":\{"10":1,"2":2,"A":3,"_":4,"a":5\}/
  )
})

test('canonical JSON preserves own __proto__ data and validates its complete subtree', () => {
  const args: Record<string, unknown> = {}
  Object.defineProperty(args, '__proto__', {
    value: { nested: 'kept' }, enumerable: true, configurable: true, writable: true
  })
  const messages = deepFreeze([{
    role: 'assistant' as const,
    content: null,
    toolCalls: [{ callId: 'call-1', name: 'fixture', arguments: args }]
  }])
  assert.match(serializeModelMessages(messages), /"arguments":\{"__proto__":\{"nested":"kept"\}\}/)

  let traps = 0
  const hostile = new Proxy(Object.freeze({ nested: 'hidden' }), {
    get: () => { traps += 1; throw new Error('proto-secret') },
    ownKeys: () => { traps += 1; throw new Error('proto-secret') }
  })
  const hostileArgs: Record<string, unknown> = {}
  Object.defineProperty(hostileArgs, '__proto__', {
    value: hostile, enumerable: true, configurable: false, writable: false
  })
  Object.freeze(hostileArgs)
  const hostileMessages = Object.freeze([Object.freeze({
    role: 'assistant' as const,
    content: null,
    toolCalls: Object.freeze([Object.freeze({
      callId: 'call-1', name: 'fixture', arguments: hostileArgs
    })])
  })])
  assert.throws(() => serializeModelMessages(hostileMessages), TypeError)
  assert.equal(traps, 0)
})

test('canonical message codec rejects hostile and ambiguous JSON before traps run', () => {
  let traps = 0
  const handler: ProxyHandler<object> = {
    get: () => {
      traps += 1
      throw new Error('estimator-secret')
    },
    ownKeys: () => {
      traps += 1
      throw new Error('estimator-secret')
    }
  }
  const valid = deepFreeze([{ role: 'user' as const, content: 'fixture' }])
  const nestedProxy = Object.freeze([Object.freeze({
    role: 'assistant' as const,
    content: null,
    toolCalls: Object.freeze([Object.freeze({
      callId: 'call-1',
      name: 'fixture',
      arguments: new Proxy(Object.freeze({ ok: true }), handler)
    })])
  })])
  const getter = Object.freeze(Object.defineProperty({}, 'role', {
    enumerable: true,
    get: () => {
      traps += 1
      throw new Error('estimator-secret')
    }
  }))

  assert.throws(() => serializeModelMessages(new Proxy(valid, handler)), TypeError)
  assert.throws(() => serializeModelMessages(nestedProxy), TypeError)
  assert.throws(() => serializeModelMessages(Object.freeze([getter])), TypeError)
  assert.equal(traps, 0)
})

test('canonical message codec rejects sparse, hidden, symbol, extra, mutable and invalid scalars', () => {
  const sparse: unknown[] = []
  sparse.length = 1
  Object.freeze(sparse)
  const extra = [{ role: 'user', content: 'fixture' }] as unknown[] & { extra?: boolean }
  extra.extra = true
  deepFreeze(extra)
  const hidden = [{ role: 'user', content: 'fixture' }]
  Object.defineProperty(hidden[0], 'hidden', { value: true, enumerable: false })
  deepFreeze(hidden)
  const symbol = [{ role: 'user', content: 'fixture', [Symbol('x')]: true }]
  deepFreeze(symbol)
  const mutableNested = Object.freeze([{ role: 'user', content: 'fixture' }])

  for (const value of [sparse, extra, hidden, symbol, mutableNested]) {
    assert.throws(() => serializeModelMessages(value), TypeError)
  }
  for (const invalid of [-0, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const messages = deepFreeze([{
      role: 'assistant' as const,
      content: null,
      toolCalls: [{ callId: 'call-1', name: 'fixture', arguments: { invalid } }]
    }])
    assert.throws(() => serializeModelMessages(messages), TypeError)
  }
  assert.throws(() => serializeModelMessages(deepFreeze([{
    role: 'user' as const,
    content: '\ud800'
  }])), TypeError)
})

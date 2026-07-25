import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryPortSignalScopeV1 } from '../../src/agent/memory/memory-port-signal.js'

test('memory port signal accepts native plain composite and aborted signals', () => {
  const controller = new AbortController()
  const composite = AbortSignal.any([controller.signal])
  const plainScope = createMemoryPortSignalScopeV1(controller.signal)
  const compositeScope = createMemoryPortSignalScopeV1(composite)
  const abortedScope = createMemoryPortSignalScopeV1(AbortSignal.abort('fixture'))

  assert.equal(plainScope.isAborted(), false)
  assert.equal(compositeScope.isAborted(), false)
  assert.equal(abortedScope.isAborted(), true)
  assert.equal(abortedScope.signal?.aborted, true)

  controller.abort()
  assert.equal(plainScope.isAborted(), true)
  assert.equal(compositeScope.isAborted(), true)
  assert.equal(plainScope.signal?.aborted, true)
  assert.equal(compositeScope.signal?.aborted, true)

  plainScope.close()
  compositeScope.close()
  abortedScope.close()
})

test('memory port signal rejects forged and proxied signals', () => {
  const forged = Object.create(AbortSignal.prototype) as AbortSignal
  const proxied = new Proxy(new AbortController().signal, {})
  const accessor = new AbortController().signal
  Object.defineProperty(accessor, 'aborted', { get: () => false })

  assert.throws(() => createMemoryPortSignalScopeV1(forged), TypeError)
  assert.throws(() => createMemoryPortSignalScopeV1(proxied), TypeError)
  assert.throws(() => createMemoryPortSignalScopeV1(accessor), TypeError)
  assert.throws(() => createMemoryPortSignalScopeV1({ aborted: false }), TypeError)
})

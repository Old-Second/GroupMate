import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPersonalMemoryOperationsGatewayV1,
  formatPersonalMemoryOperationsStatusV1,
  type PersonalMemoryOperationsPortV1
} from '../../src/runtime/personal-memory-operations.js'

function snapshot (overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    status: 'ready',
    canonical: {
      namespaces: 2,
      activeRecords: 8,
      logicalBytes: 4_096,
      sqliteFileBytes: 65_536
    },
    lexical: {
      status: 'ready',
      records: 8,
      logicalBytes: 2_048,
      sqliteFileBytes: 32_768,
      lagRecords: 0
    },
    extraction: {
      status: 'idle',
      pendingRecords: 0,
      deadLetterRecords: 0,
      logicalBytes: 0
    },
    hotCache: {
      status: 'disabled',
      records: 0,
      logicalBytes: 0
    },
    semantic: {
      embedding: 'disabled',
      vector: 'disabled',
      rerank: 'disabled'
    },
    ...overrides
  }
}

test('off mode status and maintenance never touch the production port', async () => {
  let inspectCalls = 0
  let executeCalls = 0
  const port: PersonalMemoryOperationsPortV1 = {
    async inspect () {
      inspectCalls += 1
      throw new Error('must not inspect')
    },
    async execute () {
      executeCalls += 1
      throw new Error('must not execute')
    }
  }
  const gateway = createPersonalMemoryOperationsGatewayV1({
    mode: () => 'off',
    port: () => port
  })

  assert.deepEqual(await gateway.inspect(), {
    schemaVersion: 1,
    status: 'off',
    mode: 'off'
  })
  assert.deepEqual(await gateway.execute('verify'), {
    schemaVersion: 1,
    status: 'disabled',
    action: 'verify'
  })
  assert.equal(inspectCalls, 0)
  assert.equal(executeCalls, 0)
})

test('active mode exposes bounded body-free operational status', async () => {
  const port: PersonalMemoryOperationsPortV1 = {
    async inspect () { return snapshot() },
    async execute (request) {
      return {
        schemaVersion: 1,
        status: 'completed',
        action: request.action,
        affectedRecords: 8
      }
    }
  }
  const gateway = createPersonalMemoryOperationsGatewayV1({
    mode: () => 'explicit',
    port: () => port
  })

  assert.deepEqual(await gateway.inspect(), {
    ...snapshot(),
    mode: 'explicit'
  })
  assert.deepEqual(await gateway.execute('rebuild_lexical'), {
    schemaVersion: 1,
    status: 'completed',
    action: 'rebuild_lexical',
    affectedRecords: 8
  })
  assert.match(formatPersonalMemoryOperationsStatusV1(await gateway.inspect()), /2 个命名空间/)
  assert.match(formatPersonalMemoryOperationsStatusV1(await gateway.inspect()), /8 条有效记忆/)
  assert.doesNotMatch(formatPersonalMemoryOperationsStatusV1(await gateway.inspect()), /text|query|secret/i)
})

test('operations fail closed on absent, throwing, malformed and secret-bearing ports', async () => {
  const absent = createPersonalMemoryOperationsGatewayV1({
    mode: () => 'shadow',
    port: () => null
  })
  assert.deepEqual(await absent.inspect(), {
    schemaVersion: 1,
    status: 'unavailable',
    mode: 'shadow'
  })
  assert.deepEqual(await absent.execute('verify'), {
    schemaVersion: 1,
    status: 'unavailable',
    action: 'verify'
  })

  for (const result of [
    { ...snapshot(), apiKey: 'secret' },
    snapshot({ canonical: { namespaces: -1 } }),
    snapshot({ semantic: { embedding: 'ready', vector: 'disabled', rerank: 'disabled' } })
  ]) {
    const gateway = createPersonalMemoryOperationsGatewayV1({
      mode: () => 'automatic',
      port: () => ({
        async inspect () { return result },
        async execute () { throw new Error('unavailable') }
      })
    })
    assert.deepEqual(await gateway.inspect(), {
      schemaVersion: 1,
      status: 'unavailable',
      mode: 'automatic'
    })
    assert.deepEqual(await gateway.execute('verify'), {
      schemaVersion: 1,
      status: 'unavailable',
      action: 'verify'
    })
  }
})

test('operations reject unknown actions before dispatch', async () => {
  let calls = 0
  const gateway = createPersonalMemoryOperationsGatewayV1({
    mode: () => 'explicit',
    port: () => ({
      async inspect () { return snapshot() },
      async execute () {
        calls += 1
        return { schemaVersion: 1, status: 'completed', action: 'verify', affectedRecords: 0 }
      }
    })
  })
  await assert.rejects(
    gateway.execute('delete_all' as 'verify'),
    /长期记忆维护动作无效/
  )
  assert.equal(calls, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GroupHistoryReadCoordinator,
  type GroupHistoryDiagnosticCode,
  type GroupHistorySnapshotRow
} from '../../src/runtime/group-history-read-coordinator.js'

function rawRow (id: string, text: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    message_id: id,
    raw_message: text,
    sender: Object.freeze({ user_id: 'member-1', card: '群友', nickname: '群友' }),
    time: 1_789_000_000
  })
}

function snapshotRow (id: string, text: string): GroupHistorySnapshotRow {
  return Object.freeze({
    message_id: id,
    raw_message: text,
    sender: Object.freeze({ user_id: 'member-1', card: '群友', nickname: '群友' }),
    time: 1_789_000_000
  })
}

function deferred<T> (): Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
}> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return Object.freeze({ promise, resolve })
}

test('a stuck group does not prevent another group from loading history', async () => {
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 10 })
  const stuck = coordinator.read({
    key: 'bot-a\0group-a',
    limit: 50,
    load: async (): Promise<readonly unknown[]> => await new Promise(() => {})
  })
  await new Promise(resolve => setTimeout(resolve, 15))

  assert.deepEqual(await coordinator.read({
    key: 'bot-a\0group-b',
    limit: 50,
    load: async () => [rawRow('b-1', '群 B 内容')]
  }), [snapshotRow('b-1', '群 B 内容')])
  assert.deepEqual(await stuck, [])
})

test('same-group callers reuse one host operation', async () => {
  const gate = deferred<readonly unknown[]>()
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 50 })
  let loadCalls = 0
  const load = async (): Promise<readonly unknown[]> => {
    loadCalls += 1
    return await gate.promise
  }
  const first = coordinator.read({ key: 'bot\0group', limit: 50, load })
  const second = coordinator.read({ key: 'bot\0group', limit: 50, load })

  gate.resolve([rawRow('m-1', '同群内容')])

  assert.deepEqual(await first, [snapshotRow('m-1', '同群内容')])
  assert.deepEqual(await second, [snapshotRow('m-1', '同群内容')])
  assert.equal(loadCalls, 1)
})

test('same-group waiter count is bounded while one host operation is pending', async () => {
  const gate = deferred<readonly unknown[]>()
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 50 })
  let loadCalls = 0
  const load = async (): Promise<readonly unknown[]> => {
    loadCalls += 1
    return await gate.promise
  }
  const first = coordinator.read({ key: 'bot\0group', limit: 50, load })
  const second = coordinator.read({ key: 'bot\0group', limit: 50, load })
  const third = coordinator.read({ key: 'bot\0group', limit: 50, load })

  const thirdState = await Promise.race([
    third.then(value => Object.freeze({ kind: 'resolved' as const, value })),
    new Promise<Readonly<{ readonly kind: 'still_pending' }>>(resolve => {
      setTimeout(() => resolve(Object.freeze({ kind: 'still_pending' as const })), 10)
    })
  ])
  assert.deepEqual(thirdState, Object.freeze({ kind: 'resolved', value: Object.freeze([]) }))
  assert.equal(loadCalls, 1)

  gate.resolve([rawRow('m-1', '同群内容')])
  assert.equal((await first).length, 1)
  assert.equal((await second).length, 1)
})

test('a third group does not dispatch after two host operations remain pending', async () => {
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 5, maxInFlight: 2 })
  const never = async (): Promise<readonly unknown[]> => await new Promise(() => {})
  await Promise.all([
    coordinator.read({ key: 'bot\0a', limit: 50, load: never }),
    coordinator.read({ key: 'bot\0b', limit: 50, load: never })
  ])
  let thirdCalls = 0

  assert.deepEqual(await coordinator.read({
    key: 'bot\0c',
    limit: 50,
    load: async () => {
      thirdCalls += 1
      return [rawRow('c-1', '不应读取')]
    }
  }), [])
  assert.equal(thirdCalls, 0)
})

test('timeout falls back to the latest unexpired snapshot', async () => {
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 5 })
  const expected = [snapshotRow('m-1', '最近成功内容')]
  assert.deepEqual(await coordinator.read({
    key: 'bot\0group',
    limit: 50,
    load: async () => [rawRow('m-1', '最近成功内容')]
  }), expected)

  assert.deepEqual(await coordinator.read({
    key: 'bot\0group',
    limit: 50,
    load: async (): Promise<readonly unknown[]> => await new Promise(() => {})
  }), expected)
})

test('a late success uses the original start time as cache expiry', async () => {
  let now = 0
  const gate = deferred<readonly unknown[]>()
  const coordinator = new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    cacheTtlMs: 60_000,
    now: () => now
  })
  assert.deepEqual(await coordinator.read({
    key: 'bot\0group',
    limit: 50,
    load: async () => await gate.promise
  }), [])

  now = 59_000
  gate.resolve([rawRow('m-1', '迟到内容')])
  await new Promise<void>(resolve => setImmediate(resolve))
  now = 60_001

  assert.deepEqual(await coordinator.read({
    key: 'bot\0group',
    limit: 50,
    load: async (): Promise<readonly unknown[]> => await new Promise(() => {})
  }), [])
})

test('cache group count evicts the least recently used snapshot', async () => {
  const coordinator = new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    maxCacheGroups: 2
  })
  for (const key of ['a', 'b', 'c']) {
    await coordinator.read({
      key: `bot\0${key}`,
      limit: 50,
      load: async () => [rawRow(`${key}-1`, `群 ${key}`)]
    })
  }
  const never = async (): Promise<readonly unknown[]> => await new Promise(() => {})
  await Promise.all([
    coordinator.read({ key: 'bot\0x', limit: 50, load: never }),
    coordinator.read({ key: 'bot\0y', limit: 50, load: never })
  ])

  assert.deepEqual(await coordinator.read({ key: 'bot\0a', limit: 50, load: never }), [])
  assert.deepEqual(await coordinator.read({ key: 'bot\0c', limit: 50, load: never }), [
    snapshotRow('c-1', '群 c')
  ])
})

test('one snapshot drops oldest rows until its byte limit is satisfied', async () => {
  const coordinator = new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    maxEntryBytes: 180
  })

  const bounded = await coordinator.read({
    key: 'bot\0bounded',
    limit: 50,
    load: async () => [rawRow('old', '旧'.repeat(100)), rawRow('new', '新')]
  })

  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 180)
  assert.equal(bounded.length, 1)
  assert.equal(bounded[0]?.message_id, 'new')
})

test('total cache bytes evict older group snapshots', async () => {
  const coordinator = new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    maxEntryBytes: 180,
    maxCacheBytes: 200
  })
  await coordinator.read({
    key: 'bot\0a', limit: 50, load: async () => [rawRow('a-1', '群 a')]
  })
  await coordinator.read({
    key: 'bot\0b', limit: 50, load: async () => [rawRow('b-1', '群 b')]
  })
  const never = async (): Promise<readonly unknown[]> => await new Promise(() => {})
  await Promise.all([
    coordinator.read({ key: 'bot\0x', limit: 50, load: never }),
    coordinator.read({ key: 'bot\0y', limit: 50, load: never })
  ])

  assert.deepEqual(await coordinator.read({ key: 'bot\0a', limit: 50, load: never }), [])
  assert.deepEqual(await coordinator.read({ key: 'bot\0b', limit: 50, load: never }), [
    snapshotRow('b-1', '群 b')
  ])
})

test('snapshots ignore accessors and retain only bounded allowlisted data', async () => {
  let getterCalls = 0
  const hostile = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostile, 'message_id', {
    enumerable: true,
    get: () => {
      getterCalls += 1
      return 'hostile'
    }
  })
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 5 })

  const rows = await coordinator.read({
    key: 'bot\0group',
    limit: 50,
    load: async () => [hostile, {
      message_id: 'm-1',
      raw_message: '字'.repeat(5_000),
      secret: 'drop-me',
      message: [{ type: 'image', file: Buffer.alloc(16) }],
      sender: {
        user_id: 'u-1', card: '群友', nickname: '群友', token: 'drop-me'
      },
      callback: () => undefined,
      time: 1_789_000_000
    }]
  })

  assert.equal(getterCalls, 0)
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
    'message_id', 'raw_message', 'sender', 'time'
  ])
  assert.deepEqual(Object.keys(rows[0]?.sender ?? {}).sort(), [
    'card', 'nickname', 'user_id'
  ])
  assert.equal([...(rows[0]?.raw_message ?? '')].length, 4_096)
  assert.equal(JSON.stringify(rows).includes('drop-me'), false)
})

test('snapshot text preserves legacy message segment projection', async () => {
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 5 })

  const rows = await coordinator.read({
    key: 'bot\0group',
    limit: 50,
    load: async () => [{
      message_id: 'm-1',
      message: [
        { type: 'text', data: { text: '你好' } },
        { type: 'at', qq: 'member-2' },
        { type: 'image', file: 'unretained-resource' }
      ],
      sender: { user_id: 'member-1', card: '群友', nickname: '群友' }
    }]
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.raw_message, '你好@member-2[图片]')
  assert.equal(JSON.stringify(rows).includes('unretained-resource'), false)
})

test('snapshot keeps legacy history rows that have no message identifier', async () => {
  const coordinator = new GroupHistoryReadCoordinator({ timeoutMs: 5 })

  const rows = await coordinator.read({
    key: 'bot\0group',
    limit: 50,
    load: async () => [{
      raw_message: '没有消息标识的旧适配器历史',
      sender: { user_id: 'member-1', card: '群友', nickname: '群友' }
    }]
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.message_id, undefined)
  assert.equal(rows[0]?.raw_message, '没有消息标识的旧适配器历史')
})

test('diagnostics use fixed cache-aware codes and isolate callback failures', async () => {
  const codes: GroupHistoryDiagnosticCode[] = []
  const withoutCache = new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    maxInFlight: 1,
    onDiagnostic: code => { codes.push(code) }
  })
  const never = async (): Promise<readonly unknown[]> => await new Promise(() => {})
  assert.deepEqual(await withoutCache.read({ key: 'bot\0a', limit: 50, load: never }), [])
  assert.deepEqual(await withoutCache.read({ key: 'bot\0b', limit: 50, load: never }), [])

  const withCache = new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    maxInFlight: 1,
    onDiagnostic: code => { codes.push(code) }
  })
  await withCache.read({
    key: 'bot\0cached', limit: 50, load: async () => [rawRow('m-1', '缓存')]
  })
  assert.deepEqual(await withCache.read({ key: 'bot\0cached', limit: 50, load: never }), [
    snapshotRow('m-1', '缓存')
  ])
  const capacityWithCache = new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    maxInFlight: 1,
    onDiagnostic: code => { codes.push(code) }
  })
  await capacityWithCache.read({
    key: 'bot\0cached', limit: 50, load: async () => [rawRow('m-2', '容量缓存')]
  })
  await capacityWithCache.read({ key: 'bot\0blocker', limit: 50, load: never })
  assert.deepEqual(await capacityWithCache.read({
    key: 'bot\0cached', limit: 50, load: never
  }), [snapshotRow('m-2', '容量缓存')])
  assert.deepEqual(await new GroupHistoryReadCoordinator({
    timeoutMs: 5,
    onDiagnostic: code => {
      codes.push(code)
      throw new Error('diagnostic callback failure')
    }
  }).read({
    key: 'bot\0rejected',
    limit: 50,
    load: async () => { throw new Error('host rejection') }
  }), [])

  assert.deepEqual(codes, [
    'timeout_without_cache',
    'capacity_without_cache',
    'timeout_with_cache',
    'timeout_without_cache',
    'capacity_with_cache',
    'read_rejected'
  ])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  listYunzaiBots,
  sendYunzaiGroupMessage
} from '../../src/runtime/yunzai-bot-registry.js'

function withHostBot<T> (host: unknown, operation: () => T): T {
  const present = Reflect.has(globalThis, 'Bot')
  const original = Reflect.get(globalThis, 'Bot')
  if (host === undefined) Reflect.deleteProperty(globalThis, 'Bot')
  else Reflect.set(globalThis, 'Bot', host)
  try {
    return operation()
  } finally {
    if (present) Reflect.set(globalThis, 'Bot', original)
    else Reflect.deleteProperty(globalThis, 'Bot')
  }
}

function botInstance (botId: string): Record<string, unknown> {
  return {
    uin: botId,
    gl: new Map<number, unknown>(),
    pickGroup: () => ({ sendMsg: async () => undefined })
  }
}

test('multi account hosts expose every live bot instance and no adapter placeholder', () => {
  const first = botInstance('1001')
  const second = botInstance('1002')
  const host = {
    uin: Object.assign(['1001', '1002'], { toJSON: () => '1001' }),
    adapter: [{ id: 'OneBotv11', name: 'OneBot' }, { id: 'stdin', name: 'stdin' }],
    bots: { 1001: first, 1002: second },
    gl: new Map<number, unknown>(),
    pickGroup: () => ({ sendMsg: async () => undefined })
  }

  const bots = withHostBot(host, () => listYunzaiBots())

  assert.deepEqual(bots, [first, second])
  assert.equal(bots.includes(host as unknown as Record<string, unknown>), false)
  assert.equal(bots.some(bot => bot === undefined || bot === null), false)
  assert.equal(Object.isFrozen(bots), true)
})

test('multi account hosts resolve instances indexed on the host object', () => {
  const instance = botInstance('2001')
  const host = {
    uin: ['2001'],
    adapter: [{ id: 'OneBotv11' }],
    2001: instance
  }

  assert.deepEqual(withHostBot(host, () => listYunzaiBots()), [instance])
})

test('a bot registered under several account ids is returned once', () => {
  const shared = botInstance('3001')
  const host = { uin: ['3001', '3002'], bots: { 3001: shared, 3002: shared } }

  assert.deepEqual(withHostBot(host, () => listYunzaiBots()), [shared])
})

test('unknown, malformed and offline account ids are skipped', () => {
  const online = botInstance('4001')
  const host = {
    uin: ['4001', 'not-an-account', '', null, 4002],
    bots: { 4001: online }
  }

  assert.deepEqual(withHostBot(host, () => listYunzaiBots()), [online])
})

test('multi account hosts without a live bot list nothing', () => {
  const host = {
    uin: [],
    adapter: [{ id: 'OneBotv11' }],
    bots: {},
    gl: new Map<number, unknown>(),
    pickGroup: () => ({ sendMsg: async () => undefined })
  }

  assert.deepEqual(withHostBot(host, () => listYunzaiBots()), [])
})

test('legacy single account hosts are the bot instance themselves', () => {
  const host = { uin: 5001, gl: new Map<number, unknown>() }

  assert.deepEqual(withHostBot(host, () => listYunzaiBots()), [host])
})

test('hosts without a bot global or bot shape list nothing', () => {
  assert.deepEqual(withHostBot(undefined, () => listYunzaiBots()), [])
  assert.deepEqual(withHostBot({ uin: 6001 }, () => listYunzaiBots()), [])
})

test('group sends prefer the picker exposed by multi account instances', async () => {
  const sent: unknown[] = []
  const picked: unknown[] = []
  const bot = {
    pickGroup: (groupId: unknown) => {
      picked.push(groupId)
      return { sendMsg: async (message: unknown) => { sent.push(message); return 'ok' } }
    },
    sendGroupMsg: async () => { throw new Error('aggregate signature must not be used') }
  }

  assert.equal(await sendYunzaiGroupMessage(bot, 700, '你好'), 'ok')
  assert.deepEqual(picked, [700])
  assert.deepEqual(sent, ['你好'])
})

test('group sends fall back to the legacy client method', async () => {
  const calls: unknown[][] = []
  const bot = {
    sendGroupMsg: async (...args: unknown[]) => { calls.push(args); return 'legacy' }
  }

  assert.equal(await sendYunzaiGroupMessage(bot, 800, '你好'), 'legacy')
  assert.deepEqual(calls, [[800, '你好']])
})

test('group sends reject a bot without any send capability', async () => {
  await assert.rejects(
    async () => await sendYunzaiGroupMessage({ pickGroup: () => null }, 900, '你好'),
    TypeError
  )
})

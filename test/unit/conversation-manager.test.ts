import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionSummary } from '../../src/agent/session/session-record.js'
import type { LegacySessionBridge } from '../../src/runtime/legacy-session-bridge.js'
import {
  endAllConversations,
  endConversation,
  joinConversation,
  listConversations
} from '../../src/runtime/conversation-manager.js'

const event = {
  isGroup: true,
  group_id: 8,
  user_id: 7,
  self_id: 10000,
  sender: { user_id: 7, nickname: 'member' },
  message: [] as Array<Record<string, unknown>>
}

function fakeBridge (overrides: Partial<LegacySessionBridge> = {}): LegacySessionBridge {
  return {
    resolveAddress: () => ({ botId: '10000', scope: { kind: 'private', userId: '7' } }),
    loadOrCreate: async () => { throw new Error('not implemented') },
    save: async () => {},
    has: async () => false,
    delete: async () => false,
    list: async function * () {},
    deleteAll: async () => 0,
    fork: async () => false,
    ...overrides
  }
}

function summary (userId: string): SessionSummary {
  return {
    address: { botId: '10000', scope: { kind: 'private', userId } },
    sessionId: `session-${userId}`,
    startedBy: { userId, displayName: `member-${userId}` },
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:01:00.000Z',
    turnCount: 2,
    source: 'canonical'
  }
}

test('list returns exact empty and populated conversation results', async () => {
  assert.deepEqual(await listConversations({ bridge: fakeBridge(), event }), {
    message: '当前没有人正在与机器人对话',
    quote: true,
    success: false
  })
  const bridge = fakeBridge({
    list: async function * () {
      yield summary('7')
    }
  })
  assert.deepEqual(await listConversations({ bridge, event }), {
    message: '当前对话列表：(格式为【开始时间 ｜ qq昵称 ｜ 对话长度 ｜ 最后活跃时间】)\n2026-07-13T00:00:00.000Z ｜ member-7 ｜ 2 ｜ 2026-07-13T00:01:00.000Z \n',
    quote: true,
    success: true
  })
})

test('end current returns exact results for missing and active sessions', async () => {
  assert.deepEqual(await endConversation({
    bridge: fakeBridge(),
    event,
    groupMerge: false,
    toggleMode: 'at'
  }), {
    message: '当前没有开启对话',
    quote: true,
    success: false
  })
  assert.deepEqual(await endConversation({
    bridge: fakeBridge({ delete: async () => true }),
    event,
    groupMerge: false,
    toggleMode: 'at'
  }), {
    message: '已结束当前对话，请@我进行聊天以开启新的对话',
    quote: true,
    success: true
  })
})

test('end mentioned filters the bot mention in at mode', async () => {
  const targets: Array<string | number | undefined> = []
  const bridge = fakeBridge({
    delete: async (_event, _groupMerge, targetUserId) => {
      targets.push(targetUserId)
      return true
    }
  })
  const mentionedEvent = {
    ...event,
    message: [
      { type: 'at', qq: 10000, text: '@GroupMate' },
      { type: 'at', qq: 9, text: '@target' }
    ]
  }

  assert.deepEqual(await endConversation({
    bridge,
    event: mentionedEvent,
    groupMerge: false,
    toggleMode: 'at'
  }), {
    message: '已结束target的对话，TA仍可以@我进行聊天以开启新的对话',
    quote: true,
    success: true
  })
  assert.deepEqual(targets, [9])
})

test('end all returns the exact deleted count', async () => {
  assert.deepEqual(await endAllConversations({
    bridge: fakeBridge({ deleteAll: async () => 3 }),
    event
  }), {
    message: '结束了3个用户的对话。',
    quote: true,
    success: true
  })
})

test('join validates mentions and forks to an independent session', async () => {
  assert.deepEqual(await joinConversation({
    bridge: fakeBridge(),
    event,
    groupMerge: false,
    toggleMode: 'at'
  }), {
    message: '指令错误，使用本指令时请同时@某人',
    quote: true,
    success: false
  })

  const joinedEvent = {
    ...event,
    message: [{ type: 'at', qq: 9, text: '@target' }]
  }
  assert.deepEqual(await joinConversation({
    bridge: fakeBridge({ fork: async () => true }),
    event: joinedEvent,
    groupMerge: false,
    toggleMode: 'at'
  }), {
    message: '加入target的对话成功',
    quote: false,
    success: true
  })
})

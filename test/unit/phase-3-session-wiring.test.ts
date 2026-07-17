import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import type { AgentSessionState } from '../../src/agent/session/agent-session-state.js'
import type { SessionRecord } from '../../src/agent/session/session-record.js'
import type { ConversationSessionPort } from '../../src/runtime/agent-service.js'
import {
  createYunzaiChatController,
  type ChatEntryPolicySnapshot,
  type YunzaiChatControllerOptions
} from '../../src/runtime/yunzai-chat-controller.js'

const root = process.cwd()

test('production chat uses AgentService sessions after the legacy core is deleted', async () => {
  const calls: string[] = []
  const replies: string[] = []
  const conversations: ConversationSessionPort = {
    get: async () => null,
    list: async function * () {
      calls.push('list')
      yield {
        address: { botId: 'bot-1', scope: { kind: 'private', userId: 'target' } },
        sessionId: 'session-target',
        startedBy: { userId: 'target', displayName: '目标' },
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:01:00.000Z',
        turnCount: 2,
        source: 'canonical'
      }
    },
    delete: async () => { calls.push('delete'); return true },
    deleteAll: async () => { calls.push('deleteAll'); return 2 },
    fork: async (_source, target, startedBy) => {
      calls.push('fork')
      return {
        schemaVersion: 1,
        sessionId: 'joined',
        botId: target.botId,
        scope: target.scope,
        startedBy,
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
        turnCount: 0,
        state: { schemaVersion: 1, messages: [] }
      } satisfies SessionRecord<AgentSessionState>
    }
  }
  const snapshot: ChatEntryPolicySnapshot = Object.freeze({
    toggleMode: 'prefix',
    enablePrivateChat: true,
    whitelist: Object.freeze([]),
    blacklist: Object.freeze([]),
    imgOcr: false,
    groupMerge: false,
    enableGroupContext: false,
    thinkingMode: 'default',
    reasoningEffort: 'default',
    sessionTtlSeconds: 60,
    assistantLabel: '派蒙',
    promptPrefixOverride: '',
    actorCastApi: ''
  })
  const controller = createYunzaiChatController({
    policy: {
      entryMode: () => 'prefix',
      snapshot: async () => snapshot,
      clearAzureEmotionFeedback: async () => { calls.push('clearFeedback') }
    },
    agent: { conversations },
    controls: {
      presentCommand: async ({ message }: { readonly message: string }) => {
        replies.push(message)
      }
    }
  } as unknown as YunzaiChatControllerOptions, ['api', 'API'])
  const event = {
    isGroup: true,
    group_id: 'group-1',
    self_id: 'bot-1',
    user_id: 'actor-1',
    sender: { user_id: 'actor-1', nickname: '群友' },
    message: [{ type: 'at', qq: 'target', text: '@目标' }]
  }

  await controller.getAllConversations(event)
  await controller.destroyConversations({ ...event, message: [] })
  await controller.endAllConversations(event)
  assert.equal(await controller.joinConversation(event), true)

  assert.deepEqual(calls, ['list', 'clearFeedback', 'delete', 'deleteAll', 'fork'])
  assert.equal(replies.length, 4)
  assert.match(replies[0] ?? '', /当前对话列表/)
  assert.equal(replies[1], '已结束当前对话，请@我进行聊天以开启新的对话')
  assert.equal(replies[2], '结束了2个用户的对话。')
  assert.equal(replies[3], '加入目标的对话成功')

  for (const file of [
    'model/core.js',
    'src/runtime/legacy-session-bridge.ts',
    'dist/runtime/legacy-session-bridge.js'
  ]) {
    let code: string | undefined
    try {
      await access(path.join(root, file))
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code
    }
    assert.equal(code, 'ENOENT', `${file} must be removed`)
  }
})

test('legacy JavaScript session modules are removed after TypeScript wiring', async () => {
  for (const file of ['model/conversation.js', 'model/legacy/conversation-scope.js']) {
    let code: string | undefined
    try {
      await access(path.join(root, file))
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code
    }
    assert.equal(code, 'ENOENT', `${file} must be removed`)
  }
})

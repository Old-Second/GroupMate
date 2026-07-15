import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { getYunzaiAgentServiceBridge } from '../../src/runtime/agent-service-bridge.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const root = process.cwd()
const entries = Object.freeze([
  'apps/chat.js',
  'apps/bym.js',
  'apps/approval.js'
])

const localImport = /(?:import\s+(?:[^'";]+?\s+from\s+)?|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g

async function exists (file: string): Promise<boolean> {
  try {
    await access(path.join(root, file))
    return true
  } catch {
    return false
  }
}

async function resolveImport (from: string, specifier: string): Promise<string | null> {
  const candidate = path.normalize(path.join(path.dirname(from), specifier))
  for (const file of [candidate, `${candidate}.js`, path.join(candidate, 'index.js')]) {
    if (await exists(file)) return file
  }
  return null
}

async function productionGraph (): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (sources.has(file)) continue
    const source = await readFile(path.join(root, file), 'utf8')
    sources.set(file, source)
    localImport.lastIndex = 0
    for (const match of source.matchAll(localImport)) {
      const resolved = await resolveImport(file, match[2] as string)
      if (resolved !== null && !sources.has(resolved)) queue.push(resolved)
    }
  }
  return sources
}

test('Phase 5 production entries reach one run engine and one OpenAI-compatible transport', async () => {
  const graph = await productionGraph()
  const files = [...graph.keys()].sort()
  const modelLoops = files.filter(file => file === 'dist/agent/run/run-engine.js')
  const transports = files.filter(file => (
    file === 'dist/agent/model/openai-compatible-adapter.js'
  ))
  const combined = [...graph.entries()].map(([file, source]) => `${file}\n${source}`).join('\n')

  assert.deepEqual(modelLoops, ['dist/agent/run/run-engine.js'])
  assert.deepEqual(transports, ['dist/agent/model/openai-compatible-adapter.js'])
  assert.equal(files.includes('model/core.js'), false)
  assert.equal(files.includes('utils/openai/chatgpt-api.js'), false)
  assert.equal(files.includes('dist/runtime/tools/approval-command.js'), false)
  assert.doesNotMatch(combined, /agentRuntimeMode|legacyRuntime|newRuntime|catch\s*\([^)]*\)\s*\{[^}]*model\/core\.js/s)
})

test('Phase 5 approval app accepts only an exact quoted decision', async () => {
  const source = await readFile(path.join(root, 'apps/approval.js'), 'utf8')

  assert.match(source, /\^\(确认\|拒绝\)\$/)
  assert.doesNotMatch(source, /#确认|#拒绝|token|finalize/i)
  assert.match(source, /priority:\s*1143/)
})

function modelResponse (text: string) {
  const body = JSON.stringify({
    id: `response-${text}`,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: text }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
  })
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    body: {
      async * [Symbol.asyncIterator] () {
        yield Buffer.from(body)
      }
    }
  }
}

function modelToolResponse (
  callId: string,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>
) {
  const body = JSON.stringify({
    id: `response-${callId}`,
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name, arguments: JSON.stringify(argumentsValue) }
        }]
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
  })
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    body: {
      async * [Symbol.asyncIterator] () {
        yield Buffer.from(body)
      }
    }
  }
}

test('Phase 5 production wiring runs ordinary and ephemeral requests through AgentService', async () => {
  const timestamp = '2026-07-14T05:00:00.000Z'
  const redis = new FakeRedis(() => Date.parse(timestamp))
  const responses = [modelResponse('ordinary reply'), modelResponse('<EMPTY>')]
  const requests: Array<Record<string, unknown>> = []
  let groupHistory: readonly unknown[] = []
  let generated = 0
  const config: Record<string, unknown> = {
    openAiCompatibilityProfile: 'standard',
    openAiBaseUrl: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model',
    apiStream: false,
    apiMaxToken: 256,
    temperature: 0.7,
    defaultTimeoutMs: 30_000,
    groupMerge: false,
    toolPolicyProfile: 'compatible',
    toolApprovalTtlSeconds: 120,
    serpSource: 'ikechan8370',
    imageSearchSource: 'ikechan8370',
    enableToolCrossGroupSend: false,
    enableToolPrivateSend: false,
    enableToolVideoDownload: false
  }
  const bridge = getYunzaiAgentServiceBridge({
    config,
    redis,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body) as Record<string, unknown>)
      return responses.shift() ?? modelResponse('unexpected')
    },
    getMasterIds: async () => ['master-1'],
    getBotId: () => 'bot-1',
    loadGroupHistory: async () => groupHistory,
    segment: () => ({}),
    now: () => new Date(timestamp),
    generateId: () => `production-${++generated}`
  })
  const event = {
    isGroup: false,
    isPrivate: true,
    self_id: 'bot-1',
    user_id: 'actor-1',
    message_id: 'message-1',
    msg: 'hello',
    message: [{ type: 'text', text: 'hello' }],
    sender: { user_id: 'actor-1', nickname: 'member' },
    bot: {
      uin: 'bot-1',
      pickFriend: () => ({ sendMsg: async () => ({ message_id: 'sent-1' }) })
    }
  }

  const ordinary = await bridge.handle(event, 'hello', {
    systemInstructions: ['You are GroupMate.'],
    sessionTtlSeconds: 600
  })
  assert.equal(ordinary.kind, 'completed')
  assert.equal(ordinary.kind === 'completed' ? ordinary.text : null, 'ordinary reply')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.temperature, 0.7)
  const firstMessages = requests[0]?.messages as Array<{
    role?: unknown
    content?: unknown
  }> | undefined
  assert.equal(firstMessages?.some(message => (
    message.role === 'system' && String(message.content).includes('actor-1')
  )), false)
  assert.equal(firstMessages?.some(message => (
    message.role === 'user' && String(message.content).includes('actor-1') &&
    String(message.content).includes('不可信数据')
  )), true)
  const stored = await bridge.conversations.get({
    botId: 'bot-1', scope: { kind: 'private', userId: 'actor-1' }
  })
  assert.equal(stored?.turnCount, 1)

  const ephemeral = await bridge.handleEphemeral({
    ...event,
    message_id: 'message-2',
    msg: 'ambient',
    message: [{ type: 'text', text: 'ambient' }]
  }, 'ambient', { systemInstructions: ['You are GroupMate.'] })
  assert.equal(ephemeral.kind, 'completed')
  assert.equal(ephemeral.kind === 'completed' ? ephemeral.text : null, '<EMPTY>')
  assert.equal((await bridge.conversations.get({
    botId: 'bot-1', scope: { kind: 'private', userId: 'actor-1' }
  }))?.turnCount, 1)
  assert.equal(requests.length, 2)

  config.toolPolicyProfile = 'safe'
  config.toolPrivateSendPolicy = 'everyone'
  responses.push(
    modelToolResponse('call-private-send', 'sendMessage', {
      text: 'fixture delivery', targetKind: 'private', targetId: '2002'
    }),
    modelResponse('审批任务完成。')
  )
  const originalReplies: unknown[] = []
  const approverReplies: unknown[] = []
  const approvalMessages: unknown[] = []
  const targetMessages: unknown[] = []
  const approvalEventBase = {
    isGroup: false,
    isPrivate: true,
    self_id: 'bot-1',
    bot: {
      uin: 'bot-1',
      getFriendList: async () => [{ user_id: '2002' }],
      pickFriend: (userId: string | number) => ({
        sendMsg: async (message: unknown) => {
          if (String(userId) === 'master-1') {
            approvalMessages.push(message)
            return { message_id: `approval-private-${approvalMessages.length}` }
          }
          targetMessages.push(message)
          return { message_id: 'target-private-1' }
        }
      })
    }
  }
  const privateRequestEvent = {
    ...approvalEventBase,
    user_id: 'actor-1',
    message_id: 'message-3',
    msg: '请发送给用户 2002 一条测试消息',
    message: [{ type: 'text', text: '请发送给用户 2002 一条测试消息' }],
    sender: { user_id: 'actor-1', nickname: 'member', role: 'member' },
    reply: async (message: unknown) => {
      originalReplies.push(message)
      return { message_id: 'original-reply-1' }
    }
  }
  const paused = await bridge.handle(
    privateRequestEvent,
    '请发送给用户 2002 一条测试消息',
    { systemInstructions: ['You are GroupMate.'] }
  )
  assert.equal(paused.kind, 'paused')
  assert.equal(approvalMessages.length, 1)
  assert.equal(targetMessages.length, 0)

  const routed = await bridge.routeApprovalReply({
    ...approvalEventBase,
    user_id: 'master-1',
    message_id: 'approval-reply-1',
    msg: '拒绝',
    message: [{ type: 'text', text: '拒绝' }],
    source: { message_id: 'approval-private-1' },
    sender: { user_id: 'master-1', nickname: 'master', role: 'member' },
    reply: async (message: unknown) => {
      approverReplies.push(message)
      return { message_id: 'approver-reply-1' }
    }
  })
  assert.equal(routed, true)
  assert.deepEqual(targetMessages, [])
  assert.deepEqual(originalReplies, ['审批任务完成。'])
  assert.equal(approverReplies.length, 0)
  const approvalRequestMessages = requests.slice(2).flatMap(request => (
    Array.isArray(request.messages) ? request.messages : []
  )) as Array<{ role?: unknown; content?: unknown }>
  assert.equal(approvalRequestMessages.some(message => (
    message.role === 'user' && message.content === '拒绝'
  )), false)
  assert.doesNotMatch(
    JSON.stringify(approvalRequestMessages),
    /approval-private-1|approval-reply-1/
  )

  responses.push(
    modelToolResponse('call-private-send-approved', 'sendMessage', {
      text: 'approved fixture delivery', targetKind: 'private', targetId: '2002'
    }),
    modelResponse('消息发送完成。')
  )
  const approvedRequestEvent = {
    ...privateRequestEvent,
    message_id: 'message-4',
    msg: '请再次发送给用户 2002 一条测试消息',
    message: [{ type: 'text', text: '请再次发送给用户 2002 一条测试消息' }]
  }
  const approvedPaused = await bridge.handle(
    approvedRequestEvent,
    '请再次发送给用户 2002 一条测试消息',
    { systemInstructions: ['You are GroupMate.'] }
  )
  assert.equal(approvedPaused.kind, 'paused')
  assert.equal(approvalMessages.length, 2)

  const approvedRouted = await bridge.routeApprovalReply({
    ...approvalEventBase,
    user_id: 'master-1',
    message_id: 'approval-reply-2',
    msg: '确认',
    message: [{ type: 'text', text: '确认' }],
    source: { message_id: 'approval-private-2' },
    sender: { user_id: 'master-1', nickname: 'master', role: 'member' },
    reply: async (message: unknown) => {
      approverReplies.push(message)
      return { message_id: 'approver-reply-2' }
    }
  })
  assert.equal(approvedRouted, true)
  assert.deepEqual(targetMessages, ['approved fixture delivery'])
  assert.deepEqual(originalReplies, ['审批任务完成。', '消息发送完成。'])
  assert.equal(approverReplies.length, 0)
  const approvedFollowUp = requests.at(-1) ?? {}
  assert.equal(Object.hasOwn(approvedFollowUp, 'tools'), false)
  assert.equal(approvedFollowUp.tool_choice, 'none')

  config.toolPolicyProfile = 'compatible'
  responses.push(modelResponse('group reply'))
  groupHistory = [
    {
      message_id: 'group-prior-1', time: Date.parse(timestamp) / 1_000 - 1,
      raw_message: 'prior group context',
      sender: { user_id: 'member-2', nickname: 'another member' }
    },
    {
      message_id: 'group-current-1', time: Date.parse(timestamp) / 1_000,
      raw_message: 'current group prompt',
      sender: { user_id: 'actor-1', nickname: 'member' }
    }
  ]
  const groupMembers = new Map<string, Record<string, unknown>>([
    ['bot-1', { user_id: 'bot-1', role: 'admin' }],
    ['actor-1', { user_id: 'actor-1', nickname: 'member', role: 'member' }]
  ])
  const groupRuntime = {
    getChatHistory: async () => [],
    getMemberMap: async () => groupMembers
  }
  const groupResult = await bridge.handle({
    isGroup: true,
    self_id: 'bot-1',
    group_id: 'group-1',
    message_id: 'group-current-1',
    msg: 'current group prompt',
    message: [{ type: 'text', text: 'current group prompt' }],
    sender: { user_id: 'actor-1', nickname: 'member', role: 'member' },
    group: groupRuntime,
    bot: { uin: 'bot-1' }
  }, 'current group prompt', {
    systemInstructions: ['You are GroupMate.'], enableGroupContext: true
  })
  assert.equal(groupResult.kind, 'completed')
  const groupMessages = requests.at(-1)?.messages as Array<{
    role?: unknown
    content?: unknown
  }> | undefined
  assert.equal(groupMessages?.filter(message => (
    String(message.content).includes('current group prompt')
  )).length, 1)
  assert.equal(groupMessages?.some(message => (
    String(message.content).includes('prior group context')
  )), true)
  assert.equal(groupMessages?.some((message, index, all) => (
    index > 0 && (message.role === 'user' || message.role === 'assistant') &&
    message.role === all[index - 1]?.role
  )), false)
})

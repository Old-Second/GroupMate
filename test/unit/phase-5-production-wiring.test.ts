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

test('Task 2 host entries hand off one exact presentation intent scalar', async () => {
  const chat = await readFile(path.join(root, 'apps/chat.js'), 'utf8')
  const bym = await readFile(path.join(root, 'apps/bym.js'), 'utf8')
  const bridge = await readFile(
    path.join(root, 'src/runtime/agent-service-bridge.ts'),
    'utf8'
  )

  assert.match(chat, /presentationIntent:\s*\{[\s\S]*?kind:\s*'ordinary'[\s\S]*?forcePicture:\s*forcePictureMode/)
  assert.match(bym, /Math\.min\(Math\.max\(Math\.trunc\(Number\(Config\.bymFuckRecallTime\)\s*\|\|\s*100\),\s*1\),\s*3600\)\s*\*\s*1000/)
  assert.match(bym, /presentationIntent:\s*\{[\s\S]*?kind:\s*'proactive'[\s\S]*?recallAfterMs/)
  assert.match(bym, /recallMsg:\s*recallAfterMs\s*\/\s*1000/)
  assert.doesNotMatch(bridge, /bymFuckRecallTime|forcePictureMode/)
  assert.match(
    bridge,
    /onTerminalSnapshot:\s*snapshot\s*=>\s*terminalFacts\.acceptSnapshot\(snapshot\)/
  )
  assert.match(
    bridge,
    /onTerminalCommitReceipt:\s*receipt\s*=>\s*terminalFacts\.acceptCommitReceipt\(receipt\)/
  )
  assert.match(
    bridge,
    /onCommitted:\s*\(snapshot,\s*receipt\)\s*=>\s*\{[\s\S]*?createAgentRunLog\(snapshot,\s*receipt\)/
  )
})

test('Task 5 contracts have one canonical owner and consumers import those types', async () => {
  const completion = await readFile(
    path.join(root, 'src/agent/contracts/completion.ts'),
    'utf8'
  )
  const observation = await readFile(
    path.join(root, 'src/runtime/request-observation.ts'),
    'utf8'
  )
  const service = await readFile(
    path.join(root, 'src/runtime/agent-service.ts'),
    'utf8'
  )
  const bridge = await readFile(
    path.join(root, 'src/runtime/agent-service-bridge.ts'),
    'utf8'
  )
  const router = await readFile(
    path.join(root, 'src/runtime/run-approval-router.ts'),
    'utf8'
  )
  const routerTest = await readFile(
    path.join(root, 'test/unit/approval-reference-router.test.ts'),
    'utf8'
  )

  assert.match(completion, /export type SessionPersistenceOutcome\s*=/)
  assert.doesNotMatch(observation, /(?:export\s+)?type SessionPersistenceOutcome\s*=/)
  assert.match(
    observation,
    /export type \{ SessionPersistenceOutcome \} from '\.\.\/agent\/contracts\/completion\.js'/
  )
  assert.match(
    service,
    /import type \{ SessionPersistenceOutcome \} from '\.\.\/agent\/contracts\/completion\.js'/
  )

  assert.match(observation, /export interface ApprovalRecoveryDeferred/)
  assert.doesNotMatch(service, /export interface ApprovalRecoveryDeferred/)
  const deferredDeclarations = [observation, service, bridge, router]
    .flatMap(source => source.match(/export interface ApprovalRecoveryDeferred/g) ?? [])
  assert.equal(deferredDeclarations.length, 1)
  for (const [source, modulePath] of [
    [service, "from './request-observation.js'"],
    [bridge, "from './request-observation.js'"],
    [router, "from './request-observation.js'"],
    [routerTest, "from '../../src/runtime/request-observation.js'"]
  ]) {
    assert.equal(source.includes('ApprovalRecoveryDeferred'), true)
    assert.equal(source.includes(modulePath), true)
  }
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
  const agentRunLogs: Array<Readonly<Record<string, unknown>>> = []
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
    logger: {
      info: entry => { agentRunLogs.push(entry) }
    },
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
    sessionTtlSeconds: 600,
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'ordinary', forcePicture: false
    })
  })
  assert.equal(ordinary.kind, 'completed')
  assert.equal(ordinary.kind === 'completed' ? ordinary.text : null, 'ordinary reply')
  assert.equal(ordinary.kind === 'completed' ? ordinary.sessionPersistence : null, 'saved')
  assert.equal(
    ordinary.kind === 'completed' ? ordinary.requestObservationDraft.outcome : null,
    'completed'
  )
  assert.equal(agentRunLogs.length, 1)
  assert.equal(agentRunLogs[0]?.event, 'agent.run')
  assert.match(String(agentRunLogs[0]?.runRef), /^[0-9a-f]{32}$/)
  assert.match(String(agentRunLogs[0]?.observationId), /^[0-9a-f]{64}$/)
  assert.equal(agentRunLogs[0]?.providerAttempts, 1)
  assert.equal(agentRunLogs[0]?.modelTurns, 1)
  assert.equal(agentRunLogs[0]?.deletedKeyCount, 2)
  assert.equal(agentRunLogs[0]?.createdKeyCount, 1)
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
  }, 'ambient', {
    systemInstructions: ['You are GroupMate.'],
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'proactive', recallAfterMs: null
    })
  })
  assert.equal(ephemeral.kind, 'completed')
  assert.equal(ephemeral.kind === 'completed' ? ephemeral.text : null, null)
  assert.equal(ephemeral.kind === 'completed' ? ephemeral.visibleOutput : null, false)
  assert.equal(
    ephemeral.kind === 'completed' ? ephemeral.sessionPersistence : null,
    'not_attempted'
  )
  assert.equal(
    ephemeral.kind === 'completed'
      ? ephemeral.requestObservationDraft.sessionSaveDurationMs
      : null,
    'not_attempted'
  )
  assert.equal(agentRunLogs.length, 2)
  assert.equal(agentRunLogs[1]?.event, 'agent.run')
  assert.equal(agentRunLogs[1]?.providerAttempts, 1)
  assert.equal(agentRunLogs[1]?.modelTurns, 1)
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
    {
      systemInstructions: ['You are GroupMate.'],
      presentationIntent: Object.freeze({
        schemaVersion: 1, kind: 'ordinary', forcePicture: false
      })
    }
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
    {
      systemInstructions: ['You are GroupMate.'],
      presentationIntent: Object.freeze({
        schemaVersion: 1, kind: 'ordinary', forcePicture: false
      })
    }
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
    systemInstructions: ['You are GroupMate.'],
    enableGroupContext: true,
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'ordinary', forcePicture: false
    })
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

  config.toolPolicyProfile = 'safe'
  config.toolPrivateSendPolicy = 'everyone'
  responses.push(modelToolResponse(
    'call-private-send-display-failure',
    'sendMessage',
    { text: 'must not be sent', targetKind: 'private', targetId: '2002' }
  ))
  const logsBeforeDisplayFailure = agentRunLogs.filter(entry => (
    entry.event === 'agent.run'
  )).length
  const displayFailure = await bridge.handle({
    ...privateRequestEvent,
    message_id: 'message-display-failure',
    msg: '请给用户 2002 发送消息并验证审批消息发送失败',
    message: [{ type: 'text', text: '请给用户 2002 发送消息并验证审批消息发送失败' }],
    bot: {
      ...approvalEventBase.bot,
      pickFriend: () => ({
        sendMsg: async () => { throw new Error('injected approval display failure') }
      })
    }
  }, '请给用户 2002 发送消息并验证审批消息发送失败', {
    systemInstructions: ['You are GroupMate.'],
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'ordinary', forcePicture: false
    })
  })

  assert.equal(displayFailure.kind, 'cancelled')
  if (displayFailure.kind !== 'cancelled') {
    assert.fail('approval display failure did not return the cancellation envelope')
  }
  if (displayFailure.terminal === null) {
    assert.fail('approval display cancellation did not commit a terminal fact')
  }
  assert.equal(displayFailure.reason, 'approval_delivery_failed')
  assert.equal(displayFailure.terminal.snapshot.status, 'cancelled')
  assert.equal(
    displayFailure.terminal.snapshot.cancellationReason,
    'approval_delivery_failed'
  )
  assert.equal(displayFailure.requestObservationDraft.outcome, 'completed')
  assert.equal(
    displayFailure.requestObservationDraft.terminalObservationId,
    displayFailure.terminal.snapshot.observationId
  )
  assert.equal(displayFailure.sessionPersistence, 'not_attempted')
  assert.equal(agentRunLogs.filter(entry => (
    entry.event === 'agent.run'
  )).length, logsBeforeDisplayFailure + 1)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthorizedToolContext, ToolRuntimeFacts, ToolTarget } from '../../src/agent/tools/tool-context.js'
import { ToolPolicyEngine } from '../../src/agent/tools/policy-engine.js'
import { shouldFinalizeToolResult } from '../../src/agent/tools/tool-result.js'
import { validateToolInputRecord } from '../../src/agent/tools/schema-validator.js'
import type { ToolObjectSchema } from '../../src/agent/tools/tool-schema.js'
import { NetworkPolicy } from '../../src/agent/tools/network-policy.js'
import { PolicyFetch, type PolicyTransportResponse } from '../../src/runtime/tools/policy-fetch.js'
import { createVisibleToolDefinitions } from '../../src/runtime/tools/tool-runtime-factory.js'
import type {
  MusicShare,
  QqSendCapabilities,
  ToolResource,
  VisibleToolServices
} from '../../src/tools/visible-tool-support.js'

const facts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '7', role: 'member', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' },
  scope: { kind: 'group', groupId: '9' },
  botGroupRole: 'admin', actorGroupRole: 'member', targetRole: 'none',
  targetIsBotMaster: false, targetExists: true
}

const context: AuthorizedToolContext = {
  runId: 'run-1', callId: 'call-1', snapshotId: 'snapshot-1', facts,
  target: { kind: 'group', groupId: '9' }, signal: new AbortController().signal
}

function response (body: string, contentType: string): PolicyTransportResponse {
  return {
    status: 200, statusText: 'OK', headers: { 'content-type': contentType },
    body: (async function * () { yield Buffer.from(body) })()
  }
}

function fixture (): {
  definitions: ReturnType<typeof createVisibleToolDefinitions>
  calls: Array<{ kind: string; target: ToolTarget; value: unknown }>
} {
  const calls: Array<{ kind: string; target: ToolTarget; value: unknown }> = []
  const qq: QqSendCapabilities = {
    sendText: async (target, value) => { calls.push({ kind: 'text', target, value }) },
    sendImage: async (target, value) => { calls.push({ kind: 'image', target, value }) },
    sendAudio: async (target, value) => { calls.push({ kind: 'audio', target, value }) },
    sendVideo: async (target, value) => { calls.push({ kind: 'video', target, value }) },
    sendMusic: async (target, value) => { calls.push({ kind: 'music', target, value }) },
    sendDice: async target => { calls.push({ kind: 'dice', target, value: null }) },
    sendRps: async (target, value) => { calls.push({ kind: 'rps', target, value }) }
  }
  const services: VisibleToolServices = {
    policyFetch: new PolicyFetch({
      networkPolicy: new NetworkPolicy({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] }),
      transport: { request: async request => request.url.pathname.endsWith('.mp4')
        ? response('video', 'video/mp4')
        : response('image', 'image/png') }
    }),
    qq,
    generateImage: async (): Promise<ToolResource> => ({
      kind: 'buffer', data: Buffer.from('drawn'), mimeType: 'image/png', byteLength: 5
    }),
    processImage: async (): Promise<ToolResource> => ({
      kind: 'remote_url', url: 'https://cdn.example/processed.png', mimeType: 'image/png', byteLength: 0
    }),
    synthesizeAudio: async (): Promise<ToolResource> => ({
      kind: 'buffer', data: Buffer.from('audio'), mimeType: 'audio/silk', byteLength: 5
    }),
    resolveVideo: async id => ({
      id, shareText: `video ${id}`, videoUrl: 'https://cdn.example/video.mp4'
    }),
    drawingAvailable: true,
    pictureProcessingAvailable: true,
    ttsAvailable: true,
    videoDownloadEnabled: true,
    videoMaxBytes: 1024,
    canSendCrossChannel: () => true
  }
  return { definitions: createVisibleToolDefinitions(services), calls }
}

function byName (definitions: ReturnType<typeof createVisibleToolDefinitions>, name: string) {
  const definition = definitions.find(item => item.name === name)
  assert.ok(definition)
  return definition
}

test('visible tool factory exposes ten exact typed definitions', () => {
  const { definitions } = fixture()
  assert.deepEqual(definitions.map(tool => tool.name), [
    'draw', 'processPicture', 'sendPicture', 'sendVideo', 'sendAvatar',
    'sendMusic', 'sendAudioMessage', 'sendDice', 'sendRPS', 'sendMessage'
  ])
  for (const definition of definitions) {
    assert.equal(definition.readOnly, false)
    assert.equal(definition.idempotency, 'call')
  }
  assert.equal(byName(definitions, 'sendMessage').effect, 'side_effect')
  assert.equal(byName(definitions, 'sendMessage').permission, 'bot_master_cross_channel')
})

test('media tools bind to the current group or private channel target', () => {
  const { definitions } = fixture()
  const picture = byName(definitions, 'sendPicture')
  assert.deepEqual(picture.resolveTarget({}, facts), { kind: 'group', groupId: '9' })
  const privateFacts: ToolRuntimeFacts = {
    ...facts,
    channel: { kind: 'private', botId: '10000', userId: '7' },
    scope: { kind: 'private', userId: '7' },
    botGroupRole: 'none', actorGroupRole: 'none'
  }
  assert.deepEqual(picture.resolveTarget({}, privateFacts), { kind: 'private', userId: '7' })
})

test('visible media tools call the QQ capability and return visible only after success', async () => {
  const { definitions, calls } = fixture()
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['draw', { prompt: 'cat' }, 'image'],
    ['sendPicture', { urls: ['https://image.example/cat.png'] }, 'image'],
    ['sendAvatar', { userIds: ['7'] }, 'image'],
    ['sendVideo', { id: 'BV1' }, 'video'],
    ['sendMusic', { id: '1' }, 'music'],
    ['sendAudioMessage', { text: 'hello', voice: '' }, 'audio'],
    ['sendRPS', { value: 2 }, 'rps']
  ]
  for (const [name, input, kind] of cases) {
    const before = calls.length
    const result = await byName(definitions, name).execute(input, context)
    assert.equal(result.status, 'success', name)
    if (result.status === 'success') assert.equal(result.effect, 'visible', name)
    assert.equal(calls.length, before + 1, name)
    assert.equal(calls.at(-1)?.kind, kind, name)
  }
})

test('processPicture returns background resource without sending QQ output', async () => {
  const { definitions, calls } = fixture()
  const result = await byName(definitions, 'processPicture').execute({
    type: 'hed', imageUrl: 'https://image.example/cat.png', userId: ''
  }, context)
  assert.equal(result.status, 'success')
  if (result.status === 'success') {
    assert.equal(result.effect, 'background')
    assert.equal(result.content[0]?.type, 'resource_ref')
  }
  assert.equal(calls.length, 0)
})

test('sendDice clamps count to five and uses only the authorized target', async () => {
  const { definitions, calls } = fixture()
  const result = await byName(definitions, 'sendDice').execute({ count: 99 }, context)
  assert.equal(result.status, 'success')
  assert.equal(calls.length, 5)
  assert.ok(calls.every(call => call.kind === 'dice' && JSON.stringify(call.target) === JSON.stringify(context.target)))
})

test('missing TTS and media services fail before QQ output', async () => {
  const original = fixture()
  const services = visibleOptions(original.calls, {
    ttsAvailable: false, drawingAvailable: false, pictureProcessingAvailable: false
  })
  const definitions = createVisibleToolDefinitions(services)
  for (const [name, input] of [
    ['draw', { prompt: 'cat' }],
    ['processPicture', { type: 'hed', imageUrl: 'https://image.example/cat.png', userId: '' }],
    ['sendAudioMessage', { text: 'hello', voice: '' }]
  ] as const) {
    const result = await byName(definitions, name).execute(input, context)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.equal(result.errorCode, 'configuration_missing')
  }
  assert.equal(original.calls.length, 0)
})

test('sendMessage policy denies the current channel and never calls QQ capability', () => {
  const { definitions, calls } = fixture()
  const definition = byName(definitions, 'sendMessage')
  const target = definition.resolveTarget({ targetKind: 'group', targetId: '9', text: 'hello' }, facts)
  const decision = new ToolPolicyEngine().decide({
    profile: 'compatible', definition,
    input: { targetKind: 'group', targetId: '9', text: 'hello' },
    facts: { ...facts, actor: { ...facts.actor, isBotMaster: true } },
    target,
    intent: {
      trustedSources: ['current_request'],
      actions: ['send'], explicitTargetIds: ['9'], mentionUserIds: [],
      currentMessageId: 'current', replyMessageId: null
    }
  })
  assert.equal(decision.kind, 'deny')
  if (decision.kind === 'deny') assert.equal(decision.reasonCode, 'current_channel_uses_normal_reply')
  assert.equal(calls.length, 0)
})

test('sendMessage cross-channel target is exact and capability runs once after authorization', async () => {
  const { definitions, calls } = fixture()
  const definition = byName(definitions, 'sendMessage')
  const input = { targetKind: 'group', targetId: '88', text: 'hello' }
  const target = definition.resolveTarget(input, facts)
  assert.deepEqual(target, { kind: 'group', groupId: '88' })
  const result = await definition.execute(input, { ...context, target })
  assert.equal(result.status, 'success')
  if (result.status === 'success') assert.equal(result.effect, 'visible')
  assert.deepEqual(calls, [{ kind: 'text', target: { kind: 'group', groupId: '88' }, value: 'hello' }])
})

test('sendMessage applies private and group configuration to the exact authorized target', async () => {
  const calls: Array<{ kind: string; target: ToolTarget; value: unknown }> = []
  const checked: ToolTarget[] = []
  const definitions = createVisibleToolDefinitions(visibleOptions(calls, {
    canSendCrossChannel: target => {
      checked.push(target)
      return target.kind === 'private'
    }
  }))
  const definition = byName(definitions, 'sendMessage')
  const privateTarget = { kind: 'private' as const, userId: '88' }
  const privateResult = await definition.execute({
    targetKind: 'private', targetId: '88', text: 'hello'
  }, { ...context, target: privateTarget })
  assert.equal(privateResult.status, 'success')

  const groupTarget = { kind: 'group' as const, groupId: '99' }
  const groupResult = await definition.execute({
    targetKind: 'group', targetId: '99', text: 'hello'
  }, { ...context, target: groupTarget })
  assert.equal(groupResult.status, 'denied')
  if (groupResult.status === 'denied') assert.equal(groupResult.reasonCode, 'cross_channel_disabled')
  assert.deepEqual(checked, [privateTarget, groupTarget])
  assert.deepEqual(calls, [{ kind: 'text', target: privateTarget, value: 'hello' }])
})

test('typed effect finalizes only successful visible results', () => {
  assert.equal(shouldFinalizeToolResult({
    status: 'success', effect: 'visible', content: [], retryable: false
  }), true)
  assert.equal(shouldFinalizeToolResult({
    status: 'success', effect: 'background', content: [], retryable: false
  }), false)
  assert.equal(shouldFinalizeToolResult({
    status: 'failed', effect: 'none', errorCode: 'tool_execution_failed',
    userMessage: '工具执行失败。', retryable: false
  }), false)
})

test('visible tool schemas reject model-supplied sender and admin authority', () => {
  const { definitions } = fixture()
  for (const name of ['sendPicture', 'sendMessage']) {
    const definition = byName(definitions, name)
    const valid = name === 'sendMessage'
      ? { text: 'hello', targetKind: 'group', targetId: '88' }
      : { urls: ['https://image.example/cat.png'] }
    assert.throws(() => validateToolInputRecord(
      definition.inputSchema as ToolObjectSchema,
      { ...valid, sender: { isAdmin: true }, isAdmin: true }
    ))
  }
})

test('abort signal reaches the QQ capability and returns typed cancellation', async () => {
  const calls: Array<{ kind: string; target: ToolTarget; value: unknown }> = []
  const services = visibleOptions(calls)
  const qq: QqSendCapabilities = {
    ...services.qq,
    sendMusic: async (_target, _music, signal) => {
      assert.equal(signal.aborted, true)
      throw new DOMException('aborted', 'AbortError')
    }
  }
  const definitions = createVisibleToolDefinitions({ ...services, qq })
  const controller = new AbortController()
  controller.abort()
  const result = await byName(definitions, 'sendMusic').execute({ id: '1' }, {
    ...context, signal: controller.signal
  })
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.equal(result.errorCode, 'tool_cancelled')
})

test('partial multi-send failure is indeterminate and cannot be replayed as a normal failure', async () => {
  const calls: Array<{ kind: string; target: ToolTarget; value: unknown }> = []
  const services = visibleOptions(calls)
  let sent = 0
  const definitions = createVisibleToolDefinitions({
    ...services,
    qq: {
      ...services.qq,
      sendDice: async () => {
        sent += 1
        if (sent === 2) throw new Error('fixture')
      }
    }
  })
  const result = await byName(definitions, 'sendDice').execute({ count: 3 }, context)
  assert.equal(result.status, 'indeterminate')
  if (result.status === 'indeterminate') assert.equal(result.retryable, false)
})

function visibleOptions (
  calls: Array<{ kind: string; target: ToolTarget; value: unknown }>,
  overrides: Partial<VisibleToolServices> = {}
): VisibleToolServices {
  const qq: QqSendCapabilities = {
    sendText: async (target, value) => { calls.push({ kind: 'text', target, value }) },
    sendImage: async (target, value) => { calls.push({ kind: 'image', target, value }) },
    sendAudio: async (target, value) => { calls.push({ kind: 'audio', target, value }) },
    sendVideo: async (target, value) => { calls.push({ kind: 'video', target, value }) },
    sendMusic: async (target, value: MusicShare) => { calls.push({ kind: 'music', target, value }) },
    sendDice: async target => { calls.push({ kind: 'dice', target, value: null }) },
    sendRps: async (target, value) => { calls.push({ kind: 'rps', target, value }) }
  }
  return {
    policyFetch: new PolicyFetch({
      networkPolicy: new NetworkPolicy({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] }),
      transport: { request: async () => response('image', 'image/png') }
    }),
    qq,
    generateImage: async () => ({ kind: 'buffer', data: Buffer.from('x'), mimeType: 'image/png', byteLength: 1 }),
    processImage: async () => ({ kind: 'remote_url', url: 'https://cdn.example/x', mimeType: 'image/png', byteLength: 0 }),
    synthesizeAudio: async () => ({ kind: 'buffer', data: Buffer.from('x'), mimeType: 'audio/silk', byteLength: 1 }),
    resolveVideo: async id => ({ id, shareText: id, videoUrl: 'https://cdn.example/x.mp4' }),
    drawingAvailable: true, pictureProcessingAvailable: true, ttsAvailable: true,
    videoDownloadEnabled: false, videoMaxBytes: 1024, canSendCrossChannel: () => true,
    ...overrides
  }
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthorizedToolContext, ToolRuntimeFacts } from '../../src/agent/tools/tool-context.js'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import { ToolPolicyEngine } from '../../src/agent/tools/policy-engine.js'
import {
  shouldFinalizeToolExecution,
  shouldFinalizeToolResult
} from '../../src/agent/tools/tool-result.js'
import { validateToolInputRecord } from '../../src/agent/tools/schema-validator.js'
import type { ToolObjectSchema } from '../../src/agent/tools/tool-schema.js'
import { NetworkPolicy } from '../../src/agent/tools/network-policy.js'
import { PolicyFetch, type PolicyTransportResponse } from '../../src/runtime/tools/policy-fetch.js'
import { createVisibleToolDefinitions } from '../../src/runtime/tools/tool-runtime-factory.js'
import type {
  DeliveryResult,
  OutboundMedia,
  RuntimeDeliveryReceipt
} from '../../src/runtime/presentation/presentation-result.js'
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

function sentDelivery<M extends OutboundMedia> (media: M): DeliveryResult<M> {
  return Object.freeze({
    kind: 'sent', media, attempt: 1,
    receipt: Object.freeze({ schemaVersion: 1, media }) as RuntimeDeliveryReceipt<M>
  })
}

function definiteDelivery<M extends OutboundMedia> (media: M): DeliveryResult<M> {
  return Object.freeze({ kind: 'failed_definite', media, attempt: 1, code: 'host_rejected' })
}

function unknownDelivery<M extends OutboundMedia> (media: M): DeliveryResult<M> {
  return Object.freeze({ kind: 'outcome_unknown', media, attempt: 1, code: 'unknown_host_result' })
}

function response (body: string, contentType: string): PolicyTransportResponse {
  return {
    status: 200, statusText: 'OK', headers: { 'content-type': contentType },
    body: (async function * () { yield Buffer.from(body) })()
  }
}

function fixture (): {
  definitions: ReturnType<typeof createVisibleToolDefinitions>
  calls: Array<{ kind: string; target: SessionAddress; value: unknown }>
} {
  const calls: Array<{ kind: string; target: SessionAddress; value: unknown }> = []
  const qq: QqSendCapabilities = {
    sendText: async (target, value) => { calls.push({ kind: 'text', target, value }); return sentDelivery('text') },
    sendImage: async (target, value) => { calls.push({ kind: 'image', target, value }); return sentDelivery('picture') },
    sendAudio: async (target, value) => { calls.push({ kind: 'audio', target, value }); return sentDelivery('voice') },
    sendVideo: async (target, value) => { calls.push({ kind: 'video', target, value }); return sentDelivery('video') },
    sendMusic: async (target, value) => { calls.push({ kind: 'music', target, value }); return sentDelivery('music') },
    sendDice: async target => { calls.push({ kind: 'dice', target, value: null }); return sentDelivery('dice') },
    sendRps: async (target, value) => { calls.push({ kind: 'rps', target, value }); return sentDelivery('rps') }
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
    crossChannelAccess: { private: 'everyone', group: 'everyone' }
  }
  return { definitions: createVisibleToolDefinitions(services), calls }
}

function byName (definitions: ReturnType<typeof createVisibleToolDefinitions>, name: string) {
  const definition = definitions.find(item => item.name === name)
  assert.ok(definition)
  return definition
}

test('visible tool factory exposes ten exact typed definitions without progress as a tool', () => {
  const { definitions } = fixture()
  assert.deepEqual(definitions.map(tool => tool.name), [
    'draw', 'processPicture', 'sendPicture', 'sendVideo', 'sendAvatar',
    'sendMusic', 'sendAudioMessage', 'sendDice', 'sendRPS', 'sendMessage'
  ])
  assert.equal(definitions.some(tool => tool.name === 'reportProgress'), false)
  for (const definition of definitions) {
    assert.equal(definition.readOnly, false)
    assert.equal(definition.idempotency, definition.name === 'sendMessage' ? 'semantic' : 'call')
    assert.equal(definition.executionClass, definition.name === 'sendMessage' ? 'side_effect' : 'visible_output')
    assert.equal(definition.retrySafe, false)
  }
  assert.equal(byName(definitions, 'sendMessage').effect, 'side_effect')
  assert.equal(byName(definitions, 'sendMessage').permission, 'cross_channel')
  assert.deepEqual(byName(definitions, 'sendMessage').crossChannelAccess, {
    private: 'everyone', group: 'everyone'
  })
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
  assert.ok(calls.every(call => call.kind === 'dice' && JSON.stringify(call.target) === JSON.stringify({
    botId: '10000', scope: { kind: 'group', groupId: '9' }
  })))
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

test('cross-channel message keeps its explicit target', async () => {
  const { definitions, calls } = fixture()
  const definition = byName(definitions, 'sendMessage')
  const input = { targetKind: 'group', targetId: '88', text: 'hello' }
  const target = definition.resolveTarget(input, facts)
  assert.deepEqual(target, { kind: 'group', groupId: '88' })
  const result = await definition.execute(input, { ...context, target })
  assert.equal(result.status, 'success')
  if (result.status === 'success') assert.equal(result.effect, 'background')
  assert.deepEqual(calls, [{
    kind: 'text',
    target: { botId: '10000', scope: { kind: 'group', groupId: '88' } },
    value: 'hello'
  }])
})

test('sendMessage applies private and group configuration to the exact authorized target', async () => {
  const calls: Array<{ kind: string; target: SessionAddress; value: unknown }> = []
  const definitions = createVisibleToolDefinitions(visibleOptions(calls, {
    crossChannelAccess: { private: 'everyone', group: 'disabled' }
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
  assert.deepEqual(calls, [{
    kind: 'text',
    target: { botId: '10000', scope: privateTarget },
    value: 'hello'
  }])
})

test('sendMessage repeats master authorization at the capability boundary', async () => {
  const calls: Array<{ kind: string; target: SessionAddress; value: unknown }> = []
  const definitions = createVisibleToolDefinitions(visibleOptions(calls, {
    crossChannelAccess: { private: 'master', group: 'master' }
  }))
  const definition = byName(definitions, 'sendMessage')
  const target = { kind: 'private' as const, userId: '88' }
  const denied = await definition.execute({
    targetKind: 'private', targetId: '88', text: 'hello'
  }, { ...context, target })
  assert.equal(denied.status, 'denied')
  if (denied.status === 'denied') assert.equal(denied.reasonCode, 'permission_denied')
  const allowed = await definition.execute({
    targetKind: 'private', targetId: '88', text: 'hello'
  }, {
    ...context,
    facts: { ...context.facts, actor: { ...context.facts.actor, isBotMaster: true } },
    target
  })
  assert.equal(allowed.status, 'success')
  assert.deepEqual(calls, [{
    kind: 'text',
    target: { botId: '10000', scope: target },
    value: 'hello'
  }])
})

test('visible tools mark only confirmed deliveries visible', async () => {
  const calls: Array<{ kind: string; target: SessionAddress; value: unknown }> = []
  const services = visibleOptions(calls)
  const results: DeliveryResult<'music'>[] = [
    sentDelivery('music'), definiteDelivery('music'), unknownDelivery('music')
  ]
  const definitions = createVisibleToolDefinitions({
    ...services,
    qq: {
      ...services.qq,
      sendMusic: async () => results.shift() ?? unknownDelivery('music')
    }
  })
  const confirmed = await byName(definitions, 'sendMusic').execute({ id: '1' }, context)
  const rejected = await byName(definitions, 'sendMusic').execute({ id: '1' }, context)
  const unknown = await byName(definitions, 'sendMusic').execute({ id: '1' }, context)
  assert.equal(confirmed.status, 'success')
  if (confirmed.status === 'success') assert.equal(confirmed.effect, 'visible')
  assert.equal(rejected.status, 'failed')
  if (rejected.status === 'failed') assert.equal(rejected.errorCode, 'tool_execution_failed')
  assert.equal(unknown.status, 'indeterminate')
  if (unknown.status === 'indeterminate') assert.equal(unknown.errorCode, 'tool_outcome_unknown')
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

test('successful background and visible effects stop further tool calls', () => {
  assert.equal(shouldFinalizeToolExecution('side_effect', {
    status: 'success', effect: 'background',
    content: [{ type: 'text', text: '已执行操作。' }], retryable: false
  }), true)
  assert.equal(shouldFinalizeToolExecution('visible_output', {
    status: 'success', effect: 'visible', content: [], retryable: false
  }), true)
  assert.equal(shouldFinalizeToolExecution('visible_output', {
    status: 'success', effect: 'background',
    content: [{ type: 'resource_ref', resourceType: 'image', resourceId: 'processed' }], retryable: false
  }), false)
  assert.equal(shouldFinalizeToolExecution('side_effect', {
    status: 'success', effect: 'none', content: [], retryable: false
  }), false)
  assert.equal(shouldFinalizeToolExecution('side_effect', {
    status: 'denied', effect: 'none', reasonCode: 'current_channel_uses_normal_reply',
    userMessage: '当前会话请使用普通回复。', retryable: false
  }), true)
  assert.equal(shouldFinalizeToolExecution('read_only', {
    status: 'failed', effect: 'none', errorCode: 'configuration_missing',
    userMessage: '工具配置不完整。', retryable: false
  }), true)
  assert.equal(shouldFinalizeToolExecution('read_only', {
    status: 'failed', effect: 'none', errorCode: 'upstream_unavailable',
    userMessage: '工具暂时不可用。', retryable: true
  }), false)
  assert.equal(shouldFinalizeToolExecution('side_effect', {
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '操作结果暂时无法确认。', retryable: false
  }), true)
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

test('pre-dispatch abort stays a definite visible-tool execution failure', async () => {
  const calls: Array<{ kind: string; target: SessionAddress; value: unknown }> = []
  const services = visibleOptions(calls)
  const qq: QqSendCapabilities = {
    ...services.qq,
    sendMusic: async (_target, _music, signal) => {
      assert.equal(signal.aborted, true)
      return {
        kind: 'failed_definite', media: 'music', attempt: 1,
        code: 'aborted_before_dispatch'
      }
    }
  }
  const definitions = createVisibleToolDefinitions({ ...services, qq })
  const controller = new AbortController()
  controller.abort()
  const result = await byName(definitions, 'sendMusic').execute({ id: '1' }, {
    ...context, signal: controller.signal
  })
  assert.equal(result.status, 'failed')
  if (result.status === 'failed') assert.equal(result.errorCode, 'tool_execution_failed')
})

test('partial multi-send failure is indeterminate and cannot be replayed as a normal failure', async () => {
  const calls: Array<{ kind: string; target: SessionAddress; value: unknown }> = []
  const services = visibleOptions(calls)
  let sent = 0
  const definitions = createVisibleToolDefinitions({
    ...services,
    qq: {
      ...services.qq,
      sendDice: async () => {
        sent += 1
        return sent === 2 ? unknownDelivery('dice') : sentDelivery('dice')
      }
    }
  })
  const result = await byName(definitions, 'sendDice').execute({ count: 3 }, context)
  assert.equal(result.status, 'indeterminate')
  if (result.status === 'indeterminate') assert.equal(result.retryable, false)
})

test('multi-part visible tools never replay a confirmed prefix after definite failure', async () => {
  const cases = [
    ['sendAvatar', { userIds: ['7', '8'] }, 'picture'],
    ['sendPicture', { urls: ['https://image.example/one.png', 'https://image.example/two.png'] }, 'picture'],
    ['sendDice', { count: 2 }, 'dice']
  ] as const
  for (const [name, input, media] of cases) {
    const calls: Array<{ kind: string; target: SessionAddress; value: unknown }> = []
    const services = visibleOptions(calls)
    let attempts = 0
    const next = () => {
      attempts += 1
      return attempts === 1 ? sentDelivery(media) : definiteDelivery(media)
    }
    const qq: QqSendCapabilities = media === 'picture'
      ? { ...services.qq, sendImage: async () => next() as DeliveryResult<'picture'> }
      : { ...services.qq, sendDice: async () => next() as DeliveryResult<'dice'> }
    const result = await byName(createVisibleToolDefinitions({ ...services, qq }), name).execute(input, context)
    assert.equal(result.status, 'indeterminate', name)
    if (result.status === 'indeterminate') assert.equal(result.retryable, false, name)
    assert.equal(attempts, 2, name)

    const firstFailureQq: QqSendCapabilities = media === 'picture'
      ? { ...services.qq, sendImage: async () => definiteDelivery('picture') }
      : { ...services.qq, sendDice: async () => definiteDelivery('dice') }
    const firstFailure = await byName(
      createVisibleToolDefinitions({ ...services, qq: firstFailureQq }), name
    ).execute(input, context)
    assert.equal(firstFailure.status, 'failed', `${name} first failure`)
    if (firstFailure.status === 'failed') {
      assert.equal(firstFailure.errorCode, 'tool_execution_failed', `${name} first failure`)
    }
  }
})

function visibleOptions (
  calls: Array<{ kind: string; target: SessionAddress; value: unknown }>,
  overrides: Partial<VisibleToolServices> = {}
): VisibleToolServices {
  const qq: QqSendCapabilities = {
    sendText: async (target, value) => { calls.push({ kind: 'text', target, value }); return sentDelivery('text') },
    sendImage: async (target, value) => { calls.push({ kind: 'image', target, value }); return sentDelivery('picture') },
    sendAudio: async (target, value) => { calls.push({ kind: 'audio', target, value }); return sentDelivery('voice') },
    sendVideo: async (target, value) => { calls.push({ kind: 'video', target, value }); return sentDelivery('video') },
    sendMusic: async (target, value: MusicShare) => { calls.push({ kind: 'music', target, value }); return sentDelivery('music') },
    sendDice: async target => { calls.push({ kind: 'dice', target, value: null }); return sentDelivery('dice') },
    sendRps: async (target, value) => { calls.push({ kind: 'rps', target, value }); return sentDelivery('rps') }
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
    videoDownloadEnabled: false, videoMaxBytes: 1024,
    crossChannelAccess: { private: 'everyone', group: 'everyone' },
    ...overrides
  }
}

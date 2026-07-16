import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  PresentationRouteV1,
  RecoveredLegacyPresentationRoute
} from '../../src/agent/contracts/interaction.js'
import type { FinalChatReplyEnvelope } from '../../src/runtime/agent-service.js'
import {
  buildApprovalPresentationInput,
  createYunzaiAgentServiceBridge,
  createApprovalOutboundPortFactory,
  type ActivePresentationContext,
  type YunzaiBotPicker
} from '../../src/runtime/agent-service-bridge.js'
import { createPendingIndicatorConfigPort } from '../../src/runtime/presentation/pending-indicator-config.js'
import { RECOVERED_LEGACY_PROFILE } from '../../src/runtime/presentation/presentation-profile.js'
import { ReplyPresenter } from '../../src/runtime/presentation/reply-presenter.js'
import {
  TTS_SYNTHESIS_DIAGNOSTIC_EVENT
} from '../../src/runtime/presentation/tts-reply-presentation.js'
import type {
  PresentationSettings,
  PresentationSettingsPort
} from '../../src/runtime/presentation/presentation-settings.js'
import {
  PLAIN_TEXT_PRESENTATION_HOOKS,
  UNAVAILABLE_GROUPMATE_PICTURE_RENDERER,
  UNAVAILABLE_TTS_REPLY_PORT
} from '../../src/runtime/runtime-presentation-hooks.js'
import type { YunzaiOutboundPort } from '../../src/runtime/presentation/yunzai-outbound-port.js'
import { FakeRedis } from '../helpers/fake-redis.js'

class RecordingRedis extends FakeRedis {
  readonly getCalls: string[] = []

  override async get (key: string): Promise<string | null> {
    this.getCalls.push(key)
    return await super.get(key)
  }
}

const settings: PresentationSettings = Object.freeze({
  schemaVersion: 1,
  quoteReply: true,
  enableRobotAt: false,
  enableMarkdown: false,
  enableSuggestedResponses: false,
  forwardReasoning: false,
  blockWords: Object.freeze([]),
  promptBlockWords: Object.freeze([]),
  tts: Object.freeze({
    enabled: false,
    mode: 'vits-uma-genshin-honkai',
    activeVoice: 'default',
    alsoSendText: false,
    autoFallbackThreshold: 299,
    filter: null,
    azureEmotionEnabled: false
  }),
  picture: Object.freeze({
    userEnabled: false,
    autoEnabled: false,
    autoThreshold: 1_200,
    deviceScaleFactor: 1,
    closeBrowserAfterRender: true,
    showQRCode: false,
    live2d: null
  })
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
    body: { async * [Symbol.asyncIterator] () { yield Buffer.from(body) } }
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
    body: { async * [Symbol.asyncIterator] () { yield Buffer.from(body) } }
  }
}

async function ordinaryRestartFixture (
  decision: '确认' | '拒绝' = '确认',
  options: Readonly<{ useTts?: boolean }> = Object.freeze({})
): Promise<Readonly<{
  routed: boolean
  messages: ReadonlyMap<string, readonly unknown[]>
  pickerCalls: readonly string[]
  providerRequests: readonly unknown[]
  settingsKeys: readonly string[]
  recoveryImageReads: number
  diagnostics: readonly Readonly<Record<string, unknown>>[]
}>> {
  const timestamp = '2026-07-16T00:00:00.000Z'
  const redis = new RecordingRedis(() => Date.parse(timestamp))
  await createPendingIndicatorConfigPort(redis).setEnabled(false)
  await redis.set('CHATGPT:USER:requester-u', JSON.stringify({
    usePicture: false,
    useTTS: options.useTts === true
  }))
  const messages = new Map<string, unknown[]>()
  const pickerCalls: string[] = []
  const providerRequests: unknown[] = []
  const diagnostics: Readonly<Record<string, unknown>>[] = []
  let recoveryImageReads = 0
  const recoveredResponses = [modelResponse('<think>private reasoning</think>restart completed')]
  const send = async (targetId: string, message: unknown) => {
    const values = messages.get(targetId) ?? []
    values.push(message)
    messages.set(targetId, values)
    return { message_id: `${targetId}-message-${values.length}` }
  }
  const bot = {
    uin: 'bot-original',
    getFriendList: async () => [
      { user_id: 'requester-u' },
      { user_id: 'approver-m' },
      { user_id: '2002' }
    ],
    pickFriend: (userId: string | number) => ({
      sendMsg: async (message: unknown) => await send(String(userId), message),
      recallMsg: async () => true
    })
  }
  const config = {
    openAiCompatibilityProfile: 'standard',
    openAiBaseUrl: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model',
    apiStream: false,
    apiMaxToken: 256,
    defaultTimeoutMs: 30_000,
    forwardReasoning: false,
    groupMerge: false,
    toolPolicyProfile: 'strict',
    toolApprovalTtlSeconds: 120,
    toolPrivateSendPolicy: 'everyone',
    toolCrossGroupSendPolicy: 'disabled',
    serpSource: 'ikechan8370',
    imageSearchSource: 'ikechan8370'
  }
  const common = {
    config,
    redis,
    getMasterIds: async () => ['approver-m'],
    getBotId: (event: unknown) => String((event as { self_id?: unknown }).self_id),
    segment: () => ({})
  }
  let generatedA = 0
  const bridgeA = createYunzaiAgentServiceBridge({
    ...common,
    fetch: async () => modelToolResponse('call-send', 'sendMessage', {
      text: 'restart delivery', targetKind: 'private', targetId: '2002'
    }) as never,
    now: () => new Date(timestamp),
    generateId: () => `bridge-a-${++generatedA}`
  })
  const paused = await bridgeA.handle({
    isGroup: false,
    self_id: 'bot-original',
    user_id: 'requester-u',
    message_id: 'request-message',
    msg: '请发送给用户 2002：restart delivery',
    message: [{ type: 'text', text: '请发送给用户 2002：restart delivery' }],
    sender: { user_id: 'requester-u', nickname: 'requester' },
    bot
  }, '请发送给用户 2002：restart delivery', {
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'ordinary', forcePicture: true
    })
  })
  assert.equal(paused.kind, 'paused')
  const approvalMessageId = `${'approver-m'}-message-1`
  assert.equal(messages.get('approver-m')?.length, 1)
  redis.getCalls.length = 0

  let generatedB = 0
  const bridgeB = createYunzaiAgentServiceBridge({
    ...common,
    fetch: async (_url, init) => {
      providerRequests.push(JSON.parse(init.body))
      const response = recoveredResponses.shift()
      if (response === undefined) throw new Error('recovered model script exhausted')
      return response as never
    },
    now: () => new Date(timestamp),
    generateId: () => `bridge-b-${++generatedB}`,
    getImages: async () => {
      recoveryImageReads += 1
      throw new Error('synthetic recovery event must not reach image extraction')
    },
    botPicker: {
      pick: async botId => {
        pickerCalls.push(botId)
        return botId === 'bot-original' ? bot as never : null
      }
    },
    logger: {
      error: event => { diagnostics.push(event) }
    }
  })
  const routed = await bridgeB.routeApprovalReply({
    isGroup: false,
    self_id: 'bot-original',
    user_id: 'approver-m',
    message_id: 'approval-reply',
    msg: decision,
    message: [{ type: 'text', text: decision }],
    source: { message_id: approvalMessageId },
    sender: { user_id: 'approver-m', nickname: 'approver' }
  })
  await bridgeA.shutdown('test_complete')
  await bridgeB.shutdown('test_complete')
  return Object.freeze({
    routed,
    messages: new Map([...messages].map(([key, value]) => [key, Object.freeze([...value])])),
    pickerCalls: Object.freeze([...pickerCalls]),
    providerRequests: Object.freeze([...providerRequests]),
    settingsKeys: Object.freeze(redis.getCalls.filter(key => key.startsWith('CHATGPT:USER:'))),
    recoveryImageReads,
    diagnostics: Object.freeze([...diagnostics])
  })
}

async function proactiveRestartFixture (): Promise<Readonly<{
  routed: boolean
  groupMessages: readonly Readonly<{ id: string; message: unknown }>[]
  targetMessages: readonly unknown[]
  recalledMessageIds: readonly string[]
  pickerCalls: readonly string[]
}>> {
  const timestamp = '2026-07-16T00:00:00.000Z'
  const redis = new FakeRedis(() => Date.parse(timestamp))
  await createPendingIndicatorConfigPort(redis).setEnabled(false)
  const groupMessages: Array<{ id: string; message: unknown }> = []
  const targetMessages: unknown[] = []
  const recalledMessageIds: string[] = []
  const pickerCalls: string[] = []
  const members = new Map<unknown, Record<string, unknown>>([
    ['requester-u', { user_id: 'requester-u', role: 'member' }],
    ['approver-m', { user_id: 'approver-m', role: 'member' }],
    ['bot-original', { user_id: 'bot-original', role: 'admin' }]
  ])
  const group = {
    getMemberMap: async () => members,
    getChatHistory: async () => [],
    sendMsg: async (message: unknown) => {
      const id = `group-message-${groupMessages.length + 1}`
      groupMessages.push({ id, message })
      return { message_id: id }
    },
    recallMsg: async (messageId: string) => {
      recalledMessageIds.push(messageId)
      return true
    }
  }
  const bot = {
    uin: 'bot-original',
    getFriendList: async () => [{ user_id: '2002' }],
    pickFriend: () => ({
      sendMsg: async (message: unknown) => {
        targetMessages.push(message)
        return { message_id: 'target-message-1' }
      },
      recallMsg: async () => true
    }),
    pickGroup: () => group
  }
  const config = {
    openAiCompatibilityProfile: 'standard',
    openAiBaseUrl: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model',
    apiStream: false,
    apiMaxToken: 256,
    defaultTimeoutMs: 30_000,
    groupMerge: true,
    toolPolicyProfile: 'strict',
    toolApprovalTtlSeconds: 120,
    toolPrivateSendPolicy: 'everyone',
    toolCrossGroupSendPolicy: 'disabled',
    serpSource: 'ikechan8370',
    imageSearchSource: 'ikechan8370'
  }
  const common = {
    config,
    redis,
    getMasterIds: async () => ['approver-m'],
    getBotId: (event: unknown) => String((event as { self_id?: unknown }).self_id),
    segment: () => ({})
  }
  let generatedA = 0
  const bridgeA = createYunzaiAgentServiceBridge({
    ...common,
    fetch: async () => modelToolResponse('call-proactive-send', 'sendMessage', {
      text: 'proactive delivery', targetKind: 'private', targetId: '2002'
    }) as never,
    now: () => new Date(timestamp),
    generateId: () => `proactive-a-${++generatedA}`
  })
  const paused = await bridgeA.handleEphemeral({
    isGroup: true,
    self_id: 'bot-original',
    group_id: 'group-original',
    user_id: 'requester-u',
    message_id: 'proactive-request',
    msg: '请发送给用户 2002：proactive delivery',
    message: [{ type: 'text', text: '请发送给用户 2002：proactive delivery' }],
    sender: { user_id: 'requester-u', role: 'member' },
    group,
    bot
  }, '请发送给用户 2002：proactive delivery', {
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'proactive', recallAfterMs: 1_000
    })
  })
  assert.equal(paused.kind, 'paused')
  assert.equal(groupMessages.length, 1)

  let generatedB = 0
  const bridgeB = createYunzaiAgentServiceBridge({
    ...common,
    fetch: async () => modelResponse('好') as never,
    now: () => new Date(timestamp),
    generateId: () => `proactive-b-${++generatedB}`,
    botPicker: {
      pick: async botId => {
        pickerCalls.push(botId)
        return botId === 'bot-original' ? bot as never : null
      }
    }
  })
  const routed = await bridgeB.routeApprovalReply({
    isGroup: true,
    self_id: 'bot-original',
    group_id: 'group-original',
    user_id: 'approver-m',
    message_id: 'proactive-approval-reply',
    msg: '确认',
    message: [{ type: 'text', text: '确认' }],
    source: { message_id: groupMessages[0]?.id },
    sender: { user_id: 'approver-m', role: 'member' },
    group
  })
  await new Promise(resolve => setTimeout(resolve, 1_100))
  await bridgeA.shutdown('test_complete')
  await bridgeB.shutdown('test_complete')
  return Object.freeze({
    routed,
    groupMessages: Object.freeze(groupMessages.map(value => Object.freeze({ ...value }))),
    targetMessages: Object.freeze([...targetMessages]),
    recalledMessageIds: Object.freeze([...recalledMessageIds]),
    pickerCalls: Object.freeze([...pickerCalls])
  })
}

function finalResult (text = '完成'): FinalChatReplyEnvelope {
  return Object.freeze({
    kind: 'completed',
    runId: 'run-1',
    runRef: '1'.repeat(32),
    completion: Object.freeze({ kind: 'reply_text', text }),
    output: Object.freeze({
      id: 'output-1', role: 'assistant', createdAt: '2026-07-16T00:00:00.000Z',
      parts: Object.freeze([{ type: 'text', text }])
    }),
    terminal: {} as never,
    text,
    visibleOutput: false,
    requestObservationDraft: {} as never,
    sessionPersistence: 'not_attempted'
  }) as unknown as FinalChatReplyEnvelope
}

function ordinaryRoute (): Extract<PresentationRouteV1, { requestKind: 'ordinary_chat' }> {
  return Object.freeze({
    schemaVersion: 1,
    requestKind: 'ordinary_chat',
    profile: 'ordinary',
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'ordinary', forcePicture: true
    }),
    sessionAddress: Object.freeze({
      botId: 'bot-original',
      scope: Object.freeze({ kind: 'private', userId: 'requester-u' })
    }),
    actorId: 'requester-u',
    requestMessageId: 'request-message'
  })
}

function context (
  route: PresentationRouteV1 | RecoveredLegacyPresentationRoute
): ActivePresentationContext {
  return Object.freeze({
    runRef: '1'.repeat(32),
    requestRef: '2'.repeat(32),
    route
  })
}

test('approval recovery presents to the original route and original actor settings', async () => {
  const loads: string[] = []
  const port: PresentationSettingsPort = {
    load: async actorId => {
      loads.push(actorId)
      return settings
    }
  }
  const input = await buildApprovalPresentationInput({
    context: context(ordinaryRoute()),
    result: finalResult(),
    settings: port
  })

  assert.deepEqual(loads, ['requester-u'])
  assert.deepEqual(input.route.sessionAddress, {
    botId: 'bot-original', scope: { kind: 'private', userId: 'requester-u' }
  })
  assert.equal(input.profile.kind, 'ordinary')
  assert.equal(input.profile.kind === 'ordinary' && input.profile.forcePicture, true)

  const restarted = await ordinaryRestartFixture()
  assert.equal(restarted.routed, true)
  assert.equal(
    restarted.messages.has('2002'),
    true,
    JSON.stringify({ messages: [...restarted.messages], requests: restarted.providerRequests })
  )
  assert.deepEqual(restarted.messages.get('2002'), ['restart delivery'])
  assert.equal(
    restarted.messages.get('requester-u')?.includes('restart completed'),
    true,
    JSON.stringify({ messages: [...restarted.messages], requests: restarted.providerRequests })
  )
  assert.equal(restarted.pickerCalls.length >= 2, true)
  assert.equal(restarted.pickerCalls.every(botId => botId === 'bot-original'), true)
  assert.equal(restarted.providerRequests.length, 1)
  assert.equal(restarted.settingsKeys.length >= 1, true)
  assert.equal(restarted.settingsKeys.every(key => key === 'CHATGPT:USER:requester-u'), true)
  assert.equal(restarted.recoveryImageReads, 0)
})

test('approval recovery after restart preserves force-picture and recall intent', async () => {
  const port: PresentationSettingsPort = { load: async () => settings }
  const ordinary = await buildApprovalPresentationInput({
    context: context(ordinaryRoute()), result: finalResult(), settings: port
  })
  const proactiveRoute: Extract<PresentationRouteV1, { requestKind: 'proactive_chat' }> = Object.freeze({
    schemaVersion: 1,
    requestKind: 'proactive_chat',
    profile: 'proactive',
    presentationIntent: Object.freeze({
      schemaVersion: 1, kind: 'proactive', recallAfterMs: 7_000
    }),
    sessionAddress: Object.freeze({
      botId: 'bot-original', scope: Object.freeze({ kind: 'group', groupId: 'group-original' })
    }),
    actorId: 'requester-u'
  })
  const proactive = await buildApprovalPresentationInput({
    context: context(proactiveRoute), result: finalResult(), settings: port
  })

  assert.equal(ordinary.profile.kind === 'ordinary' && ordinary.profile.forcePicture, true)
  assert.equal(proactive.profile.kind === 'proactive' && proactive.profile.recallAfterMs, 7_000)

  const restarted = await proactiveRestartFixture()
  assert.equal(restarted.routed, true)
  assert.deepEqual(restarted.targetMessages, ['proactive delivery'])
  const final = restarted.groupMessages.find(item => item.message === '好')
  assert.notEqual(final, undefined)
  assert.equal(final === undefined ? false : restarted.recalledMessageIds.includes(final.id), true)
  assert.equal(restarted.pickerCalls.every(botId => botId === 'bot-original'), true)
})

test('approval recovery after restart uses bot picker and plain safe hooks', async () => {
  const calls: string[] = []
  const picker: YunzaiBotPicker = {
    pick: async botId => {
      calls.push(`bot:${botId}`)
      return {
        pickFriend: (userId: string | number) => ({
          sendMsg: async (message: unknown) => {
            calls.push(`friend:${String(userId)}:${JSON.stringify(message)}`)
            return { message_id: 'sent-1' }
          },
          recallMsg: async () => true
        })
      } as never
    }
  }
  const factory = createApprovalOutboundPortFactory({
    botPicker: picker,
    segment: () => ({})
  })
  const outbound = await factory.forTarget(ordinaryRoute().sessionAddress)
  const delivered = await outbound.deliver({
    media: 'text', atoms: Object.freeze([{ kind: 'text', text: '恢复完成' }])
  }, 1)
  const input = await buildApprovalPresentationInput({
    context: context(ordinaryRoute()),
    result: finalResult(),
    settings: { load: async () => settings }
  })

  assert.equal(delivered.kind, 'sent')
  assert.equal(input.hooks, PLAIN_TEXT_PRESENTATION_HOOKS)
  assert.match(calls.join('\n'), /bot:bot-original/)
  assert.match(calls.join('\n'), /friend:requester-u/)

  const restarted = await ordinaryRestartFixture('拒绝')
  assert.equal(restarted.routed, true)
  assert.equal(restarted.pickerCalls.every(botId => botId === 'bot-original'), true)
  assert.equal(restarted.messages.has('2002'), false)
  assert.equal(restarted.messages.get('requester-u')?.includes('restart completed'), true)
  assert.doesNotMatch(JSON.stringify(restarted.messages.get('requester-u')), /private reasoning/)
})

test('approval TTS diagnostic logger exposes only fixed event and code', async () => {
  const restarted = await ordinaryRestartFixture('确认', { useTts: true })
  assert.equal(restarted.routed, true)
  assert.deepEqual(restarted.diagnostics, [{
    event: TTS_SYNTHESIS_DIAGNOSTIC_EVENT,
    code: 'synthesis_rejected'
  }])
  assert.doesNotMatch(
    JSON.stringify(restarted.diagnostics),
    /restart completed|requester-u|bot-original|fixture-key|fixture-model/
  )
})

test('legacy null route recovers without actor message id or rich presentation', async () => {
  const route: RecoveredLegacyPresentationRoute = Object.freeze({
    schemaVersion: 1,
    requestKind: 'legacy_unknown',
    profile: 'recovered_legacy_plain_text',
    sessionAddress: Object.freeze({
      botId: 'bot-original', scope: Object.freeze({ kind: 'group', groupId: 'group-original' })
    })
  })
  let settingsLoads = 0
  const input = await buildApprovalPresentationInput({
    context: context(route),
    result: finalResult('<EMPTY>'),
    settings: {
      load: async () => {
        settingsLoads += 1
        return settings
      }
    }
  })

  assert.equal(settingsLoads, 0)
  assert.equal(input.profile, RECOVERED_LEGACY_PROFILE)
  assert.equal(input.hooks, PLAIN_TEXT_PRESENTATION_HOOKS)
  assert.equal('actorId' in input.route, false)
  assert.equal('requestMessageId' in input.route, false)

  const sent: string[] = []
  const outbound: YunzaiOutboundPort = {
    target: route.sessionAddress,
    deliver: async (part, attempt) => {
      if (part.media === 'text') {
        sent.push(part.atoms.map(atom => atom.kind === 'text' ? atom.text : '').join(''))
      }
      return Object.freeze({
        kind: 'sent', media: part.media, attempt,
        receipt: Object.freeze({ schemaVersion: 1, media: part.media, messageId: 'legacy-1' })
      }) as never
    },
    recall: async () => Object.freeze({ kind: 'recalled' })
  }
  await new ReplyPresenter({
    outboundFactory: { forTarget: async () => outbound },
    tts: UNAVAILABLE_TTS_REPLY_PORT,
    ttsDiagnostics: { reportSynthesisFailure: () => undefined },
    pictureRenderer: UNAVAILABLE_GROUPMATE_PICTURE_RENDERER,
    random: () => 1,
    sleep: async () => undefined,
    schedule: callback => setTimeout(callback, 1)
  }).present(input)
  assert.equal(sent.includes('<EMPTY>'), false)
  assert.equal(sent.length, 1)
})

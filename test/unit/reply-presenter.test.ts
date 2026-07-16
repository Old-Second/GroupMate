import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CompletionDisposition } from '../../src/agent/contracts/completion.js'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type { PresentationRouteV1, RecoveredLegacyPresentationRoute } from '../../src/agent/contracts/interaction.js'
import type { RunAdvanceResult } from '../../src/agent/contracts/result.js'
import { serializeAgentError, AgentError } from '../../src/agent/contracts/error.js'
import { createInitialRunObservationCounters, terminalObservationId } from '../../src/agent/run/run-observation.js'
import {
  aggregatePresentationResults,
  type DeliveryResult,
  type PresentationDeliveryMedia,
  type PresentationResult,
  type RuntimeDeliveryReceipt
} from '../../src/runtime/presentation/presentation-result.js'
import {
  ordinaryProfile,
  proactiveProfile,
  RECOVERED_LEGACY_PROFILE
} from '../../src/runtime/presentation/presentation-profile.js'
import {
  BLOCKED_RESPONSE_MESSAGE,
  CANCELLED_MESSAGE,
  POSTPROCESS_EMPTY_MESSAGE,
  SESSION_PERSISTENCE_FAILED_MESSAGE
} from '../../src/runtime/presentation/response-presentation-safety.js'
import { ReplyPresenter } from '../../src/runtime/presentation/reply-presenter.js'
import type {
  GroupMatePictureRenderer,
  PictureRenderResult
} from '../../src/runtime/presentation/groupmate-picture-renderer.js'
import type { TtsPresentationDiagnosticPort } from '../../src/runtime/presentation/tts-reply-presentation.js'
import {
  createRuntimePresentationHooks,
  type PresentationInput,
  type RuntimePresentationHooks
} from '../../src/runtime/runtime-presentation-hooks.js'
import type {
  OutboundDeliveryOptions,
  OutboundPart,
  RecallResult,
  SafeTextAtom,
  YunzaiOutboundPort,
  YunzaiOutboundPortFactory
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import type { PresentationSettings } from '../../src/runtime/presentation/presentation-settings.js'
import type {
  TtsReplyPort,
  TtsSynthesisErrorCode,
  TtsSynthesisResult
} from '../../src/runtime/presentation/yunzai-tts-reply-port.js'

const createdAt = '2026-07-16T00:00:00.000Z'
const runRef = '2'.repeat(32)
const groupAddress: SessionAddress = Object.freeze({
  botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})
const privateAddress: SessionAddress = Object.freeze({
  botId: 'bot-1', scope: Object.freeze({ kind: 'private', userId: 'actor-1' })
})

const ordinaryRoute: PresentationRouteV1 = Object.freeze({
  schemaVersion: 1,
  requestKind: 'ordinary_chat',
  profile: 'ordinary',
  presentationIntent: Object.freeze({ schemaVersion: 1, kind: 'ordinary', forcePicture: false }),
  sessionAddress: groupAddress,
  actorId: 'actor-1',
  requestMessageId: 'request-message-1'
})

const proactiveRoute: PresentationRouteV1 = Object.freeze({
  schemaVersion: 1,
  requestKind: 'proactive_chat',
  profile: 'proactive',
  presentationIntent: Object.freeze({ schemaVersion: 1, kind: 'proactive', recallAfterMs: 2_000 }),
  sessionAddress: groupAddress,
  actorId: 'actor-1',
  requestMessageId: 'request-message-2'
})

const recoveredRoute: RecoveredLegacyPresentationRoute = Object.freeze({
  schemaVersion: 1,
  requestKind: 'legacy_unknown',
  profile: 'recovered_legacy_plain_text',
  sessionAddress: privateAddress
})

function settings (overrides: Partial<PresentationSettings> = {}): PresentationSettings {
  return Object.freeze({
    schemaVersion: 1,
    quoteReply: true,
    enableRobotAt: true,
    enableMarkdown: true,
    enableSuggestedResponses: true,
    forwardReasoning: true,
    blockWords: Object.freeze([]),
    promptBlockWords: Object.freeze([]),
    tts: Object.freeze({
      enabled: false,
      mode: 'vits-uma-genshin-honkai',
      activeVoice: 'voice',
      alsoSendText: false,
      autoFallbackThreshold: 299,
      filter: null,
      azureEmotionEnabled: false
    }),
    picture: Object.freeze({
      userEnabled: false,
      autoEnabled: false,
      autoThreshold: 1200,
      deviceScaleFactor: 1,
      closeBrowserAfterRender: true,
      showQRCode: true,
      live2d: null
    }),
    ...overrides
  })
}

function terminalFacts (status: 'completed' | 'failed' | 'cancelled', completion: CompletionDisposition | null) {
  const revision = 5
  const observationId = terminalObservationId(runRef, revision)
  const counters = createInitialRunObservationCounters()
  const completionObservation = completion?.kind === 'reply_text'
    ? Object.freeze({ kind: 'reply_text' as const, lengthBucket: '1_40' as const })
    : completion?.kind === 'already_visible'
      ? Object.freeze({ kind: 'already_visible' as const, source: 'tool_output' as const })
      : completion?.kind === 'allowed_silence'
        ? Object.freeze({ kind: 'allowed_silence' as const, reason: 'proactive_empty_directive' as const })
        : Object.freeze({ kind: 'none' as const })
  return Object.freeze({
    snapshot: Object.freeze({
      schemaVersion: 2 as const,
      observationId,
      runRef,
      revision,
      status,
      finishedAt: createdAt,
      completion: completionObservation,
      errorCode: status === 'failed' ? 'provider_timeout' as const : null,
      cancellationReason: status === 'cancelled' ? 'user_cancelled' : null,
      counters,
      engineDurationMs: counters.engineActiveDurationMs
    }),
    receipt: Object.freeze({
      schemaVersion: 1 as const,
      observationId,
      runRef,
      revision,
      deletedKeyCount: 2,
      createdKeyCount: 1,
      checkpointBytesDeleted: 10,
      eventBytesDeleted: 10,
      tombstoneBytes: 100
    })
  })
}

function output (text: string) {
  return Object.freeze({
    id: `message-${text}`,
    role: 'assistant' as const,
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt,
    provenance: Object.freeze({
      source: 'agent_output', trust: 'trusted' as const, sensitivity: 'group' as const,
      sourceId: runRef, createdAt
    })
  })
}

function completed (completion: CompletionDisposition): Extract<RunAdvanceResult, { kind: 'completed' }> {
  return Object.freeze({
    kind: 'completed', runId: 'run-1', runRef, completion,
    output: completion.kind === 'already_visible'
      ? null
      : output(completion.kind === 'allowed_silence' ? '<EMPTY>' : completion.text),
    terminal: terminalFacts('completed', completion)
  })
}

const failed: Extract<RunAdvanceResult, { kind: 'failed' }> = Object.freeze({
  kind: 'failed', runId: 'run-1', runRef,
  error: serializeAgentError(new AgentError({
    code: 'provider_timeout', stage: 'model.call', retryable: true,
    userMessage: 'private provider detail'
  })),
  terminal: terminalFacts('failed', null)
})

const cancelled: Extract<RunAdvanceResult, { kind: 'cancelled' }> = Object.freeze({
  kind: 'cancelled', runId: 'run-1', runRef, reason: 'user_cancelled',
  terminal: terminalFacts('cancelled', null)
})

function sent (
  media: PresentationDeliveryMedia,
  attempt: 1 | 2 = 1,
  messageId = `${media}-${attempt}`
): DeliveryResult<typeof media> {
  return Object.freeze({
    kind: 'sent', media, attempt,
    receipt: Object.freeze({ schemaVersion: 1, media, messageId }) as RuntimeDeliveryReceipt<typeof media>
  })
}

function definite (
  media: PresentationDeliveryMedia,
  attempt: 1 | 2 = 1
): DeliveryResult<typeof media> {
  return Object.freeze({ kind: 'failed_definite', media, attempt, code: 'host_rejected' })
}

function indeterminate (
  media: PresentationDeliveryMedia,
  attempt: 1 | 2 = 1
): DeliveryResult<typeof media> {
  return Object.freeze({ kind: 'outcome_unknown', media, attempt, code: 'unknown_host_result' })
}

interface OutboundCall {
  readonly part: OutboundPart
  readonly attempt: 1 | 2
  readonly options: OutboundDeliveryOptions | undefined
}

function fixture (input: {
  readonly deliveries?: DeliveryResult[]
  readonly random?: number[]
  readonly hooks?: Partial<RuntimePresentationHooks>
  readonly recall?: (receipt: RuntimeDeliveryReceipt) => Promise<RecallResult>
  readonly synthesis?: TtsSynthesisResult
  readonly diagnostic?: (code: TtsSynthesisErrorCode) => void | Promise<void>
  readonly pictureResult?: PictureRenderResult
} = {}) {
  const deliveries = [...(input.deliveries ?? [])]
  const calls: OutboundCall[] = []
  const targets: SessionAddress[] = []
  const recalls: RuntimeDeliveryReceipt[] = []
  const sleeps: number[] = []
  const schedules: Array<{ callback: () => void; milliseconds: number }> = []
  const notifications: Array<{ runRef: string; text: string; hasReasoning: boolean }> = []
  const conversions: Array<{ text: string; enableRobotAt: boolean; enableMarkdown: boolean }> = []
  const ttsCalls: object[] = []
  const ttsDiagnosticCalls: TtsSynthesisErrorCode[] = []
  const pictureCalls: object[] = []
  const random = [...(input.random ?? [])]
  const port: YunzaiOutboundPort = {
    target: groupAddress,
    deliver: async (part, attempt, options) => {
      calls.push({ part, attempt, options })
      const next = deliveries.shift()
      if (next !== undefined) return next as DeliveryResult<typeof part.media>
      return sent(part.media as PresentationDeliveryMedia, attempt) as DeliveryResult<typeof part.media>
    },
    recall: receipt => {
      recalls.push(receipt)
      return input.recall?.(receipt) ?? Promise.resolve(
        Object.freeze({ kind: 'recalled' }) satisfies RecallResult
      )
    }
  }
  const outboundFactory: YunzaiOutboundPortFactory = {
    forTarget: async target => {
      targets.push(target)
      return port
    }
  }
  const hooks: RuntimePresentationHooks = {
    postprocess: input.hooks?.postprocess ?? (async ({ text }) => ({ text })),
    convertText: input.hooks?.convertText ?? (async value => {
      conversions.push(value)
      return Object.freeze([{ kind: 'text' as const, text: value.text }])
    }),
    notifyResponsePost: input.hooks?.notifyResponsePost ?? (value => { notifications.push(value) })
  }
  const tts: TtsReplyPort = {
    synthesize: async value => {
      ttsCalls.push(value)
      return input.synthesis ?? Object.freeze({
        kind: 'ready',
        audio: Object.freeze({
          kind: 'buffer', data: new Uint8Array([1]), mimeType: 'audio/ogg', byteLength: 1
        })
      })
    }
  }
  const ttsDiagnostics: TtsPresentationDiagnosticPort = {
    reportSynthesisFailure: code => {
      ttsDiagnosticCalls.push(code)
      return input.diagnostic?.(code)
    }
  }
  const pictureRenderer: GroupMatePictureRenderer = {
    render: async value => {
      pictureCalls.push(value)
      return input.pictureResult ?? Object.freeze({
        kind: 'rendered',
        resource: Object.freeze({
          kind: 'buffer', data: new Uint8Array([137, 80, 78, 71]),
          mimeType: 'image/png', byteLength: 4
        }),
        source: 'local'
      })
    }
  }
  const presenter = new ReplyPresenter({
    outboundFactory,
    tts,
    ttsDiagnostics,
    pictureRenderer,
    random: () => random.shift() ?? 0.5,
    sleep: async milliseconds => { sleeps.push(milliseconds) },
    schedule: (callback, milliseconds) => {
      schedules.push({ callback, milliseconds })
      return undefined as unknown as ReturnType<typeof setTimeout>
    }
  })
  return {
    presenter,
    calls,
    targets,
    recalls,
    sleeps,
    schedules,
    notifications,
    conversions,
    ttsCalls,
    ttsDiagnosticCalls,
    pictureCalls,
    hooks
  }
}

type PresentationInputFixture = Omit<PresentationInput, 'route' | 'profile'> & {
  readonly route: PresentationInput['route']
  readonly profile: PresentationInput['profile']
}

function input (
  result: PresentationInput['result'],
  overrides: Partial<PresentationInputFixture> = {}
): PresentationInput {
  return {
    result,
    sessionPersistence: 'saved',
    route: ordinaryRoute,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }),
    settings: settings(),
    citationForwards: Object.freeze([]),
    suggestions: Object.freeze([]),
    hooks: fixture().hooks,
    ...overrides
  } as PresentationInput
}

const ordinaryTypeFixture = input(completed({ kind: 'reply_text', text: '类型夹具' }))
if (false) {
  // @ts-expect-error presentation route and profile branches must remain associated
  const invalidPresentationInput: PresentationInput = {
    ...ordinaryTypeFixture,
    route: proactiveRoute,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false })
  }
  void invalidPresentationInput
}

function sentTexts (calls: readonly OutboundCall[]): string[] {
  return calls.flatMap(call => call.part.media === 'text'
    ? call.part.atoms.flatMap(atom => atom.kind === 'text' ? [atom.text] : [])
    : [])
}

async function captureUnhandledRejections (
  action: () => Promise<void>
): Promise<readonly unknown[]> {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    await action()
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', listener)
  }
  return Object.freeze(unhandled)
}

test('postprocessor empty never falls back to the original response', async () => {
  const secret = 'ORIGINAL-SECRET-FIXTURE'
  const f = fixture({
    hooks: {
      postprocess: async () => ({ text: '   ', reasoningView: { text: secret, truncated: false } })
    }
  })
  const result = await f.presenter.present(input(completed({ kind: 'reply_text', text: secret }), {
    hooks: f.hooks
  }))
  assert.equal(result.outcome, 'complete')
  assert.deepEqual(sentTexts(f.calls), [POSTPROCESS_EMPTY_MESSAGE])
  assert.doesNotMatch(JSON.stringify({ calls: f.calls, notifications: f.notifications }), new RegExp(secret))

  const proactive = fixture({ hooks: { postprocess: async () => ({ text: '' }) } })
  const proactiveResult = await proactive.presenter.present(input(
    completed({ kind: 'reply_text', text: secret }),
    {
      route: proactiveRoute,
      profile: proactiveProfile({ recallAfterMs: 2_000 }),
      hooks: proactive.hooks
    }
  ))
  assert.deepEqual(proactiveResult, { schemaVersion: 1, outcome: 'failed', deliveries: [] })
  assert.equal(proactive.calls.length, 0)
})

test('presenter accepts completed failed and cancelled final run results', async () => {
  const f = fixture()
  const completedResult = await f.presenter.present(input(completed({ kind: 'reply_text', text: '完成' }), { hooks: f.hooks }))
  const failedResult = await f.presenter.present(input(failed, { hooks: f.hooks }))
  const cancelledResult = await f.presenter.present(input(cancelled, { hooks: f.hooks }))
  assert.deepEqual([completedResult.outcome, failedResult.outcome, cancelledResult.outcome], ['complete', 'complete', 'complete'])
  assert.deepEqual(sentTexts(f.calls), ['完成', 'AI 服务响应超时，请稍后重试', CANCELLED_MESSAGE])
  assert.equal(f.notifications.length, 1)
})

test('presenter isolates quote citation and input reply snapshot concepts', async () => {
  const f = fixture()
  await f.presenter.present(input(completed({ kind: 'reply_text', text: '正文' }), {
    route: ordinaryRoute,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }),
    citationForwards: [{ title: '来源', text: '引用正文', sourceUrl: 'https://example.com' }],
    hooks: f.hooks
  }))
  assert.equal(f.calls[0]?.part.media, 'forward')
  assert.equal(f.calls[0]?.options?.quoteMessageId, undefined)
  assert.equal(f.calls[1]?.part.media, 'text')
  assert.equal(f.calls[1]?.options?.quoteMessageId, 'request-message-1')
  assert.doesNotMatch(JSON.stringify(f.calls), /quoted input|snapshot|actor-1/)

  const privateProfile = ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false })
  const privateFixture = fixture()
  await privateFixture.presenter.present(input(completed({ kind: 'reply_text', text: '私聊' }), {
    route: Object.freeze({ ...ordinaryRoute, sessionAddress: privateAddress, requestMessageId: 'private-message' }),
    profile: privateProfile,
    hooks: privateFixture.hooks
  }))
  assert.equal(privateFixture.calls[0]?.options?.quoteMessageId, undefined)
})

test('presenter rejects route and profile matrix mismatches before side effects', async () => {
  const forgedRoute = (value: object): PresentationInput['route'] =>
    value as unknown as PresentationInput['route']
  const forgedProfile = (value: object): PresentationInput['profile'] =>
    value as unknown as PresentationInput['profile']
  const proactiveRecallNull = Object.freeze({
    ...proactiveRoute,
    presentationIntent: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'proactive' as const,
      recallAfterMs: null
    })
  })
  const privateOrdinaryRoute = Object.freeze({
    ...ordinaryRoute,
    sessionAddress: privateAddress,
    requestMessageId: 'private-request'
  })
  const noMessageOrdinaryRoute = Object.freeze((({ requestMessageId: _, ...route }) => route)(
    ordinaryRoute
  ))
  const noMessageProactiveRoute = Object.freeze((({ requestMessageId: _, ...route }) => route)(
    proactiveRoute
  ))

  const cases: ReadonlyArray<Readonly<{
    route: PresentationInput['route']
    profile: PresentationInput['profile']
    settings?: PresentationSettings
  }>> = [
    {
      route: proactiveRoute,
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false })
    },
    {
      route: forgedRoute({ ...ordinaryRoute, requestKind: 'proactive_chat' }),
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true })
    },
    {
      route: forgedRoute({ ...ordinaryRoute, profile: 'proactive' }),
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true })
    },
    {
      route: forgedRoute({
        ...ordinaryRoute,
        presentationIntent: { schemaVersion: 1, kind: 'proactive', recallAfterMs: null }
      }),
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true })
    },
    {
      route: proactiveRecallNull,
      profile: proactiveProfile({ recallAfterMs: 1_000 })
    },
    ...['', 7, 'x'.repeat(129)].map(requestMessageId => ({
      route: forgedRoute({ ...proactiveRoute, requestMessageId }),
      profile: proactiveProfile({ recallAfterMs: 2_000 })
    })),
    {
      route: proactiveRoute,
      profile: forgedProfile({
        ...proactiveProfile({ recallAfterMs: 2_000 }),
        maxParts: 2
      })
    },
    {
      route: ordinaryRoute,
      profile: ordinaryProfile({ forcePicture: true, quoteCurrentRequest: true })
    },
    {
      route: ordinaryRoute,
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false })
    },
    {
      route: ordinaryRoute,
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }),
      settings: settings({ quoteReply: false })
    },
    {
      route: privateOrdinaryRoute,
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true })
    },
    {
      route: noMessageOrdinaryRoute,
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true })
    },
    {
      route: recoveredRoute,
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false })
    }
  ]

  for (const invalid of cases) {
    let postprocessCalls = 0
    const f = fixture({
      hooks: {
        postprocess: async ({ text }) => {
          postprocessCalls += 1
          return { text }
        }
      }
    })
    const result = await f.presenter.present(input(completed({
      kind: 'reply_text', text: '矩阵不匹配正文'
    }), {
      route: invalid.route,
      profile: invalid.profile,
      settings: invalid.settings ?? settings(),
      hooks: f.hooks
    }))
    assert.deepEqual(result, { schemaVersion: 1, outcome: 'failed', deliveries: [] })
    assert.equal(postprocessCalls, 0)
    assert.equal(f.targets.length, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(f.conversions.length, 0)
    assert.equal(f.notifications.length, 0)
    assert.equal(f.schedules.length, 0)
    assert.equal(f.sleeps.length, 0)
  }

  const validProactive = fixture({ random: [0] })
  const validResult = await validProactive.presenter.present(input(completed({
    kind: 'reply_text', text: '无引用消息也能主动回复'
  }), {
    route: noMessageProactiveRoute,
    profile: proactiveProfile({ recallAfterMs: 2_000 }),
    hooks: validProactive.hooks
  }))
  assert.equal(validResult.outcome, 'complete')
  assert.equal(validProactive.targets.length, 1)
  assert.equal(validProactive.calls.length, 1)
  assert.equal(validProactive.calls[0]?.options?.quoteMessageId, undefined)
})

test('presenter aggregates retries and multi-part outcomes deterministically', async () => {
  const f = fixture({ deliveries: [
    definite('forward', 1), sent('forward', 2),
    sent('text'),
    indeterminate('forward')
  ] })
  const result = await f.presenter.present(input(completed({ kind: 'reply_text', text: '正文' }), {
    citationForwards: [{ title: '来源', text: '引用' }],
    settings: settings({ forwardReasoning: true }),
    hooks: {
      ...f.hooks,
      postprocess: async ({ text }) => ({
        text,
        reasoningView: { text: '推理', truncated: false }
      })
    }
  }))
  assert.equal(result.outcome, 'partial')
  assert.deepEqual(result.deliveries.map(delivery => [delivery.media, delivery.kind, delivery.attempt]), [
    ['forward', 'sent', 2],
    ['text', 'sent', 1],
    ['forward', 'outcome_unknown', 1]
  ])
  assert.equal(f.calls.length, 4)
})

test('presenter aggregation preserves a child partial without a fabricated delivery', async () => {
  const child: PresentationResult = Object.freeze({
    schemaVersion: 1,
    outcome: 'partial',
    deliveries: Object.freeze([sent('text')])
  })
  const aggregated = aggregatePresentationResults([
    child,
    Object.freeze({ schemaVersion: 1, outcome: 'complete', deliveries: Object.freeze([sent('forward')]) })
  ])
  assert.equal(aggregated.outcome, 'partial')
  assert.deepEqual(aggregated.deliveries.map(item => item.media), ['text', 'forward'])
})

test('session persistence failure preserves completion and applies the text visible and silence matrix', async () => {
  const replyCompletion = Object.freeze({ kind: 'reply_text' as const, text: '正文' })
  const visibleCompletion = Object.freeze({ kind: 'already_visible' as const, source: 'tool_output' as const })
  const silenceCompletion = Object.freeze({
    kind: 'allowed_silence' as const,
    reason: 'proactive_empty_directive' as const
  })
  const replyResult = completed(replyCompletion)
  const visibleResult = completed(visibleCompletion)
  const silenceResult = completed(silenceCompletion)

  for (const [result, route, profile, expected] of [
    [replyResult, ordinaryRoute, ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }), ['正文', SESSION_PERSISTENCE_FAILED_MESSAGE]],
    [visibleResult, ordinaryRoute, ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }), [SESSION_PERSISTENCE_FAILED_MESSAGE]],
    [silenceResult, proactiveRoute, proactiveProfile({ recallAfterMs: 2_000 }), []]
  ] as const) {
    const f = fixture()
    const presentation = await f.presenter.present(input(result, {
      sessionPersistence: 'failed', route, profile, hooks: f.hooks
    }))
    assert.strictEqual(result.kind, 'completed')
    assert.deepEqual(sentTexts(f.calls), expected)
    assert.equal(presentation.outcome, expected.length === 0 ? 'skipped' : 'complete')
    if (expected.length === 0) assert.equal(presentation.skipReason, 'allowed_silence')
  }
})

test('ordinary profile preserves citation reasoning suggestions and trusted buttons', async () => {
  const f = fixture()
  const result = await f.presenter.present(input(completed({ kind: 'reply_text', text: '代码```' }), {
    citationForwards: [{ title: '来源', text: '引用' }],
    suggestions: ['继续', '#chat1', '结束对话', '换个话题'],
    hooks: {
      ...f.hooks,
      postprocess: async ({ text }) => ({ text, reasoningView: { text: '推理', truncated: false } })
    }
  }))
  assert.equal(result.outcome, 'complete')
  assert.deepEqual(f.calls.map(call => call.part.media), ['forward', 'text', 'forward', 'text'])
  const main = f.calls[1]?.part
  assert.equal(main?.media, 'text')
  if (main?.media === 'text') {
    assert.equal((main.atoms[0] as Extract<SafeTextAtom, { kind: 'text' }>).text, '代码\n```')
  }
  const suggestion = f.calls[3]?.part
  assert.equal(suggestion?.media, 'text')
  if (suggestion?.media === 'text') {
    assert.equal((suggestion.atoms[0] as Extract<SafeTextAtom, { kind: 'text' }>).text, '建议的回复：\n继续\n换个话题')
    assert.deepEqual(suggestion.buttons, {
      schemaVersion: 1, kind: 'chat_suggestions', suggestions: ['继续', '换个话题']
    })
  }
  assert.deepEqual(f.notifications, [{ runRef, text: '代码\n```', hasReasoning: true }])

  const runtimeHooks = createRuntimePresentationHooks({
    loadPostprocessors: async () => Object.freeze([]),
    convertText: async ({ text }) => Object.freeze([{ kind: 'text' as const, text }]),
    notifyResponsePost: () => undefined
  })
  assert.deepEqual(
    await runtimeHooks.postprocess({ text: '<think>  内联推理  </think>\n可见正文' }),
    {
      text: '可见正文',
      reasoningView: { text: '内联推理', truncated: false }
    }
  )
})

test('response post notification failures never escape presentation', async () => {
  for (const notifyResponsePost of [
    () => { throw new Error('private-body target-group receipt-sync') },
    async () => { throw new Error('private-body target-group receipt-async') }
  ]) {
    const f = fixture({ hooks: { notifyResponsePost } })
    let result: PresentationResult | undefined
    const unhandled = await captureUnhandledRejections(async () => {
      result = await f.presenter.present(input(completed({
        kind: 'reply_text', text: '通知失败仍应发送'
      }), { hooks: f.hooks }))
    })
    assert.equal(result?.outcome, 'complete')
    assert.equal(f.calls.length, 1)
    assert.deepEqual(unhandled, [])
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-body|target-group|receipt-(?:sync|async)/
    )
  }
})

test('proactive profile owns split quote delay and receipt-only recall', async () => {
  let conversionCalls = 0
  const f = fixture({
    random: [0.09, 0.11, 0.09],
    deliveries: [sent('text', 1, 'p1'), indeterminate('text'), sent('text', 1, 'p3')],
    hooks: {
      convertText: async () => {
        conversionCalls += 1
        return Object.freeze([{ kind: 'markdown' as const, markdown: 'rich output' }])
      }
    }
  })
  const result = await f.presenter.present(input(completed({
    kind: 'reply_text', text: '第一段。第二段？第三段'
  }), {
    route: proactiveRoute,
    profile: proactiveProfile({ recallAfterMs: 2_000 }),
    hooks: f.hooks
  }))
  assert.equal(result.outcome, 'partial')
  assert.equal(conversionCalls, 0)
  assert.ok(f.calls.every(call => call.part.media === 'text' &&
    call.part.atoms.every(atom => atom.kind === 'text')))
  assert.deepEqual(f.calls.map(call => call.options?.quoteMessageId !== undefined), [true, false, true])
  assert.deepEqual(f.sleeps, [600, 800, 600])
  assert.deepEqual(f.schedules.map(item => item.milliseconds), [2_000, 2_000])
  for (const scheduled of f.schedules) scheduled.callback()
  await Promise.resolve()
  assert.deepEqual(f.recalls.map(receipt => receipt.messageId), ['p1', 'p3'])
})

test('scheduled recall failures never escape presentation', async () => {
  for (const recall of [
    () => { throw new Error('private-body target-group receipt-sync') },
    async () => { throw new Error('private-body target-group receipt-async') }
  ]) {
    const f = fixture({
      deliveries: [sent('text', 1, 'recall-receipt')],
      recall
    })
    const result = await f.presenter.present(input(completed({
      kind: 'reply_text', text: '单段主动回复'
    }), {
      route: proactiveRoute,
      profile: proactiveProfile({ recallAfterMs: 2_000 }),
      hooks: f.hooks
    }))
    assert.equal(result.outcome, 'complete')
    assert.equal(f.calls.length, 1)
    assert.equal(f.schedules.length, 1)
    const unhandled = await captureUnhandledRejections(async () => {
      f.schedules[0]?.callback()
    })
    assert.deepEqual(unhandled, [])
    assert.equal(f.recalls.length, 1)
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-body|target-group|receipt-(?:sync|async)/
    )
  }
})

test('recovered legacy profile cannot use rich presentation or silence', async () => {
  const f = fixture({
    hooks: {
      postprocess: async ({ text }) => ({ text, reasoningView: { text: 'private reasoning', truncated: false } }),
      convertText: async () => Object.freeze([{ kind: 'markdown' as const, markdown: 'unsafe rich body' }])
    }
  })
  await f.presenter.present(input(completed({ kind: 'reply_text', text: '恢复正文' }), {
    route: recoveredRoute,
    profile: RECOVERED_LEGACY_PROFILE,
    citationForwards: [{ title: '来源', text: '引用' }],
    suggestions: ['建议'],
    hooks: f.hooks
  }))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0]?.part, {
    media: 'text', atoms: [{ kind: 'text', text: '恢复正文' }]
  })
  assert.equal(f.calls[0]?.options?.quoteMessageId, undefined)

  const legacyFailure = fixture()
  const result = await legacyFailure.presenter.present(input(Object.freeze({
    ...failed,
    error: serializeAgentError(new AgentError({
      code: 'legacy_entry_kind_unavailable', stage: 'run.completion', retryable: false,
      userMessage: '<EMPTY>'
    }))
  }), {
    route: recoveredRoute,
    profile: RECOVERED_LEGACY_PROFILE,
    hooks: legacyFailure.hooks
  }))
  assert.equal(result.outcome, 'complete')
  assert.deepEqual(sentTexts(legacyFailure.calls), ['旧任务缺少可信入口信息，无法安全恢复回复。'])
  assert.doesNotMatch(JSON.stringify(legacyFailure.calls), /<EMPTY>/)

  for (const postprocess of [
    async () => ({ text: '替代恢复正文' }),
    async () => ({ text: '' }),
    async () => ({
      text: '<EMPTY>',
      reasoningView: { text: '不应出现的恢复推理', truncated: false }
    }),
    async (): Promise<{ readonly text: string }> => {
      throw new Error('不应执行恢复 hook')
    }
  ]) {
    let hookCalls = 0
    const legacyEmpty = fixture({
      hooks: {
        postprocess: async () => {
          hookCalls += 1
          return await postprocess()
        }
      }
    })
    const legacyEmptyResult = await legacyEmpty.presenter.present(input(completed({
      kind: 'reply_text', text: '  <EMPTY>  '
    }), {
      route: recoveredRoute,
      profile: RECOVERED_LEGACY_PROFILE,
      hooks: legacyEmpty.hooks
    }))
    assert.equal(legacyEmptyResult.outcome, 'complete')
    assert.equal(hookCalls, 0)
    assert.deepEqual(sentTexts(legacyEmpty.calls), ['旧任务缺少可信入口信息，无法安全恢复回复。'])
    assert.doesNotMatch(
      JSON.stringify(legacyEmpty.calls),
      /<EMPTY>|替代恢复正文|不应出现的恢复推理/
    )
  }

  const blocked = fixture({ hooks: { postprocess: async ({ text }) => ({ text }) } })
  await blocked.presenter.present(input(completed({ kind: 'reply_text', text: 'private secret' }), {
    route: recoveredRoute,
    profile: RECOVERED_LEGACY_PROFILE,
    settings: settings({ blockWords: Object.freeze(['SECRET']) }),
    hooks: blocked.hooks
  }))
  assert.deepEqual(sentTexts(blocked.calls), [BLOCKED_RESPONSE_MESSAGE])
})

test('ReplyPresenter selects TTS then picture then text with required renderer', async () => {
  const ttsSettings = settings({
    tts: Object.freeze({
      enabled: true,
      mode: 'azure',
      activeVoice: 'zh-CN-XiaoxiaoNeural',
      alsoSendText: false,
      autoFallbackThreshold: 299,
      filter: null,
      azureEmotionEnabled: false
    }),
    picture: Object.freeze({
      ...settings().picture,
      userEnabled: true
    })
  })
  const ordinary = fixture()
  const ordinaryResult = await ordinary.presenter.present(input(completed({
    kind: 'reply_text', text: '语音优先正文'
  }), {
    settings: ttsSettings,
    hooks: ordinary.hooks
  }))
  assert.equal(ordinaryResult.outcome, 'complete')
  assert.equal(ordinary.ttsCalls.length, 1)
  assert.equal(ordinary.pictureCalls.length, 0)
  assert.deepEqual(ordinary.calls.map(call => call.part.media), ['voice'])
  assert.equal(ordinary.conversions.length, 0)

  const picture = fixture({
    hooks: {
      postprocess: async ({ text }) => ({
        text,
        reasoningView: { text: '图片内推理', truncated: false }
      })
    }
  })
  await picture.presenter.present(input(completed({ kind: 'reply_text', text: '图片正文' }), {
    citationForwards: Object.freeze([{
      title: '图片内来源', text: '图片内引用', sourceUrl: 'https://example.com/source'
    }]),
    settings: settings({
      picture: Object.freeze({ ...settings().picture, userEnabled: true })
    }),
    hooks: picture.hooks
  }))
  assert.equal(picture.ttsCalls.length, 0)
  assert.equal(picture.pictureCalls.length, 1)
  assert.deepEqual(picture.calls.map(call => call.part.media), ['picture'])
  assert.equal(picture.conversions.length, 0)
  assert.deepEqual(picture.pictureCalls[0], {
    replyText: '图片正文',
    citations: [{
      title: '图片内来源', text: '图片内引用', sourceUrl: 'https://example.com/source'
    }],
    reasoningView: { text: '图片内推理', truncated: false },
    settings: settings({
      picture: Object.freeze({ ...settings().picture, userEnabled: true })
    }).picture
  })

  const autoMiss = fixture()
  await autoMiss.presenter.present(input(completed({ kind: 'reply_text', text: '四个字啊' }), {
    settings: settings({
      picture: Object.freeze({
        ...settings().picture, autoEnabled: true, autoThreshold: 6
      })
    }),
    hooks: autoMiss.hooks
  }))
  assert.equal(autoMiss.pictureCalls.length, 0)
  assert.deepEqual(autoMiss.calls.map(call => call.part.media), ['text'])

  const autoHit = fixture()
  await autoHit.presenter.present(input(completed({ kind: 'reply_text', text: '六个汉字正好' }), {
    settings: settings({
      picture: Object.freeze({
        ...settings().picture, autoEnabled: true, autoThreshold: 6
      })
    }),
    hooks: autoHit.hooks
  }))
  assert.equal(autoHit.pictureCalls.length, 1)
  assert.deepEqual(autoHit.calls.map(call => call.part.media), ['picture'])

  const forced = fixture()
  await forced.presenter.present(input(completed({ kind: 'reply_text', text: '强制图片' }), {
    route: Object.freeze({
      ...ordinaryRoute,
      presentationIntent: Object.freeze({
        schemaVersion: 1 as const, kind: 'ordinary' as const, forcePicture: true
      })
    }),
    profile: ordinaryProfile({ forcePicture: true, quoteCurrentRequest: true }),
    hooks: forced.hooks
  }))
  assert.equal(forced.pictureCalls.length, 1)
  assert.deepEqual(forced.calls.map(call => call.part.media), ['picture'])

  const disabled = fixture()
  await disabled.presenter.present(input(completed({ kind: 'reply_text', text: '普通文本' }), {
    hooks: disabled.hooks
  }))
  assert.equal(disabled.ttsCalls.length, 0)
  assert.equal(disabled.pictureCalls.length, 0)
  assert.deepEqual(disabled.calls.map(call => call.part.media), ['text'])

  const textFirstFailure = fixture({
    synthesis: Object.freeze({ kind: 'failed_definite', code: 'synthesis_rejected' }),
    deliveries: [sent('forward'), sent('text'), sent('text')]
  })
  const partial = await textFirstFailure.presenter.present(input(completed({
    kind: 'reply_text', text: '聚合时只能出现一次的原文'
  }), {
    sessionPersistence: 'failed',
    citationForwards: Object.freeze([{ title: '来源', text: '引用' }]),
    settings: settings({
      tts: Object.freeze({
        ...ttsSettings.tts,
        alsoSendText: true
      })
    }),
    hooks: textFirstFailure.hooks
  }))
  assert.equal(partial.outcome, 'partial')
  assert.deepEqual(partial.deliveries.map(item => item.media), ['forward', 'text', 'text'])
  assert.equal(
    sentTexts(textFirstFailure.calls).filter(text => text === '聚合时只能出现一次的原文').length,
    1
  )
  assert.deepEqual(sentTexts(textFirstFailure.calls).at(-1), SESSION_PERSISTENCE_FAILED_MESSAGE)
  assert.deepEqual(textFirstFailure.ttsDiagnosticCalls, ['synthesis_rejected'])
  assert.equal(textFirstFailure.pictureCalls.length, 0)
})

test('ReplyPresenter bypasses picture for proactive and recovered legacy profiles', async () => {
  const richSettings = settings({
    tts: Object.freeze({ ...settings().tts, enabled: true }),
    picture: Object.freeze({ ...settings().picture, userEnabled: true, autoEnabled: true })
  })
  const proactive = fixture()
  await proactive.presenter.present(input(completed({ kind: 'reply_text', text: '主动正文' }), {
    route: proactiveRoute,
    profile: proactiveProfile({ recallAfterMs: 2_000 }),
    settings: richSettings,
    hooks: proactive.hooks
  }))
  assert.equal(proactive.ttsCalls.length, 0)
  assert.equal(proactive.pictureCalls.length, 0)
  assert.deepEqual(proactive.calls.map(call => call.part.media), ['text'])

  const legacy = fixture()
  await legacy.presenter.present(input(completed({ kind: 'reply_text', text: '恢复正文' }), {
    route: recoveredRoute,
    profile: RECOVERED_LEGACY_PROFILE,
    settings: richSettings,
    hooks: legacy.hooks
  }))
  assert.equal(legacy.ttsCalls.length, 0)
  assert.equal(legacy.pictureCalls.length, 0)
  assert.deepEqual(legacy.calls.map(call => call.part.media), ['text'])
})

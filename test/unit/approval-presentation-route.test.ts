import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  PresentationRouteV1,
  RecoveredLegacyPresentationRoute
} from '../../src/agent/contracts/interaction.js'
import type { FinalChatReplyEnvelope } from '../../src/runtime/agent-service.js'
import {
  buildApprovalPresentationInput,
  createApprovalOutboundPortFactory,
  type ActivePresentationContext,
  type YunzaiBotPicker
} from '../../src/runtime/agent-service-bridge.js'
import { RECOVERED_LEGACY_PROFILE } from '../../src/runtime/presentation/presentation-profile.js'
import { ReplyPresenter } from '../../src/runtime/presentation/reply-presenter.js'
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

const settings: PresentationSettings = Object.freeze({
  schemaVersion: 1,
  quoteReply: true,
  enableRobotAt: false,
  enableMarkdown: false,
  enableSuggestedResponses: false,
  forwardReasoning: false,
  forwardToolDetails: false,
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

function finalResult (text = '完成'): FinalChatReplyEnvelope {
  return Object.freeze({
    kind: 'completed',
    runId: 'run-1',
    runRef: '1'.repeat(32),
    completion: Object.freeze({ kind: 'reply_text', text }),
    output: Object.freeze({
      id: 'output-1',
      role: 'assistant',
      createdAt: '2026-07-16T00:00:00.000Z',
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
      schemaVersion: 1,
      kind: 'ordinary',
      forcePicture: true
    }),
    sessionAddress: Object.freeze({
      botId: 'bot-original',
      scope: Object.freeze({ kind: 'group', groupId: 'group-original' })
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

test('approval presentation returns to the original route and actor settings', async () => {
  const loads: string[] = []
  const port: PresentationSettingsPort = Object.freeze({
    load: async (actorId: string) => {
      loads.push(actorId)
      return settings
    }
  })

  const input = await buildApprovalPresentationInput({
    context: context(ordinaryRoute()),
    result: finalResult(),
    settings: port
  })

  assert.deepEqual(loads, ['requester-u'])
  assert.deepEqual(input.route.sessionAddress, {
    botId: 'bot-original',
    scope: { kind: 'group', groupId: 'group-original' }
  })
  assert.equal(input.profile.kind, 'ordinary')
  assert.equal(input.profile.kind === 'ordinary' && input.profile.forcePicture, true)
  assert.equal(input.profile.kind === 'ordinary' && input.profile.quoteCurrentRequest, true)
  assert.equal(input.hooks, PLAIN_TEXT_PRESENTATION_HOOKS)
})

test('approval presentation preserves proactive recall intent', async () => {
  const route: Extract<PresentationRouteV1, { requestKind: 'proactive_chat' }> = Object.freeze({
    schemaVersion: 1,
    requestKind: 'proactive_chat',
    profile: 'proactive',
    presentationIntent: Object.freeze({
      schemaVersion: 1,
      kind: 'proactive',
      recallAfterMs: 7_000
    }),
    sessionAddress: Object.freeze({
      botId: 'bot-original',
      scope: Object.freeze({ kind: 'group', groupId: 'group-original' })
    }),
    actorId: 'requester-u'
  })

  const input = await buildApprovalPresentationInput({
    context: context(route),
    result: finalResult(),
    settings: { load: async () => settings }
  })

  assert.equal(input.profile.kind, 'proactive')
  assert.equal(input.profile.kind === 'proactive' && input.profile.recallAfterMs, 7_000)
  assert.equal(input.route, route)
})

test('approval outbound selects the bot and target recorded by the original route', async () => {
  const calls: string[] = []
  const picker: YunzaiBotPicker = Object.freeze({
    pick: async (botId: string) => {
      calls.push(`bot:${botId}`)
      return {
        pickGroup: (groupId: string | number) => ({
          sendMsg: async (message: unknown) => {
            calls.push(`group:${String(groupId)}:${JSON.stringify(message)}`)
            return { message_id: 'sent-1' }
          },
          recallMsg: async () => true
        })
      } as never
    }
  })
  const factory = createApprovalOutboundPortFactory({
    botPicker: picker,
    segment: () => ({})
  })

  const outbound = await factory.forTarget(ordinaryRoute().sessionAddress)
  const delivered = await outbound.deliver({
    media: 'text',
    atoms: Object.freeze([{ kind: 'text', text: '恢复完成' }])
  }, 1)

  assert.equal(delivered.kind, 'sent')
  assert.deepEqual(calls, [
    'bot:bot-original',
    'group:group-original:"恢复完成"'
  ])
})

test('approval outbound materializes a new forward message through the target adapter', async () => {
  const forwarded: unknown[] = []
  const sent: unknown[] = []
  const materialized = Object.freeze({
    test: true,
    message: Object.freeze([{ type: 'node' }])
  })
  const picker: YunzaiBotPicker = Object.freeze({
    pick: async () => ({
      pickGroup: () => ({
        makeForwardMsg: async (nodes: unknown) => {
          forwarded.push(nodes)
          return materialized
        },
        sendMsg: async (message: unknown) => {
          sent.push(message)
          return { message_id: 'sent-forward' }
        },
        recallMsg: async () => true
      })
    }) as never
  })
  const factory = createApprovalOutboundPortFactory({
    botPicker: picker,
    segment: () => ({})
  })

  const outbound = await factory.forTarget(ordinaryRoute().sessionAddress)
  const delivered = await outbound.deliver(Object.freeze({
    media: 'forward' as const,
    title: '执行过程',
    nodes: Object.freeze([
      Object.freeze({ kind: 'text' as const, text: '先搜索资料' }),
      Object.freeze({ kind: 'text' as const, text: '再整理结果' })
    ])
  }), 1)

  assert.equal(delivered.kind, 'sent')
  assert.deepEqual(forwarded, [[
    { message: '执行过程' },
    { message: '先搜索资料' },
    { message: '再整理结果' }
  ]])
  assert.deepEqual(sent, [materialized])
})

test('approval presentation rejects a result from another run', async () => {
  await assert.rejects(
    buildApprovalPresentationInput({
      context: Object.freeze({
        ...context(ordinaryRoute()),
        runRef: '2'.repeat(32)
      }),
      result: finalResult(),
      settings: { load: async () => settings }
    }),
    /run reference is invalid/
  )
})

test('legacy approval recovery uses safe plain text without actor settings or empty sentinel', async () => {
  const route: RecoveredLegacyPresentationRoute = Object.freeze({
    schemaVersion: 1,
    requestKind: 'legacy_unknown',
    profile: 'recovered_legacy_plain_text',
    sessionAddress: Object.freeze({
      botId: 'bot-original',
      scope: Object.freeze({ kind: 'group', groupId: 'group-original' })
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
  const outbound: YunzaiOutboundPort = Object.freeze({
    target: route.sessionAddress,
    deliver: async (
      part: Parameters<YunzaiOutboundPort['deliver']>[0],
      attempt: number
    ) => {
      if (part.media === 'text') {
        sent.push(part.atoms.map(atom => atom.kind === 'text' ? atom.text : '').join(''))
      }
      return Object.freeze({
        kind: 'sent',
        media: part.media,
        attempt,
        receipt: Object.freeze({
          schemaVersion: 1,
          media: part.media,
          messageId: 'legacy-1'
        })
      }) as never
    },
    recall: async () => Object.freeze({ kind: 'recalled' })
  })
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

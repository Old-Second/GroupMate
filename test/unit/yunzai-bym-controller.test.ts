import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PresentationRouteV1 } from '../../src/agent/contracts/interaction.js'
import type { ChatReplyEnvelope } from '../../src/runtime/agent-service.js'
import type { PreparedYunzaiMessageEvidenceV1 } from '../../src/runtime/message-input.js'
import type { PresentationResult } from '../../src/runtime/presentation/presentation-result.js'
import type { PresentationSettings } from '../../src/runtime/presentation/presentation-settings.js'
import type { PresentationInput } from '../../src/runtime/runtime-presentation-hooks.js'
import {
  createYunzaiBymController,
  type BymPolicySnapshot
} from '../../src/runtime/yunzai-bym-controller.js'

const settings: PresentationSettings = Object.freeze({
  schemaVersion: 1,
  quoteReply: false,
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

const presentationResult: PresentationResult = Object.freeze({
  schemaVersion: 1,
  outcome: 'complete',
  deliveries: Object.freeze([])
})

const basePolicy: BymPolicySnapshot = Object.freeze({
  enabled: true,
  assistantLabel: '派蒙',
  recognizeLeadingAlias: true,
  ratePercent: 25,
  disabledGroupIds: Object.freeze([]),
  thinkingMode: 'enabled',
  reasoningEffort: 'high',
  preset: '\n保持自然。',
  retaliationWords: Object.freeze(['坏蛋']),
  retaliationBlacklistActorIds: Object.freeze([]),
  retaliationPrompt: '\n怼回去。',
  retaliationRecallEnabled: true,
  retaliationRecallSeconds: 60
})

function event (overrides: Record<string, unknown> = {}) {
  return {
    isGroup: true,
    group_id: 'group-1',
    self_id: 'bot-1',
    user_id: 'actor-1',
    message_id: 'message-1',
    msg: '大家今天怎么样？',
    message: [{ type: 'text', text: '大家今天怎么样？' }],
    sender: { user_id: 'actor-1', nickname: '群友' },
    ...overrides
  }
}

function completedEnvelope (text: string): ChatReplyEnvelope {
  return Object.freeze({
    kind: 'completed',
    runId: 'run-1',
    runRef: '1'.repeat(32),
    completion: Object.freeze({ kind: 'reply_text', text }),
    output: null,
    terminal: Object.freeze({
      snapshot: Object.freeze({ observationId: 'a'.repeat(64) })
    }),
    requestObservationDraft: Object.freeze({}),
    sessionPersistence: 'not_attempted'
  }) as unknown as ChatReplyEnvelope
}

function pausedEnvelope (): ChatReplyEnvelope {
  return Object.freeze({
    kind: 'paused',
    runId: 'run-paused',
    runRef: '2'.repeat(32),
    interruption: Object.freeze({})
  }) as unknown as ChatReplyEnvelope
}

function fixture (input: Readonly<{
  policy?: BymPolicySnapshot
  random?: number
  blocked?: boolean
  preparedPrompt?: string
  result?: ChatReplyEnvelope
  agentError?: boolean
}> = {}) {
  const calls: string[] = []
  const prepared: Array<Readonly<{
    prompt: string
    recallAfterMs: number | null
  }>> = []
  const agentInputs: unknown[] = []
  const presentationInputs: PresentationInput[] = []
  const diagnostics: Readonly<Record<string, unknown>>[] = []
  let completionCalls = 0
  const controller = createYunzaiBymController({
    policy: {
      snapshot: () => input.policy ?? basePolicy
    },
    random: () => input.random ?? 0.24,
    promptScreening: {
      isBlocked: async ({ prompt }) => {
        calls.push(`screen:${prompt}`)
        return input.blocked === true || prompt.includes('引用屏蔽词')
      }
    },
    requests: {
      prepare: async ({ event: currentEvent, prompt, presentationIntent }) => {
        calls.push('prepare')
        prepared.push({ prompt, recallAfterMs: presentationIntent.recallAfterMs })
        const actorId = String(currentEvent.sender?.user_id ?? currentEvent.user_id)
        const route: Extract<PresentationRouteV1, { requestKind: 'proactive_chat' }> =
          Object.freeze({
            schemaVersion: 1,
            requestKind: 'proactive_chat',
            profile: 'proactive',
            presentationIntent: Object.freeze({ ...presentationIntent }),
            sessionAddress: Object.freeze({
              botId: 'bot-1',
              scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
            }),
            actorId,
            requestMessageId: 'message-1'
          })
        const evidencePrompt = input.preparedPrompt ?? prompt
        const evidence: PreparedYunzaiMessageEvidenceV1 = Object.freeze({
          schemaVersion: 1,
          prompt: evidencePrompt,
          imageUrls: Object.freeze([]),
          currentMessageId: 'message-1',
          quotedMessageId: null,
          hasReply: false,
          replyResolved: false,
          currentSegmentCount: 1,
          replySegmentCount: 0,
          ocrTexts: Object.freeze([])
        })
        return Object.freeze({ route, evidence })
      }
    },
    agent: {
      handleEphemeral: async agentInput => {
        calls.push('agent')
        agentInputs.push(agentInput)
        if (input.agentError === true) throw new Error('provider detail must stay silent')
        return input.result ?? completedEnvelope('完整主动回复。第二句。')
      }
    },
    presentationSettings: {
      load: async () => settings
    },
    hooks: {
      forActiveEvent: () => Object.freeze({
        postprocess: async ({ text }: { readonly text: string }) => Object.freeze({ text }),
        convertText: async ({ text }: { readonly text: string }) =>
          Object.freeze([{ kind: 'text' as const, text }]),
        notifyResponsePost: () => undefined
      })
    },
    presenter: {
      present: async presentationInput => {
        calls.push('present')
        presentationInputs.push(presentationInput)
        return presentationResult
      }
    },
    completionCoordinator: {
      complete: async ({ envelope, present }) => {
        completionCalls += 1
        calls.push('complete')
        return await present(Object.freeze({
          result: envelope as never,
          sessionPersistence: envelope.sessionPersistence
        }))
      }
    },
    diagnostics: {
      record: entry => { diagnostics.push(entry) }
    }
  })
  return {
    controller,
    calls,
    prepared,
    agentInputs,
    presentationInputs,
    diagnostics,
    completionCalls: () => completionCalls
  }
}

test('BYM preserves trigger rate retaliation policy and always returns false', async () => {
  const disabled = fixture({ policy: Object.freeze({ ...basePolicy, enabled: false }) })
  assert.equal(await disabled.controller.bym(event()), false)
  assert.deepEqual(disabled.calls, [])

  const disabledGroup = fixture({
    policy: Object.freeze({ ...basePolicy, disabledGroupIds: Object.freeze(['group-1']) })
  })
  assert.equal(await disabledGroup.controller.bym(event()), false)
  assert.deepEqual(disabledGroup.calls, [])

  const missed = fixture({ random: 0.25 })
  assert.equal(await missed.controller.bym(event()), false)
  assert.deepEqual(missed.calls, [])

  const blocked = fixture({ blocked: true, random: 0 })
  assert.equal(await blocked.controller.bym(event()), false)
  assert.deepEqual(blocked.calls, ['prepare', 'screen:大家今天怎么样？'])

  const canonicalBlocked = fixture({
    random: 0,
    preparedPrompt: '大家今天怎么样？\n引用消息：引用屏蔽词'
  })
  assert.equal(await canonicalBlocked.controller.bym(event()), false)
  assert.deepEqual(canonicalBlocked.calls, [
    'prepare', 'screen:大家今天怎么样？\n引用消息：引用屏蔽词'
  ])

  const invalidRandom = fixture({ random: Number.NaN })
  assert.equal(await invalidRandom.controller.bym(event()), false)
  assert.deepEqual(invalidRandom.calls, [])

  const explicit = fixture({
    policy: Object.freeze({ ...basePolicy, ratePercent: 0 }),
    random: 0.99
  })
  assert.equal(await explicit.controller.bym(event({
    msg: '今天心情怎么样？',
    hasAlias: true
  })), false)
  assert.deepEqual(explicit.calls, [
    'prepare', 'screen:今天心情怎么样？', 'agent', 'complete', 'present'
  ])

  const retaliation = fixture({
    policy: Object.freeze({
      ...basePolicy,
      ratePercent: 100,
      retaliationRecallSeconds: 9_999
    })
  })
  assert.equal(await retaliation.controller.bym(event({ msg: '派蒙是坏蛋' })), false)
  assert.equal(retaliation.prepared[0]?.recallAfterMs, 3_600_000)
  const retaliationAgent = retaliation.agentInputs[0] as {
    readonly systemInstructions: readonly string[]
    readonly enableGroupContext: boolean
    readonly thinkingMode: string
    readonly reasoningEffort: string
  }
  assert.match(retaliationAgent.systemInstructions[0] ?? '', /保持自然。/)
  assert.match(retaliationAgent.systemInstructions[0] ?? '', /怼回去。/)
  assert.equal(retaliationAgent.enableGroupContext, true)
  assert.equal(retaliationAgent.thinkingMode, 'enabled')
  assert.equal(retaliationAgent.reasoningEffort, 'high')

  const blacklisted = fixture({
    policy: Object.freeze({
      ...basePolicy,
      ratePercent: 100,
      retaliationBlacklistActorIds: Object.freeze(['actor-1'])
    })
  })
  assert.equal(await blacklisted.controller.bym(event({ msg: '派蒙是坏蛋' })), false)
  assert.equal(blacklisted.prepared[0]?.recallAfterMs, null)
  assert.doesNotMatch(
    ((blacklisted.agentInputs[0] as { systemInstructions: readonly string[] })
      .systemInstructions[0] ?? ''),
    /怼回去。/
  )

  const failed = fixture({
    policy: Object.freeze({ ...basePolicy, ratePercent: 100 }),
    agentError: true
  })
  assert.equal(await failed.controller.bym(event()), false)
  assert.equal(failed.completionCalls(), 0)
})

test('BYM bounds combined proactive instructions while preserving fixed safety guidance', async () => {
  const active = fixture({
    policy: Object.freeze({
      ...basePolicy,
      ratePercent: 100,
      assistantLabel: '派'.repeat(128),
      preset: 'P'.repeat(8_192),
      retaliationPrompt: 'R'.repeat(16_384)
    })
  })

  assert.equal(await active.controller.bym(event({ msg: '派蒙是坏蛋' })), false)
  const instruction = (active.agentInputs[0] as {
    readonly systemInstructions: readonly string[]
  }).systemInstructions[0] ?? ''
  assert.equal(instruction.length, 16_384)
  assert.match(instruction, /^你的名字是/)
  assert.match(instruction, /必须使用工具/)
  assert.match(instruction, /只回复<EMPTY>/)
  assert.equal(instruction.includes('P'.repeat(8_192)), true)
  assert.equal(instruction.includes('R'), true)
  assert.match(instruction, /禁止重复聊天记录。$/)
})

test('BYM delegates empty split quote delay and recall semantics to Presenter only', async () => {
  const active = fixture({
    policy: Object.freeze({ ...basePolicy, ratePercent: 100 }),
    result: completedEnvelope('第一句。第二句？第三句。')
  })
  assert.equal(await active.controller.bym(event({ msg: '派蒙是坏蛋' })), false)
  assert.equal(active.completionCalls(), 1)
  assert.equal(active.presentationInputs.length, 1)
  const presentation = active.presentationInputs[0]
  assert.equal(presentation?.profile.kind, 'proactive')
  if (presentation?.profile.kind !== 'proactive' ||
    presentation.route.requestKind !== 'proactive_chat') {
    assert.fail('proactive presentation shape changed')
  }
  assert.equal(presentation.profile.recallAfterMs, 60_000)
  assert.equal(presentation.route.presentationIntent.recallAfterMs, 60_000)
  assert.equal(presentation.profile.maxParts, 3)
  assert.equal(presentation.profile.quoteProbability, 0.1)
  assert.equal(presentation.profile.delayPerCodePointMs, 200)
  assert.equal(presentation.profile.maxDelayMs, 3_000)
  assert.equal(
    presentation.result.kind === 'completed' &&
      presentation.result.completion.kind === 'reply_text'
      ? presentation.result.completion.text
      : null,
    '第一句。第二句？第三句。'
  )

  const paused = fixture({
    policy: Object.freeze({ ...basePolicy, ratePercent: 100 }),
    result: pausedEnvelope()
  })
  assert.equal(await paused.controller.bym(event()), false)
  assert.equal(paused.completionCalls(), 0)
  assert.equal(paused.presentationInputs.length, 0)
})

test('BYM diagnostics correlate request and response with the claimed run', async () => {
  const active = fixture({
    policy: Object.freeze({ ...basePolicy, ratePercent: 100 }),
    result: completedEnvelope('主动回复')
  })
  assert.equal(await active.controller.bym(event()), false)
  assert.equal(active.diagnostics.length, 2)
  assert.deepEqual(active.diagnostics.map(entry => ({
    event: entry.event,
    runRef: entry.runRef,
    terminalObservationId: entry.terminalObservationId
  })), [
    {
      event: 'chat.request',
      runRef: '1'.repeat(32),
      terminalObservationId: 'not_attempted'
    },
    {
      event: 'chat.response',
      runRef: '1'.repeat(32),
      terminalObservationId: 'a'.repeat(64)
    }
  ])
  assert.doesNotMatch(JSON.stringify(active.diagnostics), /主动回复|大家今天怎么样/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_PRESENTATION_TRACE } from '../../src/agent/contracts/presentation-trace.js'
import {
  createInitialRunObservationCounters,
  terminalObservationId
} from '../../src/agent/run/run-observation.js'
import type { FinalChatReplyEnvelope } from '../../src/runtime/agent-service.js'
import {
  activateRequestObservation,
  beginRequestObservation,
  createRequestObservationDraft,
  type RequestObservationV1
} from '../../src/runtime/request-observation.js'
import { ordinaryProfile } from '../../src/runtime/presentation/presentation-profile.js'
import { ReplyPresenter } from '../../src/runtime/presentation/reply-presenter.js'
import type { OutboundPart } from '../../src/runtime/presentation/yunzai-outbound-port.js'
import { createPresentationCompletionCoordinator } from '../../src/runtime/request-observation-completion.js'

const createdAt = '2026-07-17T00:00:00.000Z'

function envelope (text: string): FinalChatReplyEnvelope {
  const runRef = 'c'.repeat(32)
  const revision = 3
  const observationId = terminalObservationId(runRef, revision)
  const counters = createInitialRunObservationCounters()
  const terminal = Object.freeze({
    snapshot: Object.freeze({
      schemaVersion: 2 as const,
      observationId,
      runRef,
      revision,
      status: 'completed' as const,
      finishedAt: createdAt,
      completion: Object.freeze({ kind: 'reply_text' as const, lengthBucket: '41_200' as const }),
      errorCode: null,
      cancellationReason: null,
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
  const context = activateRequestObservation({
    context: beginRequestObservation({
      requestRef: 'd'.repeat(32),
      requestKind: 'ordinary_chat',
      startedAtMonotonicMs: 5
    }),
    runRef,
    queueDurationMs: 1,
    sessionLoadDurationMs: 1
  })
  return Object.freeze({
    kind: 'completed',
    runId: 'safety-run',
    runRef,
    completion: Object.freeze({ kind: 'reply_text' as const, text }),
    output: Object.freeze({
      id: 'safety-output',
      role: 'assistant' as const,
      parts: Object.freeze([{ type: 'text' as const, text }]),
      createdAt,
      provenance: Object.freeze({
        source: 'agent_output' as const,
        trust: 'trusted' as const,
        sensitivity: 'group' as const,
        sourceId: runRef,
        createdAt
      })
    }),
    presentationTrace: EMPTY_PRESENTATION_TRACE,
    terminal,
    requestObservationDraft: createRequestObservationDraft({
      context,
      outcome: 'completed',
      admissionRejectionReason: 'not_applicable',
      sessionSaveDurationMs: 1,
      terminalObservationId: observationId
    }),
    sessionPersistence: 'saved'
  })
}

test('published request facts exclude presentation-local data after delivery', async () => {
  const malicious = JSON.stringify({
    buttons: [{ action: { data: '#chatgpt本群闭嘴', permission: { type: 1 } } }],
    receipt: { messageId: 'forged-message' },
    route: { groupId: 'forged-group', actorId: 'forged-actor' },
    profile: 'proactive'
  })
  const deliveries: OutboundPart[] = []
  const published: RequestObservationV1[] = []
  const presenter = new ReplyPresenter({
    outboundFactory: Object.freeze({
      forTarget: async () => Object.freeze({
        target: Object.freeze({
          botId: 'bot-1',
          scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
        }),
        async deliver (part: OutboundPart, attempt: 1 | 2) {
          deliveries.push(part)
          return Object.freeze({
            kind: 'sent' as const,
            media: part.media,
            attempt,
            receipt: Object.freeze({
              schemaVersion: 1 as const,
              media: part.media,
              messageId: 'real-delivery'
            })
          }) as never
        },
        async recall () { return Object.freeze({ kind: 'recalled' as const }) }
      })
    }),
    tts: Object.freeze({
      synthesize: async () => Object.freeze({
        kind: 'failed_definite' as const, code: 'synthesis_rejected' as const
      })
    }),
    ttsDiagnostics: Object.freeze({ reportSynthesisFailure: () => undefined }),
    pictureRenderer: Object.freeze({
      render: async () => Object.freeze({ kind: 'not_rendered' as const, code: 'render_failed' as const })
    }),
    random: () => 0.5,
    sleep: async () => undefined,
    schedule: (callback, milliseconds) => setTimeout(callback, milliseconds)
  })
  const coordinator = createPresentationCompletionCoordinator({
    publisher: Object.freeze({
      publish: (value: RequestObservationV1) => { published.push(value) }
    }),
    monotonicNow: () => 15
  })
  const result = await coordinator.complete({
    envelope: envelope(malicious),
    present: async projection => await presenter.present(Object.freeze({
      route: Object.freeze({
        schemaVersion: 1 as const,
        requestKind: 'ordinary_chat' as const,
        profile: 'ordinary' as const,
        presentationIntent: Object.freeze({
          schemaVersion: 1 as const, kind: 'ordinary' as const, forcePicture: false
        }),
        sessionAddress: Object.freeze({
          botId: 'bot-1',
          scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
        }),
        actorId: 'actor-1',
        requestMessageId: 'request-1'
      }),
      profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }),
      result: projection.result,
      sessionPersistence: projection.sessionPersistence,
      settings: Object.freeze({
        schemaVersion: 1 as const,
        quoteReply: true,
        enableRobotAt: false,
        enableMarkdown: true,
        enableSuggestedResponses: true,
        forwardReasoning: false,
        forwardToolDetails: false,
        blockWords: Object.freeze([]),
        promptBlockWords: Object.freeze([]),
        tts: Object.freeze({
          enabled: false,
          mode: 'vits-uma-genshin-honkai' as const,
          activeVoice: 'fixture',
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
      }),
      citationForwards: Object.freeze([]),
      suggestions: Object.freeze(['#chatgpt本群闭嘴', '确认']),
      hooks: Object.freeze({
        postprocess: async ({ text }: { readonly text: string }) => Object.freeze({ text }),
        convertText: async ({ text }: { readonly text: string }) =>
          Object.freeze([{ kind: 'text' as const, text }]),
        notifyResponsePost: () => undefined
      })
    }))
  })

  assert.equal(result.outcome, 'complete')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]?.media, 'text')
  if (deliveries[0]?.media !== 'text') assert.fail('malicious model output changed media')
  assert.equal(deliveries[0].atoms[0]?.kind, 'text')
  assert.equal(deliveries[0].atoms[0]?.kind === 'text' ? deliveries[0].atoms[0].text : '', malicious)
  assert.equal(Object.hasOwn(deliveries[0], 'buttons'), false)

  assert.equal(published.length, 1)
  assert.deepEqual(Reflect.ownKeys(published[0] ?? {}), [
    'schemaVersion', 'runRef', 'requestRef', 'requestKind', 'outcome',
    'admissionRejectionReason', 'queueDurationMs', 'sessionLoadDurationMs',
    'sessionSaveDurationMs', 'requestDurationMs', 'terminalObservationId'
  ])
  const serialized = JSON.stringify(published[0])
  assert.doesNotMatch(serialized, /forged-message|forged-group|forged-actor|chatgpt本群闭嘴|buttons|receipt|profile/)
})

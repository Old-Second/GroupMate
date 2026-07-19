import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import { ContextEngine } from '../../src/agent/context/context-engine.js'
import { NoopMemoryStore } from '../../src/agent/context/noop-memory-store.js'
import type { RunEngine } from '../../src/agent/run/run-engine.js'
import type { FrozenObservationPolicyV1 } from '../../src/agent/run/run-observation.js'
import { AgentService } from '../../src/runtime/agent-service.js'
import { ordinaryProfile } from '../../src/runtime/presentation/presentation-profile.js'
import type {
  PendingIndicatorHandle,
  PendingIndicatorPresenter
} from '../../src/runtime/presentation/pending-indicator-presenter.js'
import type {
  YunzaiOutboundPort,
  YunzaiOutboundPortFactory
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import { createRunPresentationLifecycle } from '../../src/runtime/run-presentation-lifecycle.js'
import type { RunProgressPresenter } from '../../src/runtime/run-progress-presenter.js'
import type { YunzaiAgentRequestDraft } from '../../src/runtime/yunzai-request-adapter.js'

test('run lifecycle waits for AgentService runRef claim and settles exactly once', async () => {
  const route = Object.freeze({
    schemaVersion: 1 as const,
    requestKind: 'ordinary_chat' as const,
    profile: 'ordinary' as const,
    presentationIntent: Object.freeze({
      schemaVersion: 1 as const, kind: 'ordinary' as const, forcePicture: false
    }),
    sessionAddress: Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
    }),
    actorId: 'actor-1',
    requestMessageId: 'message-1'
  })
  const calls: string[] = []
  const target = route.sessionAddress as SessionAddress
  const outbound = { target } as YunzaiOutboundPort
  const outboundFactory: YunzaiOutboundPortFactory = {
    forTarget: async value => {
      calls.push(`target:${value.scope.kind}`)
      return outbound
    }
  }
  const handle: PendingIndicatorHandle = {
    runRef: '1'.repeat(32),
    dismiss: async reason => { calls.push(`dismiss:${reason}`) }
  }
  const pending = {
    show: async () => {
      calls.push('pending')
      return handle
    }
  } as unknown as PendingIndicatorPresenter
  const progress = {
    attach: (input: { runRef: string; observationPolicy: FrozenObservationPolicyV1 }) => {
      calls.push(`attach:${input.runRef}:${JSON.stringify(input.observationPolicy)}`)
    },
    drain: async () => { calls.push('drain') },
    detach: () => { calls.push('detach') }
  } as unknown as RunProgressPresenter
  const policy = Object.freeze({
    schemaVersion: 1 as const, levelAtStart: 'diagnostic' as const, sampledSuccess: false
  })
  const lifecycle = createRunPresentationLifecycle({
    route,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }),
    pendingEnabled: true,
    outboundFactory,
    pending,
    progress
  })

  assert.deepEqual(calls, [])
  await lifecycle.onRunStarted({
    runId: 'run-1', runRef: '1'.repeat(32), observationPolicy: policy
  })
  await Promise.all([
    lifecycle.onRunSettled({ runId: 'run-1', status: 'paused' }),
    lifecycle.onRunSettled({ runId: 'run-1', status: 'terminal' })
  ])
  assert.deepEqual(calls, [
    'target:group', 'pending',
    `attach:${'1'.repeat(32)}:${JSON.stringify(policy)}`,
    'dismiss:paused', 'drain', 'detach'
  ])
})

test('run lifecycle isolates cleanup failures and still drains and detaches once', async () => {
  const target: SessionAddress = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'private', userId: 'actor-1' })
  })
  const calls: string[] = []
  const lifecycle = createRunPresentationLifecycle({
    route: Object.freeze({
      schemaVersion: 1 as const,
      requestKind: 'ordinary_chat' as const,
      profile: 'ordinary' as const,
      presentationIntent: Object.freeze({
        schemaVersion: 1 as const, kind: 'ordinary' as const, forcePicture: false
      }),
      sessionAddress: target,
      actorId: 'actor-1'
    }),
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false }),
    pendingEnabled: true,
    outboundFactory: {
      forTarget: async () => ({ target }) as YunzaiOutboundPort
    },
    pending: {
      show: async () => ({
        runRef: '1'.repeat(32),
        dismiss: async () => {
          calls.push('dismiss')
          throw new Error('dismiss failed')
        }
      })
    } as unknown as PendingIndicatorPresenter,
    progress: {
      attach: () => { calls.push('attach') },
      drain: async () => {
        calls.push('drain')
        throw new Error('drain failed')
      },
      detach: () => {
        calls.push('detach')
        throw new Error('detach failed')
      }
    } as unknown as RunProgressPresenter
  })
  await lifecycle.onRunStarted({
    runId: 'run-1', runRef: '1'.repeat(32),
    observationPolicy: Object.freeze({
      schemaVersion: 1, levelAtStart: 'basic', sampledSuccess: false
    })
  })

  await assert.doesNotReject(async () => await Promise.all([
    lifecycle.onRunSettled({ runId: 'run-1', status: 'paused' }),
    lifecycle.onRunSettled({ runId: 'run-1', status: 'terminal' }),
    lifecycle.onRunSettled({ runId: 'run-1', status: 'terminal' })
  ]))
  assert.deepEqual(calls, ['attach', 'dismiss', 'drain', 'detach'])
})

test('AgentService callback lifecycle detaches once when progress drain rejects', async () => {
  const createdAt = '2026-07-17T00:00:00.000Z'
  const sessionAddress = Object.freeze({
    botId: 'bot-1',
    scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const message = Object.freeze({
    id: 'message-1',
    role: 'user' as const,
    parts: Object.freeze([{ type: 'text' as const, text: '兼容生命周期清理测试' }]),
    createdAt,
    provenance: Object.freeze({
      source: 'qq_message' as const,
      trust: 'untrusted' as const,
      sensitivity: 'group' as const,
      sourceId: 'message-1',
      createdAt
    })
  })
  const request: YunzaiAgentRequestDraft = Object.freeze({
    requestId: 'request-1',
    requestRef: '2'.repeat(32),
    requestKind: 'proactive_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'proactive_chat',
      profile: 'proactive',
      presentationIntent: Object.freeze({
        schemaVersion: 1, kind: 'proactive', recallAfterMs: null
      }),
      sessionAddress,
      actorId: 'actor-1',
      requestMessageId: message.id
    }),
    createdAt,
    deadlineAt: '2026-07-17T00:04:00.000Z',
    sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'member' }),
    channel: Object.freeze({
      kind: 'group', botId: 'bot-1', groupId: 'group-1'
    }),
    message,
    references: Object.freeze({ currentMessageId: message.id, quotedMessageId: null }),
    systemInstructions: Object.freeze(['You are GroupMate.']),
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    contextBudget: Object.freeze({
      modelContextTokens: 8_192,
      reservedOutputTokens: 256,
      reservedToolTokens: 512,
      safetyMarginTokens: 128,
      maxItems: 64,
      maxBytes: 256 * 1_024
    })
  })
  const calls: string[] = []
  let releases = 0
  const progress = {
    handle: () => undefined,
    attach: () => { calls.push('attach') },
    drain: async () => {
      calls.push('drain')
      throw new Error('private drain failure')
    },
    detach: () => { calls.push('detach') }
  } as unknown as RunProgressPresenter
  const engine = {
    start: async (
      input: Parameters<RunEngine['start']>[0],
      options: Parameters<RunEngine['start']>[1]
    ): Promise<never> => {
      await options?.afterCheckpointCreated?.(Object.freeze({
        runId: input.runId,
        runRef: input.runRef,
        observationPolicy: input.observationPolicy
      }))
      throw new Error('injected engine failure after checkpoint claim')
    }
  } as unknown as RunEngine
  const service = new AgentService({
    sessions: {} as never,
    runStore: {} as never,
    admission: {
      acquire: async () => Object.freeze({
        release: async () => { releases += 1 }
      }),
      recover: async () => { throw new Error('not used') }
    } as never,
    contextEngine: new ContextEngine({
      estimator: {
        estimate: () => 1,
        estimateModelMessage: () => 1
      },
      memoryStore: new NoopMemoryStore()
    }),
    progressPresenter: progress,
    createEngine: () => engine,
    createRuntime: async () => Object.freeze({
      binding: Object.freeze({
        snapshot: Object.freeze({}),
        prepareToolContext: async () => { throw new Error('not used') },
        contextFor: async () => { throw new Error('not used') }
      }) as never,
      progress: async () => undefined
    }),
    now: () => new Date(createdAt),
    generateId: () => 'run-1',
    createRunRef: () => '1'.repeat(32),
    monotonicNow: () => 0
  })

  const result = await service.handleEphemeral(request)

  assert.equal(result.kind, 'failed')
  assert.deepEqual(calls, ['attach', 'drain', 'detach'])
  assert.equal(releases, 1)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type { ChatReplyEnvelope } from '../../src/runtime/agent-service.js'
import type { PresentationResult } from '../../src/runtime/presentation/presentation-result.js'
import type {
  YunzaiOutboundPort,
  YunzaiOutboundPortFactory
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import type {
  ActivePresentationContext,
  ApprovalReference,
  ApprovalReplyProjection,
  ApprovalRouteOutcome,
  ApprovalRouteResultHandler
} from '../../src/runtime/run-approval-router.js'
import {
  APPROVAL_RECOVERY_DEFERRED_MESSAGE
} from '../../src/runtime/run-approval-router.js'
import {
  createApprovalControlPresenter,
  createYunzaiApprovalController
} from '../../src/runtime/yunzai-approval-controller.js'

const approvalAddress: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group', groupId: 'approval-group' })
})
const originalAddress: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group', groupId: 'original-group' })
})
const reference: ApprovalReference = Object.freeze({
  schemaVersion: 1,
  approvalAddress,
  messageId: 'approval-message',
  runId: 'run-1',
  approvalId: 'approval-1'
})
const context: ActivePresentationContext = Object.freeze({
  runRef: '1'.repeat(32),
  requestRef: '2'.repeat(32),
  route: Object.freeze({
    schemaVersion: 1,
    requestKind: 'ordinary_chat',
    profile: 'ordinary',
    presentationIntent: Object.freeze({
      schemaVersion: 1,
      kind: 'ordinary',
      forcePicture: true
    }),
    sessionAddress: originalAddress,
    actorId: 'requester',
    requestMessageId: 'original-message'
  })
})

const projection: ApprovalReplyProjection = Object.freeze({
  text: '确认',
  quotedMessageId: 'approval-message',
  sessionAddress: approvalAddress,
  actor: Object.freeze({ userId: 'approver', role: 'group_owner' }),
  occurredAt: '2026-07-17T00:00:00.000Z'
})

function finalEnvelope (): ChatReplyEnvelope {
  return Object.freeze({
    kind: 'completed',
    runId: 'run-1',
    runRef: context.runRef,
    completion: Object.freeze({ kind: 'already_visible', source: 'tool_output' }),
    output: null,
    terminal: null,
    requestObservationDraft: Object.freeze({}),
    sessionPersistence: 'not_attempted'
  }) as unknown as ChatReplyEnvelope
}

const deferred: ApprovalRouteOutcome = Object.freeze({
  kind: 'approval_deferred',
  reason: 'queue_full',
  retryable: true,
  runRef: context.runRef,
  requestRef: context.requestRef
})

const presentationResult: PresentationResult = Object.freeze({
  schemaVersion: 1,
  outcome: 'unknown',
  deliveries: Object.freeze([])
})

function scriptedRouter (results: readonly ApprovalRouteOutcome[]) {
  let call = 0
  const projections: ApprovalReplyProjection[] = []
  return {
    projections,
    route: async (
      reply: ApprovalReplyProjection,
      onResult?: ApprovalRouteResultHandler
    ): Promise<boolean> => {
      projections.push(reply)
      const result = results[call++]
      if (result === undefined) return false
      await onResult?.(result, reference, context)
      return true
    }
  }
}

test('approval controller presents through original route without retaining decision event', async () => {
  const router = scriptedRouter([finalEnvelope()])
  const terminalInputs: unknown[] = []
  let completionCalls = 0
  let replyCalls = 0
  const decisionEvent = {
    msg: '确认',
    reply: async () => { replyCalls += 1 },
    marker: 'decision-event'
  }
  const controller = createYunzaiApprovalController({
    projector: {
      project: async currentEvent => {
        assert.equal(currentEvent, decisionEvent)
        return projection
      }
    },
    router,
    controlPresenter: {
      presentRecoveryDeferred: async () => Object.freeze([])
    },
    pausedHandler: {
      handle: async () => undefined
    },
    terminalPresenter: {
      present: async input => {
        terminalInputs.push(input)
        assert.deepEqual(Reflect.ownKeys(input), ['route', 'projection'])
        assert.equal(Object.values(input).some(value => value === (decisionEvent as unknown)), false)
        return presentationResult
      }
    },
    completionCoordinator: {
      complete: async ({ envelope, present }) => {
        completionCalls += 1
        return await present(Object.freeze({
          result: envelope as never,
          sessionPersistence: envelope.sessionPersistence
        }))
      }
    }
  })

  assert.equal(await controller.confirmToolOperation(decisionEvent), true)
  assert.equal(completionCalls, 1)
  assert.equal(replyCalls, 0)
  assert.equal(terminalInputs.length, 1)
  const terminal = terminalInputs[0] as {
    readonly route: ActivePresentationContext['route']
  }
  assert.equal(terminal.route, context.route)
  assert.equal(terminal.route.sessionAddress, originalAddress)
  assert.equal(router.projections[0]?.sessionAddress, approvalAddress)

  assert.equal(await controller.confirmToolOperation({ msg: ' 确认 ' }), false)
  assert.equal(await createYunzaiApprovalController({
    projector: { project: async () => null },
    router,
    controlPresenter: { presentRecoveryDeferred: async () => Object.freeze([]) },
    pausedHandler: { handle: async () => undefined },
    terminalPresenter: { present: async () => presentationResult },
    completionCoordinator: {
      complete: async () => { throw new Error('must not complete') }
    }
  }).confirmToolOperation({ msg: '拒绝' }), false)
})

test('approval controller reports deferred recovery on approval address and retry consumes once', async () => {
  const delivered: Array<{
    readonly target: SessionAddress
    readonly part: unknown
    readonly attempt: number
    readonly options: unknown
  }> = []
  const outbound: YunzaiOutboundPort = {
    target: approvalAddress,
    deliver: async (part, attempt, options) => {
      delivered.push({ target: approvalAddress, part, attempt, options })
      return attempt === 1
        ? Object.freeze({
            kind: 'failed_definite', media: part.media, attempt, code: 'host_rejected'
          }) as never
        : Object.freeze({
            kind: 'sent', media: part.media, attempt,
            receipt: Object.freeze({ schemaVersion: 1, media: part.media })
          }) as never
    },
    recall: async () => Object.freeze({ kind: 'failed_definite', code: 'host_rejected' })
  }
  const factory: YunzaiOutboundPortFactory = Object.freeze({
    forTarget: async (target: SessionAddress) => {
      assert.equal(target, approvalAddress)
      return outbound
    }
  })
  const controlPresenter = createApprovalControlPresenter({ outboundFactory: factory })
  const router = scriptedRouter([deferred, finalEnvelope()])
  let completionCalls = 0
  let terminalCalls = 0
  let pausedCalls = 0
  const controller = createYunzaiApprovalController({
    projector: { project: async () => projection },
    router,
    controlPresenter,
    pausedHandler: {
      handle: async () => { pausedCalls += 1 }
    },
    terminalPresenter: {
      present: async ({ route }) => {
        terminalCalls += 1
        assert.equal(route, context.route)
        return presentationResult
      }
    },
    completionCoordinator: {
      complete: async ({ envelope, present }) => {
        completionCalls += 1
        return await present(Object.freeze({
          result: envelope as never,
          sessionPersistence: envelope.sessionPersistence
        }))
      }
    }
  })

  assert.equal(await controller.confirmToolOperation({ msg: '确认' }), true)
  assert.equal(completionCalls, 0)
  assert.equal(terminalCalls, 0)
  assert.equal(pausedCalls, 0)
  assert.equal(delivered.length, 2)
  assert.deepEqual(delivered.map(item => item.attempt), [1, 2])
  assert.deepEqual(delivered[0]?.part, {
    media: 'text',
    atoms: [{ kind: 'text', text: APPROVAL_RECOVERY_DEFERRED_MESSAGE }]
  })
  assert.equal(delivered[0]?.options, undefined)

  assert.equal(await controller.confirmToolOperation({ msg: '确认' }), true)
  assert.equal(completionCalls, 1)
  assert.equal(terminalCalls, 1)
  assert.equal(delivered.length, 2)
})

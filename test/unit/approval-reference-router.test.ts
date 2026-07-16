import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type { RunAdvanceResult } from '../../src/agent/contracts/result.js'
import type { ApprovalInterruption } from '../../src/agent/run/interruption.js'
import {
  RedisApprovalReferenceIndex,
  RunApprovalRouter,
  projectYunzaiApprovalReply,
  redisApprovalReferenceKey,
  type ApprovalDecisionInput,
  type ApprovalDisplayInput,
  type ApprovalReference,
  type ApprovalReferenceIndex,
  type RunApprovalControl
} from '../../src/runtime/run-approval-router.js'
import { AgentError } from '../../src/agent/contracts/error.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const groupAddress: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})
const now = '2026-07-14T00:00:10.000Z'

function pending (): ApprovalInterruption {
  return Object.freeze({
    schemaVersion: 1,
    approvalId: 'approval-1',
    runId: 'run-1',
    step: 0,
    callId: 'call-1',
    toolFingerprint: 'a'.repeat(64),
    argumentHash: 'b'.repeat(64),
    action: 'sendMessage',
    target: 'group:group-2',
    keyParameters: Object.freeze(['text=<12 chars>']),
    requester: Object.freeze({ userId: 'actor-1', role: 'group_owner' }),
    approverPolicy: Object.freeze({
      profile: 'safe',
      allowedRoles: Object.freeze(['bot_master', 'group_owner', 'group_admin'] as const),
      eligibleActorIds: Object.freeze(['actor-1']),
      requireDifferentActor: false
    }),
    approvalAddress: groupAddress,
    createdAt: '2026-07-14T00:00:00.000Z'
  })
}

class MemoryReferenceIndex implements ApprovalReferenceIndex {
  readonly values = new Map<string, ApprovalReference>()

  async create (reference: ApprovalReference, _ttlSeconds: number): Promise<boolean> {
    const key = `${JSON.stringify(reference.approvalAddress)}:${reference.messageId}`
    if (this.values.has(key)) return false
    this.values.set(key, reference)
    return true
  }

  async load (address: SessionAddress, messageId: string): Promise<ApprovalReference | null> {
    return this.values.get(`${JSON.stringify(address)}:${messageId}`) ?? null
  }

  async delete (reference: ApprovalReference): Promise<void> {
    const key = `${JSON.stringify(reference.approvalAddress)}:${reference.messageId}`
    if (this.values.get(key)?.approvalId === reference.approvalId) this.values.delete(key)
  }
}

class FakeApprovalControl implements RunApprovalControl {
  current: ApprovalInterruption | null = pending()
  readonly decisions: ApprovalDecisionInput[] = []

  async pendingApproval (runId: string, approvalId: string): Promise<ApprovalInterruption | null> {
    return this.current?.runId === runId && this.current.approvalId === approvalId
      ? this.current
      : null
  }

  async displayApproval (input: ApprovalDisplayInput): Promise<ApprovalInterruption | null> {
    if (this.current === null || input.approvalId !== this.current.approvalId) return null
    this.current = Object.freeze({
      ...this.current,
      approvalMessageId: input.messageId,
      displayedAt: input.displayedAt,
      expiresAt: new Date(
        new Date(input.displayedAt).getTime() + input.ttlSeconds * 1_000
      ).toISOString()
    })
    return this.current
  }

  async decideApproval (input: ApprovalDecisionInput): Promise<RunAdvanceResult | null> {
    if (this.current === null || input.approvalId !== this.current.approvalId ||
      JSON.stringify(input.sessionAddress) !== JSON.stringify(this.current.approvalAddress)) {
      return null
    }
    const actor = input.actor
    if (input.kind !== 'expired' && (actor === undefined ||
      !this.current.approverPolicy.eligibleActorIds.includes(actor.userId) ||
      !this.current.approverPolicy.allowedRoles.includes(actor.role))) return null
    this.decisions.push(input)
    this.current = null
    return Object.freeze({
      kind: 'completed',
      runId: input.runId,
      runRef: '1'.repeat(32),
      completion: Object.freeze({ kind: 'already_visible', source: 'tool_output' }),
      output: null
    })
  }
}

function reply (overrides: Partial<{
  text: string
  quotedMessageId: string | null
  sessionAddress: SessionAddress
  actorId: string
  actorRole: 'bot_master' | 'group_owner' | 'group_admin' | 'member'
  occurredAt: string
}> = {}) {
  return Object.freeze({
    text: overrides.text ?? '确认',
    quotedMessageId: overrides.quotedMessageId === undefined
      ? 'approval-message-1'
      : overrides.quotedMessageId,
    sessionAddress: overrides.sessionAddress ?? groupAddress,
    actor: Object.freeze({
      userId: overrides.actorId ?? 'actor-1',
      role: overrides.actorRole ?? 'group_owner'
    }),
    occurredAt: overrides.occurredAt ?? now
  })
}

test('reference approval requires an exact quote before deciding', async () => {
  const control = new FakeApprovalControl()
  const index = new MemoryReferenceIndex()
  const router = new RunApprovalRouter({ control, index })
  assert.notEqual(await router.registerDisplayed({
    runId: 'run-1', approvalId: 'approval-1', messageId: 'approval-message-1',
    displayedAt: now, ttlSeconds: 120
  }), null)

  assert.equal(await router.route(reply({ quotedMessageId: null })), false)
  assert.equal(await router.route(reply({ quotedMessageId: 'other' })), false)
  assert.equal(await router.route(reply({ text: '确认一下' })), false)
  assert.equal(control.decisions.length, 0)
  assert.equal(await router.route(reply()), true)
  assert.equal(control.decisions[0]?.kind, 'approved')
})

test('Yunzai approval projection requires an exact quoted decision', async () => {
  const receivedAt = '2026-07-14T00:00:10.987Z'
  const event = {
    msg: '确认', time: Math.floor(Date.parse(now) / 1_000),
    isGroup: true, group_id: 'group-1', user_id: 'actor-1',
    sender: { user_id: 'actor-1', role: 'owner' },
    source: { message_id: 'approval-message-1' },
    message: [{ type: 'text', text: '确认' }]
  }
  const projected = await projectYunzaiApprovalReply(event, {
    botId: 'bot-1', masterIds: [], now: () => new Date(receivedAt)
  })

  assert.equal(projected?.quotedMessageId, 'approval-message-1')
  assert.equal(projected?.actor.role, 'group_owner')
  assert.deepEqual(projected?.sessionAddress, groupAddress)
  assert.equal(projected?.occurredAt, receivedAt)
  assert.equal(await projectYunzaiApprovalReply({ ...event, msg: '确认一下' }, {
    botId: 'bot-1', masterIds: []
  }), null)
  assert.equal(await projectYunzaiApprovalReply({ ...event, source: undefined }, {
    botId: 'bot-1', masterIds: []
  }), null)
})

test('reference approval rejects wrong bot, session and actor projections', async () => {
  const control = new FakeApprovalControl()
  const index = new MemoryReferenceIndex()
  const router = new RunApprovalRouter({ control, index })
  await router.registerDisplayed({
    runId: 'run-1', approvalId: 'approval-1', messageId: 'approval-message-1',
    displayedAt: now, ttlSeconds: 120
  })

  assert.equal(await router.route(reply({
    sessionAddress: Object.freeze({
      botId: 'bot-2', scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
    })
  })), false)
  assert.equal(await router.route(reply({
    sessionAddress: Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'group-2' })
    })
  })), false)
  assert.equal(await router.route(reply({ actorId: 'actor-2' })), false)
  assert.equal(control.decisions.length, 0)
})

test('reference approval records rejection and turns a late reply into expiry', async () => {
  const rejection = new FakeApprovalControl()
  const rejectionRouter = new RunApprovalRouter({
    control: rejection,
    index: new MemoryReferenceIndex()
  })
  await rejectionRouter.registerDisplayed({
    runId: 'run-1', approvalId: 'approval-1', messageId: 'approval-message-1',
    displayedAt: now, ttlSeconds: 120
  })
  assert.equal(await rejectionRouter.route(reply({ text: '拒绝' })), true)
  assert.equal(rejection.decisions[0]?.kind, 'rejected')

  const expiry = new FakeApprovalControl()
  const expiryRouter = new RunApprovalRouter({
    control: expiry,
    index: new MemoryReferenceIndex()
  })
  await expiryRouter.registerDisplayed({
    runId: 'run-1', approvalId: 'approval-1', messageId: 'approval-message-1',
    displayedAt: now, ttlSeconds: 30
  })
  assert.equal(await expiryRouter.route(reply({
    occurredAt: '2026-07-14T00:00:41.000Z'
  })), true)
  assert.equal(expiry.decisions[0]?.kind, 'expired')
})

test('duplicate and concurrent approval replies have exactly one decision winner', async () => {
  const control = new FakeApprovalControl()
  const index = new MemoryReferenceIndex()
  const router = new RunApprovalRouter({ control, index })
  await router.registerDisplayed({
    runId: 'run-1', approvalId: 'approval-1', messageId: 'approval-message-1',
    displayedAt: now, ttlSeconds: 120
  })

  const results = await Promise.all([router.route(reply()), router.route(reply())])
  assert.deepEqual(results.sort(), [false, true])
  assert.equal(control.decisions.length, 1)
  assert.equal(await router.route(reply()), false)
})

test('Redis approval references use hashed bounded keys and the shared atomic budget', async () => {
  const redis = new FakeRedis(() => Date.parse(now))
  const index = new RedisApprovalReferenceIndex(redis)
  const reference = (position: number): ApprovalReference => Object.freeze({
    schemaVersion: 1,
    approvalAddress: Object.freeze({
      botId: 'bot-private-value',
      scope: Object.freeze({ kind: 'group', groupId: 'group-private-value' })
    }),
    messageId: `message-private-${position}`,
    runId: `run-${position}`,
    approvalId: `approval-${position}`
  })

  assert.doesNotMatch(
    redisApprovalReferenceKey(reference(0).approvalAddress, reference(0).messageId),
    /bot-private-value|message-private/
  )
  assert.equal(await index.create(reference(0), 600), true)
  assert.deepEqual(await index.load(reference(0).approvalAddress, reference(0).messageId), reference(0))
  await index.delete(reference(0))
  assert.equal(await index.load(reference(0).approvalAddress, reference(0).messageId), null)

  for (let position = 0; position < 64; position += 1) {
    assert.equal(await index.create(reference(position), 600), true)
  }
  await assert.rejects(index.create(reference(64), 600), error => (
    error instanceof AgentError && error.code === 'run_budget_exceeded'
  ))
  assert.equal(redis.evalCalls.some(call => call.operation === 'approval_index_create'), true)
  assert.equal(redis.evalCalls.some(call => call.operation === 'approval_index_delete'), true)
})

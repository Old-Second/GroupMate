import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type {
  ModelAdapter,
  ModelRequest,
  ModelTurn
} from '../../src/agent/model/model-adapter.js'
import { standardOpenAIProfile } from '../../src/agent/model/standard-openai-profile.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  RunEngine,
  type ApprovalControlContext,
  type RunRuntimeBinding,
  type StartRunInput
} from '../../src/agent/run/run-engine.js'
import { ToolScheduler } from '../../src/agent/run/tool-scheduler.js'
import {
  isApprovalActorEligible,
  parseApprovalInterruption,
  parseApprovalReplyText,
  type ApprovalActorReference,
  type ApprovalInterruption
} from '../../src/agent/run/interruption.js'
import type { ToolCall } from '../../src/agent/tools/tool-call.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext,
  ToolRuntimeFacts
} from '../../src/agent/tools/tool-context.js'
import type { ToolDefinition } from '../../src/agent/tools/tool-definition.js'
import type { ToolPolicyProfile } from '../../src/agent/tools/policy-engine.js'
import {
  completedPreparedCall,
  type PreparedToolCall,
  type SerializablePreparedCapability
} from '../../src/agent/tools/prepared-capability.js'
import { ToolRegistry, type ToolSnapshot } from '../../src/agent/tools/tool-registry.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import type { ToolRuntime } from '../../src/agent/tools/tool-runtime.js'
import { InMemoryRunStore } from '../helpers/in-memory-run-store.js'

const createdAt = '2026-07-14T00:00:00.000Z'

function interruption (
  profile: ApprovalInterruption['approverPolicy']['profile'] = 'safe'
): ApprovalInterruption {
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
      profile,
      allowedRoles: Object.freeze(['bot_master', 'group_owner', 'group_admin'] as const),
      eligibleActorIds: Object.freeze(['actor-1', 'actor-2']),
      requireDifferentActor: profile === 'strict'
    }),
    approvalAddress: Object.freeze({
      botId: 'bot-1',
      scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
    }),
    createdAt
  })
}

test('approval reply text accepts only trimmed NFC exact decisions', () => {
  assert.equal(parseApprovalReplyText('确认'), 'approved')
  assert.equal(parseApprovalReplyText('  拒绝\n'), 'rejected')
  assert.equal(parseApprovalReplyText('确\u{8ba4}'), 'approved')
  assert.equal(parseApprovalReplyText('确认一下'), null)
  assert.equal(parseApprovalReplyText('#确认'), null)
  assert.equal(parseApprovalReplyText(''), null)
})

test('safe allows an eligible requester while strict requires another eligible actor', () => {
  const safe = interruption('safe')
  assert.equal(isApprovalActorEligible(safe, safe.requester), true)
  assert.equal(isApprovalActorEligible(safe, {
    userId: 'actor-2', role: 'group_admin'
  }), true)
  assert.equal(isApprovalActorEligible(safe, {
    userId: 'actor-3', role: 'group_admin'
  }), false)

  const strict = interruption('strict')
  assert.equal(isApprovalActorEligible(strict, strict.requester), false)
  assert.equal(isApprovalActorEligible(strict, {
    userId: 'actor-2', role: 'group_admin'
  }), true)
})

test('approval interruption round-trips its bounded control address and eligibility', () => {
  const parsed = parseApprovalInterruption(interruption())
  assert.deepEqual(parsed.approvalAddress, {
    botId: 'bot-1', scope: { kind: 'group', groupId: 'group-1' }
  })
  assert.deepEqual(parsed.approverPolicy.eligibleActorIds, ['actor-1', 'actor-2'])
  assert.throws(() => parseApprovalInterruption({
    ...interruption(),
    approverPolicy: {
      ...interruption().approverPolicy,
      eligibleActorIds: ['actor-1', 'actor-1']
    }
  }), /eligible actor/i)
})

const deadlineAt = '2026-07-14T00:04:00.000Z'
const groupAddress: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})
const approvalSchema = Object.freeze({
  type: 'object' as const,
  properties: Object.freeze({ value: Object.freeze({ type: 'string' as const }) }),
  required: Object.freeze(['value']),
  additionalProperties: false as const
})

function successResult (text: string): ToolResult {
  return Object.freeze({
    status: 'success', effect: 'background',
    content: Object.freeze([{ type: 'text' as const, text }]),
    retryable: false
  })
}

function deniedResult (text: string): ToolResult {
  return Object.freeze({
    status: 'denied', effect: 'none', reasonCode: 'permission_denied',
    userMessage: text, retryable: false
  })
}

function riskyDefinition (name: string): ToolDefinition {
  return Object.freeze({
    name, version: 1, aliases: Object.freeze([]), description: `${name} fixture`,
    inputSchema: approvalSchema, effect: 'side_effect', risk: 'high',
    readOnly: false, destructive: false, idempotency: 'call', openWorld: false,
    timeoutMs: 1_000, maxOutputBytes: 4_096, network: 'none',
    permission: 'current_channel', executionClass: 'side_effect', retrySafe: false,
    resourceKeys: () => Object.freeze(['group:group-2']),
    resolveTarget: () => Object.freeze({ kind: 'group' as const, groupId: 'group-2' }),
    execute: async () => successResult(name)
  })
}

const riskyDefinitions = Object.freeze([
  riskyDefinition('riskyOne'),
  riskyDefinition('riskyTwo')
])

interface ApprovalHarnessState {
  policyProfile: ToolPolicyProfile
  botId: string
  actorId: string
  actorGroupRole: ToolRuntimeFacts['actorGroupRole']
  targetGroupId: string
  denyOnPrepare: boolean
  eligibleApprovers: ApprovalActorReference[]
}

function stateFacts (
  state: ApprovalHarnessState,
  address: SessionAddress
): ToolRuntimeFacts {
  const channel = address.scope.kind === 'private'
    ? Object.freeze({
        kind: 'private' as const,
        botId: state.botId,
        userId: address.scope.userId
      })
    : Object.freeze({
        kind: 'group' as const,
        botId: state.botId,
        groupId: address.scope.groupId
      })
  return Object.freeze({
    botId: state.botId,
    actor: Object.freeze({
      userId: state.actorId,
      role: state.actorGroupRole === 'owner'
        ? 'owner' as const
        : state.actorGroupRole === 'admin' ? 'admin' as const : 'member' as const,
      isBotMaster: false
    }),
    channel,
    scope: address.scope,
    botGroupRole: 'owner',
    actorGroupRole: state.actorGroupRole,
    targetRole: 'member',
    targetIsBotMaster: false,
    targetExists: true
  })
}

class ApprovalToolRuntime implements ToolRuntime {
  readonly state: ApprovalHarnessState
  readonly executions: string[] = []

  constructor (state: ApprovalHarnessState) {
    this.state = state
  }

  async prepare (
    call: ToolCall,
    _context: ToolPreparationContext,
    _snapshot: ToolSnapshot
  ): Promise<PreparedToolCall> {
    if (this.state.denyOnPrepare) {
      return completedPreparedCall(
        call.callId,
        call.requestedName,
        deniedResult('机器人权限已变化。')
      )
    }
    const capability: SerializablePreparedCapability = Object.freeze({
      schemaVersion: 1,
      callId: call.callId,
      toolName: call.requestedName,
      toolVersion: 1,
      snapshotId: call.snapshotId,
      canonicalArguments: call.arguments as SerializablePreparedCapability['canonicalArguments'],
      argumentHash: `hash-${call.callId}`,
      target: Object.freeze({ kind: 'group', groupId: this.state.targetGroupId }),
      resourceKeys: Object.freeze([`group:${this.state.targetGroupId}`]),
      executionClass: 'side_effect',
      retrySafe: false
    })
    return Object.freeze({
      kind: 'approval_required', capability, summaryCode: `${call.requestedName}_approval`
    })
  }

  async executePrepared (
    prepared: SerializablePreparedCapability,
    context: ToolExecutionContext,
    _snapshot: ToolSnapshot,
    _signal: AbortSignal
  ): Promise<ToolResult> {
    if (context.approval?.kind !== 'approved') {
      return deniedResult('审批状态缺失。')
    }
    this.executions.push(prepared.callId)
    return successResult(`done:${prepared.callId}`)
  }
}

class ApprovalAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  readonly #turns: ModelTurn[]

  constructor (calls: number) {
    this.#turns = [
      Object.freeze({
        text: '',
        toolCalls: Object.freeze(Array.from({ length: calls }, (_, index) => Object.freeze({
          index,
          callId: `call-${index + 1}`,
          name: riskyDefinitions[index]?.name ?? 'riskyOne',
          argumentsText: JSON.stringify({ value: `value-${index + 1}` }),
          arguments: Object.freeze({ value: `value-${index + 1}` })
        }))),
        finishReason: 'tool_calls' as const
      }),
      Object.freeze({
        text: '任务结果已确认。',
        toolCalls: Object.freeze([]),
        finishReason: 'stop' as const
      })
    ]
  }

  async complete (request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request)
    const turn = this.#turns.shift()
    if (turn === undefined) throw new Error('approval adapter script exhausted')
    return turn
  }
}

function approvalHarness (options: {
  profile?: ToolPolicyProfile
  calls?: number
  address?: SessionAddress
  actorId?: string
  actorGroupRole?: ToolRuntimeFacts['actorGroupRole']
  eligibleApprovers?: ApprovalActorReference[]
} = {}) {
  const address = options.address ?? groupAddress
  const state: ApprovalHarnessState = {
    policyProfile: options.profile ?? 'safe',
    botId: address.botId,
    actorId: options.actorId ?? 'actor-1',
    actorGroupRole: options.actorGroupRole ?? 'owner',
    targetGroupId: 'group-2',
    denyOnPrepare: false,
    eligibleApprovers: options.eligibleApprovers ?? [
      { userId: options.actorId ?? 'actor-1', role: 'group_owner' }
    ]
  }
  const toolRuntime = new ApprovalToolRuntime(state)
  const adapter = new ApprovalAdapter(options.calls ?? 1)
  const store = new InMemoryRunStore()
  let nowValue = createdAt
  let generated = 0
  const initialFacts = stateFacts(state, address)
  const registry = new ToolRegistry(riskyDefinitions)
  const snapshot = registry.createSnapshot({
    id: 'snapshot-approval-1',
    facts: initialFacts,
    enabledTools: riskyDefinitions.map(definition => definition.name)
  })
  const engine = new RunEngine({
    adapter,
    profile: standardOpenAIProfile,
    scheduler: new ToolScheduler({ runtime: toolRuntime }),
    store,
    budget: createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 }),
    now: () => new Date(nowValue),
    generateId: () => `approval-generated-${++generated}`
  })
  const binding = (runtimeSnapshot = snapshot): RunRuntimeBinding => Object.freeze({
    snapshot: runtimeSnapshot,
    prepareContext: async () => Object.freeze({
      messages: Object.freeze([{ role: 'user' as const, content: '执行风险任务' }]),
      estimatedInputTokens: 16
    }),
    prepareToolContext: async () => Object.freeze({
      runId: 'run-approval-1',
      profile: state.policyProfile,
      facts: stateFacts(state, address),
      intent: Object.freeze({
        trustedSources: Object.freeze(['current_request'] as const),
        actions: Object.freeze([]), explicitTargetIds: Object.freeze([]),
        mentionUserIds: Object.freeze([]), currentMessageId: 'message-current',
        replyMessageId: null
      }),
      now: nowValue
    }),
    contextFor: async () => Object.freeze({
      runId: 'run-approval-1',
      profile: state.policyProfile,
      facts: stateFacts(state, address),
      intent: Object.freeze({
        trustedSources: Object.freeze(['current_request'] as const),
        actions: Object.freeze([]), explicitTargetIds: Object.freeze([]),
        mentionUserIds: Object.freeze([]), currentMessageId: 'message-current',
        replyMessageId: null
      }),
      now: nowValue
    }),
    approvalControlContext: async (): Promise<ApprovalControlContext> => Object.freeze({
      eligibleApprovers: Object.freeze(state.eligibleApprovers.map(actor => Object.freeze({ ...actor })))
    })
  })
  const input: StartRunInput = Object.freeze({
    runId: 'run-approval-1',
    sessionId: 'session-approval-1',
    sessionAddress: address,
    deadlineAt,
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    runtime: binding()
  })
  return Object.freeze({
    adapter, toolRuntime, store, state, snapshot, engine, input, binding,
    setNow: (value: string) => { nowValue = value }
  })
}

async function displayCurrent (
  fixture: ReturnType<typeof approvalHarness>,
  interruption: ApprovalInterruption,
  messageId: string,
  displayedAt: string,
  ttlSeconds = 120
): Promise<ApprovalInterruption> {
  fixture.setNow(displayedAt)
  const displayed = await fixture.engine.displayApproval({
    runId: interruption.runId,
    approvalId: interruption.approvalId,
    messageId,
    displayedAt,
    ttlSeconds
  })
  assert.notEqual(displayed, null)
  return displayed as ApprovalInterruption
}

test('RunEngine resolves ordered approvals in one run without executing an undecided batch', async () => {
  const fixture = approvalHarness({ calls: 2 })
  const first = await fixture.engine.start(fixture.input)
  assert.equal(first.kind, 'paused')
  assert.equal(fixture.toolRuntime.executions.length, 0)
  if (first.kind !== 'paused') return

  await displayCurrent(
    fixture,
    first.interruption,
    'approval-message-1',
    '2026-07-14T00:00:01.000Z'
  )
  fixture.setNow('2026-07-14T00:00:02.000Z')
  const firstDecision = await fixture.engine.decideApproval({
    runId: first.runId,
    approvalId: first.interruption.approvalId,
    kind: 'approved',
    decidedAt: '2026-07-14T00:00:02.000Z',
    sessionAddress: groupAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'group_owner' })
  })
  assert.equal(firstDecision?.kind, 'paused')
  assert.equal(fixture.toolRuntime.executions.length, 0)
  if (firstDecision?.kind !== 'paused') return

  await displayCurrent(
    fixture,
    firstDecision.interruption,
    'approval-message-2',
    '2026-07-14T00:00:03.000Z'
  )
  fixture.setNow('2026-07-14T00:00:04.000Z')
  const completed = await fixture.engine.decideApproval({
    runId: first.runId,
    approvalId: firstDecision.interruption.approvalId,
    kind: 'approved',
    decidedAt: '2026-07-14T00:00:04.000Z',
    sessionAddress: groupAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'group_owner' })
  })

  assert.equal(completed?.kind, 'completed')
  assert.deepEqual(fixture.toolRuntime.executions, ['call-1', 'call-2'])
  const checkpoint = await fixture.store.load('run-approval-1')
  assert.equal(checkpoint?.approvalHistory.length, 2)
  assert.deepEqual(
    checkpoint?.approvalHistory.map(item => item.decision?.kind),
    ['approved', 'approved']
  )
  assert.equal(JSON.stringify(fixture.adapter.requests[1]?.messages).includes('approval-generated'), false)
})

test('RunEngine turns rejection and expiry into exact terminal tool results without dispatch', async () => {
  for (const branch of ['rejected', 'expired'] as const) {
    const fixture = approvalHarness()
    const paused = await fixture.engine.start(fixture.input)
    assert.equal(paused.kind, 'paused')
    if (paused.kind !== 'paused') continue
    await displayCurrent(
      fixture,
      paused.interruption,
      `approval-message-${branch}`,
      '2026-07-14T00:00:01.000Z',
      branch === 'expired' ? 30 : 120
    )
    const decidedAt = branch === 'expired'
      ? '2026-07-14T00:00:31.000Z'
      : '2026-07-14T00:00:02.000Z'
    fixture.setNow(decidedAt)
    const result = await fixture.engine.decideApproval({
      runId: paused.runId,
      approvalId: paused.interruption.approvalId,
      kind: branch,
      decidedAt,
      sessionAddress: groupAddress,
      ...(branch === 'expired'
        ? {}
        : { actor: Object.freeze({ userId: 'actor-1', role: 'group_owner' as const }) })
    })
    assert.equal(result?.kind, 'completed')
    assert.equal(fixture.toolRuntime.executions.length, 0)
    const checkpoint = await fixture.store.load('run-approval-1')
    assert.equal(checkpoint?.toolLedgers[0]?.calls[0]?.status, branch)
    const toolMessage = fixture.adapter.requests[1]?.messages.find(message => message.role === 'tool')
    assert.match(toolMessage?.role === 'tool' ? toolMessage.content : '',
      branch === 'expired' ? /已过期/ : /已拒绝/)
  }
})

test('RunEngine starts approval TTL at display time and excludes waiting from runtime deadlines', async () => {
  const fixture = approvalHarness()
  const paused = await fixture.engine.start(fixture.input)
  assert.equal(paused.kind, 'paused')
  if (paused.kind !== 'paused') return
  assert.equal(paused.interruption.displayedAt, undefined)
  assert.equal(paused.interruption.expiresAt, undefined)
  const beforeDisplay = await fixture.store.load('run-approval-1')

  const displayed = await displayCurrent(
    fixture,
    paused.interruption,
    'approval-message-long-wait',
    '2026-07-14T00:00:01.000Z',
    300
  )
  assert.equal(displayed.expiresAt, '2026-07-14T00:05:01.000Z')
  const afterDisplay = await fixture.store.load('run-approval-1')
  assert.equal(
    afterDisplay?.budgetCounters.usedActiveRuntimeMs,
    beforeDisplay?.budgetCounters.usedActiveRuntimeMs
  )

  fixture.setNow('2026-07-14T00:04:30.000Z')
  const result = await fixture.engine.decideApproval({
    runId: paused.runId,
    approvalId: paused.interruption.approvalId,
    kind: 'approved',
    decidedAt: '2026-07-14T00:04:30.000Z',
    sessionAddress: groupAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'group_owner' })
  })
  assert.equal(result?.kind, 'completed')
  const completed = await fixture.store.load('run-approval-1')
  assert.equal(completed?.deadlineAt, '2026-07-14T00:08:30.000Z')
  assert.ok((completed?.budgetCounters.usedActiveRuntimeMs ?? 240_000) < 10_000)
})

test('RunEngine safe requester can self-confirm while strict requires a known different approver', async () => {
  const noSecond = approvalHarness({
    profile: 'strict',
    eligibleApprovers: [{ userId: 'actor-1', role: 'group_owner' }]
  })
  const unavailable = await noSecond.engine.start(noSecond.input)
  assert.equal(unavailable.kind, 'completed')
  assert.equal(noSecond.toolRuntime.executions.length, 0)
  const unavailableMessage = noSecond.adapter.requests[1]?.messages
    .find(message => message.role === 'tool')
  assert.match(unavailableMessage?.role === 'tool' ? unavailableMessage.content : '', /另一名/)

  const strict = approvalHarness({
    profile: 'strict',
    eligibleApprovers: [
      { userId: 'actor-1', role: 'group_owner' },
      { userId: 'actor-2', role: 'group_admin' }
    ]
  })
  const paused = await strict.engine.start(strict.input)
  assert.equal(paused.kind, 'paused')
  if (paused.kind !== 'paused') return
  await displayCurrent(
    strict,
    paused.interruption,
    'approval-message-strict',
    '2026-07-14T00:00:01.000Z'
  )
  assert.equal(await strict.engine.decideApproval({
    runId: paused.runId,
    approvalId: paused.interruption.approvalId,
    kind: 'approved',
    decidedAt: '2026-07-14T00:00:02.000Z',
    sessionAddress: groupAddress,
    actor: Object.freeze({ userId: 'actor-1', role: 'group_owner' })
  }), null)
  strict.setNow('2026-07-14T00:00:02.000Z')
  const approved = await strict.engine.decideApproval({
    runId: paused.runId,
    approvalId: paused.interruption.approvalId,
    kind: 'approved',
    decidedAt: '2026-07-14T00:00:02.000Z',
    sessionAddress: groupAddress,
    actor: Object.freeze({ userId: 'actor-2', role: 'group_admin' })
  })
  assert.equal(approved?.kind, 'completed')
  assert.deepEqual(strict.toolRuntime.executions, ['call-1'])
})

test('RunEngine routes a private unqualified request to its configured bot owner', async () => {
  const privateAddress: SessionAddress = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'private', userId: 'member-1' })
  })
  const fixture = approvalHarness({
    address: privateAddress,
    actorId: 'member-1',
    actorGroupRole: 'member',
    eligibleApprovers: [{ userId: 'owner-1', role: 'bot_master' }]
  })
  const result = await fixture.engine.start(fixture.input)
  assert.equal(result.kind, 'paused')
  if (result.kind !== 'paused') return
  assert.deepEqual(result.interruption.approvalAddress, {
    botId: 'bot-1', scope: { kind: 'private', userId: 'owner-1' }
  })
  assert.deepEqual(result.interruption.approverPolicy.eligibleActorIds, ['owner-1'])
})

test('RunEngine fails closed when authorization or a frozen tool changes after approval', async () => {
  const cases: Array<{
    name: string
    mutate: (fixture: ReturnType<typeof approvalHarness>) => RunRuntimeBinding | undefined
  }> = [
    { name: 'policy profile', mutate: fixture => { fixture.state.policyProfile = 'strict'; return undefined } },
    { name: 'requester role', mutate: fixture => { fixture.state.actorGroupRole = 'admin'; return undefined } },
    { name: 'target', mutate: fixture => { fixture.state.targetGroupId = 'group-3'; return undefined } },
    { name: 'bot identity', mutate: fixture => { fixture.state.botId = 'bot-2'; return undefined } },
    { name: 'bot permission', mutate: fixture => { fixture.state.denyOnPrepare = true; return undefined } },
    {
      name: 'approver configuration',
      mutate: fixture => {
        fixture.state.eligibleApprovers = [{ userId: 'actor-2', role: 'group_admin' }]
        return undefined
      }
    },
    {
      name: 'tool fingerprint',
      mutate: fixture => {
        const changed = new ToolRegistry(riskyDefinitions).createSnapshot({
          id: 'snapshot-approval-changed',
          facts: stateFacts(fixture.state, groupAddress),
          enabledTools: riskyDefinitions.map(definition => definition.name)
        })
        return fixture.binding(changed)
      }
    }
  ]

  for (const entry of cases) {
    const fixture = approvalHarness()
    const paused = await fixture.engine.start(fixture.input)
    assert.equal(paused.kind, 'paused', entry.name)
    if (paused.kind !== 'paused') continue
    await displayCurrent(
      fixture,
      paused.interruption,
      `approval-message-${entry.name.replace(/\s+/g, '-')}`,
      '2026-07-14T00:00:01.000Z'
    )
    const replacement = entry.mutate(fixture)
    fixture.setNow('2026-07-14T00:00:02.000Z')
    const result = await fixture.engine.decideApproval({
      runId: paused.runId,
      approvalId: paused.interruption.approvalId,
      kind: 'approved',
      decidedAt: '2026-07-14T00:00:02.000Z',
      sessionAddress: groupAddress,
      actor: Object.freeze({ userId: 'actor-1', role: 'group_owner' })
    }, replacement)
    assert.equal(
      result?.kind,
      entry.name === 'tool fingerprint' ? 'failed' : 'completed',
      entry.name
    )
    assert.equal(fixture.toolRuntime.executions.length, 0, entry.name)
    const checkpoint = await fixture.store.load('run-approval-1')
    assert.equal(checkpoint?.toolLedgers[0]?.calls[0]?.status, 'denied', entry.name)
  }
})

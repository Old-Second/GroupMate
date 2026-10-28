import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { SerializablePreparedCapability } from '../../src/agent/tools/prepared-capability.js'
import type { RunCheckpoint } from '../../src/agent/run/run-checkpoint.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import {
  createYunzaiToolRuntimeBridge,
  type YunzaiAgentToolRun,
  type YunzaiToolRuntimeBridge
} from '../../src/runtime/tools/yunzai-tool-runtime.js'
import type { RedisToolClient } from '../../src/runtime/tools/redis-tool-client.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const BOT_ID = '10000'
const GROUP_ID = '9'
const ACTOR_ID = '7'
const TARGET_ID = '8'
const MASTER_ID = '1'

type Role = 'owner' | 'admin' | 'member'

interface HostOptions {
  readonly roles?: Readonly<Record<string, Role>>
  readonly fresh?: Readonly<Record<string, Role | null>>
  readonly muteOutcome?: 'ok' | 'false' | 'throw'
  readonly otherGroups?: readonly string[]
  readonly friends?: readonly string[]
}

interface HostCall {
  readonly name: string
  readonly args: readonly unknown[]
}

interface Host {
  readonly calls: readonly HostCall[]
  readonly event: Record<string, any>
  named: (name: string) => readonly HostCall[]
}

function createHost (options: HostOptions = {}): Host {
  const roles: Readonly<Record<string, Role>> = options.roles ??
    { [ACTOR_ID]: 'admin', [TARGET_ID]: 'member', [BOT_ID]: 'admin' }
  const calls: HostCall[] = []
  const members = new Map<unknown, Record<string, unknown>>(
    Object.entries(roles).map(([userId, role]) => [
      Number(userId), { user_id: Number(userId), role, nickname: `member-${userId}` }
    ])
  )
  const effect = (name: string, outcome: 'ok' | 'false' | 'throw' = 'ok') =>
    async (...args: readonly unknown[]): Promise<unknown> => {
      calls.push(Object.freeze({ name, args: Object.freeze([...args]) }))
      if (outcome === 'throw') throw new Error('host capability failed')
      if (outcome === 'false') return false
      return Object.freeze({ message_id: `host-delivery-${calls.length}` })
    }
  const group = {
    getMemberMap: async () => members,
    muteMember: effect('muteMember', options.muteOutcome ?? 'ok'),
    kickMember: effect('kickMember'),
    setCard: effect('setCard'),
    setTitle: effect('setTitle'),
    recallMsg: effect('recallMsg'),
    sendMsg: effect('sendMsg')
  }
  const bot = {
    uin: Number(BOT_ID),
    pickGroup: (groupId: unknown) => String(groupId) === GROUP_ID
      ? group
      : { getMemberMap: async () => new Map(), sendMsg: effect(`sendMsg:group:${String(groupId)}`) },
    pickFriend: (userId: unknown) => ({ sendMsg: effect(`sendMsg:private:${String(userId)}`) }),
    getGroupList: async () => (options.otherGroups ?? []).map(groupId => ({ group_id: Number(groupId) })),
    getFriendList: async () => (options.friends ?? []).map(userId => ({ user_id: Number(userId) })),
    getGroupMemberInfo: async (groupId: unknown, userId: unknown, noCache: boolean) => {
      assert.equal(noCache, true, 'an execution boundary must bypass the member cache')
      const override = options.fresh?.[String(userId)]
      const role = override === undefined ? roles[String(userId)] ?? null : override
      return role === null
        ? null
        : { user_id: Number(userId), group_id: Number(groupId), role, join_time: 1 }
    },
    setEssenceMessage: effect('setEssenceMessage'),
    removeEssenceMessage: effect('removeEssenceMessage')
  }
  const event: Record<string, any> = {
    isGroup: true,
    group_id: Number(GROUP_ID),
    self_id: Number(BOT_ID),
    user_id: Number(ACTOR_ID),
    message_id: 'current-request-message',
    sender: {
      user_id: Number(ACTOR_ID), role: roles[ACTOR_ID] ?? 'member', nickname: 'actor'
    },
    message: [],
    group,
    bot
  }
  return Object.freeze({
    calls,
    event,
    named: (name: string) => calls.filter(call => call.name === name)
  })
}

function config (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    toolPolicyProfile: 'compatible',
    toolApprovalTtlSeconds: 120,
    serpSource: 'ikechan8370',
    imageSearchSource: 'ikechan8370',
    extraUrl: '',
    enableToolCrossGroupSend: false,
    enableToolPrivateSend: false,
    enableToolVideoDownload: false,
    groupMerge: true,
    ...overrides
  }
}

interface ToolOutcome {
  readonly preparedKind: 'ready' | 'approval_required' | 'completed'
  readonly result: ToolResult | null
}

interface BridgeInput {
  readonly host: Host
  readonly prompt: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly redis?: RedisToolClient
  readonly masterIds?: readonly string[]
  readonly logger?: { info?: (event: Readonly<Record<string, unknown>>) => void }
}

async function prepareRun (input: BridgeInput): Promise<{
  bridge: YunzaiToolRuntimeBridge
  run: YunzaiAgentToolRun
}> {
  const bridge = createYunzaiToolRuntimeBridge({
    config: input.config ?? config(),
    redis: input.redis ?? new FakeRedis(),
    getMasterIds: async () => [...(input.masterIds ?? [])],
    getBotId: () => BOT_ID,
    segment: () => ({}),
    ...(input.logger === undefined ? {} : { logger: input.logger })
  })
  const run = await bridge.prepareAgentRun({ event: input.host.event, prompt: input.prompt })
  return { bridge, run }
}

async function executeTool (
  bridge: YunzaiToolRuntimeBridge,
  run: YunzaiAgentToolRun,
  input: Readonly<{
    runId: string
    callId: string
    requestedName: string
    arguments: Readonly<Record<string, unknown>>
  }>
): Promise<ToolOutcome> {
  const signal = new AbortController().signal
  const checkpoint = { runId: input.runId } as RunCheckpoint
  const preparationContext = await run.binding.prepareToolContext(checkpoint, signal)
  const prepared = await bridge.runtime.prepare(Object.freeze({
    runId: input.runId,
    callId: input.callId,
    snapshotId: run.snapshot.id,
    requestedName: input.requestedName,
    arguments: input.arguments
  }), preparationContext, run.snapshot)
  if (prepared.kind === 'completed') {
    return Object.freeze({ preparedKind: 'completed', result: prepared.result })
  }
  if (prepared.kind === 'approval_required') {
    return Object.freeze({ preparedKind: 'approval_required', result: null })
  }
  const executionContext = await run.binding.contextFor(
    prepared.capability as SerializablePreparedCapability, checkpoint, signal
  )
  return Object.freeze({
    preparedKind: 'ready',
    result: await bridge.runtime.executePrepared(
      prepared.capability, executionContext, run.snapshot, signal
    )
  })
}

async function runTool (input: BridgeInput & {
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly runId?: string
}): Promise<ToolOutcome> {
  const { bridge, run } = await prepareRun(input)
  const runId = input.runId ?? `run-${input.tool}`
  return await executeTool(bridge, run, {
    runId, callId: `${runId}-call`, requestedName: input.tool, arguments: input.arguments
  })
}

function denial (outcome: ToolOutcome): string {
  assert.equal(outcome.result?.status, 'denied', JSON.stringify(outcome.result))
  return outcome.result?.status === 'denied' ? outcome.result.reasonCode : ''
}

test('an authorized mute reaches the host exactly once with the resolved member target', async () => {
  const host = createHost()
  const redis = new FakeRedis()
  const outcome = await runTool({
    host, redis, masterIds: [ACTOR_ID], prompt: `禁言 QQ:${TARGET_ID} 60 秒`,
    tool: 'jinyan', arguments: { userId: TARGET_ID, seconds: 60 }
  })

  assert.equal(outcome.result?.status, 'success', JSON.stringify(outcome.result))
  assert.equal(outcome.result?.effect, 'background')
  assert.deepEqual(host.calls.map(call => call.name), ['muteMember'])
  assert.deepEqual(host.calls[0]?.args, [Number(TARGET_ID), 60])
  const reservation = [...redis.setCalls].at(-1)
  assert.match(reservation?.key ?? '', /^GROUPMATE:TOOL:IDEMPOTENCY:v1:[0-9a-f]{64}:/)
  assert.deepEqual(reservation?.options, { EX: 300, XX: true })
})

test('each authorized management capability calls one narrow host method', async () => {
  const owner = { [ACTOR_ID]: 'owner', [TARGET_ID]: 'member', [BOT_ID]: 'owner' } as const
  for (const authorized of [
    {
      tool: 'setTitle', arguments: { userId: TARGET_ID, title: '冠军' },
      prompt: `给 QQ:${TARGET_ID} 设置头衔 冠军`, call: 'setTitle', args: [Number(TARGET_ID), '冠军']
    },
    {
      tool: 'editCard', arguments: { userId: TARGET_ID, card: '新名片' },
      prompt: `修改 QQ:${TARGET_ID} 的群名片 新名片`, call: 'setCard', args: [Number(TARGET_ID), '新名片']
    },
    {
      tool: 'handleMsg', arguments: { messageId: 'quoted-message', type: 'recall' },
      prompt: '撤回 消息:quoted-message', call: 'recallMsg', args: ['quoted-message']
    },
    {
      tool: 'handleMsg', arguments: { messageId: 'quoted-message', type: 'essence' },
      prompt: '把 消息:quoted-message 设为精华', call: 'setEssenceMessage', args: ['quoted-message']
    }
  ] as const) {
    const host = createHost({ roles: owner })
    const outcome = await runTool({
      host, prompt: authorized.prompt, tool: authorized.tool, masterIds: [ACTOR_ID],
      arguments: authorized.arguments, runId: `run-${authorized.call}`
    })

    assert.equal(outcome.result?.status, 'success', `${authorized.tool}: ${JSON.stringify(outcome.result)}`)
    assert.deepEqual(host.calls.map(call => call.name), [authorized.call])
    assert.deepEqual(host.calls[0]?.args, authorized.args)
  }
})

/**
 * Preparation shares one context for the whole batch, and that context resolves
 * facts for the target `{ kind: 'none' }`, so `targetRole` is still unknown when
 * the hierarchy gate runs. The gate refuses rather than defers, which is why a
 * kick never reaches execution even for an authorized actor. The direction is
 * fail-closed - no side effect leaks - but `docs/tools.md:13` promises the
 * capability to an authority holder, so the refusal is a gap, not the contract.
 */
test('a kick is refused while the target role is unknown and admitted once it is resolved', async () => {
  const host = createHost({ roles: { [ACTOR_ID]: 'owner', [TARGET_ID]: 'member', [BOT_ID]: 'owner' } })
  const { bridge, run } = await prepareRun({
    host, masterIds: [ACTOR_ID], prompt: `踢出 QQ:${TARGET_ID}`
  })
  const call = Object.freeze({
    runId: 'run-kick', callId: 'run-kick-call', snapshotId: run.snapshot.id,
    requestedName: 'kickOut', arguments: Object.freeze({ userId: TARGET_ID })
  })
  const signal = new AbortController().signal
  const checkpoint = { runId: call.runId } as RunCheckpoint

  const refused = await executeTool(bridge, run, call)
  assert.equal(denial(refused), 'role_hierarchy_denied')
  assert.equal(refused.preparedKind, 'completed')
  assert.equal(host.calls.length, 0)

  const resolved = await run.binding.contextFor(
    Object.freeze({
      target: Object.freeze({ kind: 'member', groupId: GROUP_ID, userId: TARGET_ID })
    }) as SerializablePreparedCapability,
    checkpoint,
    signal
  )
  const prepared = await bridge.runtime.prepare(call, resolved, run.snapshot)
  assert.equal(prepared.kind, 'ready')
  if (prepared.kind !== 'ready') return
  const result = await bridge.runtime.executePrepared(
    prepared.capability, resolved, run.snapshot, signal
  )

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual(host.calls.map(hostCall => hostCall.name), ['kickMember'])
  assert.deepEqual(host.calls[0]?.args, [Number(TARGET_ID)])
})



interface DenialCase {
  readonly label: string
  readonly roles?: Readonly<Record<string, Role>>
  readonly fresh?: Readonly<Record<string, Role | null>>
  readonly masterIds?: readonly string[]
  readonly config?: Readonly<Record<string, unknown>>
  readonly otherGroups?: readonly string[]
  readonly friends?: readonly string[]
  readonly prompt: string
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly reasonCode: string
  readonly stage: 'completed' | 'ready'
}

const ADMIN_BOT = { [ACTOR_ID]: 'admin', [TARGET_ID]: 'member', [BOT_ID]: 'admin' } as const
const OWNER_BOT = { [ACTOR_ID]: 'owner', [TARGET_ID]: 'member', [BOT_ID]: 'admin' } as const

const denials: readonly DenialCase[] = Object.freeze([
  {
    label: 'an ordinary member cannot mute another member',
    roles: { [ACTOR_ID]: 'member', [TARGET_ID]: 'member', [BOT_ID]: 'admin' },
    prompt: `禁言 QQ:${TARGET_ID} 60 秒`, tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    reasonCode: 'permission_denied', stage: 'completed'
  },
  {
    label: 'an authority holder who is not a bot master cannot mute a third party',
    roles: OWNER_BOT, prompt: `禁言 QQ:${TARGET_ID} 60 秒`, tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    reasonCode: 'role_hierarchy_denied', stage: 'completed'
  },
  {
    label: 'a bot without group authority exposes no management tool at all',
    roles: { [ACTOR_ID]: 'owner', [TARGET_ID]: 'member', [BOT_ID]: 'member' },
    masterIds: [ACTOR_ID], prompt: `禁言 QQ:${TARGET_ID} 60 秒`, tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    reasonCode: 'tool_unavailable', stage: 'completed'
  },
  {
    label: 'the bot itself is a protected target',
    roles: OWNER_BOT, masterIds: [ACTOR_ID], prompt: `禁言 QQ:${BOT_ID} 60 秒`,
    tool: 'jinyan', arguments: { userId: BOT_ID, seconds: 60 },
    reasonCode: 'target_protected', stage: 'completed'
  },
  {
    label: 'a bot master is a protected target',
    roles: OWNER_BOT, masterIds: [ACTOR_ID, TARGET_ID],
    prompt: `禁言 QQ:${TARGET_ID} 60 秒`, tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    reasonCode: 'target_protected', stage: 'ready'
  },
  {
    label: 'a target that left the group before dispatch is not found',
    roles: OWNER_BOT, masterIds: [ACTOR_ID], fresh: { [TARGET_ID]: null },
    prompt: `禁言 QQ:${TARGET_ID} 60 秒`, tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    reasonCode: 'target_not_found', stage: 'ready'
  },
  {
    label: 'a mute without an explicit target in the current request is refused',
    roles: OWNER_BOT, masterIds: [ACTOR_ID], prompt: '禁言他 60 秒', tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    reasonCode: 'explicit_intent_required', stage: 'completed'
  },
  {
    label: 'a mute the current request never asked for is refused',
    roles: OWNER_BOT, masterIds: [ACTOR_ID], prompt: '今天天气不错', tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    reasonCode: 'explicit_intent_required', stage: 'completed'
  },
  {
    label: 'an ordinary member cannot lift their own mute through the tool',
    roles: { [ACTOR_ID]: 'member', [TARGET_ID]: 'member', [BOT_ID]: 'admin' },
    prompt: `给 QQ:${ACTOR_ID} 解禁`, tool: 'jinyan',
    arguments: { userId: ACTOR_ID, seconds: 0 },
    reasonCode: 'self_unmute_denied', stage: 'completed'
  },
  {
    label: 'a self mute longer than sixty seconds is refused',
    roles: { [ACTOR_ID]: 'member', [TARGET_ID]: 'member', [BOT_ID]: 'admin' },
    prompt: `禁言 QQ:${ACTOR_ID} 600 秒`, tool: 'jinyan',
    arguments: { userId: ACTOR_ID, seconds: 600 },
    reasonCode: 'self_mute_duration_exceeded', stage: 'completed'
  },
  {
    label: 'a group administrator is never offered the kick tool',
    roles: ADMIN_BOT, prompt: `踢出 QQ:${TARGET_ID}`, tool: 'kickOut',
    arguments: { userId: TARGET_ID }, reasonCode: 'tool_unavailable', stage: 'completed'
  },
  {
    label: 'a title needs the bot to own the group',
    roles: OWNER_BOT, masterIds: [ACTOR_ID], prompt: `给 QQ:${TARGET_ID} 设置头衔 冠军`,
    tool: 'setTitle', arguments: { userId: TARGET_ID, title: '冠军' },
    reasonCode: 'tool_unavailable', stage: 'completed'
  },
  {
    label: 'the current request message can never be recalled',
    roles: ADMIN_BOT, masterIds: [ACTOR_ID], prompt: '撤回 消息:current-request-message',
    tool: 'handleMsg', arguments: { messageId: 'current-request-message', type: 'recall' },
    reasonCode: 'current_message_protected', stage: 'completed'
  },
  {
    label: 'both send policies disabled hide the send tool entirely',
    roles: ADMIN_BOT, masterIds: [ACTOR_ID], otherGroups: ['88'],
    prompt: '发送到群 88：你好', tool: 'sendMessage',
    arguments: { targetKind: 'group', targetId: '88', text: '你好' },
    reasonCode: 'tool_unavailable', stage: 'completed'
  },
  {
    label: 'a cross-group send stays disabled by configuration',
    roles: ADMIN_BOT, otherGroups: ['88'],
    config: { toolPrivateSendPolicy: 'everyone', toolCrossGroupSendPolicy: 'disabled' },
    prompt: '发送到群 88：你好', tool: 'sendMessage',
    arguments: { targetKind: 'group', targetId: '88', text: '你好' },
    reasonCode: 'cross_channel_disabled', stage: 'completed'
  },
  {
    label: 'the current group uses a normal reply instead of the send tool',
    roles: ADMIN_BOT, masterIds: [ACTOR_ID],
    config: { toolCrossGroupSendPolicy: 'everyone' },
    prompt: `发送到群 ${GROUP_ID}：你好`,
    tool: 'sendMessage', arguments: { targetKind: 'group', targetId: GROUP_ID, text: '你好' },
    reasonCode: 'current_channel_uses_normal_reply', stage: 'completed'
  },
  {
    label: 'a master-only private send refuses an ordinary actor',
    roles: ADMIN_BOT, friends: [TARGET_ID],
    config: { toolPrivateSendPolicy: 'master', toolCrossGroupSendPolicy: 'everyone' },
    prompt: `发给 用户:${TARGET_ID} 你好`, tool: 'sendMessage',
    arguments: { targetKind: 'private', targetId: TARGET_ID, text: '你好' },
    reasonCode: 'permission_denied', stage: 'completed'
  },
  {
    label: 'a cross-group send to a group the bot cannot see is not found',
    roles: ADMIN_BOT, masterIds: [ACTOR_ID], otherGroups: [],
    config: { toolCrossGroupSendPolicy: 'everyone' },
    prompt: '发送到群 88：你好', tool: 'sendMessage',
    arguments: { targetKind: 'group', targetId: '88', text: '你好' },
    reasonCode: 'target_not_found', stage: 'ready'
  }
])

test('every unauthorized side-effect request is denied without touching the host', async () => {
  for (const scenario of denials) {
    const host = createHost({
      ...(scenario.roles === undefined ? {} : { roles: scenario.roles }),
      ...(scenario.fresh === undefined ? {} : { fresh: scenario.fresh }),
      ...(scenario.otherGroups === undefined ? {} : { otherGroups: scenario.otherGroups }),
      ...(scenario.friends === undefined ? {} : { friends: scenario.friends })
    })
    const outcome = await runTool({
      host,
      prompt: scenario.prompt,
      tool: scenario.tool,
      arguments: scenario.arguments,
      runId: `run-denied-${denials.indexOf(scenario)}`,
      config: config(scenario.config ?? {}),
      ...(scenario.masterIds === undefined ? {} : { masterIds: scenario.masterIds })
    })

    assert.equal(denial(outcome), scenario.reasonCode, scenario.label)
    assert.equal(outcome.preparedKind, scenario.stage, scenario.label)
    assert.deepEqual(host.calls, [], scenario.label)
  }
})

test('an identity that cannot be re-verified at the boundary stops the run before any effect', async () => {
  for (const missing of [BOT_ID, ACTOR_ID]) {
    const host = createHost({
      roles: { [ACTOR_ID]: 'owner', [TARGET_ID]: 'member', [BOT_ID]: 'admin' },
      fresh: { [missing]: null }
    })
    const { bridge, run } = await prepareRun({
      host, masterIds: [ACTOR_ID], prompt: `禁言 QQ:${TARGET_ID} 60 秒`
    })

    await assert.rejects(
      async () => await executeTool(bridge, run, {
        runId: `run-unverified-${missing}`, callId: `run-unverified-${missing}-call`,
        requestedName: 'jinyan', arguments: { userId: TARGET_ID, seconds: 60 }
      }),
      (error: unknown) => error instanceof AgentError &&
        error.code === 'authorization_changed' && !error.retryable,
      missing
    )
    assert.equal(host.calls.length, 0, missing)
  }
})

test('a dispatched action whose host outcome is lost becomes an unknown result', async () => {
  for (const muteOutcome of ['throw', 'false'] as const) {
    const host = createHost({ muteOutcome })
    const redis = new FakeRedis()
    const outcome = await runTool({
      host, redis, masterIds: [ACTOR_ID], prompt: `禁言 QQ:${TARGET_ID} 60 秒`,
      tool: 'jinyan', arguments: { userId: TARGET_ID, seconds: 60 },
      runId: `run-unknown-${muteOutcome}`
    })

    assert.equal(outcome.result?.status, 'indeterminate', muteOutcome)
    assert.equal(outcome.result?.effect, 'possible', muteOutcome)
    assert.equal(
      outcome.result?.status === 'indeterminate' ? outcome.result.errorCode : '',
      'tool_outcome_unknown',
      muteOutcome
    )
    assert.equal(host.named('muteMember').length, 1, muteOutcome)
    const key = [...redis.setCalls].at(-1)?.key ?? ''
    const stored = JSON.parse(await redis.get(key) ?? 'null')
    assert.equal(stored?.state, 'indeterminate', muteOutcome)
    assert.deepEqual(Object.keys(stored ?? {}).sort(), ['schemaVersion', 'state', 'updatedAt'], muteOutcome)
  }
})

class ControlPlaneRedis implements RedisToolClient {
  readonly entries = new Map<string, string>()

  constructor (private readonly failOn: (value: string) => boolean) {}

  async get (key: string): Promise<string | null> {
    return this.entries.get(key) ?? null
  }

  async getDel (key: string): Promise<string | null> {
    const value = this.entries.get(key) ?? null
    this.entries.delete(key)
    return value
  }

  async set (
    key: string,
    value: string,
    options: { EX: number; NX?: boolean; XX?: boolean }
  ): Promise<unknown> {
    if (this.failOn(value)) throw new Error('redis control plane is unavailable')
    if (options.NX === true && this.entries.has(key)) return null
    if (options.XX === true && !this.entries.has(key)) return null
    this.entries.set(key, value)
    return 'OK'
  }

  async del (key: string): Promise<number> {
    return this.entries.delete(key) ? 1 : 0
  }
}

function journal (): {
  readonly entries: Array<Readonly<Record<string, unknown>>>
  readonly logger: { info: (event: Readonly<Record<string, unknown>>) => void }
  readonly controlFailures: () => Array<Readonly<Record<string, unknown>>>
} {
  const entries: Array<Readonly<Record<string, unknown>>> = []
  return {
    entries,
    logger: { info: (event) => { entries.push(event) } },
    controlFailures: () => entries.filter(entry => entry.event === 'groupmate.tool.control_failure')
  }
}

test('a lost unknown-state write is reported instead of silently dropped', async () => {
  const host = createHost({ muteOutcome: 'throw' })
  const redis = new ControlPlaneRedis(value => value.includes('"state":"indeterminate"'))
  const sink = journal()
  const outcome = await runTool({
    host, redis, masterIds: [ACTOR_ID], logger: sink.logger,
    prompt: `禁言 QQ:${TARGET_ID} 60 秒`, tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 }, runId: 'run-lost-unknown'
  })

  assert.equal(outcome.result?.status, 'indeterminate', JSON.stringify(outcome.result))
  assert.equal(host.named('muteMember').length, 1)
  const reported = sink.controlFailures()
  assert.equal(reported.length, 1)
  assert.equal(reported[0]?.operation, 'idempotency_mark_indeterminate')
  assert.equal(reported[0]?.unpersistedState, 'unknown')
  assert.equal(reported[0]?.eventType, 'control_failure')
  assert.equal(reported[0]?.toolName, 'jinyan')
  assert.equal(reported[0]?.effect, 'side_effect')
  assert.equal(reported[0]?.risk, 'high')
  assert.equal(reported[0]?.errorName, 'Error')
  assert.match(String(reported[0]?.occurredAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.match(String(reported[0]?.runIdHash), /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(reported[0]).includes('run-lost-unknown'), false)
  assert.equal(
    sink.entries.some(entry => entry.event === 'groupmate.tool.audit' && entry.eventType === 'indeterminate'),
    true
  )
})

test('a lost failed-state write after an audit outage is reported without dispatching', async () => {
  const host = createHost()
  const redis = new ControlPlaneRedis(value => value.includes('"state":"completed"'))
  const sink = journal()
  const logger = {
    info: (event: Readonly<Record<string, unknown>>) => {
      if (event.event === 'groupmate.tool.audit' && event.eventType === 'started') {
        throw new Error('journal is unavailable')
      }
      sink.logger.info(event)
    }
  }
  const outcome = await runTool({
    host, redis, masterIds: [ACTOR_ID], logger,
    prompt: `禁言 QQ:${TARGET_ID} 60 秒`, tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 }, runId: 'run-lost-failed'
  })

  assert.equal(outcome.result?.status, 'failed', JSON.stringify(outcome.result))
  assert.equal(
    outcome.result?.status === 'failed' ? outcome.result.errorCode : '',
    'tool_control_unavailable'
  )
  assert.equal(host.calls.length, 0)
  const reported = sink.controlFailures()
  assert.equal(reported.length, 1)
  assert.equal(reported[0]?.operation, 'idempotency_complete')
  assert.equal(reported[0]?.unpersistedState, 'failed')
})

test('an observability sink that fails never changes the tool outcome', async () => {
  const host = createHost({ muteOutcome: 'throw' })
  const redis = new ControlPlaneRedis(value => value.includes('"state":"indeterminate"'))
  const outcome = await runTool({
    host,
    redis,
    masterIds: [ACTOR_ID],
    logger: {
      info: (event) => {
        if (event.event === 'groupmate.tool.control_failure') {
          throw new Error('journal is unavailable')
        }
      }
    },
    prompt: `禁言 QQ:${TARGET_ID} 60 秒`,
    tool: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 },
    runId: 'run-sink-failure'
  })

  assert.equal(outcome.result?.status, 'indeterminate', JSON.stringify(outcome.result))
  assert.equal(host.named('muteMember').length, 1)
})

test('a repeated request for the same action replays the stored outcome once', async () => {
  const host = createHost()
  const redis = new FakeRedis()
  const { bridge, run } = await prepareRun({
    host, redis, masterIds: [ACTOR_ID], prompt: `禁言 QQ:${TARGET_ID} 60 秒`
  })
  const call = {
    runId: 'run-replay', callId: 'run-replay-first', requestedName: 'jinyan',
    arguments: { userId: TARGET_ID, seconds: 60 }
  }

  const first = await executeTool(bridge, run, call)
  const second = await executeTool(bridge, run, { ...call, callId: 'run-replay-second' })

  assert.equal(first.result?.status, 'success', JSON.stringify(first.result))
  assert.equal(second.result?.status, 'success', JSON.stringify(second.result))
  assert.equal(host.named('muteMember').length, 1)
})

test('an authorized cross-group send reaches the selected group through the host port', async () => {
  const host = createHost({ roles: ADMIN_BOT, otherGroups: ['88'] })
  const outcome = await runTool({
    host, masterIds: [ACTOR_ID], config: config({ toolCrossGroupSendPolicy: 'everyone' }),
    prompt: '发送到群 88：你好', tool: 'sendMessage',
    arguments: { targetKind: 'group', targetId: '88', text: '你好' }
  })

  assert.equal(outcome.result?.status, 'success', JSON.stringify(outcome.result))
  assert.deepEqual(host.calls.map(call => call.name), ['sendMsg:group:88'])
  assert.deepEqual(host.calls[0]?.args, ['你好'])
  assert.equal(host.named('sendMsg').length, 0)
})

test('a private conversation exposes no group management capability', async () => {
  const sends: unknown[] = []
  const event: Record<string, any> = {
    isGroup: false,
    user_id: Number(ACTOR_ID),
    sender: { user_id: Number(ACTOR_ID), nickname: 'actor' },
    message: [],
    bot: {
      pickFriend: () => ({ sendMsg: async (message: unknown) => { sends.push(message); return { message_id: 'private-1' } } })
    }
  }
  const host: Host = Object.freeze({ calls: [], event, named: () => [] })
  const { bridge, run } = await prepareRun({
    host, masterIds: [ACTOR_ID], prompt: `禁言 QQ:${TARGET_ID} 60 秒`
  })

  for (const tool of ['jinyan', 'kickOut', 'setTitle', 'editCard', 'handleMsg']) {
    assert.equal(run.snapshot.toolNames.includes(tool), false, tool)
    const outcome = await executeTool(bridge, run, {
      runId: `run-private-${tool}`, callId: `run-private-${tool}-call`,
      requestedName: tool, arguments: { userId: TARGET_ID, seconds: 60 }
    })
    assert.equal(denial(outcome), 'tool_unavailable', tool)
  }
  assert.deepEqual(sends, [])
})

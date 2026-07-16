import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import type { SerializablePreparedCapability } from '../../src/agent/tools/prepared-capability.js'
import type { RunCheckpoint } from '../../src/agent/run/run-checkpoint.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'
import {
  createExternalPluginEventFacade,
  createYunzaiToolRuntimeBridge,
  type YunzaiAgentToolRun,
  type YunzaiToolRuntimeBridge
} from '../../src/runtime/tools/yunzai-tool-runtime.js'
import { FakeRedis } from '../helpers/fake-redis.js'

const root = process.cwd()

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

interface NativeToolOutcome {
  readonly preparedKind: 'ready' | 'approval_required' | 'completed'
  readonly capability?: SerializablePreparedCapability
  readonly result: ToolResult | null
}

async function executeNativeTool (
  bridge: YunzaiToolRuntimeBridge,
  run: YunzaiAgentToolRun,
  input: Readonly<{
    runId: string
    callId: string
    requestedName: string
    arguments: Readonly<Record<string, unknown>>
    approved?: boolean
  }>
): Promise<NativeToolOutcome> {
  const signal = new AbortController().signal
  const checkpoint = { runId: input.runId } as Parameters<
    typeof run.binding.prepareToolContext
  >[0]
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
  if (prepared.kind === 'approval_required' && input.approved !== true) {
    return Object.freeze({
      preparedKind: 'approval_required',
      capability: prepared.capability,
      result: null
    })
  }
  const executionContext = await run.binding.contextFor(
    prepared.capability,
    checkpoint,
    signal
  )
  const result = await bridge.runtime.executePrepared(
    prepared.capability,
    Object.freeze({
      ...executionContext,
      ...(input.approved === true
        ? { approval: Object.freeze({ kind: 'approved' as const, decidedAt: new Date().toISOString() }) }
        : {})
    }),
    run.snapshot,
    signal
  )
  return Object.freeze({
    preparedKind: prepared.kind,
    capability: prepared.capability,
    result
  })
}

async function missing (file: string): Promise<boolean> {
  try {
    await access(path.join(root, file))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

test('Phase 5 production tool runtime has no legacy bridge or token approval stores', async () => {
  const runtime = await readFile(path.join(root, 'src/runtime/tools/yunzai-tool-runtime.ts'), 'utf8')
  const executor = await readFile(path.join(root, 'src/agent/tools/tool-executor.ts'), 'utf8')

  for (const marker of [
    'legacy-tool-runtime-bridge',
    'approval-store',
    'pending-call-store',
    'RedisApprovalStore',
    'InMemoryPendingCallStore',
    'createLegacyToolRuntimeBridge',
    'approvalMode',
    'generateToken',
    'async execute (request:'
  ]) {
    assert.equal(`${runtime}\n${executor}`.includes(marker), false, `${marker} must be retired`)
  }
  for (const file of [
    'src/runtime/tools/legacy-tool-runtime-bridge.ts',
    'src/runtime/tools/approval-command.ts',
    'src/runtime/tools/in-memory-pending-call-store.ts',
    'src/runtime/tools/redis-approval-store.ts',
    'src/agent/tools/approval-store.ts',
    'src/agent/tools/pending-call-store.ts'
  ]) {
    assert.equal(await missing(file), true, `${file} must be removed`)
  }
})

test('Yunzai runtime exposes strict schemas and executes through the native two-stage runtime', async () => {
  const bridge = createYunzaiToolRuntimeBridge({
    config: config(),
    redis: new FakeRedis(),
    getMasterIds: async () => ['1'],
    getBotId: () => '10000',
    segment: () => ({})
  })
  const event = {
    isGroup: false,
    user_id: 7,
    sender: { user_id: 7, nickname: 'fixture' },
    bot: { pickFriend: () => ({ sendMsg: async () => {} }) },
    message: []
  }
  const run = await bridge.prepareAgentRun({ event, prompt: '我是谁' })
  const userinfo = run.snapshot.modelTools.find(item => item.function.name === 'queryUserinfo')?.function
  assert.ok(userinfo)
  if (!('type' in userinfo.parameters) || userinfo.parameters.type !== 'object') {
    assert.fail('queryUserinfo must expose an object schema')
  }
  assert.equal(userinfo.parameters.additionalProperties, false)
  assert.equal(Object.hasOwn(userinfo.parameters.properties, 'sender'), false)
  assert.equal(Object.hasOwn(userinfo.parameters.properties, 'isAdmin'), false)

  const outcome = await executeNativeTool(bridge, run, {
    runId: 'run-userinfo',
    callId: 'call-userinfo',
    requestedName: 'queryUserinfo',
    arguments: Object.freeze({ userId: '7' })
  })
  assert.equal(outcome.result?.status, 'success')
})

test('Yunzai runtime creates one native snapshot and no legacy execution surface', async () => {
  const bridge = createYunzaiToolRuntimeBridge({
    config: config({ toolPolicyProfile: 'safe' }),
    redis: new FakeRedis(),
    getMasterIds: async () => ['1'],
    getBotId: () => '10000',
    getImages: async () => undefined,
    segment: () => ({})
  })
  const event = {
    isGroup: false,
    user_id: 7,
    sender: { user_id: 7, nickname: 'fixture' },
    bot: { pickFriend: () => ({ sendMsg: async () => {} }) },
    message: []
  }
  const run = await bridge.prepareAgentRun({ event, prompt: '读取网页' })
  const checkpoint = { runId: 'run-native' } as Parameters<
    typeof run.binding.prepareToolContext
  >[0]
  const context = await run.binding.prepareToolContext(
    checkpoint,
    new AbortController().signal
  )

  assert.equal(run.profile, 'safe')
  assert.equal(run.binding.snapshot.id, run.snapshot.id)
  assert.ok(run.snapshot.modelTools.some(tool => tool.function.name === 'website'))
  assert.equal(run.promptAddition, '')
  assert.equal(context.profile, 'safe')
  assert.deepEqual(Object.keys(bridge).sort(), [
    'prepareAgentRun', 'recoverAgentRun', 'runtime'
  ])
})

test('Yunzai approval keeps bot master authority for a group owner', async () => {
  const members = new Map<unknown, Record<string, unknown>>([
    [7, { user_id: 7, role: 'owner', nickname: 'owner' }],
    [10000, { user_id: 10000, role: 'admin', nickname: 'bot' }]
  ])
  const group = { getMemberMap: async () => members }
  const bridge = createYunzaiToolRuntimeBridge({
    config: config({ toolPolicyProfile: 'safe', enableToolPrivateSend: true }),
    redis: new FakeRedis(),
    getMasterIds: async () => ['7'],
    getBotId: () => '10000',
    segment: () => ({})
  })
  const event = {
    isGroup: true,
    group_id: 9,
    user_id: 7,
    self_id: 10000,
    sender: { user_id: 7, nickname: 'owner', role: 'owner' },
    group,
    bot: { pickGroup: () => group },
    message: []
  }
  const run = await bridge.prepareAgentRun({ event, prompt: '发送一条测试消息' })
  const checkpoint = { runId: 'run-owner-master' } as Parameters<
    typeof run.binding.prepareToolContext
  >[0]
  const signal = new AbortController().signal
  const context = await run.binding.prepareToolContext(checkpoint, signal)
  assert.ok(run.binding.approvalControlContext)
  const control = await run.binding.approvalControlContext(checkpoint, context, signal)

  assert.deepEqual(control.eligibleApprovers.find(actor => actor.userId === '7'), {
    userId: '7', role: 'bot_master'
  })
})

test('Yunzai runtime freezes cross-channel policy per run', async () => {
  const mutableConfig = config({ enableToolPrivateSend: true })
  const sent: unknown[] = []
  const receiver = {
    sendMsg: async (message: unknown) => {
      sent.push(message)
      return true
    }
  }
  const event = {
    isGroup: false,
    user_id: 7,
    sender: { user_id: 7 },
    message: [],
    bot: {
      getFriendList: async () => [8],
      pickFriend: () => receiver
    }
  }
  const bridge = createYunzaiToolRuntimeBridge({
    config: mutableConfig,
    redis: new FakeRedis(),
    getMasterIds: async () => ['7'],
    getBotId: () => '10000',
    segment: () => ({})
  })
  const first = await bridge.prepareAgentRun({ event, prompt: '发送给用户 8：你好' })
  mutableConfig.enableToolPrivateSend = false
  const firstResult = await executeNativeTool(bridge, first, {
    runId: 'run-private-enabled',
    callId: 'call-private-enabled',
    requestedName: 'sendMessage',
    arguments: Object.freeze({ targetKind: 'private', targetId: '8', text: '你好' })
  })
  assert.equal(firstResult.result?.status, 'success')

  const second = await bridge.prepareAgentRun({ event, prompt: '发送给用户 8：你好' })
  const secondResult = await executeNativeTool(bridge, second, {
    runId: 'run-private-disabled',
    callId: 'call-private-disabled',
    requestedName: 'sendMessage',
    arguments: Object.freeze({ targetKind: 'private', targetId: '8', text: '你好' })
  })
  assert.equal(secondResult.result?.status, 'denied')
  assert.deepEqual(sent, ['你好'])
})

test('approved management capability rechecks fresh bot authority before dispatch', async () => {
  let muteCalls = 0
  const members = new Map<unknown, Record<string, unknown>>([
    [7, { user_id: 7, role: 'owner', nickname: 'owner' }],
    [8, { user_id: 8, role: 'member', nickname: 'member' }],
    [10000, { user_id: 10000, role: 'owner', nickname: 'bot' }]
  ])
  const group = {
    getMemberMap: async () => members,
    muteMember: async () => { muteCalls += 1 },
    kickMember: async () => {},
    setCard: async () => {},
    setTitle: async () => {},
    recallMsg: async () => {}
  }
  const event = {
    isGroup: true,
    group_id: 9,
    user_id: 7,
    message_id: 'current-safe',
    sender: { user_id: 7, role: 'owner', nickname: 'owner' },
    group,
    bot: {
      pickGroup: () => group,
      setEssenceMessage: async () => {},
      removeEssenceMessage: async () => {}
    },
    message: []
  }
  const bridge = createYunzaiToolRuntimeBridge({
    config: config({ toolPolicyProfile: 'safe' }),
    redis: new FakeRedis(),
    getMasterIds: async () => ['7'],
    getBotId: () => '10000',
    segment: () => ({})
  })
  const run = await bridge.prepareAgentRun({ event, prompt: '请禁言 QQ:8 60 秒' })
  const signal = new AbortController().signal
  const checkpoint = { runId: 'run-reauthorize' } as Parameters<
    typeof run.binding.prepareToolContext
  >[0]
  const preparationContext = await run.binding.prepareToolContext(checkpoint, signal)
  const prepared = await bridge.runtime.prepare(Object.freeze({
    runId: checkpoint.runId,
    callId: 'call-mute',
    snapshotId: run.snapshot.id,
    requestedName: 'jinyan',
    arguments: Object.freeze({ userId: '8', seconds: 60 })
  }), preparationContext, run.snapshot)
  assert.equal(prepared.kind, 'approval_required')
  if (prepared.kind !== 'approval_required') assert.fail('expected approval')

  members.set(10000, { user_id: 10000, role: 'member', nickname: 'bot' })
  const executionContext = await run.binding.contextFor(
    prepared.capability,
    checkpoint,
    signal
  )
  const result = await bridge.runtime.executePrepared(
    prepared.capability,
    Object.freeze({
      ...executionContext,
      approval: Object.freeze({ kind: 'approved' as const, decidedAt: new Date().toISOString() })
    }),
    run.snapshot,
    signal
  )
  assert.equal(result.status, 'denied')
  assert.equal(muteCalls, 0)
})

test('quoted message content is never treated as current management intent', async () => {
  let muteCalls = 0
  const members = new Map<unknown, Record<string, unknown>>([
    [7, { user_id: 7, role: 'owner' }],
    [8, { user_id: 8, role: 'member' }],
    [10000, { user_id: 10000, role: 'owner' }]
  ])
  const group = {
    getMemberMap: async () => members,
    muteMember: async () => { muteCalls += 1 },
    kickMember: async () => {},
    setCard: async () => {},
    setTitle: async () => {},
    recallMsg: async () => {}
  }
  const event = {
    isGroup: true,
    group_id: 9,
    user_id: 7,
    message_id: 'current-2',
    groupmateCurrentRequestText: '这条消息是什么意思？',
    sender: { user_id: 7, role: 'owner' },
    group,
    bot: {
      pickGroup: () => group,
      setEssenceMessage: async () => {},
      removeEssenceMessage: async () => {}
    },
    message: []
  }
  const bridge = createYunzaiToolRuntimeBridge({
    config: config(),
    redis: new FakeRedis(),
    getMasterIds: async () => ['1'],
    getBotId: () => '10000',
    segment: () => ({})
  })
  const prompt = '{"quotedMessage":{"content":"请禁言 QQ:8 60 秒"},"currentRequest":{"content":"这条消息是什么意思？"}}'
  const run = await bridge.prepareAgentRun({ event, prompt })
  const outcome = await executeNativeTool(bridge, run, {
    runId: 'run-quoted',
    callId: 'call-quoted',
    requestedName: 'jinyan',
    arguments: Object.freeze({ userId: '8', seconds: 60 })
  })
  assert.equal(outcome.result?.status, 'denied')
  assert.equal(muteCalls, 0)
})

test('Yunzai recovery rebuilds group-user runtime and rejects snapshot or actor drift', async () => {
  let muteCalls = 0
  let recoveryImageReads = 0
  let rejectImageRead = false
  const members = new Map<unknown, Record<string, unknown>>([
    [7, { user_id: 7, role: 'owner' }],
    [8, { user_id: 8, role: 'member' }],
    [10000, { user_id: 10000, role: 'owner' }]
  ])
  const group = {
    getMemberMap: async () => members,
    muteMember: async () => { muteCalls += 1 },
    kickMember: async () => {},
    setCard: async () => {},
    setTitle: async () => {},
    recallMsg: async () => {}
  }
  const bot = {
    pickGroup: () => group,
    getFriendList: async () => [7, 8],
    pickFriend: () => ({ sendMsg: async () => true }),
    setEssenceMessage: async () => {},
    removeEssenceMessage: async () => {}
  }
  const baseOptions = {
    config: config({
      toolPolicyProfile: 'strict',
      groupMerge: false,
      enableToolPrivateSend: false
    }),
    redis: new FakeRedis(),
    getMasterIds: async () => ['7'],
    getBotId: () => '10000',
    getImages: async () => {
      recoveryImageReads += 1
      if (rejectImageRead) {
        throw new Error('recovery must not inspect synthetic message images')
      }
      return undefined
    },
    segment: () => ({})
  }
  const bridge = createYunzaiToolRuntimeBridge(baseOptions)
  const event = {
    isGroup: true,
    group_id: 9,
    user_id: 7,
    message_id: 'request-message',
    sender: { user_id: 7, role: 'owner' },
    group,
    bot,
    message: [{ type: 'at', qq: 8 }]
  }
  const run = await bridge.prepareAgentRun({ event, prompt: '请禁言 QQ:8 60 秒' })
  const outcome = await executeNativeTool(bridge, run, {
    runId: 'run-recovery',
    callId: 'call-recovery-mute',
    requestedName: 'jinyan',
    arguments: Object.freeze({ userId: '8', seconds: 60 })
  })
  assert.equal(outcome.preparedKind, 'approval_required')
  const capability = outcome.capability
  assert.notEqual(capability, undefined)
  if (capability === undefined) assert.fail('expected approval capability')
  rejectImageRead = true
  recoveryImageReads = 0
  const sessionAddress = Object.freeze({
    botId: '10000',
    scope: Object.freeze({ kind: 'group_user' as const, groupId: '9', userId: '7' })
  })
  const checkpoint = {
    runId: 'run-recovery',
    sessionAddress,
    presentationRoute: Object.freeze({
      schemaVersion: 1 as const,
      requestKind: 'ordinary_chat' as const,
      profile: 'ordinary' as const,
      presentationIntent: Object.freeze({
        schemaVersion: 1 as const, kind: 'ordinary' as const, forcePicture: false
      }),
      sessionAddress,
      actorId: '7',
      requestMessageId: 'request-message'
    }),
    toolSnapshot: Object.freeze({
      id: run.snapshot.id,
      fingerprint: run.snapshot.fingerprint,
      manifest: run.snapshot.manifest
    }),
    preparedBatch: Object.freeze({
      schemaVersion: 1 as const,
      calls: Object.freeze([Object.freeze({
        kind: 'approval_required' as const,
        capability,
        summaryCode: 'jinyan_approval'
      })])
    }),
    interruption: Object.freeze({
      callId: capability.callId,
      argumentHash: capability.argumentHash,
      toolFingerprint: run.snapshot.fingerprint,
      requester: Object.freeze({ userId: '7', role: 'bot_master' as const })
    }),
    approvalHistory: Object.freeze([])
  } as unknown as RunCheckpoint

  const recovered = await bridge.recoverAgentRun({ checkpoint, bot })
  const recoveredContext = await recovered.binding.prepareToolContext(
    checkpoint,
    new AbortController().signal
  )
  assert.equal(recovered.snapshot.id, run.snapshot.id)
  assert.equal(recovered.snapshot.fingerprint, run.snapshot.fingerprint)
  assert.deepEqual(recoveredContext.facts.scope, {
    kind: 'group_user', groupId: '9', userId: '7'
  })
  assert.deepEqual(recoveredContext.intent.actions, ['mute'])
  assert.deepEqual(recoveredContext.intent.mentionUserIds, ['8'])
  assert.equal(recoveryImageReads, 0)

  const continuedCheckpoint = Object.freeze({
    ...checkpoint,
    interruption: null,
    preparedBatch: Object.freeze({
      schemaVersion: 1 as const,
      calls: Object.freeze([Object.freeze({
        kind: 'ready' as const,
        capability
      })])
    }),
    approvalHistory: Object.freeze([Object.freeze({
      callId: capability.callId,
      argumentHash: capability.argumentHash,
      toolFingerprint: run.snapshot.fingerprint,
      decision: Object.freeze({ kind: 'approved' as const })
    })])
  }) as unknown as RunCheckpoint
  const continuedContext = await recovered.binding.prepareToolContext(
    continuedCheckpoint,
    new AbortController().signal
  )
  assert.deepEqual(continuedContext.intent, recoveredContext.intent)

  const mismatchedActor = Object.freeze({
    ...checkpoint,
    presentationRoute: Object.freeze({
      ...(checkpoint.presentationRoute as NonNullable<RunCheckpoint['presentationRoute']>),
      actorId: '9'
    })
  }) as RunCheckpoint
  await assert.rejects(
    bridge.recoverAgentRun({ checkpoint: mismatchedActor, bot }),
    /actor identity is inconsistent/
  )

  const drifted = createYunzaiToolRuntimeBridge({
    ...baseOptions,
    config: config({
      toolPolicyProfile: 'strict',
      groupMerge: false,
      enableToolPrivateSend: true
    })
  })
  await assert.rejects(
    drifted.recoverAgentRun({ checkpoint, bot }),
    /snapshot does not match checkpoint/
  )
  assert.equal(muteCalls, 0)
})

test('external plugin facade captures sends and blocks host mutations', async () => {
  let originalSends = 0
  let originalMutes = 0
  const receiver = {
    sendMsg: async () => { originalSends += 1 },
    muteMember: async () => { originalMutes += 1 }
  }
  const event = {
    group: receiver,
    bot: {
      sendGroupMsg: async () => { originalSends += 1 },
      pickGroup: () => receiver
    }
  }
  const facade = createExternalPluginEventFacade(event)
  const image = { type: 'image', file: 'https://image.example/cat.png' }
  await facade.event.reply(image)
  await facade.event.group.sendMsg(image)
  await facade.event.bot.sendGroupMsg('9', image)
  await facade.event.bot.pickGroup('9').sendMsg(image)
  await assert.rejects(facade.event.group.muteMember('8', 60), /capability is blocked/)
  assert.throws(() => { facade.event.group.name = 'changed' }, /capability is blocked/)
  assert.equal(originalSends, 0)
  assert.equal(originalMutes, 0)
  assert.equal(facade.messages.length, 4)
})

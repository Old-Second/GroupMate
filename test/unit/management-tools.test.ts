import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthorizedToolContext, ToolRuntimeFacts, ToolTarget } from '../../src/agent/tools/tool-context.js'
import { ToolPolicyEngine, type ToolPolicyProfile } from '../../src/agent/tools/policy-engine.js'
import { validateToolInputRecord } from '../../src/agent/tools/schema-validator.js'
import type { ToolObjectSchema } from '../../src/agent/tools/tool-schema.js'
import { createManagementToolDefinitions } from '../../src/runtime/tools/tool-runtime-factory.js'
import type { QqManagementCapabilities } from '../../src/tools/management-tool-support.js'
import type { IntentAction, IntentEvidence } from '../../src/runtime/tools/intent-evidence.js'

const baseFacts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '7', role: 'member', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' },
  scope: { kind: 'group', groupId: '9' },
  botGroupRole: 'admin', actorGroupRole: 'member', targetRole: 'member',
  targetIsBotMaster: false, targetExists: true
}

function evidence (action: IntentAction, targetId: string): IntentEvidence {
  return {
    trustedSources: ['current_request'], actions: [action], mentionUserIds: [targetId],
    explicitTargetIds: [targetId], replyMessageId: action === 'recall' ? targetId : null,
    currentMessageId: 'current'
  }
}

function fixture () {
  const calls: Array<{ name: string; target: ToolTarget; value?: unknown }> = []
  const capabilities: QqManagementCapabilities = {
    muteMember: async (target, seconds) => { calls.push({ name: 'mute', target, value: seconds }) },
    kickMember: async target => { calls.push({ name: 'kick', target }) },
    setCard: async (target, card) => { calls.push({ name: 'card', target, value: card }) },
    setTitle: async (target, title) => { calls.push({ name: 'title', target, value: title }) },
    recallMessage: async target => { calls.push({ name: 'recall', target }) },
    setEssence: async (target, enabled) => { calls.push({ name: 'essence', target, value: enabled }) }
  }
  return { definitions: createManagementToolDefinitions(capabilities), calls }
}

function byName (definitions: ReturnType<typeof createManagementToolDefinitions>, name: string) {
  const definition = definitions.find(item => item.name === name)
  assert.ok(definition)
  return definition
}

function decide (options: {
  name: string
  input: Readonly<Record<string, unknown>>
  facts?: ToolRuntimeFacts
  action: IntentAction
  targetId: string
  profile?: ToolPolicyProfile
}) {
  const { definitions } = fixture()
  const definition = byName(definitions, options.name)
  const facts = options.facts ?? baseFacts
  const target = definition.resolveTarget(options.input, facts)
  return new ToolPolicyEngine().decide({
    profile: options.profile ?? 'compatible', definition, input: options.input,
    facts, target, intent: evidence(options.action, options.targetId)
  })
}

test('management tool factory exposes five side-effect definitions without untrusted authority fields', () => {
  const { definitions } = fixture()
  assert.deepEqual(definitions.map(tool => tool.name), [
    'editCard', 'jinyan', 'kickOut', 'setTitle', 'handleMsg'
  ])
  for (const definition of definitions) {
    assert.equal(definition.effect, 'side_effect')
    assert.equal(definition.idempotency, 'call')
    const schema = definition.inputSchema as ToolObjectSchema
    for (const field of ['sender', 'isAdmin', 'confirmByOwnerOrMaster']) {
      assert.equal(Object.hasOwn(schema.properties, field), false, `${definition.name}:${field}`)
    }
    assert.throws(() => validateToolInputRecord(schema, {
      ...Object.fromEntries(schema.required.map(key => [key, key === 'seconds' ? 60 : 'fixture'])),
      sender: '7'
    }))
  }
})

test('ordinary member may self-mute for at most sixty seconds', () => {
  assert.equal(decide({
    name: 'jinyan', input: { userId: '7', seconds: 60 }, action: 'mute', targetId: '7'
  }).kind, 'allow')
  for (const seconds of [61, 600]) {
    const decision = decide({
      name: 'jinyan', input: { userId: '7', seconds }, action: 'mute', targetId: '7'
    })
    assert.equal(decision.kind, 'deny')
    if (decision.kind === 'deny') assert.equal(decision.reasonCode, 'self_mute_duration_exceeded')
  }
  const unmute = decide({
    name: 'jinyan', input: { userId: '7', seconds: 0 }, action: 'unmute', targetId: '7'
  })
  assert.equal(unmute.kind, 'deny')
  if (unmute.kind === 'deny') assert.equal(unmute.reasonCode, 'self_unmute_denied')
})

test('ordinary member malicious request cannot manage another member', () => {
  for (const [name, input, action] of [
    ['jinyan', { userId: '8', seconds: 60 }, 'mute'],
    ['editCard', { userId: '8', card: 'new' }, 'edit_card'],
    ['kickOut', { userId: '8' }, 'kick']
  ] as const) {
    const decision = decide({ name, input, action, targetId: '8' })
    assert.equal(decision.kind, 'deny', name)
    if (decision.kind === 'deny') assert.equal(decision.reasonCode, 'permission_denied', name)
  }
})

test('management policy enforces target existence, protected identities and bot capability', () => {
  const rows: Array<[Partial<ToolRuntimeFacts>, string]> = [
    [{ targetExists: false }, 'target_not_found'],
    [{ targetIsBotMaster: true }, 'target_protected'],
    [{ botGroupRole: 'member' }, 'bot_permission_denied']
  ]
  for (const [override, reason] of rows) {
    const decision = decide({
      name: 'jinyan', input: { userId: '8', seconds: 60 }, action: 'mute', targetId: '8',
      facts: {
        ...baseFacts, actor: { ...baseFacts.actor, role: 'admin' }, actorGroupRole: 'admin', ...override
      }
    })
    assert.equal(decision.kind, 'deny')
    if (decision.kind === 'deny') assert.equal(decision.reasonCode, reason)
  }
})

test('owner and master hierarchy allows only reachable lower targets', () => {
  const ownerFacts: ToolRuntimeFacts = {
    ...baseFacts, actor: { ...baseFacts.actor, role: 'owner' }, actorGroupRole: 'owner'
  }
  assert.equal(decide({
    name: 'kickOut', input: { userId: '8' }, action: 'kick', targetId: '8', facts: ownerFacts
  }).kind, 'allow')
  const adminTarget = decide({
    name: 'kickOut', input: { userId: '8' }, action: 'kick', targetId: '8',
    facts: { ...ownerFacts, targetRole: 'admin' }
  })
  assert.equal(adminTarget.kind, 'deny')
  if (adminTarget.kind === 'deny') assert.equal(adminTarget.reasonCode, 'role_hierarchy_denied')

  const masterFacts: ToolRuntimeFacts = {
    ...baseFacts, actor: { ...baseFacts.actor, isBotMaster: true }
  }
  assert.equal(decide({
    name: 'kickOut', input: { userId: '8' }, action: 'kick', targetId: '8', facts: masterFacts
  }).kind, 'allow')
})

test('group administrator cannot manage an owner or peer administrator', () => {
  const adminFacts: ToolRuntimeFacts = {
    ...baseFacts, actor: { ...baseFacts.actor, role: 'admin' }, actorGroupRole: 'admin'
  }
  for (const targetRole of ['owner', 'admin'] as const) {
    const decision = decide({
      name: 'jinyan', input: { userId: '8', seconds: 60 }, action: 'mute', targetId: '8',
      facts: { ...adminFacts, targetRole }
    })
    assert.equal(decision.kind, 'deny')
    if (decision.kind === 'deny') assert.equal(decision.reasonCode, 'role_hierarchy_denied')
  }
})

test('management tools are unavailable outside the current group', () => {
  const privateFacts: ToolRuntimeFacts = {
    ...baseFacts,
    channel: { kind: 'private', botId: '10000', userId: '7' },
    scope: { kind: 'private', userId: '7' }, botGroupRole: 'none', actorGroupRole: 'none'
  }
  const decision = decide({
    name: 'jinyan', input: { userId: '7', seconds: 60 }, action: 'mute', targetId: '7',
    facts: privateFacts
  })
  assert.equal(decision.kind, 'deny')
  if (decision.kind === 'deny') assert.equal(decision.reasonCode, 'target_invalid')
})

test('message management protects current request and accepts explicit reply source', () => {
  const moderatorFacts: ToolRuntimeFacts = {
    ...baseFacts, actor: { ...baseFacts.actor, role: 'admin' }, actorGroupRole: 'admin'
  }
  const current = decide({
    name: 'handleMsg', input: { type: 'recall', messageId: 'current' },
    action: 'recall', targetId: 'current', facts: moderatorFacts
  })
  assert.equal(current.kind, 'deny')
  if (current.kind === 'deny') assert.equal(current.reasonCode, 'current_message_protected')
  assert.equal(decide({
    name: 'handleMsg', input: { type: 'recall', messageId: 'reply-1' },
    action: 'recall', targetId: 'reply-1', facts: moderatorFacts
  }).kind, 'allow')
})

test('setTitle requires bot owner before capability execution', () => {
  const ownerActor: ToolRuntimeFacts = {
    ...baseFacts, actor: { ...baseFacts.actor, role: 'owner' }, actorGroupRole: 'owner'
  }
  const denied = decide({
    name: 'setTitle', input: { userId: '8', title: 'star' },
    action: 'set_title', targetId: '8', facts: ownerActor
  })
  assert.equal(denied.kind, 'deny')
  if (denied.kind === 'deny') assert.equal(denied.reasonCode, 'bot_permission_denied')
  assert.equal(decide({
    name: 'setTitle', input: { userId: '8', title: 'star' }, action: 'set_title', targetId: '8',
    facts: { ...ownerActor, botGroupRole: 'owner' }
  }).kind, 'allow')
})

test('authorized management definition calls one narrow capability and returns background', async () => {
  const { definitions, calls } = fixture()
  const definition = byName(definitions, 'jinyan')
  const target = definition.resolveTarget({ userId: '7', seconds: 60 }, baseFacts)
  const context: AuthorizedToolContext = {
    runId: 'run-1', callId: 'call-1', snapshotId: 'snapshot-1', facts: baseFacts,
    target, signal: new AbortController().signal
  }
  const result = await definition.execute({ userId: '7', seconds: 60 }, context)
  assert.equal(result.status, 'success')
  if (result.status === 'success') assert.equal(result.effect, 'background')
  assert.deepEqual(calls, [{ name: 'mute', target: { kind: 'member', groupId: '9', userId: '7' }, value: 60 }])
})

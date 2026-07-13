import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolDefinition, ToolPermissionKind } from '../../src/agent/tools/tool-definition.js'
import type { ToolRuntimeFacts } from '../../src/agent/tools/tool-context.js'
import type { CrossChannelAccess } from '../../src/agent/tools/cross-channel-access.js'
import {
  ToolRegistry,
  ToolRegistryError,
  ToolUnavailableError
} from '../../src/agent/tools/tool-registry.js'

const noInputSchema = {
  type: 'object', properties: {}, required: [], additionalProperties: false
} as const

const memberFacts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '7', role: 'member', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' },
  scope: { kind: 'group', groupId: '9' },
  botGroupRole: 'admin',
  actorGroupRole: 'member',
  targetRole: 'none',
  targetIsBotMaster: false,
  targetExists: false
}

function definition (
  name: string,
  options: {
    aliases?: string[]
    permission?: ToolPermissionKind
    description?: string
    crossChannelAccess?: CrossChannelAccess
  } = {}
): ToolDefinition {
  return {
    name,
    version: 1,
    aliases: options.aliases ?? [],
    description: options.description ?? `${name} description`,
    inputSchema: noInputSchema,
    effect: 'read_only',
    risk: 'low',
    readOnly: true,
    destructive: false,
    idempotency: 'none',
    openWorld: false,
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    network: 'none',
    permission: options.permission ?? 'any_user',
    ...(options.crossChannelAccess === undefined ? {} : { crossChannelAccess: options.crossChannelAccess }),
    resolveTarget: () => ({ kind: 'none' }),
    execute: async () => ({ status: 'success', effect: 'none', content: [], retryable: false })
  }
}

test('registry rejects duplicate canonical names and every alias collision', () => {
  assert.throws(() => new ToolRegistry([
    definition('weather'), definition('weather')
  ]), ToolRegistryError)
  assert.throws(() => new ToolRegistry([
    definition('weather', { aliases: ['forecast'] }),
    definition('search', { aliases: ['forecast'] })
  ]), ToolRegistryError)
  assert.throws(() => new ToolRegistry([
    definition('weather', { aliases: ['search'] }), definition('search')
  ]), ToolRegistryError)
  assert.throws(() => new ToolRegistry([
    definition('weather'), definition('search', { aliases: ['weather'] })
  ]), ToolRegistryError)
})

test('registry rejects invalid definitions before snapshot creation', () => {
  assert.throws(() => new ToolRegistry([
    { ...definition('weather'), inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: true } } as never
  ]), ToolRegistryError)
  assert.throws(() => new ToolRegistry([
    definition('relay', { permission: 'cross_channel' })
  ]), ToolRegistryError)
  assert.throws(() => new ToolRegistry([{
    ...definition('relay'),
    crossChannelAccess: { private: 'everyone', group: 'disabled' }
  } as never]), ToolRegistryError)
})

test('registered definitions and model schemas ignore later source mutation', () => {
  const aliases = ['forecast']
  const properties: Record<string, { type: 'string' }> = { city: { type: 'string' } }
  const required = ['city']
  const source = {
    ...definition('weather', { aliases }),
    inputSchema: { type: 'object' as const, properties, required, additionalProperties: false as const }
  }
  const registry = new ToolRegistry([source])

  aliases.push('mutated')
  properties.secret = { type: 'string' }
  required.push('secret')
  source.description = 'mutated description'

  const snapshot = registry.createSnapshot({
    id: 'snapshot-1', facts: memberFacts, enabledTools: ['weather']
  })
  const registered = snapshot.resolve('forecast')
  assert.deepEqual(registered.definition.aliases, ['forecast'])
  assert.equal(registered.definition.description, 'weather description')
  assert.deepEqual(Object.keys((registered.definition.inputSchema as typeof source.inputSchema).properties), ['city'])
  assert.equal(Object.isFrozen(registered.definition), true)
  assert.equal(Object.isFrozen(registered.definition.inputSchema), true)
  assert.equal(Object.isFrozen(snapshot.modelTools), true)
  assert.throws(() => snapshot.resolve('mutated'), ToolUnavailableError)
})

test('snapshot is the only source for model visibility and execution', () => {
  const registry = new ToolRegistry([
    definition('weather', { aliases: ['forecast'] }),
    definition('kickOut', { permission: 'group_moderator' })
  ])
  const snapshot = registry.createSnapshot({
    id: 'snapshot-1', facts: memberFacts, enabledTools: ['weather']
  })

  assert.deepEqual(snapshot.modelTools.map(tool => tool.function.name), ['weather'])
  assert.deepEqual(snapshot.toolNames, ['weather'])
  assert.equal(snapshot.resolve('weather').definition.name, 'weather')
  assert.equal(snapshot.resolve('forecast').definition.name, 'weather')
  assert.throws(() => snapshot.resolve('kickOut'), ToolUnavailableError)
  assert.throws(() => snapshot.resolve('unknown'), ToolUnavailableError)
  assert.throws(() => snapshot.resolveCall({
    runId: 'run-1', callId: 'call-1', snapshotId: 'other',
    requestedName: 'weather', arguments: {}
  }), ToolUnavailableError)
  assert.equal(snapshot.resolveCall({
    runId: 'run-1', callId: 'call-1', snapshotId: 'snapshot-1',
    requestedName: 'forecast', arguments: {}
  }).definition.name, 'weather')
})

test('snapshots sort deterministically across registration and enablement order', () => {
  const first = new ToolRegistry([definition('zeta'), definition('alpha')]).createSnapshot({
    id: 'one', facts: memberFacts, enabledTools: ['zeta', 'alpha']
  })
  const second = new ToolRegistry([definition('alpha'), definition('zeta')]).createSnapshot({
    id: 'two', facts: memberFacts, enabledTools: ['alpha', 'zeta']
  })

  assert.deepEqual(first.toolNames, ['alpha', 'zeta'])
  assert.deepEqual(first.modelTools, second.modelTools)
})

test('snapshot filters tools by trusted scene facts', () => {
  const privateFacts: ToolRuntimeFacts = {
    ...memberFacts,
    channel: { kind: 'private', botId: '10000', userId: '7' },
    scope: { kind: 'private', userId: '7' },
    botGroupRole: 'none',
    actorGroupRole: 'none'
  }
  const registry = new ToolRegistry([
    definition('search'),
    definition('mute', { permission: 'group_moderator' }),
    definition('relay', {
      permission: 'cross_channel',
      crossChannelAccess: { private: 'master', group: 'disabled' }
    })
  ])
  const snapshot = registry.createSnapshot({
    id: 'private', facts: privateFacts, enabledTools: ['search', 'mute', 'relay']
  })
  assert.deepEqual(snapshot.toolNames, ['search'])

  const masterSnapshot = registry.createSnapshot({
    id: 'master',
    facts: { ...privateFacts, actor: { ...privateFacts.actor, isBotMaster: true } },
    enabledTools: ['search', 'mute', 'relay']
  })
  assert.deepEqual(masterSnapshot.toolNames, ['relay', 'search'])

  const ordinaryRelay = new ToolRegistry([
    definition('relay', {
      permission: 'cross_channel',
      crossChannelAccess: { private: 'everyone', group: 'master' }
    })
  ]).createSnapshot({ id: 'ordinary-relay', facts: privateFacts, enabledTools: ['relay'] })
  assert.deepEqual(ordinaryRelay.toolNames, ['relay'])

  const disabledRelay = new ToolRegistry([
    definition('relay', {
      permission: 'cross_channel',
      crossChannelAccess: { private: 'disabled', group: 'disabled' }
    })
  ]).createSnapshot({
    id: 'disabled-relay',
    facts: { ...privateFacts, actor: { ...privateFacts.actor, isBotMaster: true } },
    enabledTools: ['relay']
  })
  assert.deepEqual(disabledRelay.toolNames, [])
})

test('registry freezes cross-channel access metadata', () => {
  const access = { private: 'everyone', group: 'master' } as const
  const registry = new ToolRegistry([
    definition('relay', { permission: 'cross_channel', crossChannelAccess: access })
  ])
  const snapshot = registry.createSnapshot({ id: 'access', facts: memberFacts, enabledTools: ['relay'] })
  const registered = snapshot.resolve('relay').definition
  assert.deepEqual(registered.crossChannelAccess, access)
  assert.notEqual(registered.crossChannelAccess, access)
  assert.equal(Object.isFrozen(registered.crossChannelAccess), true)
})

test('snapshot rejects invalid identity and unknown enabled names fail closed', () => {
  const registry = new ToolRegistry([definition('weather')])
  assert.throws(() => registry.createSnapshot({
    id: '', facts: memberFacts, enabledTools: ['weather']
  }), ToolRegistryError)
  assert.throws(() => registry.createSnapshot({
    id: 'snapshot-1', facts: memberFacts, enabledTools: ['unknown']
  }), ToolRegistryError)
})

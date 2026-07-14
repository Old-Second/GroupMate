import { createHash } from 'node:crypto'
import type { ToolCall } from './tool-call.js'
import type { ToolRuntimeFacts } from './tool-context.js'
import type { ToolDefinition, ToolPermissionKind } from './tool-definition.js'
import { ToolInputError, validateToolDefinition } from './schema-validator.js'
import type { StrictToolSchema } from './tool-schema.js'
import { actorMaySendCrossChannel } from './cross-channel-access.js'
import { freezeResourceKeys } from './resource-key.js'

const snapshotIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const groupPermissions: ReadonlySet<ToolPermissionKind> = new Set([
  'self_member', 'group_moderator', 'group_owner_or_master', 'bot_group_owner'
])

export interface ModelToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: StrictToolSchema
  }
}

export interface RegisteredTool {
  readonly definition: ToolDefinition
  readonly canonicalName: string
}

export interface ToolSnapshotManifestEntry {
  readonly name: string
  readonly version: 1
  readonly schemaHash: string
  readonly policyHash: string
  readonly schedulingHash: string
}

export interface ToolSnapshot {
  readonly id: string
  readonly modelTools: readonly ModelToolDefinition[]
  readonly toolNames: readonly string[]
  readonly manifest: readonly ToolSnapshotManifestEntry[]
  readonly fingerprint: string
  resolve(requestedName: string): RegisteredTool
  resolveCall(call: ToolCall): RegisteredTool
}

export class ToolRegistryError extends TypeError {
  readonly code: 'invalid_registry' | 'invalid_snapshot'

  constructor (code: 'invalid_registry' | 'invalid_snapshot') {
    super(code === 'invalid_registry' ? 'tool registry is invalid' : 'tool snapshot is invalid')
    this.name = 'ToolRegistryError'
    this.code = code
  }
}

export class ToolUnavailableError extends Error {
  readonly code: 'tool_unavailable'

  constructor () {
    super('tool is unavailable in this snapshot')
    this.name = 'ToolUnavailableError'
    this.code = 'tool_unavailable'
  }
}

function cloneSchema (schema: StrictToolSchema): StrictToolSchema {
  if ('anyOf' in schema) {
    return Object.freeze({
      anyOf: Object.freeze(schema.anyOf.map(cloneSchema))
    })
  }
  if (schema.type === 'object') {
    const properties = Object.create(null) as Record<string, StrictToolSchema>
    for (const name of Object.keys(schema.properties).sort()) {
      properties[name] = cloneSchema(schema.properties[name])
    }
    return Object.freeze({
      type: 'object',
      properties: Object.freeze(properties),
      required: Object.freeze([...schema.required]),
      additionalProperties: false
    })
  }
  if (schema.type === 'array') {
    return Object.freeze({ type: 'array', items: cloneSchema(schema.items) })
  }
  if ('enum' in schema && schema.enum !== undefined) {
    if (schema.type === 'string') return Object.freeze({ type: 'string', enum: Object.freeze([...schema.enum]) })
    if (schema.type === 'boolean') return Object.freeze({ type: 'boolean', enum: Object.freeze([...schema.enum]) })
    return Object.freeze({ type: schema.type, enum: Object.freeze([...schema.enum]) })
  }
  return Object.freeze({ type: schema.type }) as StrictToolSchema
}

function cloneDefinition (source: ToolDefinition): ToolDefinition {
  const resolveResourceKeys = source.resourceKeys
  const definition: ToolDefinition = {
    name: source.name,
    version: 1,
    aliases: Object.freeze([...source.aliases]),
    description: source.description,
    inputSchema: cloneSchema(source.inputSchema),
    effect: source.effect,
    risk: source.risk,
    readOnly: source.readOnly,
    destructive: source.destructive,
    idempotency: source.idempotency,
    openWorld: source.openWorld,
    timeoutMs: source.timeoutMs,
    maxOutputBytes: source.maxOutputBytes,
    network: source.network,
    permission: source.permission,
    executionClass: source.executionClass,
    retrySafe: source.retrySafe,
    ...(source.crossChannelAccess === undefined
      ? {}
      : { crossChannelAccess: Object.freeze({ ...source.crossChannelAccess }) }),
    resourceKeys: (input, facts) => freezeResourceKeys(resolveResourceKeys(input, facts)),
    resolveTarget: source.resolveTarget,
    execute: source.execute
  }
  return Object.freeze(definition)
}

function sha256 (value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function manifestEntry (definition: ToolDefinition): ToolSnapshotManifestEntry {
  return Object.freeze({
    name: definition.name,
    version: 1,
    schemaHash: sha256(definition.inputSchema),
    policyHash: sha256({
      effect: definition.effect,
      risk: definition.risk,
      readOnly: definition.readOnly,
      destructive: definition.destructive,
      idempotency: definition.idempotency,
      openWorld: definition.openWorld,
      timeoutMs: definition.timeoutMs,
      maxOutputBytes: definition.maxOutputBytes,
      network: definition.network,
      permission: definition.permission,
      crossChannelAccess: definition.crossChannelAccess ?? null
    }),
    schedulingHash: sha256({
      executionClass: definition.executionClass,
      retrySafe: definition.retrySafe
    })
  })
}

function visibleInScene (definition: ToolDefinition, facts: ToolRuntimeFacts): boolean {
  if (groupPermissions.has(definition.permission) && facts.channel.kind !== 'group') return false
  if (definition.permission === 'cross_channel') {
    const access = definition.crossChannelAccess
    return access !== undefined && (
      actorMaySendCrossChannel(access, 'private', facts.actor.isBotMaster) ||
      actorMaySendCrossChannel(access, 'group', facts.actor.isBotMaster)
    )
  }
  return true
}

function modelDefinition (definition: ToolDefinition): ModelToolDefinition {
  return Object.freeze({
    type: 'function' as const,
    function: Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema
    })
  })
}

export class ToolRegistry {
  readonly #definitions: ReadonlyMap<string, RegisteredTool>
  readonly #canonical: ReadonlyMap<string, RegisteredTool>

  constructor (definitions: readonly ToolDefinition[]) {
    const names = new Map<string, RegisteredTool>()
    const canonical = new Map<string, RegisteredTool>()
    try {
      for (const source of definitions) {
        validateToolDefinition(source)
        const definition = cloneDefinition(source)
        const registered = Object.freeze({ definition, canonicalName: definition.name })
        for (const name of [definition.name, ...definition.aliases]) {
          if (names.has(name)) throw new ToolRegistryError('invalid_registry')
          names.set(name, registered)
        }
        canonical.set(definition.name, registered)
      }
    } catch (error) {
      if (error instanceof ToolRegistryError) throw error
      if (error instanceof ToolInputError) throw new ToolRegistryError('invalid_registry')
      throw error
    }
    this.#definitions = names
    this.#canonical = canonical
  }

  createSnapshot (input: {
    readonly id: string
    readonly facts: ToolRuntimeFacts
    readonly enabledTools: readonly string[]
  }): ToolSnapshot {
    if (!snapshotIdPattern.test(input.id) || !Array.isArray(input.enabledTools)) {
      throw new ToolRegistryError('invalid_snapshot')
    }
    const selected = new Map<string, RegisteredTool>()
    for (const name of input.enabledTools) {
      const registered = this.#canonical.get(name)
      if (registered === undefined) throw new ToolRegistryError('invalid_snapshot')
      if (visibleInScene(registered.definition, input.facts)) selected.set(name, registered)
    }
    const registeredTools = [...selected.values()]
      .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'en'))
    const visibleNames = new Map<string, RegisteredTool>()
    for (const registered of registeredTools) {
      visibleNames.set(registered.definition.name, registered)
      for (const alias of registered.definition.aliases) visibleNames.set(alias, registered)
    }
    const id = input.id
    const toolNames = Object.freeze(registeredTools.map(tool => tool.canonicalName))
    const modelTools = Object.freeze(registeredTools.map(tool => modelDefinition(tool.definition)))
    const manifest = Object.freeze(registeredTools.map(tool => manifestEntry(tool.definition)))
    const fingerprint = sha256(manifest)

    return Object.freeze({
      id,
      toolNames,
      modelTools,
      manifest,
      fingerprint,
      resolve (requestedName: string): RegisteredTool {
        const registered = visibleNames.get(requestedName)
        if (registered === undefined) throw new ToolUnavailableError()
        return registered
      },
      resolveCall (call: ToolCall): RegisteredTool {
        if (call.snapshotId !== id) throw new ToolUnavailableError()
        const registered = visibleNames.get(call.requestedName)
        if (registered === undefined) throw new ToolUnavailableError()
        return registered
      }
    })
  }
}

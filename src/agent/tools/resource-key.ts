import { createHash } from 'node:crypto'
import type { ToolRuntimeFacts } from './tool-context.js'

export const resourceKeyPattern = /^[a-z][a-z0-9_.:-]{0,127}$/
const resourceKindPattern = /^[a-z][a-z0-9_.-]{0,31}$/
const maxResourceKeys = 8

function stableValue (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, member]) => [key, stableValue(member)])
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return value.toString()
  return value
}

function stableString (value: unknown): string {
  try {
    return JSON.stringify(stableValue(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

export function resourceKey (kind: string, ...sensitiveParts: readonly string[]): string {
  if (!resourceKindPattern.test(kind)) throw new TypeError('invalid resource key kind')
  const digest = createHash('sha256')
    .update(JSON.stringify(sensitiveParts))
    .digest('hex')
    .slice(0, 24)
  return `${kind}:${digest}`
}

export function freezeResourceKeys (keys: readonly string[]): readonly string[] {
  if (!Array.isArray(keys) || keys.length > maxResourceKeys ||
    keys.some(key => typeof key !== 'string' || !resourceKeyPattern.test(key)) ||
    new Set(keys).size !== keys.length) {
    throw new TypeError('invalid resource keys')
  }
  return Object.freeze([...keys])
}

export function readResourceKeys (
  toolName: string,
  input: Readonly<Record<string, unknown>>
): readonly string[] {
  return freezeResourceKeys([resourceKey('read', toolName, stableString(input))])
}

export function channelResourceKey (
  facts: ToolRuntimeFacts,
  kind: 'group' | 'private',
  targetId: string
): string {
  return resourceKey('channel', facts.botId, kind, targetId)
}

export function currentChannelResourceKeys (
  _input: Readonly<Record<string, unknown>>,
  facts: ToolRuntimeFacts
): readonly string[] {
  return freezeResourceKeys([
    facts.channel.kind === 'group'
      ? channelResourceKey(facts, 'group', facts.channel.groupId)
      : channelResourceKey(facts, 'private', facts.channel.userId)
  ])
}

export function memberResourceKeys (
  input: Readonly<Record<string, unknown>>,
  facts: ToolRuntimeFacts
): readonly string[] {
  if (facts.channel.kind !== 'group') return freezeResourceKeys([])
  const userId = String(input.userId ?? '').trim() || facts.actor.userId
  return freezeResourceKeys([
    channelResourceKey(facts, 'group', facts.channel.groupId),
    resourceKey('member', facts.botId, facts.channel.groupId, userId)
  ])
}

export function messageResourceKeys (
  input: Readonly<Record<string, unknown>>,
  facts: ToolRuntimeFacts
): readonly string[] {
  if (facts.channel.kind !== 'group') return freezeResourceKeys([])
  return freezeResourceKeys([
    channelResourceKey(facts, 'group', facts.channel.groupId),
    resourceKey('message', facts.botId, facts.channel.groupId, String(input.messageId ?? '').trim())
  ])
}

export function crossChannelResourceKeys (
  input: Readonly<Record<string, unknown>>,
  facts: ToolRuntimeFacts
): readonly string[] {
  const kind = input.targetKind === 'group' ? 'group' : input.targetKind === 'private' ? 'private' : null
  if (kind === null) return freezeResourceKeys([])
  return freezeResourceKeys([
    channelResourceKey(facts, kind, String(input.targetId ?? '').trim())
  ])
}

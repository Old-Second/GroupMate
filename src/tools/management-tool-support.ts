import type { ToolRuntimeFacts, ToolTarget } from '../agent/tools/tool-context.js'
import type { ToolDefinition, ToolPermissionKind } from '../agent/tools/tool-definition.js'
import type { ToolResult } from '../agent/tools/tool-result.js'
import type { StrictToolSchema } from '../agent/tools/tool-schema.js'

export type MemberTarget = Extract<ToolTarget, { readonly kind: 'member' }>
export type MessageTarget = Extract<ToolTarget, { readonly kind: 'message' }>

export interface QqManagementCapabilities {
  muteMember(target: MemberTarget, seconds: number, signal: AbortSignal): Promise<void>
  kickMember(target: MemberTarget, signal: AbortSignal): Promise<void>
  setCard(target: MemberTarget, card: string, signal: AbortSignal): Promise<void>
  setTitle(target: MemberTarget, title: string, signal: AbortSignal): Promise<void>
  recallMessage(target: MessageTarget, signal: AbortSignal): Promise<void>
  setEssence(target: MessageTarget, enabled: boolean, signal: AbortSignal): Promise<void>
}

export function groupId (facts: ToolRuntimeFacts): string {
  return facts.channel.kind === 'group' ? facts.channel.groupId : ''
}

export function memberTarget (
  input: Readonly<Record<string, unknown>>,
  facts: ToolRuntimeFacts
): MemberTarget {
  const selected = String(input.userId ?? '').trim() || facts.actor.userId
  return Object.freeze({ kind: 'member', groupId: groupId(facts), userId: selected })
}

export function messageTarget (
  input: Readonly<Record<string, unknown>>,
  facts: ToolRuntimeFacts
): MessageTarget {
  return Object.freeze({
    kind: 'message', groupId: groupId(facts), messageId: String(input.messageId ?? '').trim()
  })
}

export function managementSuccess (message: string): ToolResult {
  return Object.freeze({
    status: 'success', effect: 'background',
    content: Object.freeze([{ type: 'text' as const, text: message }]), retryable: false
  })
}

export function managementDefinition (input: {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly inputSchema: StrictToolSchema
  readonly permission: ToolPermissionKind
  readonly destructive?: boolean
  readonly resolveTarget: ToolDefinition['resolveTarget']
  readonly execute: ToolDefinition['execute']
}): ToolDefinition {
  return Object.freeze({
    name: input.name, version: 1, aliases: Object.freeze([...(input.aliases ?? [])]),
    description: input.description, inputSchema: input.inputSchema,
    effect: 'side_effect', risk: 'high', readOnly: false,
    destructive: input.destructive ?? false, idempotency: 'semantic', openWorld: false,
    timeoutMs: 10_000, maxOutputBytes: 4 * 1024, network: 'none',
    permission: input.permission, resolveTarget: input.resolveTarget, execute: input.execute
  })
}

export function asMemberTarget (target: ToolTarget): MemberTarget | null {
  return target.kind === 'member' ? target : null
}

export function asMessageTarget (target: ToolTarget): MessageTarget | null {
  return target.kind === 'message' ? target : null
}

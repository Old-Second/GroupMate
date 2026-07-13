import type { ToolRuntimeFacts, ToolTarget } from '../agent/tools/tool-context.js'
import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import type { ToolResult } from '../agent/tools/tool-result.js'
import type { StrictToolSchema } from '../agent/tools/tool-schema.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import type { CrossChannelAccess } from '../agent/tools/cross-channel-access.js'

export type ToolResource =
  | {
      readonly kind: 'buffer'
      readonly data: Uint8Array
      readonly mimeType: string
      readonly byteLength: number
    }
  | {
      readonly kind: 'remote_url'
      readonly url: string
      readonly mimeType: string
      readonly byteLength: number
    }
  | {
      readonly kind: 'local_path'
      readonly path: string
      readonly mimeType: string
      readonly byteLength: number
    }

export interface MusicShare {
  readonly provider: '163'
  readonly id: string
}

export interface QqSendCapabilities {
  sendText(target: ToolTarget, text: string, signal: AbortSignal): Promise<void>
  sendImage(target: ToolTarget, resource: ToolResource, signal: AbortSignal): Promise<void>
  sendAudio(target: ToolTarget, resource: ToolResource, signal: AbortSignal): Promise<void>
  sendVideo(target: ToolTarget, resource: ToolResource, signal: AbortSignal): Promise<void>
  sendMusic(target: ToolTarget, music: MusicShare, signal: AbortSignal): Promise<void>
  sendDice(target: ToolTarget, signal: AbortSignal): Promise<void>
  sendRps(target: ToolTarget, value: 1 | 2 | 3, signal: AbortSignal): Promise<void>
}

export interface VideoResolution {
  readonly id: string
  readonly shareText: string
  readonly videoUrl?: string
}

export interface VisibleToolServices {
  readonly policyFetch: PolicyFetch
  readonly qq: QqSendCapabilities
  readonly generateImage: (prompt: string, signal: AbortSignal) => Promise<ToolResource>
  readonly processImage: (
    resource: ToolResource,
    type: 'hed' | 'scribble',
    signal: AbortSignal
  ) => Promise<ToolResource>
  readonly synthesizeAudio: (text: string, voice: string, signal: AbortSignal) => Promise<ToolResource>
  readonly resolveVideo: (id: string, signal: AbortSignal) => Promise<VideoResolution>
  readonly drawingAvailable: boolean
  readonly pictureProcessingAvailable: boolean
  readonly ttsAvailable: boolean
  readonly videoDownloadEnabled: boolean
  readonly videoMaxBytes: number
  readonly crossChannelAccess: CrossChannelAccess
}

export function currentChannelTarget (facts: ToolRuntimeFacts): ToolTarget {
  return facts.channel.kind === 'group'
    ? Object.freeze({ kind: 'group' as const, groupId: facts.channel.groupId })
    : Object.freeze({ kind: 'private' as const, userId: facts.channel.userId })
}

export function visibleResult (message: string): ToolResult {
  return Object.freeze({
    status: 'success', effect: 'visible',
    content: Object.freeze([{ type: 'text' as const, text: message }]), retryable: false
  })
}

export function backgroundResourceResult (resource: ToolResource, callId: string): ToolResult {
  const resourceId = resource.kind === 'remote_url'
    ? resource.url
    : resource.kind === 'local_path'
      ? resource.path
      : `runtime:${callId}`
  return Object.freeze({
    status: 'success', effect: 'background',
    content: Object.freeze([{
      type: 'resource_ref' as const,
      resourceType: 'image', resourceId, mimeType: resource.mimeType
    }]),
    retryable: false
  })
}

export function executionFailure (message = '工具执行失败。'): ToolResult {
  return Object.freeze({
    status: 'failed', effect: 'none', errorCode: 'tool_execution_failed',
    userMessage: message, retryable: false
  })
}

export function cancelledResult (): ToolResult {
  return Object.freeze({
    status: 'failed', effect: 'none', errorCode: 'tool_cancelled',
    userMessage: '工具执行已取消。', retryable: false
  })
}

export function indeterminateResult (): ToolResult {
  return Object.freeze({
    status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
    userMessage: '部分操作可能已完成，结果暂时无法确认。', retryable: false
  })
}

export function visibleDefinition (input: {
  readonly name: string
  readonly description: string
  readonly inputSchema: StrictToolSchema
  readonly network?: 'none' | 'fixed_hosts' | 'open_http'
  readonly maxOutputBytes?: number
  readonly execute: ToolDefinition['execute']
}): ToolDefinition {
  return Object.freeze({
    name: input.name, version: 1, aliases: Object.freeze([]),
    description: input.description, inputSchema: input.inputSchema,
    effect: 'visible_output', risk: 'medium', readOnly: false, destructive: false,
    idempotency: 'call', openWorld: input.network === 'open_http',
    timeoutMs: 30_000, maxOutputBytes: input.maxOutputBytes ?? 16 * 1024,
    network: input.network ?? 'none', permission: 'current_channel',
    resolveTarget: (_toolInput: Readonly<Record<string, unknown>>, facts: ToolRuntimeFacts) => currentChannelTarget(facts),
    execute: input.execute
  })
}

export function crossChannelDefinition (input: {
  readonly inputSchema: StrictToolSchema
  readonly crossChannelAccess: CrossChannelAccess
  readonly execute: ToolDefinition['execute']
}): ToolDefinition {
  return Object.freeze({
    name: 'sendMessage', version: 1, aliases: Object.freeze([]),
    description: '向明确指定的其他群或用户发送一条文本消息。',
    inputSchema: input.inputSchema,
    effect: 'side_effect', risk: 'high', readOnly: false, destructive: false,
    idempotency: 'semantic', openWorld: false, timeoutMs: 10_000,
    maxOutputBytes: 4 * 1024, network: 'none', permission: 'cross_channel',
    crossChannelAccess: Object.freeze({ ...input.crossChannelAccess }),
    resolveTarget: (toolInput: Readonly<Record<string, unknown>>) => toolInput.targetKind === 'group'
      ? Object.freeze({ kind: 'group' as const, groupId: String(toolInput.targetId) })
      : Object.freeze({ kind: 'private' as const, userId: String(toolInput.targetId) }),
    execute: input.execute
  })
}

export function resourceFromBytes (body: Uint8Array, mimeType: string): ToolResource {
  return Object.freeze({ kind: 'buffer', data: body, mimeType, byteLength: body.byteLength })
}

export function validResource (resource: ToolResource, maxBytes = 8 * 1024 * 1024): boolean {
  return Number.isSafeInteger(resource.byteLength) && resource.byteLength >= 0 &&
    resource.byteLength <= maxBytes && typeof resource.mimeType === 'string' && resource.mimeType.length <= 256 &&
    ((resource.kind === 'buffer' && resource.data.byteLength === resource.byteLength) ||
      (resource.kind === 'remote_url' && resource.url.length > 0 && resource.url.length <= 4_096) ||
      (resource.kind === 'local_path' && resource.path.length > 0 && resource.path.length <= 4_096))
}

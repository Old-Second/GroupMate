import type { ToolRuntimeFacts, ToolTarget } from '../agent/tools/tool-context.js'
import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import type { ToolResult } from '../agent/tools/tool-result.js'
import type { StrictToolSchema } from '../agent/tools/tool-schema.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import type { CrossChannelAccess } from '../agent/tools/cross-channel-access.js'
import type { SessionAddress } from '../agent/contracts/identity.js'
import type { DeliveryResult } from '../runtime/presentation/presentation-result.js'
import type { AuthorizedToolContext } from '../agent/tools/tool-context.js'
import { isToolResult, openImagePolicy, request } from './query-tool-support.js'
import {
  crossChannelResourceKeys,
  currentChannelResourceKeys
} from '../agent/tools/resource-key.js'

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
  sendText(target: SessionAddress, text: string, signal: AbortSignal): Promise<DeliveryResult<'text'>>
  sendImage(target: SessionAddress, resource: ToolResource, signal: AbortSignal): Promise<DeliveryResult<'picture'>>
  sendAudio(target: SessionAddress, resource: ToolResource, signal: AbortSignal): Promise<DeliveryResult<'voice'>>
  sendVideo(target: SessionAddress, resource: ToolResource, signal: AbortSignal): Promise<DeliveryResult<'video'>>
  sendMusic(target: SessionAddress, music: MusicShare, signal: AbortSignal): Promise<DeliveryResult<'music'>>
  sendDice(target: SessionAddress, signal: AbortSignal): Promise<DeliveryResult<'dice'>>
  sendRps(target: SessionAddress, value: 1 | 2 | 3, signal: AbortSignal): Promise<DeliveryResult<'rps'>>
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

export function sessionAddressForTarget (
  botId: string,
  target: ToolTarget
): SessionAddress | null {
  if (target.kind === 'group') {
    return Object.freeze({
      botId,
      scope: Object.freeze({ kind: 'group' as const, groupId: target.groupId })
    })
  }
  if (target.kind === 'private') {
    return Object.freeze({
      botId,
      scope: Object.freeze({ kind: 'private' as const, userId: target.userId })
    })
  }
  return null
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

export function visibleDeliveryResult (
  delivery: DeliveryResult,
  successMessage: string,
  failureMessage = '工具执行失败。'
): ToolResult {
  if (delivery.kind === 'sent') return visibleResult(successMessage)
  if (delivery.kind === 'outcome_unknown') return indeterminateResult()
  return executionFailure(failureMessage)
}

export async function dispatchVisible (
  dispatch: () => Promise<DeliveryResult>,
  successMessage: string,
  failureMessage: string
): Promise<ToolResult> {
  try {
    return visibleDeliveryResult(await dispatch(), successMessage, failureMessage)
  } catch {
    return indeterminateResult()
  }
}

export function visibleDefinition (input: {
  readonly name: string
  readonly description: string
  readonly inputSchema: StrictToolSchema
  readonly network?: 'none' | 'fixed_hosts' | 'open_http'
  readonly maxOutputBytes?: number
  readonly resourceKeys: typeof currentChannelResourceKeys
  readonly execute: ToolDefinition['execute']
}): ToolDefinition {
  return Object.freeze({
    name: input.name, version: 1, aliases: Object.freeze([]),
    description: input.description, inputSchema: input.inputSchema,
    effect: 'visible_output', risk: 'medium', readOnly: false, destructive: false,
    idempotency: 'call', openWorld: input.network === 'open_http',
    timeoutMs: 30_000, maxOutputBytes: input.maxOutputBytes ?? 16 * 1024,
    network: input.network ?? 'none', permission: 'current_channel',
    executionClass: 'visible_output', retrySafe: false,
    resourceKeys: input.resourceKeys,
    resolveTarget: (_toolInput: Readonly<Record<string, unknown>>, facts: ToolRuntimeFacts) => currentChannelTarget(facts),
    execute: input.execute
  })
}

export function crossChannelDefinition (input: {
  readonly inputSchema: StrictToolSchema
  readonly crossChannelAccess: CrossChannelAccess
  readonly resourceKeys: typeof crossChannelResourceKeys
  readonly execute: ToolDefinition['execute']
}): ToolDefinition {
  return Object.freeze({
    name: 'sendMessage', version: 1, aliases: Object.freeze([]),
    description: '向明确指定的其他群或用户发送一条文本消息。',
    inputSchema: input.inputSchema,
    effect: 'side_effect', risk: 'high', readOnly: false, destructive: false,
    idempotency: 'semantic', openWorld: false, timeoutMs: 10_000,
    maxOutputBytes: 4 * 1024, network: 'none', permission: 'cross_channel',
    executionClass: 'side_effect', retrySafe: false,
    resourceKeys: input.resourceKeys,
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

/** Download failures are definite; a dispatched QQ operation is never replayed. */
export async function sendRemoteImages (
  services: VisibleToolServices,
  urls: readonly string[],
  context: AuthorizedToolContext,
  label: '图片' | '头像'
): Promise<ToolResult> {
  const target = sessionAddressForTarget(context.facts.botId, context.target)
  if (target === null) return executionFailure(`${label}发送失败。`)
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  context.signal.addEventListener('abort', abort, { once: true })
  if (context.signal.aborted) abort()
  // Covers both downloading and dispatch, leaving time to commit before 30s.
  const deadline = Date.now() + 25_000
  const timer = setTimeout(abort, 25_000)
  let sent = 0
  let dispatching = false
  let lastFailure: ToolResult = executionFailure(`${label}暂时无法读取。`)
  const unit = label === '头像' ? '个' : '张'
  const confirmed = (): ToolResult => visibleResult(sent === urls.length
    ? `已发送 ${sent} ${unit}${label}。`
    : `已发送 ${sent} ${unit}${label}，其余${label}暂时无法发送。`)
  try {
    for (const url of urls) {
      if (controller.signal.aborted || Date.now() >= deadline) return sent > 0 ? confirmed() : cancelledResult()
      const fetched = await request(services.policyFetch, {
        url, policy: openImagePolicy, timeoutMs: Math.max(100, Math.min(8_000, deadline - Date.now())),
        signal: controller.signal, diagnosticTag: 'image_fetch'
      })
      if (isToolResult(fetched)) {
        lastFailure = fetched
        continue
      }
      if (fetched.status < 200 || fetched.status >= 300) {
        lastFailure = executionFailure(`${label}暂时无法读取。`)
        continue
      }
      if (controller.signal.aborted) return sent > 0 ? confirmed() : cancelledResult()
      dispatching = true
      const delivery = await services.qq.sendImage(
        target, resourceFromBytes(fetched.body, fetched.contentType), controller.signal
      )
      dispatching = false
      if (delivery.kind === 'outcome_unknown') return indeterminateResult()
      if (delivery.kind === 'failed_definite') return sent > 0 ? confirmed() : executionFailure(`${label}发送失败。`)
      sent += 1
    }
    return sent > 0 ? confirmed() : lastFailure
  } catch {
    if (dispatching) return indeterminateResult()
    if (sent > 0) return confirmed()
    return context.signal.aborted ? cancelledResult() : executionFailure(`${label}发送失败。`)
  } finally {
    clearTimeout(timer)
    context.signal.removeEventListener('abort', abort)
  }
}

export function validResource (resource: ToolResource, maxBytes = 8 * 1024 * 1024): boolean {
  return Number.isSafeInteger(resource.byteLength) && resource.byteLength >= 0 &&
    resource.byteLength <= maxBytes && typeof resource.mimeType === 'string' && resource.mimeType.length <= 256 &&
    ((resource.kind === 'buffer' && resource.data.byteLength === resource.byteLength) ||
      (resource.kind === 'remote_url' && resource.url.length > 0 && resource.url.length <= 4_096) ||
      (resource.kind === 'local_path' && resource.path.length > 0 && resource.path.length <= 4_096))
}

import { NetworkPolicyError, type NetworkRequestPolicy } from '../agent/tools/network-policy.js'
import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import type { ToolResult } from '../agent/tools/tool-result.js'
import type { StrictToolSchema } from '../agent/tools/tool-schema.js'
import { PolicyFetch, type PolicyResponse } from '../runtime/tools/policy-fetch.js'

export const jsonContentTypes = ['application/json'] as const
export const webContentTypes = [
  'text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'
] as const

export function clampInteger (value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), minimum), maximum)
    : fallback
}

export function textResult (text: string): ToolResult {
  return Object.freeze({
    status: 'success', effect: 'none',
    content: Object.freeze([{ type: 'text' as const, text }]), retryable: false
  })
}

export function configurationFailure (message: string): ToolResult {
  return Object.freeze({
    status: 'failed', effect: 'none', errorCode: 'configuration_missing',
    userMessage: message, retryable: false
  })
}

export function upstreamFailure (message: string, retryable = true): ToolResult {
  return Object.freeze({
    status: 'failed', effect: 'none', errorCode: 'upstream_unavailable',
    userMessage: message, retryable
  })
}

export function invalidArguments (message: string): ToolResult {
  return Object.freeze({
    status: 'denied', effect: 'none', reasonCode: 'invalid_arguments',
    userMessage: message, retryable: false
  })
}

export function targetNotFound (message: string): ToolResult {
  return Object.freeze({
    status: 'denied', effect: 'none', reasonCode: 'target_not_found',
    userMessage: message, retryable: false
  })
}

export function fixedOriginPolicy (
  input: string,
  pathPrefixes: readonly string[],
  allowedContentTypes: readonly string[] = jsonContentTypes,
  maxBytes = 256 * 1024
): { readonly origin: string; readonly policy: NetworkRequestPolicy } {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TypeError('fixed API origin is invalid')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    throw new TypeError('fixed API origin is invalid')
  }
  const port = url.port === '' ? 443 : Number(url.port)
  return Object.freeze({
    origin: url.origin,
    policy: Object.freeze({
      kind: 'fixed_hosts' as const,
      hosts: Object.freeze([Object.freeze({ hostname: url.hostname, port, pathPrefixes: Object.freeze([...pathPrefixes]) })]),
      maxBytes,
      allowedContentTypes: Object.freeze([...allowedContentTypes])
    })
  })
}

export const openWebPolicy: NetworkRequestPolicy = Object.freeze({
  kind: 'open_http' as const,
  maxBytes: 1024 * 1024,
  allowedContentTypes: Object.freeze([...webContentTypes])
})

export const openImagePolicy: NetworkRequestPolicy = Object.freeze({
  kind: 'open_http' as const,
  maxBytes: 8 * 1024 * 1024,
  allowedContentTypes: Object.freeze(['image/*'])
})

export async function request (
  policyFetch: PolicyFetch,
  options: Parameters<PolicyFetch['request']>[0]
): Promise<PolicyResponse | ToolResult> {
  try {
    return await policyFetch.request(options)
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      if (error.code === 'network_cancelled') {
        return Object.freeze({
          status: 'failed', effect: 'none', errorCode: 'tool_cancelled',
          userMessage: '工具请求已取消。', retryable: false
        })
      }
      if (error.code === 'network_timeout') {
        return Object.freeze({
          status: 'failed', effect: 'none', errorCode: 'tool_timeout',
          userMessage: '工具请求超时。', retryable: true
        })
      }
    }
    return upstreamFailure('上游服务暂时不可用。')
  }
}

export function isToolResult (value: unknown): value is ToolResult {
  return value !== null && typeof value === 'object' && 'effect' in value && 'status' in value
}

export function decodeText (response: PolicyResponse): string {
  return Buffer.from(response.body).toString('utf8')
}

export function parseJsonResponse (response: PolicyResponse): unknown | ToolResult {
  if (response.status < 200 || response.status >= 300) return upstreamFailure('上游服务暂时不可用。')
  try {
    return JSON.parse(decodeText(response)) as unknown
  } catch {
    return upstreamFailure('上游服务返回了无法解析的数据。', false)
  }
}

export function boundedText (value: unknown, maxCharacters: number): string {
  const text = typeof value === 'string' ? value : ''
  return text.length <= maxCharacters ? text : `${text.slice(0, maxCharacters)}…`
}

export function boundedJson (value: unknown, maxCharacters = 12_000): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = 'null'
  }
  return serialized.length <= maxCharacters ? serialized : `${serialized.slice(0, maxCharacters)}…`
}

export function readOnlyDefinition (input: {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly inputSchema: StrictToolSchema
  readonly network: 'none' | 'fixed_hosts' | 'open_http'
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly execute: ToolDefinition['execute']
}): ToolDefinition {
  return Object.freeze({
    name: input.name,
    version: 1,
    aliases: Object.freeze([...(input.aliases ?? [])]),
    description: input.description,
    inputSchema: input.inputSchema,
    effect: 'read_only',
    risk: 'low',
    readOnly: true,
    destructive: false,
    idempotency: 'none',
    openWorld: input.network === 'open_http',
    timeoutMs: input.timeoutMs ?? 10_000,
    maxOutputBytes: input.maxOutputBytes ?? 16 * 1024,
    network: input.network,
    permission: 'any_user',
    resolveTarget: () => Object.freeze({ kind: 'none' as const }),
    execute: input.execute
  })
}

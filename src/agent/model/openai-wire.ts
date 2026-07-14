import type { JsonObject } from './json-value.js'
import { modelProtocolError } from './model-adapter.js'

export interface OpenAIHeadersLike {
  get(name: string): string | null
}

export interface OpenAIReadableStreamReaderLike {
  read(): Promise<{ done: boolean; value?: unknown }>
  cancel?(reason?: unknown): Promise<void>
  releaseLock?(): void
}

export interface OpenAIResponseBodyLike {
  readonly [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
  getReader?(): OpenAIReadableStreamReaderLike
}

export interface OpenAIResponseLike {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers?: OpenAIHeadersLike
  readonly body?: OpenAIResponseBodyLike | null
  arrayBuffer?(): Promise<ArrayBuffer>
  text?(): Promise<string>
}

export interface OpenAIFetchInit {
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal: AbortSignal
}

export type OpenAIFetch = (
  url: string,
  init: OpenAIFetchInit
) => Promise<OpenAIResponseLike>

export interface BoundedOpenAIWireError {
  readonly status: number
  readonly statusText: string
  readonly body: string
  readonly truncated: boolean
  readonly providerCode?: string
}

export interface BoundedResponseText {
  readonly text: string
  readonly truncated: boolean
}

const SAFE_PROVIDER_CODE = /^[a-z0-9_.:-]{1,128}$/i

function toBytes (value: unknown): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value)
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw modelProtocolError('invalid_response_chunk')
}

export async function * iterateResponseBytes (
  response: OpenAIResponseLike,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  if (signal.aborted) throw signal.reason
  const body = response.body
  if (body?.getReader) {
    const reader = body.getReader()
    try {
      while (true) {
        if (signal.aborted) throw signal.reason
        const next = await reader.read()
        if (next.done) return
        if (next.value !== undefined) yield toBytes(next.value)
      }
    } finally {
      reader.releaseLock?.()
    }
  }
  if (body?.[Symbol.asyncIterator]) {
    for await (const chunk of body as Required<Pick<OpenAIResponseBodyLike, typeof Symbol.asyncIterator>>) {
      if (signal.aborted) throw signal.reason
      yield toBytes(chunk)
    }
    return
  }
  if (response.arrayBuffer) {
    yield new Uint8Array(await response.arrayBuffer())
    return
  }
  if (response.text) {
    yield Buffer.from(await response.text())
    return
  }
  throw modelProtocolError('missing_response_body')
}

export async function readBoundedResponseText (
  response: OpenAIResponseLike,
  signal: AbortSignal,
  maxBytes: number,
  options: Readonly<{ truncate?: boolean; overflowReason: string }>
): Promise<BoundedResponseText> {
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for await (const chunk of iterateResponseBytes(response, signal)) {
    const remaining = maxBytes - total
    if (chunk.byteLength > remaining) {
      if (!options.truncate) throw modelProtocolError(options.overflowReason)
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      total = maxBytes
      truncated = true
      break
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  return Object.freeze({
    text: new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))),
    truncated
  })
}

function sanitizeWireText (value: string, maxLength: number): string {
  return value
    .slice(0, maxLength)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
}

function extractProviderCode (body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const nested = record.error ?? record.detail
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return undefined
    const code = (nested as Record<string, unknown>).code
    return typeof code === 'string' && SAFE_PROVIDER_CODE.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

export async function readBoundedWireError (
  response: OpenAIResponseLike,
  signal: AbortSignal,
  maxBytes: number
): Promise<BoundedOpenAIWireError> {
  const bounded = await readBoundedResponseText(response, signal, maxBytes, {
    truncate: true,
    overflowReason: 'error_body_too_large'
  })
  const body = sanitizeWireText(bounded.text, maxBytes)
  return Object.freeze({
    status: response.status,
    statusText: sanitizeWireText(response.statusText, 128),
    body,
    truncated: bounded.truncated,
    providerCode: extractProviderCode(body)
  })
}

export function asWireRecord (value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw modelProtocolError(reason)
  }
  return value as Record<string, unknown>
}

export function asWireJsonObject (value: unknown, reason: string): JsonObject {
  return asWireRecord(value, reason) as JsonObject
}

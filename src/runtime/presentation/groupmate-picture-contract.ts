import type {
  CitationForward,
  ReasoningView
} from './reply-content.js'
import { qrCodeBrowserScript } from './qr-code-svg.js'

export interface GroupMatePictureDocumentV1 {
  readonly schemaVersion: 1
  readonly replyText: string
  readonly citations: readonly CitationForward[]
  readonly reasoningView: ReasoningView | null
  readonly showQRCode: boolean
  readonly live2d?: {
    readonly modelFileUrl: string
    readonly scale: number
    readonly positionX: number
    readonly positionY: number
    readonly rotation: number
    readonly alpha: number
  }
}

export interface GroupMatePictureAppearance {
  readonly botName: string
  readonly toneStyle: 'creative' | 'balanced' | 'precise'
}

export interface GroupMatePictureRemoteRequestV1 {
  readonly schemaVersion: 1
  readonly replyText: string
  readonly citations: readonly CitationForward[]
  readonly reasoningView: ReasoningView | null
  readonly showQRCode: boolean
}

export interface GroupMatePictureRemoteResponseV1 {
  readonly schemaVersion: 1
  readonly pagePath: `/groupmate/reply/v1/${string}`
  readonly expiresInSeconds: 600
}

export type PictureRenderFailureCode =
  | 'document_too_large'
  | 'height_limit'
  | 'local_renderer_unavailable'
  | 'live2d_unavailable'
  | 'remote_base_url_invalid'
  | 'remote_request_timeout'
  | 'remote_rejected'
  | 'remote_contract_invalid'
  | 'cloud_renderer_unavailable'
  | 'render_timeout'
  | 'render_failed'

export type PictureRenderResult =
  | {
      readonly kind: 'rendered'
      readonly resource: import('../../tools/visible-tool-support.js').ToolResource
      readonly source: 'local' | 'remote_page_local_browser' | 'remote_page_cloud_browser'
      readonly pageUrl?: string
    }
  | {
      readonly kind: 'not_rendered'
      readonly code: PictureRenderFailureCode
    }

const REQUEST_KEYS = Object.freeze([
  'schemaVersion', 'replyText', 'citations', 'reasoningView', 'showQRCode'
])
const RESPONSE_KEYS = Object.freeze(['schemaVersion', 'pagePath', 'expiresInSeconds'])
const REASONING_KEYS = Object.freeze(['text', 'truncated'])
const PAGE_PATH = /^\/groupmate\/reply\/v1\/[0-9a-f]{32}$/
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024

function exactRecord (value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const ownKeys = Reflect.ownKeys(value)
    return ownKeys.length === keys.length && ownKeys.every(key => typeof key === 'string' && keys.includes(key)) &&
      keys.every(key => Object.hasOwn(value, key))
  } catch {
    return false
  }
}

function codePointLength (value: string): number {
  return [...value].length
}

function normalizedBoundedText (
  value: unknown,
  minimum: number,
  maximum: number,
  trim: boolean
): string | null {
  if (typeof value !== 'string') return null
  const normalized = (trim ? value.trim() : value).normalize('NFC')
  const length = codePointLength(normalized)
  return length >= minimum && length <= maximum ? normalized : null
}

function safeSourceUrl (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().normalize('NFC')
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > 2_048) return null
  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? normalized : null
  } catch {
    return null
  }
}

function citation (value: unknown): CitationForward | null {
  const hasSource = value !== null && typeof value === 'object' && Object.hasOwn(value, 'sourceUrl')
  const keys = hasSource ? ['title', 'text', 'sourceUrl'] : ['title', 'text']
  if (!exactRecord(value, keys)) return null
  const title = normalizedBoundedText(value.title, 1, 200, true)
  const text = normalizedBoundedText(value.text, 1, 4_000, true)
  if (title === null || text === null) return null
  if (!hasSource) return Object.freeze({ title, text })
  const sourceUrl = safeSourceUrl(value.sourceUrl)
  return sourceUrl === null ? null : Object.freeze({ title, text, sourceUrl })
}

function citations (value: unknown): readonly CitationForward[] | null {
  if (!Array.isArray(value) || value.length > 16) return null
  const result: CitationForward[] = []
  for (const item of value) {
    const parsed = citation(item)
    if (parsed === null) return null
    result.push(parsed)
  }
  return Object.freeze(result)
}

function reasoning (value: unknown): ReasoningView | null | undefined {
  if (value === null) return null
  if (!exactRecord(value, REASONING_KEYS) || typeof value.truncated !== 'boolean') return undefined
  const text = normalizedBoundedText(value.text, 1, 2_000, true)
  return text === null ? undefined : Object.freeze({ text, truncated: value.truncated })
}

function requestFromUnknown (value: unknown): GroupMatePictureRemoteRequestV1 | null {
  if (!exactRecord(value, REQUEST_KEYS) || value.schemaVersion !== 1 ||
    typeof value.showQRCode !== 'boolean') return null
  const replyText = normalizedBoundedText(value.replyText, 1, 24_000, false)
  const parsedCitations = citations(value.citations)
  const reasoningView = reasoning(value.reasoningView)
  if (replyText === null || parsedCitations === null || reasoningView === undefined) return null
  return Object.freeze({
    schemaVersion: 1,
    replyText,
    citations: parsedCitations,
    reasoningView,
    showQRCode: value.showQRCode
  })
}

export function revalidateGroupMatePictureRemoteRequest (
  value: unknown
): GroupMatePictureRemoteRequestV1 | null {
  try {
    return requestFromUnknown(value)
  } catch {
    return null
  }
}

export function parseGroupMatePictureRemoteRequest (
  rawJson: string
): GroupMatePictureRemoteRequestV1 | null {
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson, 'utf8') > MAX_REQUEST_BYTES) return null
  try {
    return revalidateGroupMatePictureRemoteRequest(JSON.parse(rawJson))
  } catch {
    return null
  }
}

export function parseGroupMatePictureRemoteResponse (
  rawJson: string
): GroupMatePictureRemoteResponseV1 | null {
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson, 'utf8') > MAX_RESPONSE_BYTES) return null
  try {
    const value: unknown = JSON.parse(rawJson)
    if (!exactRecord(value, RESPONSE_KEYS) || value.schemaVersion !== 1 ||
      value.expiresInSeconds !== 600 || typeof value.pagePath !== 'string' ||
      !PAGE_PATH.test(value.pagePath)) return null
    return Object.freeze({
      schemaVersion: 1,
      pagePath: value.pagePath as `/groupmate/reply/v1/${string}`,
      expiresInSeconds: 600
    })
  } catch {
    return null
  }
}

function live2dDocument (value: unknown): GroupMatePictureDocumentV1['live2d'] | null | undefined {
  if (value === undefined) return undefined
  if (!exactRecord(value, [
    'modelFileUrl', 'scale', 'positionX', 'positionY', 'rotation', 'alpha'
  ])) return null
  const fields = ['scale', 'positionX', 'positionY', 'rotation', 'alpha'] as const
  if (typeof value.modelFileUrl !== 'string' || !value.modelFileUrl.startsWith('file:') ||
    Buffer.byteLength(value.modelFileUrl, 'utf8') > 4_096 ||
    fields.some(key => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null
  return Object.freeze({
    modelFileUrl: value.modelFileUrl,
    scale: value.scale as number,
    positionX: value.positionX as number,
    positionY: value.positionY as number,
    rotation: value.rotation as number,
    alpha: value.alpha as number
  })
}

function normalizedDocument (value: GroupMatePictureDocumentV1): GroupMatePictureDocumentV1 | null {
  const request = requestFromUnknown({
    schemaVersion: value.schemaVersion,
    replyText: value.replyText,
    citations: value.citations,
    reasoningView: value.reasoningView,
    showQRCode: value.showQRCode
  })
  if (request === null) return null
  const local = live2dDocument(value.live2d)
  if (local === null) return null
  return Object.freeze({ ...request, ...(local === undefined ? {} : { live2d: local }) })
}

function normalizedAppearance (value: unknown): GroupMatePictureAppearance | null {
  if (!exactRecord(value, ['botName', 'toneStyle'])) return null
  const botName = normalizedBoundedText(value.botName, 1, 80, true)
  if (botName === null || typeof value.toneStyle !== 'string') return null
  const style = value.toneStyle.trim().toLowerCase()
  const toneStyle = style === 'balanced'
    ? 'balanced'
    : style === 'precise' || style === 'precision'
      ? 'precise'
      : 'creative'
  return Object.freeze({ botName, toneStyle })
}

function placeholderCount (template: string, placeholder: string): number {
  let count = 0
  let offset = 0
  while ((offset = template.indexOf(placeholder, offset)) !== -1) {
    count++
    offset += placeholder.length
  }
  return count
}

function safeJson (value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function renderFailure (): never {
  throw Object.assign(new Error('GroupMate picture template cannot be rendered'), {
    code: 'render_failed' as const
  })
}

export function renderGroupMateHtml (
  template: string,
  document: GroupMatePictureDocumentV1,
  appearance?: unknown
): string {
  const documentPlaceholder = '<!--__GROUPMATE_DOCUMENT__-->'
  const qrPlaceholder = '<!--__GROUPMATE_QR_SCRIPT__-->'
  if (typeof template !== 'string' || placeholderCount(template, documentPlaceholder) !== 1 ||
    placeholderCount(template, qrPlaceholder) !== 1) return renderFailure()
  const normalized = normalizedDocument(document)
  if (normalized === null) return renderFailure()
  const display = appearance === undefined ? undefined : normalizedAppearance(appearance)
  if (display === null) return renderFailure()
  const json = safeJson(display === undefined
    ? normalized
    : Object.freeze({ ...normalized, appearance: display }))
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_BYTES) return renderFailure()
  return template
    .replace(documentPlaceholder, () => json)
    .replace(qrPlaceholder, () => qrCodeBrowserScript())
}

const MAX_FIELD_CHARACTERS = 500
const MAX_CONTENT_CHARACTERS = 12000
const MAX_TYPE_CHARACTERS = 64
// Forwarded chat logs are expanded only from nodes the host already delivered
// (NapCat get_msg and history parse them inline); every bound below keeps one
// quoted forward inside the existing per-message content budget.
const MAX_FORWARD_CHARACTERS = 10_000
const MAX_FORWARD_DEPTH = 3
const MAX_FORWARD_NODES = 200
const MAX_FORWARD_NODE_CHARACTERS = 2_000
const MAX_FORWARD_SENDER_CHARACTERS = 64
const MAX_FORWARD_NODE_SEGMENTS = 64
const FORWARD_INDENT = '  '
const FORWARD_OMISSION = '…（篇幅所限，其余转发内容未展示）'
const FORWARD_SEGMENT_FIELDS = [
  'text', 'name', 'qq', 'id', 'summary', 'title', 'content', 'file_name', 'data'
] as const

type UnknownRecord = Record<string, unknown>

interface ForwardContext {
  readonly lines: string[]
  remaining: number
  nodes: number
  truncated: boolean
}

interface BoundedItems {
  readonly items: readonly unknown[]
  readonly total: number
}

export interface NormalizeMessageOptions {
  textOverride?: string
  fallbackText?: string
}

export interface NormalizedMessageContent {
  text: string
  imageUrls: string[]
  segmentCount: number
}

function isRecord (value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getBoundedMetadataScalar (value: unknown): string {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return ''
  return String(value).trim().slice(0, MAX_FIELD_CHARACTERS)
}

function getContentText (value: unknown): string {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return ''
  return String(value).trim().slice(0, MAX_CONTENT_CHARACTERS)
}

function getMediaReference (value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getFirstScalar (record: UnknownRecord, fields: string[]): string {
  for (const field of fields) {
    const value = getBoundedMetadataScalar(record[field])
    if (value) return value
  }
  return ''
}

function getFirstMediaReference (record: UnknownRecord, fields: string[]): string {
  for (const field of fields) {
    const value = getMediaReference(record[field])
    if (value) return value
  }
  return ''
}

function getSafeType (value: unknown): string {
  const type = getBoundedMetadataScalar(value).slice(0, MAX_TYPE_CHARACTERS)
  return /^[a-z0-9_.-]+$/i.test(type) ? type : 'unknown'
}

function withDetail (label: string, detail: string): string {
  return detail ? `[${label}:${detail}]` : `[${label}]`
}

// Forward payloads are host data of arbitrary depth: read own data properties
// only, so an accessor or proxy can never run code or blow the budget.
function ownValue (record: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function ownRecord (record: object, key: string): UnknownRecord | undefined {
  const value = ownValue(record, key)
  return isRecord(value) ? value : undefined
}

function isScalar (value: unknown): boolean {
  return ['string', 'number', 'boolean'].includes(typeof value)
}

/** Reads a field from a host-flattened segment or its raw OneBot `data`. */
function segmentField (segment: UnknownRecord, field: string): unknown {
  const direct = ownValue(segment, field)
  if (direct !== undefined && (isScalar(direct) || Array.isArray(direct))) return direct
  const data = ownRecord(segment, 'data')
  const nested = data === undefined ? undefined : ownValue(data, field)
  return nested === undefined ? direct : nested
}

function boundedItems (value: unknown, maximum: number): BoundedItems {
  try {
    if (!Array.isArray(value)) return { items: [], total: 0 }
    const length = ownValue(value, 'length')
    const total = typeof length === 'number' && Number.isSafeInteger(length) && length > 0
      ? length
      : 0
    const items: unknown[] = []
    for (let index = 0; index < Math.min(total, maximum); index += 1) {
      items.push(ownValue(value, String(index)))
    }
    return { items, total }
  } catch {
    return { items: [], total: 0 }
  }
}

function appendForwardLine (context: ForwardContext, line: string): boolean {
  const separator = context.lines.length === 0 ? 0 : 1
  if (line.length + separator <= context.remaining) {
    context.lines.push(line)
    context.remaining -= line.length + separator
    return true
  }
  const room = context.remaining - separator
  if (room > 0) context.lines.push(line.slice(0, room))
  context.remaining = 0
  context.truncated = true
  return false
}

function forwardSenderName (node: UnknownRecord): string {
  const sender = ownRecord(node, 'sender') ?? {}
  const data = ownRecord(node, 'data') ?? {}
  const candidates = [
    ownValue(sender, 'card'), ownValue(sender, 'nickname'), ownValue(node, 'nickname'),
    ownValue(node, 'name'), ownValue(data, 'name'), ownValue(data, 'nickname'),
    ownValue(sender, 'user_id'), ownValue(node, 'user_id'), ownValue(data, 'uin')
  ]
  for (const candidate of candidates) {
    const name = getBoundedMetadataScalar(candidate).replace(/\s+/g, ' ')
    if (name) return name.slice(0, MAX_FORWARD_SENDER_CHARACTERS)
  }
  return '未知成员'
}

function forwardNodeMessage (node: UnknownRecord): unknown {
  const data = ownRecord(node, 'data') ?? {}
  const candidates = [
    ownValue(node, 'message'), ownValue(node, 'content'),
    ownValue(data, 'content'), ownValue(data, 'message')
  ]
  return candidates.find(candidate => (
    (typeof candidate === 'string' && candidate.trim() !== '') ||
    boundedItems(candidate, 1).total > 0
  ))
}

function flattenedSegment (segment: UnknownRecord): UnknownRecord {
  const flat: UnknownRecord = { type: ownValue(segment, 'type') }
  for (const field of FORWARD_SEGMENT_FIELDS) {
    const value = segmentField(segment, field)
    if (isScalar(value)) flat[field] = value
  }
  return flat
}

function isForwardType (segment: UnknownRecord): boolean {
  const type = getSafeType(ownValue(segment, 'type'))
  return type === 'forward' || type === 'node'
}

// napcat-adapter retypes a whole forward as `node`; its content then lists the
// forwarded messages (or node segments) instead of one node's own segments.
function isNodeList (value: unknown): boolean {
  const { items } = boundedItems(value, MAX_FORWARD_NODE_SEGMENTS)
  return items.length > 0 && items.every(item => {
    if (!isRecord(item)) return false
    const type = ownValue(item, 'type')
    return type === undefined || getSafeType(type) === 'node'
  })
}

function forwardItems (segment: UnknownRecord): unknown {
  const content = segmentField(segment, 'content')
  if (getSafeType(ownValue(segment, 'type')) !== 'node' || isNodeList(content)) return content
  return forwardNodeMessage(segment) === undefined ? undefined : [segment]
}

function appendForwardNode (
  value: unknown,
  depth: number,
  context: ForwardContext
): boolean {
  const node = isRecord(value) ? value : {}
  const indent = FORWARD_INDENT.repeat(depth)
  const message = forwardNodeMessage(node)
  const segments = typeof message === 'string'
    ? { items: [message], total: 1 }
    : boundedItems(message, MAX_FORWARD_NODE_SEGMENTS)
  const inline: string[] = []
  const nested: UnknownRecord[] = []
  for (const segment of segments.items) {
    if (typeof segment === 'string') {
      inline.push(segment.slice(0, MAX_FORWARD_NODE_CHARACTERS))
    } else if (isRecord(segment) && isForwardType(segment)) {
      nested.push(segment)
    } else if (isRecord(segment)) {
      const flat = flattenedSegment(segment)
      // Keep inner spacing: adjacent text segments of one node are one sentence.
      inline.push(getSafeType(flat.type) === 'text' && typeof flat.text === 'string'
        ? flat.text.slice(0, MAX_FORWARD_NODE_CHARACTERS)
        : normalizeSegment(flat, new Set()))
    }
  }
  const text = inline.join('').trim().slice(0, MAX_FORWARD_NODE_CHARACTERS)
    .replace(/\r\n?|\n/g, `\n${indent}${FORWARD_INDENT}`)
  const body = text || (nested.length === 0 ? '[空消息]' : '[转发的聊天记录]')
  if (!appendForwardLine(context, `${indent}【${forwardSenderName(node)}】：${body}`)) return false
  for (const segment of nested) {
    if (!appendForward(forwardItems(segment), depth + 1, context)) return false
  }
  return true
}

function appendForward (value: unknown, depth: number, context: ForwardContext): boolean {
  const nodes = boundedItems(value, MAX_FORWARD_NODES)
  const indent = FORWARD_INDENT.repeat(depth)
  if (nodes.total === 0) return appendForwardLine(context, `${indent}[合并转发，内容未展开]`)
  if (depth >= MAX_FORWARD_DEPTH) {
    return appendForwardLine(context, `${indent}[合并转发 共${nodes.total}条，嵌套过深未展开]`)
  }
  if (!appendForwardLine(context, `${indent}[合并转发 共${nodes.total}条]`)) return false
  for (const node of nodes.items) {
    if (context.nodes >= MAX_FORWARD_NODES) {
      context.truncated = true
      return false
    }
    context.nodes += 1
    if (!appendForwardNode(node, depth, context)) return false
  }
  if (nodes.total > nodes.items.length) context.truncated = true
  return true
}

/**
 * Renders a forwarded chat log as readable, bounded lines. Hosts that do not
 * deliver the nodes inline keep the previous summary-only label. Media inside
 * the log stays a text placeholder: forwarded files are often long gone and a
 * dead link would fail the whole provider request.
 */
export function forwardSegmentText (
  value: unknown,
  maxCharacters = MAX_FORWARD_CHARACTERS
): string {
  const segment = isRecord(value) ? value : {}
  const items = forwardItems(segment)
  if (!Array.isArray(items) || boundedItems(items, 1).total === 0) {
    const detail = ['summary', 'title', 'text', 'content']
      .map(field => getBoundedMetadataScalar(segmentField(segment, field)))
      .find(Boolean) ?? ''
    return withDetail('合并转发', detail)
  }
  const limit = Math.min(Math.max(Math.trunc(maxCharacters), 0), MAX_FORWARD_CHARACTERS)
  const context: ForwardContext = {
    lines: [],
    remaining: Math.max(limit - FORWARD_OMISSION.length - 1, 0),
    nodes: 0,
    truncated: false
  }
  appendForward(items, 0, context)
  if (context.truncated) context.lines.push(FORWARD_OMISSION)
  return context.lines.join('\n')
}

function normalizeSegment (
  value: unknown,
  imageUrls: Set<string>
): string {
  const segment = isRecord(value) ? value : {}
  const type = getSafeType(segment.type)

  switch (type) {
    case 'text':
      return getContentText(segment.text)
    case 'at': {
      const name = getFirstScalar(segment, ['name', 'text'])
      const qq = getBoundedMetadataScalar(segment.qq)
      if (name && qq) return `@${name}(${qq})`
      return `@${name || qq || '未知用户'}`
    }
    case 'face':
      return withDetail('表情', getFirstScalar(segment, ['name', 'text', 'id']))
    case 'image': {
      const image = getFirstMediaReference(segment, ['url', 'file'])
      if (image) imageUrls.add(image)
      return '[图片]'
    }
    case 'file':
      return withDetail('文件', getFirstScalar(segment, ['name', 'file_name', 'id', 'fid']))
    case 'record':
      return withDetail('语音', getFirstScalar(segment, ['name', 'file_name', 'text']))
    case 'video':
      return withDetail('视频', getFirstScalar(segment, ['name', 'file_name', 'text']))
    case 'json':
      return withDetail('JSON卡片', getFirstScalar(segment, ['summary', 'title', 'text', 'content', 'data']))
    case 'xml':
      return withDetail('XML卡片', getFirstScalar(segment, ['summary', 'title', 'text', 'content', 'data']))
    case 'forward':
    case 'node':
      return forwardSegmentText(segment)
    case 'reply':
    case 'source':
      return '[引用消息]'
    default:
      return `[消息段:${type}]`
  }
}

export function normalizeMessageContent (
  segments: unknown,
  options: NormalizeMessageOptions = {}
): NormalizedMessageContent {
  const values = Array.isArray(segments) ? segments : []
  const imageUrls = new Set<string>()
  const parts: string[] = []
  const hasTextOverride = typeof options.textOverride === 'string'

  if (hasTextOverride) {
    const text = getContentText(options.textOverride)
    if (text) parts.push(text)
  }

  for (const segment of values) {
    const type = isRecord(segment) ? getSafeType(segment.type) : 'unknown'
    if (hasTextOverride && type === 'text') continue
    const text = normalizeSegment(segment, imageUrls)
    if (text) parts.push(text)
  }

  if (parts.length === 0) {
    const fallbackText = getContentText(options.fallbackText)
    if (fallbackText) parts.push(fallbackText)
  }

  return {
    text: parts.join('\n').slice(0, MAX_CONTENT_CHARACTERS),
    imageUrls: [...imageUrls],
    segmentCount: values.length
  }
}

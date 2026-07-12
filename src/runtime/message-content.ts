const MAX_FIELD_CHARACTERS = 500
const MAX_CONTENT_CHARACTERS = 12000
const MAX_TYPE_CHARACTERS = 64

type UnknownRecord = Record<string, unknown>

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
      return withDetail('合并转发', getFirstScalar(segment, ['summary', 'title', 'text', 'content']))
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

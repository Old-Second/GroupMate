export type ChatErrorPresentationCode =
  | 'conversation_not_found'
  | 'provider_config_missing'
  | 'provider_invalid_format'
  | 'provider_auth_failed'
  | 'provider_balance_insufficient'
  | 'provider_invalid_parameters'
  | 'provider_rate_limited'
  | 'provider_server_error'
  | 'provider_overloaded'
  | 'provider_timeout'
  | 'provider_connection_failed'
  | 'provider_unknown_error'

export interface ChatErrorPresentation {
  code: ChatErrorPresentationCode
  message: string
  statusCode: number | null
  resetConversation: boolean
}

export interface ChatErrorMetadata {
  name: string
  code: string
  statusCode: number | null
}

const LEGACY_CONVERSATION_NOT_FOUND = 'Error: {"detail":"Conversation not found"}'
const MISSING_API_KEY = 'OpenAI missing required apiKey'
const SAFE_TOKEN = /^[a-z0-9_.-]{1,64}$/i

const TIMEOUT_NAMES = new Set([
  'AbortError',
  'PTimeoutError',
  'TimeoutError'
])

const TIMEOUT_CODES = new Set([
  'ABORT_ERR',
  'ERR_TIMEOUT',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])

const CONNECTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET'
])

const STATUS_PRESENTATIONS = new Map<number, Omit<ChatErrorPresentation, 'statusCode'>>([
  [400, {
    code: 'provider_invalid_format',
    message: '请求格式不正确，请联系机器人主人',
    resetConversation: false
  }],
  [401, {
    code: 'provider_auth_failed',
    message: 'AI 服务鉴权失败，请联系机器人主人',
    resetConversation: false
  }],
  [402, {
    code: 'provider_balance_insufficient',
    message: 'AI 服务余额不足，请联系机器人主人',
    resetConversation: false
  }],
  [422, {
    code: 'provider_invalid_parameters',
    message: '请求参数不受支持，请联系机器人主人',
    resetConversation: false
  }],
  [429, {
    code: 'provider_rate_limited',
    message: 'AI 服务请求过多，请稍后重试',
    resetConversation: false
  }],
  [500, {
    code: 'provider_server_error',
    message: 'AI 服务暂时异常，请稍后重试',
    resetConversation: false
  }],
  [503, {
    code: 'provider_overloaded',
    message: 'AI 服务繁忙，请稍后重试',
    resetConversation: false
  }]
])

function readDataProperty (value: unknown, property: PropertyKey): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined
  }

  let current: object | null = value as object
  for (let depth = 0; current && depth < 4; depth += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, property)
    } catch {
      return undefined
    }
    if (descriptor) {
      return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    }
    try {
      current = Object.getPrototypeOf(current)
    } catch {
      return undefined
    }
  }
  return undefined
}

function readStringProperty (value: unknown, property: PropertyKey): string | undefined {
  const candidate = readDataProperty(value, property)
  return typeof candidate === 'string' ? candidate : undefined
}

function getStatusCode (error: unknown): number | null {
  const statusCode = readDataProperty(error, 'statusCode')
  const status = readDataProperty(error, 'status')
  const candidate = Number.isInteger(statusCode) ? statusCode : status
  return typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 100 &&
    candidate <= 599
    ? candidate
    : null
}

function getSafeToken (value: string | undefined): string {
  return value && SAFE_TOKEN.test(value) ? value : 'unknown'
}

function createPresentation (
  code: ChatErrorPresentationCode,
  message: string,
  statusCode: number | null = null,
  resetConversation = false
): ChatErrorPresentation {
  return { code, message, statusCode, resetConversation }
}

export function readChatErrorMetadata (error: unknown): ChatErrorMetadata {
  return {
    name: getSafeToken(readStringProperty(error, 'name')),
    code: getSafeToken(readStringProperty(error, 'code')),
    statusCode: getStatusCode(error)
  }
}

export function getChatErrorPresentation (error: unknown): ChatErrorPresentation {
  if (error === LEGACY_CONVERSATION_NOT_FOUND) {
    return createPresentation(
      'conversation_not_found',
      '当前对话异常，已经清除，请重试',
      null,
      true
    )
  }

  const statusCode = getStatusCode(error)
  const statusPresentation = statusCode === null
    ? undefined
    : STATUS_PRESENTATIONS.get(statusCode)
  if (statusPresentation) {
    return { ...statusPresentation, statusCode }
  }

  const message = readStringProperty(error, 'message')
  if (message === MISSING_API_KEY) {
    return createPresentation(
      'provider_config_missing',
      'AI 服务尚未配置，请联系机器人主人',
      statusCode
    )
  }

  const name = readStringProperty(error, 'name')
  const code = readStringProperty(error, 'code')
  if ((name && TIMEOUT_NAMES.has(name)) || (code && TIMEOUT_CODES.has(code))) {
    return createPresentation(
      'provider_timeout',
      'AI 服务响应超时，请稍后重试',
      statusCode
    )
  }
  if (code && CONNECTION_CODES.has(code)) {
    return createPresentation(
      'provider_connection_failed',
      '无法连接 AI 服务，请稍后重试',
      statusCode
    )
  }

  return createPresentation(
    'provider_unknown_error',
    '处理请求时出现异常，请稍后重试',
    statusCode
  )
}

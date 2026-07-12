import { readChatErrorMetadata } from './chat-error-presentation.js'

type UnknownRecord = Record<string, unknown>

interface ChatRequestLogInput {
  mode?: unknown
  stream?: unknown
  prompt?: unknown
}

interface ChatResponseLogInput {
  mode?: unknown
  response?: unknown
}

interface ToolExecutionLogInput {
  name?: unknown
  result?: unknown
}

interface ChatErrorLogInput {
  mode?: unknown
  error?: unknown
  category?: unknown
}

interface MessageInputLogInput {
  prompt?: unknown
  imageUrls?: unknown
  hasReply?: unknown
  replyResolved?: unknown
  currentSegmentCount?: unknown
  replySegmentCount?: unknown
}

function isRecord (value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function getSafeMode (mode: unknown): string {
  return typeof mode === 'string' && /^[a-z0-9_-]{1,32}$/i.test(mode)
    ? mode
    : 'unknown'
}

function getStringLength (value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}

function getSafeCount (value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

function getSafeToken (value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : 'unknown'
}

export function createChatRequestLog ({ mode, stream, prompt }: ChatRequestLogInput) {
  return {
    event: 'chat.request',
    mode: getSafeMode(mode),
    stream: stream === true,
    promptCharacters: getStringLength(prompt)
  } as const
}

export function createChatResponseLog ({ mode, response }: ChatResponseLogInput) {
  const value = isRecord(response) ? response : {}
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.length : 0
  const hasFunctionCall = isRecord(value.functionCall)
  const thinkingSegments = Array.isArray(value.thinking_segments)
    ? value.thinking_segments.length
    : 0

  return {
    event: 'chat.response',
    mode: getSafeMode(mode),
    textCharacters: getStringLength(value.text),
    hasThinking: getStringLength(value.thinking_text) > 0 || thinkingSegments > 0,
    toolCallCount: toolCalls || (hasFunctionCall ? 1 : 0),
    failed: Boolean(value.error)
  } as const
}

export function createToolExecutionLog ({ name, result }: ToolExecutionLogInput) {
  return {
    event: 'chat.tool.result',
    tool: getSafeMode(name),
    resultCharacters: getStringLength(result)
  } as const
}

export function createChatErrorLog ({ mode, error, category }: ChatErrorLogInput) {
  const metadata = readChatErrorMetadata(error)

  return {
    event: 'chat.error',
    mode: getSafeMode(mode),
    category: getSafeToken(category),
    error: getSafeToken(metadata.name),
    code: getSafeToken(metadata.code),
    statusCode: metadata.statusCode
  } as const
}

export function createMessageInputLog (input: MessageInputLogInput) {
  return {
    event: 'chat.input.context',
    hasReply: input.hasReply === true,
    replyResolved: input.replyResolved === true,
    currentSegmentCount: getSafeCount(input.currentSegmentCount),
    replySegmentCount: getSafeCount(input.replySegmentCount),
    imageCount: Array.isArray(input.imageUrls) ? input.imageUrls.length : 0,
    promptCharacters: getStringLength(input.prompt)
  } as const
}

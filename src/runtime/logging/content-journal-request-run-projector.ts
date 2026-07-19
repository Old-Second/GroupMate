import { isAgentErrorCode, type SerializedAgentError } from '../../agent/contracts/error.js'
import { parsePresentationRoute } from '../../agent/contracts/interaction.js'
import type { JsonObject, JsonValue } from '../../agent/model/json-value.js'
import type { ModelRequest, ModelTurn } from '../../agent/model/model-adapter.js'
import { parseExactToolArgumentsText } from '../../agent/model/tool-arguments-text.js'
import { parseRunCheckpoint, type RunCheckpoint } from '../../agent/run/run-checkpoint.js'
import type { RunContentJournalEvent } from '../../agent/run/run-content-journal.js'
import { RUN_RESOURCE_LIMITS } from '../../agent/run/run-limits.js'
import { parseProviderTurnState } from '../../agent/run/provider-state.js'
import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js'
import { isTerminalRunStatus } from '../../agent/run/run-state.js'
import { parseTerminalCommitReceipt } from '../../agent/run/run-store.js'
import { canonicalSessionKey } from '../../agent/session/conversation-scope.js'
import type { YunzaiAgentRequestDraft } from '../yunzai-request-adapter.js'
import {
  boundedRecord,
  exactKeys,
  finiteNumber,
  jsonArray,
  jsonObject,
  ownDataRecord,
  projectAgentMessageResources,
  projectSessionAddress,
  projectToolResultResources,
  safeInteger,
  text,
  timestamp,
  type ProjectedJournalEvent,
  type UnknownRecord
} from './content-journal-projection.js'

function parseActor (value: unknown): void {
  const input = jsonObject(value, 'actor') as UnknownRecord
  exactKeys(input, ['userId', 'displayName', 'role'], ['userId', 'role'], 'actor')
  text(input.userId, 'actor user ID')
  if (input.displayName !== undefined) text(input.displayName, 'actor display name')
  if (input.role !== 'owner' && input.role !== 'admin' && input.role !== 'member') {
    throw new TypeError('actor role is invalid')
  }
}

function parseChannel (value: unknown): void {
  const input = jsonObject(value, 'channel') as UnknownRecord
  if (input.kind === 'private') {
    exactKeys(input, ['kind', 'botId', 'userId'], ['kind', 'botId', 'userId'], 'channel')
    text(input.botId, 'channel bot ID')
    text(input.userId, 'channel user ID')
    return
  }
  if (input.kind === 'group') {
    exactKeys(input, ['kind', 'botId', 'groupId'], ['kind', 'botId', 'groupId'], 'channel')
    text(input.botId, 'channel bot ID')
    text(input.groupId, 'channel group ID')
    return
  }
  throw new TypeError('channel is invalid')
}

function parseReasoning (value: unknown, label: string): void {
  const reasoning = jsonObject(value, label) as UnknownRecord
  exactKeys(reasoning, ['enabled', 'effort'], ['enabled'], label)
  if (typeof reasoning.enabled !== 'boolean' ||
    (reasoning.effort !== undefined &&
      !['low', 'medium', 'high', 'max'].includes(String(reasoning.effort)))) {
    throw new TypeError(`${label} is invalid`)
  }
}

function parseModelReasoningTrace (value: unknown): void {
  const input = jsonObject(value, 'model reasoning trace') as UnknownRecord
  exactKeys(
    input,
    ['text', 'truncated'],
    ['text', 'truncated'],
    'model reasoning trace'
  )
  text(input.text, 'model reasoning text')
  if (typeof input.truncated !== 'boolean') {
    throw new TypeError('model reasoning trace is invalid')
  }
}

function parseRunModelConfig (value: unknown): void {
  const input = jsonObject(value, 'run model') as UnknownRecord
  exactKeys(
    input,
    ['model', 'streaming', 'maxOutputTokens', 'reasoning', 'temperature', 'topP'],
    ['model', 'streaming', 'maxOutputTokens', 'reasoning'],
    'run model'
  )
  text(input.model, 'run model name')
  if (typeof input.streaming !== 'boolean') throw new TypeError('run streaming is invalid')
  safeInteger(input.maxOutputTokens, 'run output tokens', 1)
  parseReasoning(input.reasoning, 'run reasoning')
  if (input.temperature !== undefined) finiteNumber(input.temperature, 'run temperature')
  if (input.topP !== undefined) finiteNumber(input.topP, 'run top P')
}

function parseContextBudget (value: unknown): void {
  const input = jsonObject(value, 'context budget') as UnknownRecord
  const keys = [
    'modelContextTokens', 'reservedOutputTokens', 'reservedToolTokens',
    'safetyMarginTokens', 'maxItems', 'maxBytes'
  ]
  exactKeys(input, keys, keys, 'context budget')
  safeInteger(input.modelContextTokens, 'context budget modelContextTokens', 1)
  safeInteger(input.reservedOutputTokens, 'context budget reservedOutputTokens')
  safeInteger(input.reservedToolTokens, 'context budget reservedToolTokens')
  safeInteger(input.safetyMarginTokens, 'context budget safetyMarginTokens')
  safeInteger(input.maxItems, 'context budget maxItems', 1)
  safeInteger(input.maxBytes, 'context budget maxBytes', 1)
}

function projectRequest (
  value: YunzaiAgentRequestDraft
): Readonly<Record<string, unknown>> {
  const input = boundedRecord(value, RUN_RESOURCE_LIMITS.requestBytes, 'request')
  const allowed = [
    'requestId', 'requestRef', 'requestKind', 'presentationRoute', 'createdAt',
    'deadlineAt', 'sessionAddress', 'actor', 'channel', 'message', 'references',
    'systemInstructions', 'model', 'contextBudget', 'sessionTtlSeconds'
  ]
  exactKeys(input, allowed, allowed.slice(0, -1), 'request')
  text(input.requestId, 'request ID')
  if (typeof input.requestRef !== 'string' || !RUN_REF_PATTERN.test(input.requestRef)) {
    throw new TypeError('request reference is invalid')
  }
  if (input.requestKind !== 'ordinary_chat' && input.requestKind !== 'proactive_chat') {
    throw new TypeError('request kind is invalid')
  }
  timestamp(input.createdAt, 'request timestamp')
  timestamp(input.deadlineAt, 'request deadline')
  const sessionAddress = projectSessionAddress(input.sessionAddress)
  parseActor(input.actor)
  parseChannel(input.channel)
  const message = projectAgentMessageResources(input.message)
  const route = parsePresentationRoute(input.presentationRoute)
  if (route.requestKind !== input.requestKind ||
    canonicalSessionKey(route.sessionAddress) !== canonicalSessionKey(sessionAddress)) {
    throw new TypeError('request route is invalid')
  }
  const references = jsonObject(input.references, 'request references') as UnknownRecord
  exactKeys(
    references,
    ['currentMessageId', 'quotedMessageId'],
    ['currentMessageId', 'quotedMessageId'],
    'request references'
  )
  text(references.currentMessageId, 'current message ID')
  if (references.quotedMessageId !== null) text(references.quotedMessageId, 'quoted message ID')
  const instructions = jsonArray(input.systemInstructions, 256, 'system instructions')
  for (const instruction of instructions) text(instruction, 'system instruction')
  parseRunModelConfig(input.model)
  parseContextBudget(input.contextBudget)
  if (input.sessionTtlSeconds !== undefined) {
    safeInteger(input.sessionTtlSeconds, 'session TTL', 1)
  }
  return Object.freeze({ ...input, message })
}

function parseModelMessage (value: JsonValue): void {
  const input = jsonObject(value, 'model message') as UnknownRecord
  if (input.role === 'system' || input.role === 'developer' || input.role === 'user') {
    exactKeys(input, ['role', 'content'], ['role', 'content'], 'model message')
    text(input.content, 'model message content', true)
    return
  }
  if (input.role === 'tool') {
    exactKeys(input, ['role', 'content', 'toolCallId'], ['role', 'content', 'toolCallId'], 'model message')
    text(input.content, 'model message content', true)
    text(input.toolCallId, 'model tool call ID')
    return
  }
  if (input.role !== 'assistant') throw new TypeError('model message role is invalid')
  exactKeys(
    input,
    ['role', 'content', 'toolCalls', 'providerState'],
    ['role', 'content'],
    'model message'
  )
  if (input.content !== null) text(input.content, 'model message content', true)
  if (input.toolCalls !== undefined) {
    for (const call of jsonArray(input.toolCalls, 256, 'model tool calls')) {
      const toolCall = jsonObject(call, 'model tool call') as UnknownRecord
      exactKeys(
        toolCall,
        ['callId', 'name', 'argumentsText', 'arguments'],
        ['callId', 'name', 'arguments'],
        'model tool call'
      )
      text(toolCall.callId, 'model tool call ID')
      text(toolCall.name, 'model tool name')
      const argumentsValue = jsonObject(toolCall.arguments, 'model tool arguments') as JsonObject
      if (toolCall.argumentsText !== undefined) {
        text(toolCall.argumentsText, 'model tool arguments text', true)
        parseExactToolArgumentsText(toolCall.argumentsText, argumentsValue)
      }
    }
  }
  if (input.providerState !== undefined) parseProviderTurnState(input.providerState)
}

function parseModelRequest (value: unknown): ModelRequest {
  const input = boundedRecord(value, RUN_RESOURCE_LIMITS.requestBytes, 'model request')
  exactKeys(
    input,
    [
      'model', 'messages', 'tools', 'toolMode', 'streaming', 'maxOutputTokens',
      'reasoning', 'temperature', 'topP'
    ],
    ['model', 'messages', 'tools', 'toolMode', 'streaming', 'maxOutputTokens', 'reasoning'],
    'model request'
  )
  text(input.model, 'model request name')
  for (const message of jsonArray(input.messages, 512, 'model messages')) {
    parseModelMessage(message)
  }
  for (const definition of jsonArray(input.tools, 256, 'model tools')) {
    const tool = jsonObject(definition, 'model tool') as UnknownRecord
    exactKeys(tool, ['name', 'description', 'parameters'], ['name', 'description', 'parameters'], 'model tool')
    text(tool.name, 'model tool name')
    text(tool.description, 'model tool description', true)
    jsonObject(tool.parameters, 'model tool parameters')
  }
  if (input.toolMode !== 'auto' && input.toolMode !== 'required' && input.toolMode !== 'disabled') {
    throw new TypeError('model tool mode is invalid')
  }
  if (typeof input.streaming !== 'boolean') throw new TypeError('model streaming is invalid')
  safeInteger(input.maxOutputTokens, 'model output tokens', 1)
  parseReasoning(input.reasoning, 'model reasoning')
  if (input.temperature !== undefined) finiteNumber(input.temperature, 'model temperature')
  if (input.topP !== undefined) finiteNumber(input.topP, 'model top P')
  return input as unknown as ModelRequest
}

function parseModelTurn (value: unknown): ModelTurn {
  const input = boundedRecord(value, RUN_RESOURCE_LIMITS.providerResponseBytes, 'model turn')
  exactKeys(
    input,
    [
      'text', 'refusal', 'toolCalls', 'finishReason', 'usage', 'reasoning',
      'providerState', 'responseId'
    ],
    ['text', 'toolCalls', 'finishReason'],
    'model turn'
  )
  text(input.text, 'model turn text', true)
  if (input.refusal !== undefined) text(input.refusal, 'model refusal', true)
  for (const call of jsonArray(input.toolCalls, 256, 'normalized tool calls')) {
    const toolCall = jsonObject(call, 'normalized tool call') as UnknownRecord
    exactKeys(
      toolCall,
      ['index', 'callId', 'name', 'argumentsText', 'arguments'],
      ['index', 'callId', 'name', 'argumentsText', 'arguments'],
      'normalized tool call'
    )
    safeInteger(toolCall.index, 'normalized tool index')
    text(toolCall.callId, 'normalized tool call ID')
    text(toolCall.name, 'normalized tool name')
    text(toolCall.argumentsText, 'normalized tool arguments text', true)
    jsonObject(toolCall.arguments, 'normalized tool arguments')
  }
  if (!['stop', 'length', 'tool_calls', 'content_filter', 'unknown']
    .includes(String(input.finishReason))) {
    throw new TypeError('model finish reason is invalid')
  }
  if (input.usage !== undefined) {
    const usage = jsonObject(input.usage, 'model usage') as UnknownRecord
    exactKeys(
      usage,
      ['inputTokens', 'outputTokens', 'totalTokens', 'inputCache'],
      ['inputTokens', 'outputTokens', 'totalTokens'],
      'model usage'
    )
    const inputTokens = safeInteger(usage.inputTokens, 'model input tokens')
    const outputTokens = safeInteger(usage.outputTokens, 'model output tokens')
    const totalTokens = safeInteger(usage.totalTokens, 'model total tokens')
    if (inputTokens + outputTokens !== totalTokens ||
      !Number.isSafeInteger(inputTokens + outputTokens)) {
      throw new TypeError('model usage is inconsistent')
    }
    if (usage.inputCache !== undefined) {
      const inputCache = jsonObject(usage.inputCache, 'model input cache usage') as UnknownRecord
      exactKeys(
        inputCache,
        ['hitTokens', 'missTokens'],
        ['hitTokens', 'missTokens'],
        'model input cache usage'
      )
      const hitTokens = safeInteger(inputCache.hitTokens, 'model cache hit tokens')
      const missTokens = safeInteger(inputCache.missTokens, 'model cache miss tokens')
      if (hitTokens + missTokens !== inputTokens ||
        !Number.isSafeInteger(hitTokens + missTokens)) {
        throw new TypeError('model input cache usage is inconsistent')
      }
    }
  }
  if (input.reasoning !== undefined) parseModelReasoningTrace(input.reasoning)
  if (input.providerState !== undefined) parseProviderTurnState(input.providerState)
  if (input.responseId !== undefined) text(input.responseId, 'model response ID')
  return input as unknown as ModelTurn
}

function parseSerializedError (value: unknown): SerializedAgentError {
  const input = boundedRecord(
    value,
    RUN_RESOURCE_LIMITS.sanitizedErrorBodyBytes,
    'serialized agent error',
    { maxDepth: 4, maxNodes: 256 }
  )
  exactKeys(
    input,
    ['code', 'stage', 'retryable', 'userMessage', 'details'],
    ['code', 'stage', 'retryable', 'userMessage', 'details'],
    'serialized agent error'
  )
  if (!isAgentErrorCode(input.code)) throw new TypeError('agent error code is invalid')
  text(input.stage, 'agent error stage')
  if (typeof input.retryable !== 'boolean') throw new TypeError('agent error retryable is invalid')
  text(input.userMessage, 'agent error user message')
  const details = jsonObject(input.details, 'agent error details')
  for (const detail of Object.values(details)) {
    if (detail !== null && !['string', 'number', 'boolean'].includes(typeof detail)) {
      throw new TypeError('agent error detail is invalid')
    }
  }
  return input as unknown as SerializedAgentError
}

function parseProviderCommon (input: UnknownRecord): Readonly<Record<string, unknown>> {
  const occurredAt = timestamp(input.occurredAt, 'run journal timestamp')
  if (typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef) ||
    typeof input.requestRef !== 'string' || !RUN_REF_PATTERN.test(input.requestRef)) {
    throw new TypeError('run journal reference is invalid')
  }
  const ordinal = safeInteger(input.ordinal, 'provider ordinal', 1)
  if (!['primary', 'retry', 'recovery', 'correction'].includes(String(input.attemptKind))) {
    throw new TypeError('provider attempt kind is invalid')
  }
  return {
    occurredAt,
    runRef: input.runRef,
    requestRef: input.requestRef,
    ordinal,
    attemptKind: input.attemptKind
  }
}

function projectTerminalCheckpointResources (checkpoint: RunCheckpoint): RunCheckpoint {
  const output = checkpoint.output === null
    ? null
    : projectAgentMessageResources(checkpoint.output)
  const toolLedgers = Object.freeze(checkpoint.toolLedgers.map(ledger => Object.freeze({
    ...ledger,
    calls: Object.freeze(ledger.calls.map(call => Object.freeze({
      ...call,
      result: call.result === null ? null : projectToolResultResources(call.result)
    })))
  })))
  const preparedBatch = checkpoint.preparedBatch === null
    ? null
    : Object.freeze({
        ...checkpoint.preparedBatch,
        calls: Object.freeze(checkpoint.preparedBatch.calls.map(call => (
          call.kind === 'completed'
            ? Object.freeze({ ...call, result: projectToolResultResources(call.result) })
            : call
        )))
      })
  return Object.freeze({
    ...checkpoint,
    output,
    toolLedgers,
    preparedBatch
  }) as RunCheckpoint
}

function projectTerminalEvent (input: UnknownRecord): ProjectedJournalEvent {
  const keys = ['type', 'occurredAt', 'runRef', 'requestRef', 'checkpoint', 'receipt']
  exactKeys(input, keys, keys, 'terminal journal event')
  const occurredAt = timestamp(input.occurredAt, 'terminal journal timestamp')
  const parsedCheckpoint = parseRunCheckpoint(input.checkpoint)
  if (!isTerminalRunStatus(parsedCheckpoint.status)) {
    throw new TypeError('terminal journal checkpoint status is invalid')
  }
  const receipt = parseTerminalCommitReceipt(input.receipt)
  if (input.runRef !== parsedCheckpoint.runRef ||
    input.requestRef !== parsedCheckpoint.requestRef ||
    receipt.runRef !== parsedCheckpoint.runRef ||
    receipt.revision !== parsedCheckpoint.revision) {
    throw new TypeError('terminal journal correlation is invalid')
  }
  const checkpoint = projectTerminalCheckpointResources(parsedCheckpoint)
  return {
    type: 'run.terminal_committed',
    payload: {
      occurredAt,
      runRef: checkpoint.runRef,
      requestRef: checkpoint.requestRef,
      checkpoint,
      receipt
    }
  }
}

export function projectRequestJournalEvent (
  request: YunzaiAgentRequestDraft
): ProjectedJournalEvent {
  return {
    type: 'request.received',
    payload: { request: projectRequest(request) }
  }
}

export function projectRunJournalEvent (
  value: RunContentJournalEvent
): ProjectedJournalEvent {
  const envelope = ownDataRecord(value, 'run journal event')
  if (envelope.type === 'run.terminal_committed') return projectTerminalEvent(envelope)

  const input = boundedRecord(value, RUN_RESOURCE_LIMITS.providerResponseBytes, 'run journal event')
  if (input.type === 'provider.request') {
    const keys = [
      'type', 'occurredAt', 'runRef', 'requestRef', 'ordinal', 'attemptKind', 'request'
    ]
    exactKeys(input, keys, keys, 'provider request journal event')
    return {
      type: input.type,
      payload: { ...parseProviderCommon(input), request: parseModelRequest(input.request) }
    }
  }
  if (input.type === 'provider.response') {
    const keys = [
      'type', 'occurredAt', 'runRef', 'requestRef', 'ordinal', 'attemptKind', 'turn'
    ]
    exactKeys(input, keys, keys, 'provider response journal event')
    return {
      type: input.type,
      payload: { ...parseProviderCommon(input), turn: parseModelTurn(input.turn) }
    }
  }
  if (input.type === 'provider.failure') {
    const keys = [
      'type', 'occurredAt', 'runRef', 'requestRef', 'ordinal', 'attemptKind', 'error'
    ]
    exactKeys(input, keys, keys, 'provider failure journal event')
    return {
      type: input.type,
      payload: { ...parseProviderCommon(input), error: parseSerializedError(input.error) }
    }
  }
  throw new TypeError('run journal event type is invalid')
}

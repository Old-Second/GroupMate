import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseAgentMessage } from '../../src/agent/contracts/content.js'
import { AgentError, serializeAgentError } from '../../src/agent/contracts/error.js'
import { parseJsonValue } from '../../src/agent/model/json-value.js'
import type { JsonObject } from '../../src/agent/model/json-value.js'
import type { ModelRequest, ModelTurn } from '../../src/agent/model/model-adapter.js'
import { createDefaultRunBudget } from '../../src/agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  nextRunCheckpoint,
  parseRunCheckpoint,
  type RunCheckpoint
} from '../../src/agent/run/run-checkpoint.js'
import type { RunContentJournalEvent } from '../../src/agent/run/run-content-journal.js'
import { createRunEvent } from '../../src/agent/run/run-events.js'
import {
  createFrozenObservationPolicy,
  createRunTerminalSnapshot
} from '../../src/agent/run/run-observation.js'
import { parseTerminalCommitReceipt } from '../../src/agent/run/run-store.js'
import { parseToolResult } from '../../src/agent/tools/tool-result.js'
import {
  createGroupMateContentJournal
} from '../../src/runtime/logging/groupmate-content-journal.js'
import type {
  GroupMateContentJournal,
  GroupMateOutboundJournalEvent
} from '../../src/runtime/logging/groupmate-content-journal.js'
import {
  GroupMateDiskLog,
  type GroupMateDiskLogEvent
} from '../../src/runtime/logging/groupmate-disk-log.js'
import {
  createJournaledYunzaiOutboundPortFactory
} from '../../src/runtime/logging/journaled-yunzai-outbound.js'
import type {
  DeliveryResult,
  RuntimeDeliveryReceipt
} from '../../src/runtime/presentation/presentation-result.js'
import type {
  OutboundPart,
  RecallResult,
  YunzaiOutboundPort,
  YunzaiOutboundPortFactory
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import type { YunzaiAgentRequestDraft } from '../../src/runtime/yunzai-request-adapter.js'

const FIXED_TIMESTAMP = '2026-07-17T08:09:10.000Z'

async function readLogEvents (
  directory: string
): Promise<readonly Record<string, unknown>[]> {
  const files = (await readdir(directory))
    .filter(name => /^groupmate-\d{4}-\d{2}-\d{2}\.\d{4}\.jsonl$/.test(name))
    .sort()
  const rows: Record<string, unknown>[] = []
  for (const file of files) {
    const content = await readFile(path.join(directory, file), 'utf8')
    rows.push(...content.trimEnd().split('\n').map(line => (
      JSON.parse(line) as { event: Record<string, unknown> }
    ).event))
  }
  return rows
}

function requestFixture (): YunzaiAgentRequestDraft {
  const createdAt = '2026-07-17T08:00:00.000Z'
  const sessionAddress = Object.freeze({
    botId: 'bot-1',
    scope: Object.freeze({
      kind: 'group_user' as const, groupId: 'group-1', userId: 'actor-1'
    })
  })
  const message = Object.freeze({
    id: 'message-1',
    role: 'user' as const,
    parts: Object.freeze([
      Object.freeze({ type: 'text' as const, text: '请完整记录这条消息' }),
      Object.freeze({ type: 'mention' as const, userId: 'member-2', displayName: '成员二' }),
      Object.freeze({
        type: 'tool_call' as const,
        toolCallId: 'request-call-1',
        name: 'business_schema',
        arguments: Object.freeze({
          apiKey: '业务字段值',
          headers: Object.freeze({ display: '业务头信息' })
        })
      })
    ]),
    createdAt,
    provenance: Object.freeze({
      source: 'qq_message', trust: 'untrusted' as const, sensitivity: 'group' as const,
      sourceId: 'message-1', createdAt
    }),
    replyTo: Object.freeze({
      messageId: 'quoted-1',
      sender: Object.freeze({ userId: 'member-2', displayName: '成员二' }),
      parts: Object.freeze([
        Object.freeze({ type: 'text' as const, text: '被引用的完整正文' })
      ])
    })
  })
  const request: YunzaiAgentRequestDraft = Object.freeze({
    requestId: 'request-1',
    requestRef: '1'.repeat(32),
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1, kind: 'ordinary', forcePicture: false
      }),
      sessionAddress,
      actorId: 'actor-1',
      requestMessageId: message.id
    }),
    createdAt,
    deadlineAt: '2026-07-17T08:04:00.000Z',
    sessionAddress,
    actor: Object.freeze({ userId: 'actor-1', displayName: '发言者', role: 'admin' }),
    channel: Object.freeze({
      kind: 'group', botId: 'bot-1', groupId: 'group-1'
    }),
    message,
    references: Object.freeze({
      currentMessageId: message.id, quotedMessageId: 'quoted-1'
    }),
    systemInstructions: Object.freeze([
      'You are GroupMate.', '保留完整系统指令。'
    ]),
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    contextBudget: Object.freeze({
      modelContextTokens: 8_192, reservedOutputTokens: 256,
      reservedToolTokens: 0, safetyMarginTokens: 0,
      maxItems: 64, maxBytes: 256 * 1_024
    }),
    sessionTtlSeconds: 3_600
  })
  return request
}

function modelRequestFixture (): ModelRequest {
  return Object.freeze({
    model: 'fixture-model',
    messages: Object.freeze([
      Object.freeze({ role: 'developer' as const, content: '完整 provider 指令' }),
      Object.freeze({ role: 'user' as const, content: '完整 provider 请求' })
    ]),
    tools: Object.freeze([
      Object.freeze({
        name: 'lookup',
        description: '查询完整信息',
        parameters: Object.freeze({
          type: 'object',
          properties: Object.freeze({
            query: Object.freeze({ type: 'string' }),
            apiKey: Object.freeze({ type: 'string', description: '业务字段名' }),
            headers: Object.freeze({ type: 'object', description: '业务字段名' })
          })
        })
      })
    ]),
    toolMode: 'auto',
    streaming: false,
    maxOutputTokens: 256,
    reasoning: Object.freeze({ enabled: false }),
    temperature: 0.2,
    topP: 0.9
  })
}

function modelTurnFixture (): ModelTurn {
  return Object.freeze({
    text: '完整 Provider 回复',
    refusal: '完整拒绝说明',
    toolCalls: Object.freeze([Object.freeze({
      index: 0,
      callId: 'provider-call-1',
      name: 'lookup',
      argumentsText: '{"apiKey":"业务字段值","headers":{"display":"业务头信息"}}',
      arguments: Object.freeze({
        apiKey: '业务字段值',
        headers: Object.freeze({ display: '业务头信息' })
      })
    })]),
    finishReason: 'tool_calls',
    usage: Object.freeze({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }),
    providerState: Object.freeze({
      profileId: 'standard',
      profileVersion: 1,
      payload: Object.freeze({ responseCursor: 'cursor-1' })
    }),
    responseId: 'response-1'
  })
}

function terminalReceipt (
  checkpoint: RunCheckpoint
): ReturnType<typeof parseTerminalCommitReceipt> {
  const snapshot = createRunTerminalSnapshot(checkpoint)
  return parseTerminalCommitReceipt({
    schemaVersion: 1,
    observationId: snapshot.observationId,
    runRef: snapshot.runRef,
    revision: snapshot.revision,
    deletedKeyCount: 2,
    createdKeyCount: 1,
    checkpointBytesDeleted: 123,
    eventBytesDeleted: 45,
    tombstoneBytes: 67
  })
}

function terminalJournalFixture (): Readonly<{
  checkpoint: RunCheckpoint
  receipt: ReturnType<typeof parseTerminalCommitReceipt>
}> {
  const runRef = '3'.repeat(32)
  const requestRef = '4'.repeat(32)
  const runId = 'journal-terminal-run'
  const sessionId = 'journal-terminal-session'
  const createdAt = '2026-07-17T08:03:00.000Z'
  const finishedAt = '2026-07-17T08:03:01.000Z'
  const sessionAddress = Object.freeze({
    botId: 'bot-1',
    scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 256 })
  const initial = createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId,
    sessionId,
    sessionAddress,
    runRef,
    requestRef,
    requestKind: 'ordinary_chat',
    presentationRoute: Object.freeze({
      schemaVersion: 1,
      requestKind: 'ordinary_chat',
      profile: 'ordinary',
      presentationIntent: Object.freeze({
        schemaVersion: 1, kind: 'ordinary', forcePicture: false
      }),
      sessionAddress,
      actorId: 'actor-1',
      requestMessageId: 'message-1'
    }),
    observationPolicy: createFrozenObservationPolicy({
      levelAtStart: 'basic', runRef
    }),
    model: Object.freeze({
      model: 'fixture-model', streaming: false, maxOutputTokens: 256,
      reasoning: Object.freeze({ enabled: false })
    }),
    toolSnapshot: Object.freeze({
      id: 'snapshot-1',
      fingerprint: createHash('sha256').update('[]').digest('hex'),
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt: '2026-07-17T08:07:00.000Z',
    createdAt,
    event: createRunEvent({
      eventId: 'journal-event-0', runId, sessionId, sequence: 0,
      occurredAt: createdAt, type: 'run.created', payload: Object.freeze({})
    })
  })
  const preparing = nextRunCheckpoint(initial, 'preparing', {}, [], createdAt)
  const calling = nextRunCheckpoint(preparing, 'calling_model', {}, [], createdAt)
  const checkpoint = nextRunCheckpoint(calling, 'cancelled', {
    cancellationReason: 'user_cancelled',
    observationCounters: Object.freeze({
      ...calling.observationCounters,
      engineActiveDurationMs: 13
    })
  }, [createRunEvent({
    eventId: 'journal-event-terminal', runId, sessionId,
    sequence: calling.nextEventSequence,
    occurredAt: finishedAt, type: 'run.cancelled',
    payload: Object.freeze({ reason: 'user_cancelled' })
  })], finishedAt)
  return Object.freeze({ checkpoint, receipt: terminalReceipt(checkpoint) })
}

function terminalContentFixture (): Readonly<{
  checkpoint: RunCheckpoint
  receipt: ReturnType<typeof parseTerminalCommitReceipt>
  assistantText: string
  toolArgumentUrl: string
  toolResourceUrl: string
}> {
  const base = terminalJournalFixture().checkpoint
  const assistantText = '终态 assistant 保留普通文本 URL：https://text.example.test/full?q=1#fragment'
  const toolArgumentUrl = 'https://user:pass@arguments.example.test/raw?q=2#fragment'
  const toolResourceUrl = 'https://user:pass@tools.example.test/assets/result.png?token=secret#private'
  const output = parseAgentMessage({
    id: 'terminal-output-message',
    role: 'assistant',
    parts: [{ type: 'text', text: assistantText }],
    createdAt: base.updatedAt,
    provenance: {
      source: 'model', trust: 'trusted', sensitivity: 'group',
      sourceId: 'terminal-output-message', createdAt: base.updatedAt
    }
  })
  const result = parseToolResult({
    status: 'success',
    effect: 'background',
    content: [{
      type: 'resource_ref', resourceType: 'image',
      resourceId: toolResourceUrl, mimeType: 'image/png'
    }],
    retryable: false
  })
  const checkpoint = parseRunCheckpoint({
    ...base,
    status: 'completed',
    cancellationReason: null,
    output,
    completion: { kind: 'reply_text', text: assistantText },
    toolLedgers: [{
      schemaVersion: 1,
      step: 0,
      calls: [{
        occurrenceId: '0:0',
        step: 0,
        index: 0,
        callId: 'terminal-call-1',
        toolName: 'terminal_tool',
        arguments: { url: toolArgumentUrl },
        status: 'succeeded',
        capability: null,
        result
      }]
    }]
  })
  return Object.freeze({
    checkpoint,
    receipt: terminalReceipt(checkpoint),
    assistantText,
    toolArgumentUrl,
    toolResourceUrl
  })
}

function terminalUnicodeResourcesFixture (): Readonly<{
  checkpoint: RunCheckpoint
  receipt: ReturnType<typeof parseTerminalCommitReceipt>
  ledgerSourceUrl: string
  ledgerLoggedUrl: string
  preparedSourceUrl: string
  preparedLoggedUrl: string
}> {
  const base = terminalContentFixture().checkpoint
  const ledgerPath = '中'.repeat(600)
  const preparedPath = '界'.repeat(600)
  const ledgerSourceUrl = `https://user:pass@ledger.example.test/${ledgerPath}?token=secret#private`
  const preparedSourceUrl = `https://user:pass@prepared.example.test/${preparedPath}?token=secret#private`
  const ledgerResult = parseToolResult({
    status: 'success', effect: 'background', retryable: false,
    content: [{
      type: 'resource_ref', resourceType: 'image',
      resourceId: ledgerSourceUrl, mimeType: 'image/png'
    }]
  })
  const preparedResult = parseToolResult({
    status: 'success', effect: 'background', retryable: false,
    content: [{
      type: 'resource_ref', resourceType: 'file',
      resourceId: preparedSourceUrl, mimeType: 'application/octet-stream'
    }]
  })
  const checkpoint = parseRunCheckpoint({
    ...base,
    toolLedgers: [{
      schemaVersion: 1,
      step: 0,
      calls: [{
        occurrenceId: '0:0', step: 0, index: 0,
        callId: 'unicode-ledger-call', toolName: 'unicode_ledger_tool',
        arguments: {}, status: 'succeeded', capability: null,
        result: ledgerResult
      }]
    }],
    preparedBatch: {
      schemaVersion: 1,
      calls: [{
        kind: 'completed', callId: 'unicode-prepared-call',
        toolName: 'unicode_prepared_tool', result: preparedResult
      }]
    }
  })
  return Object.freeze({
    checkpoint,
    receipt: terminalReceipt(checkpoint),
    ledgerSourceUrl,
    ledgerLoggedUrl: `https://ledger.example.test/${ledgerPath}`,
    preparedSourceUrl,
    preparedLoggedUrl: `https://prepared.example.test/${preparedPath}`
  })
}

function largeTerminalFixture (): Readonly<{
  checkpoint: RunCheckpoint
  receipt: ReturnType<typeof parseTerminalCommitReceipt>
}> {
  const base = terminalJournalFixture().checkpoint
  const payload = Object.freeze(Object.fromEntries(
    Array.from({ length: 90 }, (_, index) => [`k${index}`, index])
  ))
  const events = Object.freeze(Array.from({ length: 96 }, (_, sequence) => createRunEvent({
    eventId: `large-event-${sequence}`,
    runId: base.runId,
    sessionId: base.sessionId,
    sequence,
    occurredAt: base.updatedAt,
    type: 'run.progress',
    payload
  })))
  const checkpoint = parseRunCheckpoint({
    ...base,
    events,
    nextEventSequence: events.length
  })
  return Object.freeze({ checkpoint, receipt: terminalReceipt(checkpoint) })
}

function inMemoryContentJournal (): Readonly<{
  journal: GroupMateContentJournal
  events: GroupMateDiskLogEvent[]
}> {
  const events: GroupMateDiskLogEvent[] = []
  const journal = createGroupMateContentJournal({
    record: event => { events.push(event) },
    drain: async () => undefined
  })
  return Object.freeze({ journal, events })
}

function providerRequestEvent (
  request: ModelRequest = modelRequestFixture()
): RunContentJournalEvent {
  return Object.freeze({
    type: 'provider.request',
    occurredAt: '2026-07-17T08:01:00.000Z',
    runRef: '2'.repeat(32),
    requestRef: '1'.repeat(32),
    ordinal: 1,
    attemptKind: 'primary',
    request
  })
}

test('projects complete normalized request and provider content with legitimate business keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-content-journal-'))
  try {
    const diskLog = new GroupMateDiskLog({
      directory, now: () => new Date(FIXED_TIMESTAMP)
    })
    const journal = createGroupMateContentJournal(diskLog)
    const request = requestFixture()
    const providerRequest = modelRequestFixture()
    const runEvent: RunContentJournalEvent = Object.freeze({
      type: 'provider.request',
      occurredAt: '2026-07-17T08:01:00.000Z',
      runRef: '2'.repeat(32),
      requestRef: request.requestRef,
      ordinal: 1,
      attemptKind: 'primary',
      request: providerRequest
    })

    journal.recordRequest(request)
    journal.recordRunEvent(runEvent)
    await journal.drain()

    const events = await readLogEvents(directory)
    assert.equal(events.length, 2)
    assert.deepEqual(events[0], {
      type: 'request.received',
      payload: { request }
    })
    assert.deepEqual(events[1], {
      type: 'provider.request',
      payload: {
        occurredAt: runEvent.occurredAt,
        runRef: runEvent.runRef,
        requestRef: runEvent.requestRef,
        ordinal: runEvent.ordinal,
        attemptKind: runEvent.attemptKind,
        request: providerRequest
      }
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('sanitizes only typed current and quoted request resource URLs without mutating source', () => {
  const { journal, events } = inMemoryContentJournal()
  const base = requestFixture()
  const currentResourceUrl = 'https://user:pass@current.example.test/images/a.png?token=current#private'
  const quotedResourceUrl = 'https://user:pass@quote.example.test/files/b.jpg?token=quote#private'
  const ordinaryTextUrl = 'https://user:pass@text.example.test/raw?q=1#keep'
  const toolArgumentUrl = 'https://user:pass@arguments.example.test/raw?q=2#keep'
  const request = Object.freeze({
    ...base,
    message: Object.freeze({
      ...base.message,
      parts: Object.freeze([
        Object.freeze({ type: 'text' as const, text: ordinaryTextUrl }),
        Object.freeze({
          type: 'resource_ref' as const,
          resourceType: 'image' as const,
          resourceId: currentResourceUrl,
          mimeType: 'image/png'
        }),
        Object.freeze({
          type: 'tool_call' as const,
          toolCallId: 'request-url-call',
          name: 'retain_url_argument',
          arguments: Object.freeze({ url: toolArgumentUrl })
        })
      ]),
      replyTo: Object.freeze({
        messageId: 'quoted-url-message',
        sender: Object.freeze({ userId: 'quoted-user' }),
        parts: Object.freeze([
          Object.freeze({ type: 'text' as const, text: ordinaryTextUrl }),
          Object.freeze({
            type: 'resource_ref' as const,
            resourceType: 'image' as const,
            resourceId: quotedResourceUrl,
            mimeType: 'image/jpeg'
          })
        ])
      })
    })
  }) satisfies YunzaiAgentRequestDraft
  const sourceJson = JSON.stringify(request)

  journal.recordRequest(request)

  assert.equal(JSON.stringify(request), sourceJson)
  assert.equal(events.length, 1)
  const loggedRequest = (events[0]?.payload as {
    request: {
      message: {
        parts: Array<Record<string, unknown>>
        replyTo: { parts: Array<Record<string, unknown>> }
      }
    }
  }).request
  assert.equal(loggedRequest.message.parts[0]?.text, ordinaryTextUrl)
  assert.equal(
    (loggedRequest.message.parts[2]?.arguments as { url: string }).url,
    toolArgumentUrl
  )
  assert.equal(
    loggedRequest.message.parts[1]?.resourceId,
    'https://current.example.test/images/a.png'
  )
  assert.equal(loggedRequest.message.replyTo.parts[0]?.text, ordinaryTextUrl)
  assert.equal(
    loggedRequest.message.replyTo.parts[1]?.resourceId,
    'https://quote.example.test/files/b.jpg'
  )
  assert.equal(request.message.parts[1]?.type === 'resource_ref'
    ? request.message.parts[1].resourceId
    : null, currentResourceUrl)
  assert.equal(request.message.replyTo?.parts[1]?.type === 'resource_ref'
    ? request.message.replyTo.parts[1].resourceId
    : null, quotedResourceUrl)
})

test('projects complete provider response failure and committed terminal content', () => {
  const { journal, events } = inMemoryContentJournal()
  const turn = modelTurnFixture()
  const error = serializeAgentError(new AgentError({
    code: 'provider_unavailable',
    stage: 'model.response',
    retryable: true,
    userMessage: 'Provider 暂时不可用。',
    details: Object.freeze({ providerCode: 'fixture_unavailable', statusCode: 503 })
  }))
  const terminal = terminalJournalFixture()
  const common = Object.freeze({
    occurredAt: '2026-07-17T08:03:00.000Z',
    runRef: terminal.checkpoint.runRef,
    requestRef: terminal.checkpoint.requestRef
  })
  const response: RunContentJournalEvent = Object.freeze({
    type: 'provider.response', ...common,
    ordinal: 2, attemptKind: 'retry', turn
  })
  const failure: RunContentJournalEvent = Object.freeze({
    type: 'provider.failure', ...common,
    ordinal: 3, attemptKind: 'recovery', error
  })
  const committed: RunContentJournalEvent = Object.freeze({
    type: 'run.terminal_committed', ...common,
    checkpoint: terminal.checkpoint,
    receipt: terminal.receipt
  })

  journal.recordRunEvent(response)
  journal.recordRunEvent(failure)
  journal.recordRunEvent(committed)

  assert.deepEqual(events, [
    {
      type: 'provider.response',
      payload: {
        ...common, ordinal: 2, attemptKind: 'retry', turn
      }
    },
    {
      type: 'provider.failure',
      payload: {
        ...common, ordinal: 3, attemptKind: 'recovery', error
      }
    },
    {
      type: 'run.terminal_committed',
      payload: {
        ...common, checkpoint: terminal.checkpoint, receipt: terminal.receipt
      }
    }
  ])
})

test('sanitizes terminal tool resources while retaining assistant text and tool arguments', () => {
  const { journal, events } = inMemoryContentJournal()
  const terminal = terminalContentFixture()
  journal.recordRunEvent(Object.freeze({
    type: 'run.terminal_committed',
    occurredAt: terminal.checkpoint.updatedAt,
    runRef: terminal.checkpoint.runRef,
    requestRef: terminal.checkpoint.requestRef,
    checkpoint: terminal.checkpoint,
    receipt: terminal.receipt
  }))

  assert.equal(events.length, 1)
  const checkpoint = (events[0]?.payload as { checkpoint: RunCheckpoint }).checkpoint
  assert.equal(checkpoint.output?.parts[0]?.type === 'text'
    ? checkpoint.output.parts[0].text
    : null, terminal.assistantText)
  assert.equal(
    (checkpoint.toolLedgers[0]?.calls[0]?.arguments as { url: string }).url,
    terminal.toolArgumentUrl
  )
  const loggedResult = checkpoint.toolLedgers[0]?.calls[0]?.result
  assert.equal(loggedResult?.status === 'success' && loggedResult.content[0]?.type === 'resource_ref'
    ? loggedResult.content[0].resourceId
    : null, 'https://tools.example.test/assets/result.png')
  const sourceResult = terminal.checkpoint.toolLedgers[0]?.calls[0]?.result
  assert.equal(sourceResult?.status === 'success' && sourceResult.content[0]?.type === 'resource_ref'
    ? sourceResult.content[0].resourceId
    : null, terminal.toolResourceUrl)
})

test('preserves long Unicode paths in terminal ledger and prepared-batch log copies', () => {
  const { journal, events } = inMemoryContentJournal()
  const terminal = terminalUnicodeResourcesFixture()
  assert.ok(Buffer.byteLength(terminal.ledgerSourceUrl, 'utf8') < 4 * 1024)
  assert.ok(Buffer.byteLength(new URL(terminal.ledgerSourceUrl).pathname, 'utf8') > 4 * 1024)
  assert.ok(Buffer.byteLength(terminal.preparedSourceUrl, 'utf8') < 4 * 1024)
  assert.ok(Buffer.byteLength(new URL(terminal.preparedSourceUrl).pathname, 'utf8') > 4 * 1024)
  const sourceJson = JSON.stringify(terminal.checkpoint)

  journal.recordRunEvent({
    type: 'run.terminal_committed',
    occurredAt: terminal.checkpoint.updatedAt,
    runRef: terminal.checkpoint.runRef,
    requestRef: terminal.checkpoint.requestRef,
    checkpoint: terminal.checkpoint,
    receipt: terminal.receipt
  })

  assert.equal(JSON.stringify(terminal.checkpoint), sourceJson)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'run.terminal_committed')
  const logged = (events[0]?.payload as { checkpoint: RunCheckpoint }).checkpoint
  const ledgerResult = logged.toolLedgers[0]?.calls[0]?.result
  assert.equal(ledgerResult?.status === 'success' && ledgerResult.content[0]?.type === 'resource_ref'
    ? ledgerResult.content[0].resourceId
    : null, terminal.ledgerLoggedUrl)
  const prepared = logged.preparedBatch?.calls[0]
  assert.equal(prepared?.kind === 'completed' &&
    prepared.result.status === 'success' &&
    prepared.result.content[0]?.type === 'resource_ref'
    ? prepared.result.content[0].resourceId
    : null, terminal.preparedLoggedUrl)
  const sourceLedger = terminal.checkpoint.toolLedgers[0]?.calls[0]?.result
  assert.equal(sourceLedger?.status === 'success' && sourceLedger.content[0]?.type === 'resource_ref'
    ? sourceLedger.content[0].resourceId
    : null, terminal.ledgerSourceUrl)
  const sourcePrepared = terminal.checkpoint.preparedBatch?.calls[0]
  assert.equal(sourcePrepared?.kind === 'completed' &&
    sourcePrepared.result.status === 'success' &&
    sourcePrepared.result.content[0]?.type === 'resource_ref'
    ? sourcePrepared.result.content[0].resourceId
    : null, terminal.preparedSourceUrl)
})

test('authoritative checkpoint parser rejects terminal resource output before journaling', () => {
  const { journal, events } = inMemoryContentJournal()
  const terminal = terminalContentFixture()
  const resourceUrl = 'https://user:pass@unreachable.example.test/output.png?token=secret#private'
  const invalidOutput = parseAgentMessage({
    id: 'invalid-terminal-output',
    role: 'assistant',
    parts: [{ type: 'resource_ref', resourceType: 'image', resourceId: resourceUrl }],
    createdAt: terminal.checkpoint.updatedAt,
    provenance: {
      source: 'model', trust: 'trusted', sensitivity: 'group',
      sourceId: 'invalid-terminal-output', createdAt: terminal.checkpoint.updatedAt
    }
  })
  const invalidCheckpoint = {
    ...terminal.checkpoint,
    output: invalidOutput
  } as RunCheckpoint

  assert.throws(
    () => parseRunCheckpoint(invalidCheckpoint),
    /terminal output must be a canonical assistant text message/
  )
  journal.recordRunEvent({
    type: 'run.terminal_committed',
    occurredAt: terminal.checkpoint.updatedAt,
    runRef: terminal.checkpoint.runRef,
    requestRef: terminal.checkpoint.requestRef,
    checkpoint: invalidCheckpoint,
    receipt: terminal.receipt
  })
  assert.deepEqual(events, [{
    type: 'groupmate.content_journal.projection_failure',
    payload: { operation: 'run_event', code: 'invalid_content' }
  }])
  assert.equal(JSON.stringify(events).includes(resourceUrl), false)
})

test('terminal envelope uses the authority node budget and rejects nonterminal checkpoints', () => {
  const { journal, events } = inMemoryContentJournal()
  const large = largeTerminalFixture()
  assert.throws(() => parseJsonValue(large.checkpoint, {
    maxBytes: 1024 * 1024,
    maxDepth: 32,
    maxNodes: 8_192
  }), /node limit exceeded/)
  assert.doesNotThrow(() => parseRunCheckpoint(large.checkpoint))

  journal.recordRunEvent({
    type: 'run.terminal_committed',
    occurredAt: large.checkpoint.updatedAt,
    runRef: large.checkpoint.runRef,
    requestRef: large.checkpoint.requestRef,
    checkpoint: large.checkpoint,
    receipt: large.receipt
  })

  const terminal = terminalJournalFixture()
  const nonterminal = parseRunCheckpoint({
    ...terminal.checkpoint,
    status: 'calling_model',
    cancellationReason: null
  })
  journal.recordRunEvent({
    type: 'run.terminal_committed',
    occurredAt: nonterminal.updatedAt,
    runRef: nonterminal.runRef,
    requestRef: nonterminal.requestRef,
    checkpoint: nonterminal,
    receipt: terminal.receipt
  })

  assert.equal(events[0]?.type, 'run.terminal_committed')
  assert.deepEqual(events[1], {
    type: 'groupmate.content_journal.projection_failure',
    payload: { operation: 'run_event', code: 'invalid_content' }
  })
})

test('rejects structural credential and configuration extras with fixed failure evidence', () => {
  const { journal, events } = inMemoryContentJournal()
  const extraKeys = [
    'X-Api-Key', 'config', 'defaultHeaders', 'extraHeaders',
    'baseURL', 'headers', 'Authorization'
  ] as const
  for (const key of extraKeys) {
    journal.recordRunEvent(Object.assign({}, providerRequestEvent(), {
      [key]: `forbidden-${key}`
    }) as RunContentJournalEvent)
  }
  const request = requestFixture()
  journal.recordRequest({
    ...request,
    model: Object.assign({}, request.model, {
      config: Object.freeze({ apiKey: 'nested-model-secret' })
    })
  } as YunzaiAgentRequestDraft)
  journal.recordRunEvent(providerRequestEvent(Object.assign({}, modelRequestFixture(), {
    headers: Object.freeze({ Authorization: 'nested-provider-secret' })
  }) as ModelRequest))
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target,
    part: Object.assign({
      media: 'text' as const,
      atoms: Object.freeze([{ kind: 'text' as const, text: '正文' }])
    }, {
      extraHeaders: Object.freeze({ Authorization: 'nested-outbound-secret' })
    }) as OutboundPart,
    attempt: 1,
    quoteMessageId: null,
    result: Object.freeze({
      kind: 'failed_definite', media: 'text', attempt: 1, code: 'host_rejected'
    })
  })

  assert.deepEqual(events, [
    ...extraKeys.map(() => ({
      type: 'groupmate.content_journal.projection_failure',
      payload: { operation: 'run_event', code: 'invalid_content' }
    })),
    {
      type: 'groupmate.content_journal.projection_failure',
      payload: { operation: 'request', code: 'invalid_content' }
    },
    {
      type: 'groupmate.content_journal.projection_failure',
      payload: { operation: 'run_event', code: 'invalid_content' }
    },
    {
      type: 'groupmate.content_journal.projection_failure',
      payload: { operation: 'outbound', code: 'invalid_content' }
    }
  ])
  const serialized = JSON.stringify(events)
  for (const forbidden of [
    ...extraKeys,
    'nested-model-secret', 'nested-provider-secret', 'nested-outbound-secret'
  ]) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test('rejects unbounded hostile and binary generic content with fixed failure evidence', () => {
  const { journal, events } = inMemoryContentJournal()
  const invalidRequests: ModelRequest[] = []

  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  invalidRequests.push({
    ...modelRequestFixture(),
    tools: [{
      ...modelRequestFixture().tools[0], parameters: cycle as JsonObject
    }]
  })

  let deep: JsonObject = Object.freeze({ leaf: true })
  for (let depth = 0; depth < 40; depth += 1) deep = Object.freeze({ nested: deep })
  invalidRequests.push({
    ...modelRequestFixture(),
    tools: [{ ...modelRequestFixture().tools[0], parameters: deep }]
  })
  invalidRequests.push({
    ...modelRequestFixture(),
    tools: [{
      ...modelRequestFixture().tools[0],
      parameters: { nodes: Array.from({ length: 8_200 }, (_, index) => index) }
    }]
  })
  invalidRequests.push({
    ...modelRequestFixture(),
    tools: [{
      ...modelRequestFixture().tools[0],
      parameters: { body: 'x'.repeat(600 * 1_024) }
    }]
  })

  for (const binary of [
    new ArrayBuffer(8),
    new SharedArrayBuffer(8),
    new DataView(new ArrayBuffer(8)),
    new Uint16Array([513, 1_027])
  ]) {
    invalidRequests.push({
      ...modelRequestFixture(),
      tools: [{
        ...modelRequestFixture().tools[0],
        parameters: { binary } as unknown as JsonObject
      }]
    })
  }

  let getterReads = 0
  const accessorRequest = Object.defineProperty({ ...modelRequestFixture() }, 'model', {
    enumerable: true,
    get: () => {
      getterReads += 1
      return 'hostile-model'
    }
  }) as ModelRequest
  invalidRequests.push(accessorRequest)
  invalidRequests.push(Object.assign(Object.create({ inherited: true }), modelRequestFixture()))

  for (const request of invalidRequests) journal.recordRunEvent(providerRequestEvent(request))

  assert.equal(getterReads, 0)
  assert.deepEqual(events, invalidRequests.map(() => ({
    type: 'groupmate.content_journal.projection_failure',
    payload: { operation: 'run_event', code: 'invalid_content' }
  })))
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes('513'), false)
  assert.equal(serialized.includes('1027'), false)
  assert.equal(serialized.includes('hostile-model'), false)
})

test('projects exact QQ text and forward content while bounding media resources', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-content-journal-'))
  try {
    const diskLog = new GroupMateDiskLog({
      directory, now: () => new Date(FIXED_TIMESTAMP)
    })
    const journal = createGroupMateContentJournal(diskLog)
    const target = Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
    })
    const failedResult = Object.freeze({
      kind: 'failed_definite' as const, media: 'picture' as const,
      attempt: 1 as const, code: 'host_rejected' as const
    })

    journal.recordOutbound(Object.freeze({
      type: 'qq.outbound.deliver',
      occurredAt: '2026-07-17T08:02:00.000Z',
      target,
      part: Object.freeze({
        media: 'text' as const,
        atoms: Object.freeze([
          Object.freeze({ kind: 'text' as const, text: '完整文本' }),
          Object.freeze({ kind: 'markdown' as const, markdown: '**完整 Markdown**' })
        ])
      }),
      attempt: 1,
      quoteMessageId: 'quoted-1',
      result: Object.freeze({ ...failedResult, media: 'text' as const })
    }))
    journal.recordOutbound(Object.freeze({
      type: 'qq.outbound.deliver',
      occurredAt: '2026-07-17T08:02:01.000Z',
      target,
      part: Object.freeze({
        media: 'forward' as const,
        title: '完整合并转发',
        nodes: Object.freeze([
          Object.freeze({ kind: 'text' as const, text: '节点一' }),
          Object.freeze({ kind: 'text' as const, text: '节点二' })
        ])
      }),
      attempt: 1,
      quoteMessageId: null,
      result: Object.freeze({ ...failedResult, media: 'forward' as const })
    }))
    journal.recordOutbound(Object.freeze({
      type: 'qq.outbound.deliver',
      occurredAt: '2026-07-17T08:02:02.000Z',
      target,
      part: Object.freeze({
        media: 'picture' as const,
        resource: Object.freeze({
          kind: 'buffer' as const,
          data: Uint8Array.from([1, 2, 3, 4]),
          mimeType: 'image/png',
          byteLength: 4
        })
      }),
      attempt: 1,
      quoteMessageId: null,
      result: failedResult
    }))
    journal.recordOutbound(Object.freeze({
      type: 'qq.outbound.deliver',
      occurredAt: '2026-07-17T08:02:03.000Z',
      target,
      part: Object.freeze({
        media: 'video' as const,
        resource: Object.freeze({
          kind: 'remote_url' as const,
          url: 'https://user:pass@media.example.test/video/clip.mp4?token=secret#private',
          mimeType: 'video/mp4',
          byteLength: 1_024
        })
      }),
      attempt: 1,
      quoteMessageId: null,
      result: Object.freeze({ ...failedResult, media: 'video' as const })
    }))

    await journal.drain()

    const events = await readLogEvents(directory)
    assert.deepEqual((events[0] as { payload: { part: unknown } }).payload.part, {
      media: 'text',
      atoms: [
        { kind: 'text', text: '完整文本' },
        { kind: 'markdown', markdown: '**完整 Markdown**' }
      ]
    })
    assert.deepEqual((events[1] as { payload: { part: unknown } }).payload.part, {
      media: 'forward',
      title: '完整合并转发',
      nodes: [
        { kind: 'text', text: '节点一' },
        { kind: 'text', text: '节点二' }
      ]
    })
    assert.deepEqual((events[2] as { payload: { part: unknown } }).payload.part, {
      media: 'picture',
      resource: { kind: 'buffer', mimeType: 'image/png', byteLength: 4 }
    })
    assert.deepEqual((events[3] as { payload: { part: unknown } }).payload.part, {
      media: 'video',
      resource: {
        kind: 'remote_url',
        url: 'https://media.example.test/video/clip.mp4',
        mimeType: 'video/mp4',
        byteLength: 1_024
      }
    })
    const serialized = JSON.stringify(events)
    assert.equal(serialized.includes('"data"'), false)
    assert.equal(serialized.includes('token=secret'), false)
    assert.equal(serialized.includes('#private'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('preserves legal 257-atom node and button collections under the shared hard budget', () => {
  const { journal, events } = inMemoryContentJournal()
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const atoms = Object.freeze(Array.from({ length: 257 }, (_, index) => Object.freeze({
    kind: 'text' as const,
    text: `atom-${index}`
  })))
  const part = Object.freeze({ media: 'text' as const, atoms })
  const result = Object.freeze({
    kind: 'failed_definite' as const,
    media: 'text' as const,
    attempt: 1 as const,
    code: 'host_rejected' as const
  })
  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target,
    part,
    attempt: 1,
    quoteMessageId: null,
    result
  })
  const nodes = Object.freeze(Array.from({ length: 257 }, (_, index) => Object.freeze({
    kind: 'text' as const,
    text: `node-${index}`
  })))
  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target,
    part: Object.freeze({ media: 'forward', title: '257 nodes', nodes }),
    attempt: 1,
    quoteMessageId: null,
    result: Object.freeze({ ...result, media: 'forward' })
  })
  const suggestions = Object.freeze(Array.from(
    { length: 257 }, (_, index) => `suggestion-${index}`
  ))
  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target,
    part: Object.freeze({
      media: 'text',
      atoms: Object.freeze([{ kind: 'text' as const, text: 'buttons' }]),
      buttons: Object.freeze({
        schemaVersion: 1 as const,
        kind: 'chat_suggestions' as const,
        suggestions
      })
    }),
    attempt: 1,
    quoteMessageId: null,
    result
  })

  assert.equal(events.length, 3)
  assert.equal(events[0]?.type, 'qq.outbound.deliver')
  const atomPayload = events[0]?.payload as {
    part: { atoms: Array<{ text: string }> }
    result: unknown
  }
  assert.equal(atomPayload.part.atoms.length, 257)
  assert.equal(atomPayload.part.atoms[0]?.text, 'atom-0')
  assert.equal(atomPayload.part.atoms[256]?.text, 'atom-256')
  assert.deepEqual(atomPayload.result, result)
  const nodePayload = events[1]?.payload as {
    part: { nodes: Array<{ text: string }> }
  }
  assert.equal(nodePayload.part.nodes.length, 257)
  assert.equal(nodePayload.part.nodes[256]?.text, 'node-256')
  const buttonPayload = events[2]?.payload as {
    part: { buttons: { suggestions: string[] } }
  }
  assert.equal(buttonPayload.part.buttons.suggestions.length, 257)
  assert.equal(buttonPayload.part.buttons.suggestions[256], 'suggestion-256')
})

test('rejects a virtual-length outbound Array Proxy without observing its traps', () => {
  const { journal, events } = inMemoryContentJournal()
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const atom = Object.freeze({ kind: 'text' as const, text: 'virtual-array-item' })
  const backing: Array<typeof atom> = []
  let getTraps = 0
  let prototypeTraps = 0
  let ownKeysTraps = 0
  let descriptorTraps = 0
  const atoms = new Proxy(backing, {
    get: (value, key, receiver) => {
      getTraps += 1
      if (key === 'length') return 100_000
      if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) return atom
      return Reflect.get(value, key, receiver)
    },
    getPrototypeOf: value => {
      prototypeTraps += 1
      return Reflect.getPrototypeOf(value)
    },
    ownKeys: value => {
      ownKeysTraps += 1
      return Reflect.ownKeys(value)
    },
    getOwnPropertyDescriptor: (value, key) => {
      descriptorTraps += 1
      return Reflect.getOwnPropertyDescriptor(value, key)
    }
  })
  assert.equal(atoms.length, 100_000)
  assert.equal(atoms[99_999], atom)
  getTraps = 0
  prototypeTraps = 0
  ownKeysTraps = 0
  descriptorTraps = 0

  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target,
    part: { media: 'text', atoms },
    attempt: 1,
    quoteMessageId: null,
    result: {
      kind: 'failed_definite', media: 'text', attempt: 1, code: 'host_rejected'
    }
  })

  assert.deepEqual(events, [{
    type: 'groupmate.content_journal.projection_failure',
    payload: { operation: 'outbound', code: 'invalid_content' }
  }])
  assert.equal(events.some(event => event.type === 'qq.outbound.deliver'), false)
  assert.equal(getTraps, 0)
  assert.equal(prototypeTraps, 0)
  assert.equal(ownKeysTraps, 0)
  assert.equal(descriptorTraps, 0)
})

test('rejects an outbound record Proxy without observing its traps', () => {
  const { journal, events } = inMemoryContentJournal()
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const backing = Object.freeze({
    media: 'text' as const,
    atoms: Object.freeze([Object.freeze({
      kind: 'text' as const, text: 'record-proxy-item'
    })])
  })
  let getTraps = 0
  let prototypeTraps = 0
  let ownKeysTraps = 0
  let descriptorTraps = 0
  const part = new Proxy(backing, {
    get: (value, key, receiver) => {
      getTraps += 1
      return Reflect.get(value, key, receiver)
    },
    getPrototypeOf: value => {
      prototypeTraps += 1
      return Reflect.getPrototypeOf(value)
    },
    ownKeys: value => {
      ownKeysTraps += 1
      return Reflect.ownKeys(value)
    },
    getOwnPropertyDescriptor: (value, key) => {
      descriptorTraps += 1
      return Reflect.getOwnPropertyDescriptor(value, key)
    }
  })
  assert.equal(part.media, 'text')
  getTraps = 0
  prototypeTraps = 0
  ownKeysTraps = 0
  descriptorTraps = 0

  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target,
    part,
    attempt: 1,
    quoteMessageId: null,
    result: {
      kind: 'failed_definite', media: 'text', attempt: 1, code: 'host_rejected'
    }
  })

  assert.deepEqual(events, [{
    type: 'groupmate.content_journal.projection_failure',
    payload: { operation: 'outbound', code: 'invalid_content' }
  }])
  assert.equal(events.some(event => event.type === 'qq.outbound.deliver'), false)
  assert.equal(getTraps, 0)
  assert.equal(prototypeTraps, 0)
  assert.equal(ownKeysTraps, 0)
  assert.equal(descriptorTraps, 0)
})

test('rejects a hostile 100000-item outbound Array Proxy before whole-array inspection', () => {
  const { journal, events } = inMemoryContentJournal()
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const atom = Object.freeze({ kind: 'text' as const, text: 'hostile-array-item' })
  const backing = Array.from({ length: 100_000 }, () => atom)
  let ownKeysTraps = 0
  let descriptorTraps = 0
  const atoms = new Proxy(backing, {
    ownKeys: value => {
      ownKeysTraps += 1
      return Reflect.ownKeys(value)
    },
    getOwnPropertyDescriptor: (value, key) => {
      descriptorTraps += 1
      return Reflect.getOwnPropertyDescriptor(value, key)
    }
  })

  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target,
    part: { media: 'text', atoms },
    attempt: 1,
    quoteMessageId: null,
    result: {
      kind: 'failed_definite', media: 'text', attempt: 1, code: 'host_rejected'
    }
  })

  assert.deepEqual(events, [{
    type: 'groupmate.content_journal.projection_failure',
    payload: { operation: 'outbound', code: 'invalid_content' }
  }])
  assert.equal(ownKeysTraps, 0)
  assert.ok(descriptorTraps <= 2, `descriptor traps: ${descriptorTraps}`)
})

test('rejects outbound text beyond the incremental UTF-8 byte budget', () => {
  const { journal, events } = inMemoryContentJournal()
  const oversizedText = '界'.repeat(Math.floor((1024 * 1024) / 3) + 1)
  assert.ok(Buffer.byteLength(oversizedText, 'utf8') > 1024 * 1024)
  journal.recordOutbound({
    type: 'qq.outbound.deliver',
    occurredAt: FIXED_TIMESTAMP,
    target: Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
    }),
    part: { media: 'text', atoms: [{ kind: 'text', text: oversizedText }] },
    attempt: 1,
    quoteMessageId: null,
    result: {
      kind: 'failed_definite', media: 'text', attempt: 1, code: 'host_rejected'
    }
  })
  assert.deepEqual(events, [{
    type: 'groupmate.content_journal.projection_failure',
    payload: { operation: 'outbound', code: 'invalid_content' }
  }])
  assert.equal(JSON.stringify(events).includes('界界界'), false)
})

test('retains metadata when an accepted remote URL is malformed or non-HTTP', () => {
  const { journal, events } = inMemoryContentJournal()
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const inputs = Object.freeze([
    Object.freeze({
      media: 'picture' as const,
      resource: Object.freeze({
        kind: 'remote_url' as const,
        url: 'malformed remote value ?token=secret#private',
        mimeType: 'image/png',
        byteLength: 321
      })
    }),
    Object.freeze({
      media: 'video' as const,
      resource: Object.freeze({
        kind: 'remote_url' as const,
        url: 'file:///private/video.mp4?token=secret#private',
        mimeType: 'video/mp4',
        byteLength: 654
      })
    })
  ])
  for (const part of inputs) {
    journal.recordOutbound({
      type: 'qq.outbound.deliver',
      occurredAt: FIXED_TIMESTAMP,
      target,
      part,
      attempt: 1,
      quoteMessageId: null,
      result: Object.freeze({
        kind: 'failed_definite', media: part.media, attempt: 1, code: 'host_rejected'
      })
    })
  }

  assert.deepEqual(events.map(event => event.payload.part), [
    {
      media: 'picture',
      resource: { kind: 'remote_url', mimeType: 'image/png', byteLength: 321 }
    },
    {
      media: 'video',
      resource: { kind: 'remote_url', mimeType: 'video/mp4', byteLength: 654 }
    }
  ])
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes('malformed remote value'), false)
  assert.equal(serialized.includes('file:///private/video.mp4'), false)
  assert.equal(serialized.includes('token=secret'), false)
})

function collectingJournal (
  events: GroupMateOutboundJournalEvent[],
  fail = false
): GroupMateContentJournal {
  return Object.freeze({
    recordRequest: () => undefined,
    recordRunEvent: () => undefined,
    recordOutbound: (event: GroupMateOutboundJournalEvent) => {
      if (fail) throw new Error('journal unavailable')
      events.push(event)
    },
    drain: async () => undefined
  })
}

test('journaled QQ outbound returns delegate results by identity and records fixed outcomes', async () => {
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const textPart: OutboundPart = Object.freeze({
    media: 'text', atoms: Object.freeze([{ kind: 'text' as const, text: 'delegate 正文' }])
  })
  const receipt = Object.freeze({
    schemaVersion: 1, media: 'text', messageId: 'message-1'
  }) as RuntimeDeliveryReceipt<'text'>
  const sent = Object.freeze({
    kind: 'sent', media: 'text', attempt: 1, receipt
  }) as DeliveryResult<'text'>
  const deliveryFailure = Object.freeze({
    kind: 'failed_definite' as const,
    media: 'text' as const,
    attempt: 2 as const,
    code: 'host_rejected' as const
  })
  const recalled = Object.freeze({ kind: 'recalled' as const })
  const recallFailure = Object.freeze({
    kind: 'failed_definite' as const, code: 'host_rejected' as const
  })
  const deliveryResults: DeliveryResult[] = [sent, deliveryFailure]
  const recallResults: RecallResult[] = [recalled, recallFailure]
  const delegatePort: YunzaiOutboundPort = Object.freeze({
    target,
    deliver: async () => deliveryResults.shift() as DeliveryResult,
    recall: async () => recallResults.shift() as RecallResult
  })
  const delegate: YunzaiOutboundPortFactory = Object.freeze({
    forTarget: async () => delegatePort
  })
  const events: GroupMateOutboundJournalEvent[] = []
  const wrapped = await createJournaledYunzaiOutboundPortFactory(
    delegate,
    collectingJournal(events),
    () => new Date(FIXED_TIMESTAMP)
  ).forTarget(target)

  const firstDelivery = await wrapped.deliver(textPart, 1, {
    quoteMessageId: 'quoted-message-1'
  })
  const secondDelivery = await wrapped.deliver(textPart, 2)
  const firstRecall = await wrapped.recall(receipt)
  const secondRecall = await wrapped.recall(receipt)

  assert.strictEqual(firstDelivery, sent)
  assert.strictEqual(secondDelivery, deliveryFailure)
  assert.strictEqual(firstRecall, recalled)
  assert.strictEqual(secondRecall, recallFailure)
  assert.deepEqual(events, [
    {
      type: 'qq.outbound.deliver', occurredAt: FIXED_TIMESTAMP,
      target, part: textPart, attempt: 1, quoteMessageId: 'quoted-message-1', result: sent
    },
    {
      type: 'qq.outbound.deliver', occurredAt: FIXED_TIMESTAMP,
      target, part: textPart, attempt: 2, quoteMessageId: null, result: deliveryFailure
    },
    {
      type: 'qq.outbound.recall', occurredAt: FIXED_TIMESTAMP,
      target, receipt, result: recalled
    },
    {
      type: 'qq.outbound.recall', occurredAt: FIXED_TIMESTAMP,
      target, receipt, result: recallFailure
    }
  ])
  assert.equal(events[0]?.type === 'qq.outbound.deliver' &&
    events[0].result.kind === 'sent'
    ? events[0].result.receipt.messageId
    : null, 'message-1')
})

test('journal and clock exceptions never change QQ delegate outcomes', async () => {
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'private' as const, userId: 'user-1' })
  })
  const textPart: OutboundPart = Object.freeze({
    media: 'text', atoms: Object.freeze([{ kind: 'text' as const, text: '正文' }])
  })
  const deliveryResult = Object.freeze({
    kind: 'failed_definite' as const,
    media: 'text' as const,
    attempt: 1 as const,
    code: 'host_rejected' as const
  })
  const recallResult = Object.freeze({
    kind: 'failed_definite' as const, code: 'message_id_unavailable' as const
  })
  const receipt = Object.freeze({
    schemaVersion: 1, media: 'text', messageId: 'message-2'
  }) as RuntimeDeliveryReceipt<'text'>
  const delegate: YunzaiOutboundPortFactory = Object.freeze({
    forTarget: async () => Object.freeze({
      target,
      deliver: async () => deliveryResult,
      recall: async () => recallResult
    })
  })
  const wrapped = await createJournaledYunzaiOutboundPortFactory(
    delegate,
    collectingJournal([], true),
    () => { throw new Error('clock unavailable') }
  ).forTarget(target)

  assert.strictEqual(await wrapped.deliver(textPart, 1), deliveryResult)
  assert.strictEqual(await wrapped.recall(receipt), recallResult)
})

test('hostile quote getters after delivery stay inside the swallowed journal boundary', async () => {
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'private' as const, userId: 'user-1' })
  })
  const part: OutboundPart = Object.freeze({
    media: 'text', atoms: Object.freeze([{ kind: 'text' as const, text: '正文' }])
  })
  const result = Object.freeze({
    kind: 'failed_definite' as const,
    media: 'text' as const,
    attempt: 1 as const,
    code: 'host_rejected' as const
  })
  let getterReads = 0
  const options = Object.defineProperty({}, 'quoteMessageId', {
    enumerable: true,
    get: () => {
      getterReads += 1
      throw new Error('hostile quote getter')
    }
  }) as Parameters<YunzaiOutboundPort['deliver']>[2]
  const delegate: YunzaiOutboundPortFactory = Object.freeze({
    forTarget: async () => Object.freeze({
      target,
      deliver: async () => result,
      recall: async () => Object.freeze({ kind: 'recalled' as const })
    })
  })
  const wrapped = await createJournaledYunzaiOutboundPortFactory(
    delegate, collectingJournal([]), () => new Date(FIXED_TIMESTAMP)
  ).forTarget(target)

  assert.strictEqual(await wrapped.deliver(part, 1, options), result)
  assert.equal(getterReads, 1)
})

test('journal wrapping captures delegate target once for delivery and recall', async () => {
  const target = Object.freeze({
    botId: 'bot-1', scope: Object.freeze({ kind: 'group' as const, groupId: 'group-1' })
  })
  const part: OutboundPart = Object.freeze({
    media: 'text', atoms: Object.freeze([{ kind: 'text' as const, text: '正文' }])
  })
  const receipt = Object.freeze({
    schemaVersion: 1, media: 'text', messageId: 'message-target-once'
  }) as RuntimeDeliveryReceipt<'text'>
  const deliveryResult = Object.freeze({
    kind: 'failed_definite' as const,
    media: 'text' as const,
    attempt: 1 as const,
    code: 'host_rejected' as const
  })
  const recallResult = Object.freeze({ kind: 'recalled' as const })

  async function wrappedPort (): Promise<Readonly<{
    port: YunzaiOutboundPort
    targetReads: () => number
  }>> {
    let reads = 0
    const delegatePort = Object.defineProperty({
      deliver: async () => deliveryResult,
      recall: async () => recallResult
    }, 'target', {
      enumerable: true,
      get: () => {
        reads += 1
        if (reads > 1) throw new Error('delegate target read repeatedly')
        return target
      }
    }) as unknown as YunzaiOutboundPort
    const delegate: YunzaiOutboundPortFactory = Object.freeze({
      forTarget: async () => delegatePort
    })
    const port = await createJournaledYunzaiOutboundPortFactory(
      delegate, collectingJournal([]), () => new Date(FIXED_TIMESTAMP)
    ).forTarget(target)
    return Object.freeze({ port, targetReads: () => reads })
  }

  const delivery = await wrappedPort()
  assert.strictEqual(await delivery.port.deliver(part, 1), deliveryResult)
  assert.equal(delivery.targetReads(), 1)

  const recall = await wrappedPort()
  assert.strictEqual(await recall.port.recall(receipt), recallResult)
  assert.equal(recall.targetReads(), 1)
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ModelRequest } from '../../src/agent/model/model-adapter.js'
import type { RunContentJournalEvent } from '../../src/agent/run/run-content-journal.js'
import {
  createGroupMateContentJournal
} from '../../src/runtime/logging/groupmate-content-journal.js'
import type {
  GroupMateContentJournal,
  GroupMateOutboundJournalEvent
} from '../../src/runtime/logging/groupmate-content-journal.js'
import { GroupMateDiskLog } from '../../src/runtime/logging/groupmate-disk-log.js'
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
      Object.freeze({ type: 'mention' as const, userId: 'member-2', displayName: '成员二' })
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
      reservedToolTokens: 512, safetyMarginTokens: 128,
      maxItems: 64, maxBytes: 256 * 1_024
    }),
    sessionTtlSeconds: 3_600
  })
  return Object.assign({}, request, {
    Authorization: 'Bearer must-not-be-written',
    apiKey: 'must-not-be-written'
  })
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
          properties: Object.freeze({ query: Object.freeze({ type: 'string' }) })
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

test('projects complete normalized request and provider content without config bags', async () => {
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
    const unsafeRequest = request as YunzaiAgentRequestDraft & {
      readonly Authorization: string
      readonly apiKey: string
    }
    const {
      Authorization: _authorization,
      apiKey: _apiKey,
      ...expectedRequest
    } = unsafeRequest
    assert.equal(events.length, 2)
    assert.deepEqual(events[0], {
      type: 'request.received',
      payload: { request: expectedRequest }
    })
    const serializedRequest = JSON.stringify(events[0])
    assert.equal(serializedRequest.includes('Authorization'), false)
    assert.equal(serializedRequest.includes('apiKey'), false)
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
          url: 'https://media.example.test/video/clip.mp4?token=secret#private',
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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent, AgentEventType } from '../../src/agent/contracts/event.js'
import type { FrozenObservationPolicyV1 } from '../../src/agent/run/run-observation.js'
import type { PendingIndicatorHandle } from '../../src/runtime/presentation/pending-indicator-presenter.js'
import type {
  RuntimeDeliveryReceipt,
  YunzaiOutboundPort
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import {
  progressResumeStateFromEvents,
  RunProgressPresenter,
  type ProgressAttachmentMetadata
} from '../../src/runtime/run-progress-presenter.js'

function event (
  sequence: number,
  type: AgentEventType,
  payload: AgentEvent['payload'] = {}
): AgentEvent {
  return Object.freeze({
    eventVersion: 1,
    eventId: `event-${sequence}`,
    runId: 'run-private-value',
    sessionId: 'session-private-value',
    sequence,
    occurredAt: `2026-07-14T01:00:${String(sequence).padStart(2, '0')}.000Z`,
    type,
    payload: Object.freeze(payload)
  })
}

const policy: FrozenObservationPolicyV1 = Object.freeze({
  schemaVersion: 1,
  levelAtStart: 'diagnostic',
  sampledSuccess: false
})

function attachment (input: {
  readonly sent: string[]
  readonly indicator?: PendingIndicatorHandle | null
  readonly failFirst?: boolean
  readonly requestKind?: 'ordinary_chat' | 'proactive_chat' | 'recovered_legacy_plain_text'
}) {
  let attempts = 0
  const outbound: YunzaiOutboundPort = {
    target: Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
    }),
    deliver: async (part, attempt) => {
      attempts += 1
      const text = part.media === 'text' && part.atoms[0]?.kind === 'text'
        ? part.atoms[0].text
        : ''
      if (input.failFirst === true && attempts === 1) {
        return Object.freeze({
          kind: 'outcome_unknown', media: part.media, attempt,
          code: 'host_exception_after_dispatch'
        }) as never
      }
      input.sent.push(text)
      return Object.freeze({
        kind: 'sent', media: part.media, attempt,
        receipt: Object.freeze({ schemaVersion: 1, media: part.media, messageId: `progress-${attempts}` })
      }) as never
    },
    recall: async (_receipt: RuntimeDeliveryReceipt) => Object.freeze({ kind: 'recalled' })
  }
  return {
    runId: 'run-private-value',
    runRef: '1'.repeat(32),
    requestKind: input.requestKind ?? 'ordinary_chat',
    observationPolicy: policy,
    resume: Object.freeze({ attempts: 0, seenStages: Object.freeze([]) }),
    outbound,
    indicator: input.indicator ?? null
  }
}

test('progress presenter sends deterministic bounded tool milestones at most five times', async () => {
  const sent: string[] = []
  const presenter = new RunProgressPresenter()
  presenter.attach(attachment({ sent }))

  const names = ['website', 'weather', 'github', 'queryUserinfo', 'sendPicture', 'musicQuery']
  names.forEach((toolName, index) => presenter.handle(event(index, 'tool.started', { toolName })))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent.slice(0, 2), [
    '正在读取网页（步骤 1）',
    '正在查询天气（步骤 2）'
  ])
  assert.equal(sent.length, 5)
  assert.equal(sent.every(text => [...text.normalize('NFC').trim()].length <= 200), true)
})

test('progress presenter keeps repeated search occurrences distinct and replay-safe', async () => {
  const sent: string[] = []
  const presenter = new RunProgressPresenter()
  presenter.attach(attachment({ sent }))

  for (let index = 0; index < 3; index += 1) {
    presenter.handle(event(index, 'tool.started', {
      callId: `call-${index}`,
      toolName: 'search',
      occurrenceId: `${index}:0`
    }))
  }
  presenter.handle(event(3, 'tool.started', {
    callId: 'call-replayed-occurrence',
    toolName: 'search',
    occurrenceId: '1:0'
  }))
  presenter.handle(event(4, 'tool.started', {
    callId: 'call-3',
    toolName: 'search',
    occurrenceId: '3:0'
  }))
  presenter.handle(event(5, 'tool.started', {
    callId: 'call-4',
    toolName: 'search',
    occurrenceId: '4:0'
  }))
  presenter.handle(event(6, 'tool.started', {
    callId: 'call-over-limit',
    toolName: 'search',
    occurrenceId: '5:0'
  }))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent, [
    '正在搜索网络（步骤 1）',
    '正在搜索网络（步骤 2）',
    '正在搜索网络（步骤 3）',
    '正在搜索网络（步骤 4）',
    '正在搜索网络（步骤 5）'
  ])
})

test('progress presenter falls back to legacy call identity before tool name', async () => {
  const sent: string[] = []
  const presenter = new RunProgressPresenter()
  presenter.attach(attachment({ sent }))

  presenter.handle(event(0, 'tool.started', { callId: 'legacy-1', toolName: 'search' }))
  presenter.handle(event(1, 'tool.started', { callId: 'legacy-2', toolName: 'search' }))
  presenter.handle(event(2, 'tool.started', { callId: 'legacy-2', toolName: 'search' }))
  presenter.handle(event(3, 'tool.started', { toolName: 'search' }))
  presenter.handle(event(4, 'tool.started', { toolName: 'search' }))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent, [
    '正在搜索网络（步骤 1）',
    '正在搜索网络（步骤 2）',
    '正在搜索网络（步骤 3）'
  ])
})

test('progress presenter deduplicates persisted events and suppresses terminal late delivery', async () => {
  const sent: string[] = []
  const presenter = new RunProgressPresenter()
  const historical = event(0, 'tool.started', { toolName: 'website' })
  presenter.attach(attachment({ sent }))

  presenter.handle(event(0, 'run.completed', { completionKind: 'reply_text' }))
  presenter.handle(historical)
  presenter.handle(event(1, 'tool.started', { toolName: 'website' }))
  presenter.handle(event(2, 'tool.started', { toolName: 'weather' }))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent, [])
})

test('progress presenter ignores model-like text and isolates delivery failures', async () => {
  const logs: unknown[] = []
  const sent: string[] = []
  const presenter = new RunProgressPresenter({
    onDeliveryFailure: value => logs.push(value)
  })
  presenter.attach(attachment({ sent, failFirst: true }))

  presenter.handle(event(0, 'run.progress', {
    stage: 'tool_started', toolName: 'website', text: 'model supplied private progress'
  }))
  presenter.handle(event(1, 'tool.started', { toolName: 'weather' }))
  presenter.handle(event(2, 'model.attempted', {
    observationSchemaVersion: 1,
    attemptKind: 'primary',
    outcome: 'succeeded',
    durationMs: 1,
    errorCode: null
  }))
  presenter.handle(event(3, 'tool.attempted', {
    observationSchemaVersion: 1,
    ordinal: 1,
    outcome: 'succeeded',
    durationMs: 1,
    resultCode: null
  }))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent, ['正在查询天气（步骤 2）'])
  assert.doesNotMatch(JSON.stringify(logs), /private delivery body|model supplied/)
  assert.deepEqual(logs, [{
    event: 'run.progress.delivery_failed',
    runRef: '1'.repeat(32),
    sequence: 0,
    eventType: 'run.progress',
    resultCode: 'outcome_unknown'
  }])
})

test('progress presenter isolates every pending dismiss failure from queued delivery', async () => {
  const sent: string[] = []
  const logs: unknown[] = []
  const dismissReasons: string[] = []
  let dismissCalls = 0
  const indicator: PendingIndicatorHandle = Object.freeze({
    runRef: '1'.repeat(32),
    dismiss: (reason: Parameters<PendingIndicatorHandle['dismiss']>[0]) => {
      dismissCalls += 1
      dismissReasons.push(reason)
      if (dismissCalls === 1) throw new Error('private synchronous recall failure')
      return Promise.reject(new Error('private asynchronous recall failure'))
    }
  })
  const presenter = new RunProgressPresenter({
    onDeliveryFailure: value => logs.push(value)
  })
  presenter.attach(attachment({ sent, indicator }))

  presenter.handle(event(0, 'tool.started', { toolName: 'website' }))
  presenter.handle(event(1, 'tool.started', { toolName: 'weather' }))
  presenter.handle(event(2, 'run.completed', { completionKind: 'reply_text' }))

  await assert.doesNotReject(presenter.drain('run-private-value'))
  assert.deepEqual(sent, ['正在读取网页（步骤 1）', '正在查询天气（步骤 2）'])
  assert.deepEqual(dismissReasons, ['progress', 'progress', 'terminal'])
  assert.deepEqual(logs, [])
  assert.doesNotMatch(JSON.stringify(sent), /private|recall|failure/)
})

test('progress presenter isolates a paused dismissal failure from drain', async () => {
  const sent: string[] = []
  const dismissReasons: string[] = []
  const indicator: PendingIndicatorHandle = Object.freeze({
    runRef: '1'.repeat(32),
    dismiss: async (reason: Parameters<PendingIndicatorHandle['dismiss']>[0]) => {
      dismissReasons.push(reason)
      throw new Error('private paused recall failure')
    }
  })
  const presenter = new RunProgressPresenter()
  presenter.attach(attachment({ sent, indicator }))

  presenter.handle(event(0, 'tool.started', { toolName: 'website' }))
  presenter.handle(event(1, 'run.paused', { reason: 'approval_required' }))

  await assert.doesNotReject(presenter.drain('run-private-value'))
  assert.deepEqual(sent, ['正在读取网页（步骤 1）'])
  assert.deepEqual(dismissReasons, ['progress', 'paused'])
})

test('progress freezes request kind and checkpoint observation policy outside provider feedback', async () => {
  const sent: string[] = []
  const observed: ProgressAttachmentMetadata[] = []
  const mutable = attachment({ sent }) as unknown as {
    requestKind: string
    observationPolicy: FrozenObservationPolicyV1
    resume: { attempts: number; seenStages: string[] }
  }
  mutable.resume = { attempts: 2, seenStages: ['tool_started:正在查询天气'] }
  const presenter = new RunProgressPresenter({
    onAttachment: metadata => { observed.push(metadata) }
  })
  presenter.attach(mutable as never)
  mutable.requestKind = 'proactive_chat'
  mutable.observationPolicy = Object.freeze({
    schemaVersion: 1, levelAtStart: 'off', sampledSuccess: false
  })
  mutable.resume.attempts = 0
  mutable.resume.seenStages.push('tool_started:正在读取网页')

  presenter.handle(event(0, 'run.progress', {
    stage: 'tool_started',
    toolName: 'website',
    text: 'provider supplied secret progress',
    requestKind: 'proactive_chat',
    observationLevel: 'off'
  }))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent, ['正在读取网页（步骤 2）'])
  assert.doesNotMatch(JSON.stringify(sent), /secret|proactive|observation/)
  assert.deepEqual(observed, [Object.freeze({
    runId: 'run-private-value',
    runRef: '1'.repeat(32),
    requestKind: 'ordinary_chat',
    observationPolicy: policy,
    resume: Object.freeze({
      attempts: 2,
      seenStages: Object.freeze(['tool_started:正在查询天气'])
    })
  })])
  assert.equal(Object.isFrozen(observed[0]), true)
  assert.equal(Object.isFrozen(observed[0]?.observationPolicy), true)
  assert.equal(Object.isFrozen(observed[0]?.resume), true)
  assert.equal(Object.isFrozen(observed[0]?.resume.seenStages), true)
})

test('progress attachment rejects forged request kind reference and observation policy metadata', () => {
  const observed: ProgressAttachmentMetadata[] = []
  const presenter = new RunProgressPresenter({
    onAttachment: metadata => { observed.push(metadata) }
  })

  for (const requestKind of ['legacy_unknown', 'ordinary_chat ', 'forged_kind']) {
    assert.throws(() => presenter.attach({
      ...attachment({ sent: [] }),
      requestKind
    } as never), /progress attachment is invalid/)
  }

  for (const runRef of ['A'.repeat(32), '1'.repeat(31), ` ${'1'.repeat(32)}`]) {
    assert.throws(() => presenter.attach({
      ...attachment({ sent: [] }),
      runRef
    }), /progress attachment is invalid/)
  }

  const invalidPolicies: readonly unknown[] = Object.freeze([
    { schemaVersion: 99, levelAtStart: 'diagnostic', sampledSuccess: false },
    { schemaVersion: 1, levelAtStart: 'private', sampledSuccess: false },
    { schemaVersion: 1, levelAtStart: 'diagnostic', sampledSuccess: 'false' },
    {
      schemaVersion: 1,
      levelAtStart: 'diagnostic',
      sampledSuccess: false,
      secret: 'must not cross the safe attachment boundary'
    }
  ])
  for (const observationPolicy of invalidPolicies) {
    assert.throws(() => presenter.attach({
      ...attachment({ sent: [] }),
      observationPolicy
    } as never), /observation policy/)
  }

  assert.deepEqual(observed, [])
})

test('progress resumes from persisted occurrences at the next step within bounded retries', async () => {
  const historical = Object.freeze([
    event(0, 'tool.started', {
      callId: 'call-0', toolName: 'search', occurrenceId: '0:0'
    }),
    event(1, 'tool.started', {
      callId: 'call-1', toolName: 'search', occurrenceId: '1:0'
    }),
    event(2, 'tool.started', {
      callId: 'call-2', toolName: 'search', occurrenceId: '2:0'
    }),
    event(3, 'run.paused', { reason: 'approval_required' })
  ])
  const resume = progressResumeStateFromEvents(historical)
  assert.deepEqual(resume, {
    attempts: 6,
    seenStages: [
      'tool_started:0:0',
      'tool_started:1:0',
      'tool_started:2:0'
    ]
  })

  const physicalAttempts: Array<{ text: string; attempt: number }> = []
  const outbound: YunzaiOutboundPort = {
    target: Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
    }),
    deliver: async (part, attempt) => {
      const text = part.media === 'text' && part.atoms[0]?.kind === 'text'
        ? part.atoms[0].text
        : ''
      physicalAttempts.push({ text, attempt })
      return Object.freeze({
        kind: 'failed_definite', media: part.media, attempt, code: 'host_rejected'
      }) as never
    },
    recall: async () => Object.freeze({ kind: 'recalled' })
  }
  const presenter = new RunProgressPresenter()
  presenter.attach(Object.freeze({
    runId: 'run-private-value',
    runRef: '1'.repeat(32),
    requestKind: 'ordinary_chat' as const,
    observationPolicy: policy,
    resume,
    outbound,
    indicator: null
  }))
  presenter.handle(event(4, 'tool.started', {
    callId: 'call-2-replay', toolName: 'search', occurrenceId: '2:0'
  }))
  presenter.handle(event(5, 'tool.started', {
    callId: 'call-3', toolName: 'search', occurrenceId: '3:0'
  }))
  presenter.handle(event(6, 'tool.started', {
    callId: 'call-4', toolName: 'search', occurrenceId: '4:0'
  }))
  presenter.handle(event(7, 'tool.started', {
    callId: 'call-over-limit', toolName: 'search', occurrenceId: '5:0'
  }))
  await presenter.drain('run-private-value')

  assert.deepEqual(physicalAttempts, [
    { text: '正在搜索网络（步骤 4）', attempt: 1 },
    { text: '正在搜索网络（步骤 4）', attempt: 2 },
    { text: '正在搜索网络（步骤 5）', attempt: 1 },
    { text: '正在搜索网络（步骤 5）', attempt: 2 }
  ])
  presenter.detach('run-private-value')
})

test('progress replay accepts bounded primitive occurrence and ignores hostile payloads', () => {
  const valid = event(0, 'tool.started', {
    callId: 'call-safe', toolName: 'search', occurrenceId: '7:3'
  })
  let getterCalls = 0
  const hostilePayload = Object.create(null)
  Object.defineProperties(hostilePayload, {
    callId: { value: 'call-hostile', enumerable: true },
    toolName: { value: 'search', enumerable: true },
    occurrenceId: {
      enumerable: true,
      get () {
        getterCalls += 1
        return '8:0'
      }
    }
  })
  const hostile = Object.freeze({ ...event(1, 'tool.started'), payload: hostilePayload })
  const nested = Object.freeze({
    ...event(2, 'tool.started'),
    payload: Object.freeze({
      callId: 'call-nested', toolName: 'search', occurrenceId: { step: 9, index: 0 }
    })
  })

  assert.deepEqual(progressResumeStateFromEvents([
    valid,
    hostile as never,
    nested as never
  ]), {
    attempts: 2,
    seenStages: ['tool_started:7:3']
  })
  assert.equal(getterCalls, 0)
})

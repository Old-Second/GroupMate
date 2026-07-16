import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent, AgentEventType } from '../../src/agent/contracts/event.js'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import {
  ordinaryProfile,
  proactiveProfile
} from '../../src/runtime/presentation/presentation-profile.js'
import {
  PENDING_INDICATOR_TEXT,
  PendingIndicatorPresenter
} from '../../src/runtime/presentation/pending-indicator-presenter.js'
import type {
  RuntimeDeliveryReceipt,
  YunzaiOutboundPort
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import { RunProgressPresenter } from '../../src/runtime/run-progress-presenter.js'

const target: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})

function receipt (messageId: string): RuntimeDeliveryReceipt<'text'> {
  return Object.freeze({ schemaVersion: 1, media: 'text', messageId }) as RuntimeDeliveryReceipt<'text'>
}

function runEvent (sequence: number, type: AgentEventType): AgentEvent {
  return Object.freeze({
    eventVersion: 1,
    eventId: `indicator-event-${sequence}`,
    runId: 'run-1',
    sessionId: 'session-1',
    sequence,
    occurredAt: `2026-07-16T00:00:0${sequence}.000Z`,
    type,
    payload: type === 'tool.started'
      ? Object.freeze({ toolName: 'website' })
      : Object.freeze({})
  })
}

test('pending indicator is ordinary-only and auto-dismisses at eight seconds', async () => {
  const sends: unknown[] = []
  const recalls: RuntimeDeliveryReceipt[] = []
  const timers: Array<{ callback: () => void; milliseconds: number }> = []
  const port: YunzaiOutboundPort = {
    target,
    deliver: async (part, attempt, options) => {
      sends.push({ part, attempt, options })
      return Object.freeze({ kind: 'sent', media: part.media, attempt, receipt: receipt('pending-1') }) as never
    },
    recall: async value => {
      recalls.push(value)
      return Object.freeze({ kind: 'recalled' })
    }
  }
  const presenter = new PendingIndicatorPresenter({
    setTimer: ((callback: () => void, milliseconds: number) => {
      timers.push({ callback, milliseconds })
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimer: (() => undefined) as typeof clearTimeout
  })

  assert.equal(await presenter.show({
    runRef: '1'.repeat(32), outbound: port,
    profile: proactiveProfile({ recallAfterMs: null }), enabled: true
  }), null)
  assert.equal(await presenter.show({
    runRef: '1'.repeat(32), outbound: port,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false }), enabled: false
  }), null)
  const handle = await presenter.show({
    runRef: '1'.repeat(32), outbound: port,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false }), enabled: true
  })
  assert.notEqual(handle, null)
  assert.equal(timers[0]?.milliseconds, 8_000)
  assert.deepEqual(sends, [{
    part: { media: 'text', atoms: [{ kind: 'text', text: PENDING_INDICATOR_TEXT }] },
    attempt: 1,
    options: undefined
  }])
  timers[0]?.callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(recalls.length, 1)
  assert.throws(() => new PendingIndicatorPresenter({ autoDismissMs: 0 }), TypeError)
  assert.throws(() => new PendingIndicatorPresenter({ autoDismissMs: 8_001 }), TypeError)
})

test('pending indicator isolates concurrent route-bound receipts', async () => {
  const recalled = new Map<string, string[]>()
  const port = (groupId: string): YunzaiOutboundPort => ({
    target: Object.freeze({
      botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId })
    }),
    deliver: async (part, attempt) => Object.freeze({
      kind: 'sent', media: part.media, attempt, receipt: receipt(`pending-${groupId}`)
    }) as never,
    recall: async value => {
      const values = recalled.get(groupId) ?? []
      values.push(value.messageId ?? '')
      recalled.set(groupId, values)
      return Object.freeze({ kind: 'outcome_unknown', code: 'host_timeout_after_dispatch' })
    }
  })
  const timers: Array<() => void> = []
  const presenter = new PendingIndicatorPresenter({
    autoDismissMs: 8_000,
    setTimer: ((callback: () => void) => {
      timers.push(callback)
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimer: (() => undefined) as typeof clearTimeout
  })
  const profile = ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false })
  const first = await presenter.show({
    runRef: '1'.repeat(32), outbound: port('group-1'), profile, enabled: true
  })
  const second = await presenter.show({
    runRef: '2'.repeat(32), outbound: port('group-2'), profile, enabled: true
  })
  await Promise.all([
    first?.dismiss('progress'), first?.dismiss('terminal'), second?.dismiss('paused')
  ])
  timers.forEach(timer => timer())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(recalled, new Map([
    ['group-1', ['pending-group-1']],
    ['group-2', ['pending-group-2']]
  ]))
})

test('pending indicator absorbs recall failures and settles one concurrent dismissal', async () => {
  const failures = [
    { name: 'sync throw', recall: () => { throw new Error('sync recall failure') } },
    { name: 'async reject', recall: async () => await Promise.reject(new Error('async recall failure')) },
    {
      name: 'unknown outcome',
      recall: async () => Object.freeze({
        kind: 'outcome_unknown' as const,
        code: 'host_timeout_after_dispatch' as const
      })
    }
  ]

  for (const failure of failures) {
    let recalls = 0
    let timer: (() => void) | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const port: YunzaiOutboundPort = {
        target,
        deliver: async (part, attempt) => Object.freeze({
          kind: 'sent', media: part.media, attempt, receipt: receipt(`pending-${failure.name}`)
        }) as never,
        recall: (() => {
          recalls += 1
          return failure.recall()
        }) as YunzaiOutboundPort['recall']
      }
      const presenter = new PendingIndicatorPresenter({
        setTimer: ((callback: () => void) => {
          timer = callback
          return 1 as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimer: (() => undefined) as typeof clearTimeout
      })
      const handle = await presenter.show({
        runRef: '1'.repeat(32), outbound: port,
        profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false }),
        enabled: true
      })
      assert.notEqual(handle, null, failure.name)
      const dismissals = [
        handle?.dismiss('progress'),
        handle?.dismiss('paused'),
        handle?.dismiss('terminal')
      ]
      timer?.()
      await Promise.all(dismissals)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(recalls, 1, failure.name)
      assert.deepEqual(unhandled, [], failure.name)
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  }
})

test('pending indicator dismisses once on progress paused and terminal', async () => {
  let recalls = 0
  const sent: string[] = []
  const port: YunzaiOutboundPort = {
    target,
    deliver: async (part, attempt) => {
      if (part.media === 'text' && part.atoms[0]?.kind === 'text') {
        sent.push(part.atoms[0].text)
      }
      return Object.freeze({
        kind: 'sent', media: part.media, attempt, receipt: receipt(`message-${sent.length}`)
      }) as never
    },
    recall: async () => {
      recalls += 1
      return Object.freeze({ kind: 'recalled' })
    }
  }
  const pending = new PendingIndicatorPresenter({
    setTimer: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    clearTimer: (() => undefined) as typeof clearTimeout
  })
  const indicator = await pending.show({
    runRef: '1'.repeat(32),
    outbound: port,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: false }),
    enabled: true
  })
  const progress = new RunProgressPresenter()
  progress.attach(Object.freeze({
    runId: 'run-1',
    runRef: '1'.repeat(32),
    requestKind: 'ordinary_chat' as const,
    observationPolicy: Object.freeze({
      schemaVersion: 1 as const, levelAtStart: 'basic' as const, sampledSuccess: false
    }),
    resume: Object.freeze({ attempts: 0, seenStages: Object.freeze([]) }),
    outbound: port,
    indicator
  }))

  progress.handle(runEvent(0, 'tool.started'))
  progress.handle(runEvent(1, 'run.paused'))
  progress.handle(runEvent(2, 'run.completed'))
  await progress.drain('run-1')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(recalls, 1)
  assert.deepEqual(sent, [PENDING_INDICATOR_TEXT, '正在读取网页'])
})

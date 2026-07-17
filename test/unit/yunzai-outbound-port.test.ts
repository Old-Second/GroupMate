import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type { DeliveryResult } from '../../src/runtime/presentation/presentation-result.js'
import {
  createYunzaiOutboundPortFactory,
  deliverWithDefiniteRetry,
  type OutboundPart,
  type RuntimeDeliveryReceipt,
  type YunzaiHostTargetPort
} from '../../src/runtime/presentation/yunzai-outbound-port.js'

const groupUserTarget: SessionAddress = Object.freeze({
  botId: '10000',
  scope: Object.freeze({ kind: 'group_user', groupId: '90001', userId: '70001' })
})

const textPart: OutboundPart = Object.freeze({
  media: 'text',
  atoms: Object.freeze([{ kind: 'text' as const, text: 'hello' }])
})

type HostResult = unknown | (() => unknown | Promise<unknown>)

function hostTarget (
  dispatchResults: HostResult[],
  recallResults: HostResult[] = []
): {
    readonly target: YunzaiHostTargetPort
    readonly dispatches: OutboundPart[]
    readonly recalls: Array<string | number>
  } {
  const dispatches: OutboundPart[] = []
  const recalls: Array<string | number> = []
  const resolve = async (result: HostResult | undefined): Promise<unknown> => {
    return typeof result === 'function' ? await result() : result
  }
  return {
    dispatches,
    recalls,
    target: {
      dispatch: async part => {
        dispatches.push(part)
        return await resolve(dispatchResults.shift())
      },
      recall: async messageId => {
        recalls.push(messageId)
        return await resolve(recallResults.shift())
      }
    }
  }
}

async function withImmediateTimers<T> (operation: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    return original(callback, 0, ...args)
  }) as typeof setTimeout
  try {
    return await operation()
  } finally {
    globalThis.setTimeout = original
  }
}

test('outbound normalizes a signed NapCat numeric message ID and recalls with its host type', async () => {
  const fixture = hostTarget([{ message_id: -12_345_678 }], [true])
  const port = await createYunzaiOutboundPortFactory({
    forTarget: async () => fixture.target
  }).forTarget(groupUserTarget)

  const delivered = await port.deliver(textPart, 1)
  assert.equal(delivered.kind, 'sent')
  if (delivered.kind !== 'sent') return
  assert.equal(delivered.receipt.schemaVersion, 1)
  assert.equal(delivered.receipt.media, 'text')
  assert.equal(delivered.receipt.messageId, '-12345678')
  assert.deepEqual(await port.recall(delivered.receipt), { kind: 'recalled' })
  assert.deepEqual(fixture.recalls, [-12_345_678])
})

test('outbound rejects zero fractional and unsafe numeric message IDs', async () => {
  const fixture = hostTarget([
    { message_id: 0 },
    { message_id: -1.5 },
    { message_id: Number.MAX_SAFE_INTEGER + 1 }
  ])
  const port = await createYunzaiOutboundPortFactory({
    forTarget: async () => fixture.target
  }).forTarget(groupUserTarget)

  const results = await Promise.all([
    port.deliver(textPart, 1),
    port.deliver(textPart, 1),
    port.deliver(textPart, 1)
  ])
  assert.deepEqual(results.map(result => result.kind), Array(3).fill('outcome_unknown'))
})

test('outbound classifies confirmed host results and never treats unknown as sent', async () => {
  let getterReads = 0
  const getterResult = Object.defineProperty({}, 'message_id', {
    enumerable: true,
    get: () => {
      getterReads += 1
      return 'getter-id'
    }
  })
  const inheritedResult = Object.create({ message_id: 'inherited-id' })
  const fixture = hostTarget([
    true,
    'string-id',
    { message_id: 'snake-id' },
    { messageId: 'camel-id' },
    { message_id: 'dual-id', messageId: 'dual-id', ignored: getterResult },
    false,
    undefined,
    'x'.repeat(129),
    'control\u0000id',
    'control\u0085id',
    'control\u009fid',
    getterResult,
    inheritedResult,
    { message_id: 'one', messageId: 'two' },
    { ok: true },
    () => { throw new Error('host failed') }
  ])
  const factory = createYunzaiOutboundPortFactory({ forTarget: async () => fixture.target })
  const port = await factory.forTarget(groupUserTarget)
  const results = []
  for (let index = 0; index < 16; index += 1) results.push(await port.deliver(textPart, 1))

  assert.deepEqual(results.slice(0, 5).map(result => result.kind), Array(5).fill('sent'))
  assert.deepEqual(results[5], {
    kind: 'failed_definite', media: 'text', attempt: 1, code: 'host_rejected'
  })
  assert.deepEqual(results.slice(6, 15).map(result => result.kind), Array(9).fill('outcome_unknown'))
  assert.deepEqual(results[15], {
    kind: 'outcome_unknown', media: 'text', attempt: 1, code: 'host_exception_after_dispatch'
  })
  assert.equal(getterReads, 0)

  const timeoutFixture = hostTarget([() => new Promise(() => {})])
  const timeoutPort = await createYunzaiOutboundPortFactory({
    forTarget: async () => timeoutFixture.target
  }).forTarget(groupUserTarget)
  const timedOut = await withImmediateTimers(async () => await timeoutPort.deliver(textPart, 1))
  assert.deepEqual(timedOut, {
    kind: 'outcome_unknown', media: 'text', attempt: 1, code: 'host_timeout_after_dispatch'
  })
})

test('outbound retries only explicit host rejection once', async () => {
  for (const [first, expectedCalls] of [
    [false, 2],
    [undefined, 1],
    [true, 1]
  ] as const) {
    const fixture = hostTarget([first, true])
    const port = await createYunzaiOutboundPortFactory({
      forTarget: async () => fixture.target
    }).forTarget(groupUserTarget)
    const results: readonly DeliveryResult[] = await deliverWithDefiniteRetry(port, textPart)
    assert.equal(fixture.dispatches.length, expectedCalls)
    assert.deepEqual(results.map(result => result.attempt), expectedCalls === 2 ? [1, 2] : [1])
  }
})

test('outbound distinguishes abort before and after dispatch', async () => {
  const fixture = hostTarget([true, () => new Promise(() => {})])
  const port = await createYunzaiOutboundPortFactory({
    forTarget: async () => fixture.target
  }).forTarget(groupUserTarget)

  const before = new AbortController()
  before.abort()
  assert.deepEqual(await port.deliver(textPart, 1, { signal: before.signal }), {
    kind: 'failed_definite', media: 'text', attempt: 1, code: 'aborted_before_dispatch'
  })
  assert.equal(fixture.dispatches.length, 0)

  assert.deepEqual(await port.deliver({ media: 'dice', extra: true } as unknown as OutboundPart, 1, {
    signal: before.signal
  }), {
    kind: 'failed_definite', media: 'dice', attempt: 1, code: 'invalid_part'
  })
  assert.equal(fixture.dispatches.length, 0)

  const after = new AbortController()
  const pending = port.deliver(textPart, 1, { signal: after.signal })
  assert.equal(fixture.dispatches.length, 1)
  after.abort()
  assert.deepEqual(await pending, {
    kind: 'outcome_unknown', media: 'text', attempt: 1, code: 'host_abort_after_dispatch'
  })
  assert.equal(fixture.dispatches.length, 1)
})

test('outbound represents an unknown second attempt without retrying a third time', async () => {
  const fixture = hostTarget([false, () => new Promise(() => {}), true])
  const port = await createYunzaiOutboundPortFactory({
    forTarget: async () => fixture.target
  }).forTarget(groupUserTarget)
  const results = await withImmediateTimers(async () => await deliverWithDefiniteRetry(port, textPart))
  assert.deepEqual(results.map(result => result.attempt), [1, 2])
  assert.deepEqual(results.at(-1), {
    kind: 'outcome_unknown', media: 'text', attempt: 2, code: 'host_timeout_after_dispatch'
  })
  assert.equal(fixture.dispatches.length, 2)
})

test('outbound binds target and normalizes group-user scope', async () => {
  const fixture = hostTarget([true])
  const seen: SessionAddress[] = []
  const factory = createYunzaiOutboundPortFactory({
    forTarget: async target => {
      seen.push(target)
      return fixture.target
    }
  })
  const port = await factory.forTarget(groupUserTarget)
  assert.deepEqual(port.target, {
    botId: '10000', scope: { kind: 'group', groupId: '90001' }
  })
  assert.equal(Object.isFrozen(port.target), true)
  assert.equal(Object.isFrozen(port.target.scope), true)
  assert.deepEqual(seen, [port.target])

  const inert = await createYunzaiOutboundPortFactory({
    forTarget: async () => { throw new Error('target unavailable') }
  }).forTarget(groupUserTarget)
  assert.deepEqual(await inert.deliver(textPart, 1), {
    kind: 'failed_definite', media: 'text', attempt: 1, code: 'invalid_target'
  })
})

test('recall rejects forged and cross-port receipts', async () => {
  const firstFixture = hostTarget(['message-1', true])
  const secondFixture = hostTarget(['message-2'])
  const fixtures = [firstFixture, secondFixture]
  const factory = createYunzaiOutboundPortFactory({
    forTarget: async () => fixtures.shift()?.target ?? null
  })
  const first = await factory.forTarget(groupUserTarget)
  const second = await factory.forTarget(groupUserTarget)
  const delivered = await first.deliver(textPart, 1)
  const withoutId = await first.deliver(textPart, 1)
  assert.equal(delivered.kind, 'sent')
  assert.equal(withoutId.kind, 'sent')
  if (delivered.kind !== 'sent' || withoutId.kind !== 'sent') return

  assert.deepEqual(await second.recall(delivered.receipt), {
    kind: 'failed_definite', code: 'receipt_not_owned'
  })
  assert.deepEqual(await first.recall({
    schemaVersion: 1, media: 'text', messageId: 'message-1'
  } as RuntimeDeliveryReceipt), {
    kind: 'failed_definite', code: 'receipt_not_owned'
  })
  assert.deepEqual(await first.recall(withoutId.receipt), {
    kind: 'failed_definite', code: 'message_id_unavailable'
  })
  assert.equal(firstFixture.recalls.length + secondFixture.recalls.length, 0)
})

test('recall classifies pre-abort rejection timeout and unknown exactly once', async () => {
  const fixture = hostTarget(
    ['pre-abort', 'rejected', 'throw', 'timeout', 'unknown'],
    [false, () => { throw new Error('recall failed') }, () => new Promise(() => {}), undefined]
  )
  const port = await createYunzaiOutboundPortFactory({
    forTarget: async () => fixture.target
  }).forTarget(groupUserTarget)
  const receipts: RuntimeDeliveryReceipt[] = []
  for (let index = 0; index < 5; index += 1) {
    const result: DeliveryResult = await port.deliver(textPart, 1)
    assert.equal(result.kind, 'sent')
    if (result.kind === 'sent') receipts.push(result.receipt)
  }

  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await port.recall(receipts[0], aborted.signal), {
    kind: 'failed_definite', code: 'aborted_before_dispatch'
  })
  assert.equal(fixture.recalls.length, 0)
  assert.deepEqual(await port.recall(receipts[1]), {
    kind: 'failed_definite', code: 'host_rejected'
  })
  assert.deepEqual(await port.recall(receipts[2]), {
    kind: 'outcome_unknown', code: 'host_exception_after_dispatch'
  })
  assert.deepEqual(await withImmediateTimers(async () => await port.recall(receipts[3])), {
    kind: 'outcome_unknown', code: 'host_timeout_after_dispatch'
  })
  assert.deepEqual(await port.recall(receipts[4]), {
    kind: 'outcome_unknown', code: 'unknown_host_result'
  })
  assert.equal(fixture.recalls.length, 4)
})

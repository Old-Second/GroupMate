import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import {
  RunAdmission,
  RunAdmissionRejectionError
} from '../../src/agent/run/run-admission.js'
import { FakeRedis } from '../helpers/fake-redis.js'

function address (id: number): SessionAddress {
  return Object.freeze({
    botId: 'bot-1',
    scope: Object.freeze({ kind: 'private' as const, userId: `user-${id}` })
  })
}

test('fresh admission exposes only typed queue rejection reasons', async () => {
  let generated = 0
  const admission = new RunAdmission({
    client: new FakeRedis(),
    generateId: () => `lease-${++generated}`
  })
  const first = await admission.acquire(address(1))
  const second = await admission.acquire(address(2))
  const queuedControllers = [new AbortController(), new AbortController(), new AbortController()]
  const queued = queuedControllers.map((controller, index) => (
    admission.acquire(address(index + 3), controller.signal)
  ))

  await assert.rejects(admission.acquire(address(6)), error => (
    error instanceof RunAdmissionRejectionError &&
    error.rejectionReason === 'queue_full'
  ))

  const aborted = new AbortController()
  aborted.abort('private abort detail')
  await assert.rejects(admission.acquire(address(7), aborted.signal), error => (
    error instanceof RunAdmissionRejectionError &&
    error.rejectionReason === 'queue_aborted'
  ))

  for (const controller of queuedControllers) controller.abort()
  await Promise.allSettled(queued)
  await first.release()
  await second.release()
})

test('queued abort remains a typed non-leaking rejection', async () => {
  let generated = 0
  const admission = new RunAdmission({
    client: new FakeRedis(),
    generateId: () => `abort-lease-${++generated}`
  })
  const first = await admission.acquire(address(11))
  const second = await admission.acquire(address(12))
  const controller = new AbortController()
  const queued = admission.acquire(address(13), controller.signal)

  controller.abort(new Error('private abort detail'))
  await assert.rejects(queued, error => {
    assert.equal(error instanceof RunAdmissionRejectionError, true)
    if (!(error instanceof RunAdmissionRejectionError)) return false
    assert.equal(error.rejectionReason, 'queue_aborted')
    assert.equal(error.message.includes('private abort detail'), false)
    return true
  })

  await first.release()
  await second.release()
})

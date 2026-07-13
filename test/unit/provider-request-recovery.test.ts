import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withInvalidFormatRecovery } from '../../src/runtime/provider-request-recovery.js'

test('provider request recovery leaves successful requests untouched', async () => {
  const attempts: string[] = []

  const result = await withInvalidFormatRecovery({
    canRecover: true,
    attempt: async kind => {
      attempts.push(kind)
      return 'ok'
    }
  })

  assert.equal(result, 'ok')
  assert.deepEqual(attempts, ['primary'])
})

test('provider request recovery retries one HTTP 400 after optional context', async () => {
  const attempts: string[] = []
  let recoveryNotifications = 0

  const result = await withInvalidFormatRecovery({
    canRecover: true,
    attempt: async kind => {
      attempts.push(kind)
      if (kind === 'primary') throw Object.assign(new Error('invalid'), { statusCode: 400 })
      return 'recovered'
    },
    onRecovery: () => { recoveryNotifications += 1 }
  })

  assert.equal(result, 'recovered')
  assert.deepEqual(attempts, ['primary', 'recovery'])
  assert.equal(recoveryNotifications, 1)
})

test('provider request recovery does not retry without optional context', async () => {
  const error = Object.assign(new Error('invalid'), { statusCode: 400 })
  let attempts = 0

  await assert.rejects(withInvalidFormatRecovery({
    canRecover: false,
    attempt: async () => {
      attempts += 1
      throw error
    }
  }), candidate => candidate === error)

  assert.equal(attempts, 1)
})

test('provider request recovery does not retry other provider errors', async () => {
  const error = Object.assign(new Error('invalid parameters'), { statusCode: 422 })
  let attempts = 0

  await assert.rejects(withInvalidFormatRecovery({
    canRecover: true,
    attempt: async () => {
      attempts += 1
      throw error
    }
  }), candidate => candidate === error)

  assert.equal(attempts, 1)
})

test('provider request recovery preserves the retry failure without looping', async () => {
  const retryError = Object.assign(new Error('still invalid'), { statusCode: 400 })
  const attempts: string[] = []

  await assert.rejects(withInvalidFormatRecovery({
    canRecover: true,
    attempt: async kind => {
      attempts.push(kind)
      if (kind === 'primary') throw Object.assign(new Error('invalid'), { statusCode: 400 })
      throw retryError
    }
  }), candidate => candidate === retryError)

  assert.deepEqual(attempts, ['primary', 'recovery'])
})

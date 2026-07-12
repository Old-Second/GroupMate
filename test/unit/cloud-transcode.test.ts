import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLOUD_TRANSCODE_TIMEOUT_MS,
  withCloudTranscodeTimeout
} from '../../src/runtime/cloud-transcode.js'

test('uses a ten-second production timeout and forwards the operation result', async () => {
  let receivedSignal: AbortSignal | undefined

  const result = await withCloudTranscodeTimeout(async signal => {
    receivedSignal = signal
    return 'converted'
  })

  assert.equal(CLOUD_TRANSCODE_TIMEOUT_MS, 10_000)
  assert.equal(result, 'converted')
  assert.equal(receivedSignal?.aborted, false)
})

test('rejects at the timeout boundary even when the operation ignores abort', async () => {
  let receivedSignal: AbortSignal | undefined

  const outcome = await Promise.race([
    withCloudTranscodeTimeout(async signal => {
      receivedSignal = signal
      await new Promise<never>(() => {})
    }, 5).then(
      () => 'resolved',
      error => error instanceof DOMException && error.name === 'AbortError'
        ? 'aborted'
        : 'unexpected-error'
    ),
    new Promise<string>(resolve => setTimeout(() => resolve('still-pending'), 30))
  ])

  assert.equal(outcome, 'aborted')
  assert.equal(receivedSignal?.aborted, true)
})

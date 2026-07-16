import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PENDING_INDICATOR_REDIS_KEY,
  createPendingIndicatorConfigPort
} from '../../src/runtime/presentation/pending-indicator-config.js'

test('pending config preserves missing on off and invalid legacy semantics', async () => {
  const values = new Map<string, string>()
  const writes: Array<readonly [string, string]> = []
  const port = createPendingIndicatorConfigPort({
    get: async key => values.get(key) ?? null,
    set: async (key, value) => {
      writes.push([key, value])
      values.set(key, value)
      return 'OK'
    }
  })

  assert.equal(PENDING_INDICATOR_REDIS_KEY, 'CHATGPT:CONFIRM')
  assert.equal(await port.getEnabled(), true)
  values.set(PENDING_INDICATOR_REDIS_KEY, 'on')
  assert.equal(await port.getEnabled(), true)
  values.set(PENDING_INDICATOR_REDIS_KEY, 'off')
  assert.equal(await port.getEnabled(), false)
  values.set(PENDING_INDICATOR_REDIS_KEY, 'true')
  assert.equal(await port.getEnabled(), false)

  await port.setEnabled(true)
  await port.setEnabled(false)
  assert.deepEqual(writes.slice(-2), [
    [PENDING_INDICATOR_REDIS_KEY, 'on'],
    [PENDING_INDICATOR_REDIS_KEY, 'off']
  ])
})

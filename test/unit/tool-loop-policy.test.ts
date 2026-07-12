import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldFinalizeAfterTool } from '../../src/runtime/tool-loop-policy.js'

test('finalizes the tool loop after successful message management', () => {
  assert.equal(shouldFinalizeAfterTool('handleMsg', 'success!'), true)
})

test('keeps the tool loop available when message management fails', () => {
  assert.equal(shouldFinalizeAfterTool(
    'handleMsg',
    'failed, explicit messageId is required'
  ), false)
  assert.equal(shouldFinalizeAfterTool(
    'handleMsg',
    'operation failed: fixture failure'
  ), false)
})

test('preserves existing side-effect and query tool behavior', () => {
  assert.equal(shouldFinalizeAfterTool(
    'jinyan',
    'the user fixture has been muted for 60 seconds'
  ), true)
  assert.equal(shouldFinalizeAfterTool('weather', 'fixture forecast'), false)
})

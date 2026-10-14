import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyToolPreflight, createToolExecutionLedger, toolLedgerModelMessages } from '../../src/agent/run/tool-ledger.js'

test('tool ledger carries exact provider argument text without reconstruction', () => {
  const argumentsText = '{ "second": "e\\u0301", "first": 1 }'
  const ledger = createToolExecutionLedger(0, [Object.freeze({
    index: 0,
    callId: 'call-1',
    name: 'fixture',
    argumentsText,
    arguments: Object.freeze({ second: 'e\u0301', first: 1 })
  })])

  assert.equal(
    (ledger.calls[0] as typeof ledger.calls[number] & { argumentsText?: string }).argumentsText,
    argumentsText
  )
})

test('a terminal denial reaches the next model turn with its call ID, reason and retry boundary', () => {
  const planned = createToolExecutionLedger(0, [{ index: 0, callId: 'call-1', name: 'sendPicture',
    argumentsText: '{"urls":["https://example.com/image.png"]}', arguments: { urls: ['https://example.com/image.png'] } }])
  const result = { status: 'denied' as const, effect: 'none' as const,
    reasonCode: 'explicit_intent_required' as const, userMessage: '需要在当前消息中明确说明操作和目标。', retryable: false as const }
  const terminal = applyToolPreflight(planned, { schemaVersion: 1, calls: [{ kind: 'completed',
    callId: 'call-1', toolName: 'sendPicture', result }] })
  const messages = toolLedgerModelMessages(terminal)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].toolCallId, 'call-1')
  assert.equal(messages[0].role, 'tool')
  assert.deepEqual(JSON.parse(messages[0].content), result)
  assert.equal(terminal.calls[0].status, 'denied')
})

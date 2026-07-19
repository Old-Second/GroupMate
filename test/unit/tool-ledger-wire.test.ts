import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolExecutionLedger } from '../../src/agent/run/tool-ledger.js'

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

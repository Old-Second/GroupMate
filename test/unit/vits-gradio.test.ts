import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildVitsGenerateRequest } from '../../src/runtime/vits-gradio.js'

test('builds the Gradio VITS request with required request-local metadata', () => {
  const data: unknown[] = [
    '[ZH]fixture[ZH]',
    'fixture-language',
    'fixture-speaker',
    0.6,
    0.668,
    1.2
  ]

  const first = buildVitsGenerateRequest(data)
  const second = buildVitsGenerateRequest(data)

  assert.equal(first.data, data)
  assert.equal(first.fn_index, 0)
  assert.match(first.session_hash, /^[a-f0-9]{32}$/)
  assert.match(second.session_hash, /^[a-f0-9]{32}$/)
  assert.notEqual(first.session_hash, second.session_hash)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideBymTrigger } from '../../src/runtime/bym-trigger.js'

const decide = (overrides: Partial<Parameters<typeof decideBymTrigger>[0]> = {}) => (
  decideBymTrigger({
    message: '今天心情怎么样？',
    assistantLabel: 'GroupMate',
    hasLeadingAlias: false,
    recognizeLeadingAlias: true,
    ...overrides
  })
)

test('recognizes a host-stripped leading alias only while the switch is enabled', () => {
  assert.deepEqual(decide({ hasLeadingAlias: true }), {
    prompt: '今天心情怎么样？',
    explicitlyAddressed: true
  })
  assert.deepEqual(decide({
    hasLeadingAlias: true,
    recognizeLeadingAlias: false
  }), {
    prompt: '今天心情怎么样？',
    explicitlyAddressed: false
  })
})

test('applies the switch to an unstripped leading label', () => {
  assert.equal(decide({
    message: ' GroupMate，今天心情怎么样？'
  }).explicitlyAddressed, true)
  assert.equal(decide({
    message: ' GroupMate，今天心情怎么样？',
    recognizeLeadingAlias: false
  }).explicitlyAddressed, false)
})

test('keeps middle and repeated labels explicit when leading recognition is disabled', () => {
  assert.equal(decide({
    message: '你好，GroupMate',
    recognizeLeadingAlias: false
  }).explicitlyAddressed, true)
  assert.equal(decide({
    message: 'GroupMate，稍后再问 GroupMate',
    recognizeLeadingAlias: false
  }).explicitlyAddressed, true)
})

test('rejects empty and non-text input before an agent run', () => {
  assert.deepEqual(decide({ message: '   ', hasLeadingAlias: true }), {
    prompt: null,
    explicitlyAddressed: false
  })
  assert.deepEqual(decide({ message: undefined, hasLeadingAlias: true }), {
    prompt: null,
    explicitlyAddressed: false
  })
})

test('keeps the original prompt intact for the controller-owned request preparation', () => {
  const prompt = ' 你好，GroupMate，请看这段原文。 '
  assert.deepEqual(decide({ message: prompt }), {
    prompt,
    explicitlyAddressed: true
  })
})

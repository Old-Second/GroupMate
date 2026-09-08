import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isGroupContextWindowAnchor,
  stableGroupContextWindow,
  stableGroupContextWindowStart
} from '../../src/runtime/group-context-window.js'

/** Host rows as `readGroupHistory` returns them: oldest first, newest last. */
function rows (count: number, firstId = 1): readonly Record<string, unknown>[] {
  return Object.freeze(Array.from({ length: count }, (_unused, index) => Object.freeze({
    message_id: `m${firstId + index}`,
    raw_message: `message ${firstId + index}`
  })))
}

function identities (window: readonly Record<string, unknown>[]): readonly unknown[] {
  return window.map(row => row.message_id)
}

test('the window keeps at least the configured number of messages', () => {
  for (let available = 1; available <= 64; available += 1) {
    const window = stableGroupContextWindow(rows(available), 20)
    assert.equal(window.length >= Math.min(available, 20), true)
    assert.equal(window.length <= available, true)
    assert.deepEqual(window, rows(available).slice(available - window.length))
  }
})

test('a later turn is the earlier window plus what arrived since, until the anchor rolls', () => {
  const minimum = 20
  let appendOnlyTurns = 0
  let rolledTurns = 0
  for (let arrivals = 0; arrivals < 60; arrivals += 1) {
    // The host window is full, so every arrival also drops one message from the
    // far end: the case a fixed-count window can never keep stable.
    const earlier = stableGroupContextWindow(rows(64, 1 + arrivals), minimum)
    const later = stableGroupContextWindow(rows(64, 2 + arrivals), minimum)
    const earlierIds = identities(earlier)
    const laterIds = identities(later)
    if (laterIds.slice(0, earlierIds.length).every((id, index) => id === earlierIds[index])) {
      appendOnlyTurns += 1
    } else {
      rolledTurns += 1
    }
  }
  // One anchor every six messages on average, so most turns must append only.
  assert.equal(appendOnlyTurns > rolledTurns * 2, true)
  assert.equal(rolledTurns > 0, true)
})

test('anchoring depends only on the message identity, never on its position', () => {
  const row = { message_id: 'm7', raw_message: 'anything' }
  const anchor = isGroupContextWindowAnchor(row)
  assert.equal(isGroupContextWindowAnchor({ ...row, raw_message: 'edited' }), anchor)
  assert.equal(isGroupContextWindowAnchor({ message_id: 'm7' }), anchor)
  assert.equal(isGroupContextWindowAnchor({ seq: 'm7' }), anchor)
})

test('a row the host reports without an identity can never anchor a window', () => {
  for (const value of [null, undefined, 'text', 42, [], {}, { message_id: '' }, { seq: {} }]) {
    assert.equal(isGroupContextWindowAnchor(value), false)
  }
  // Falling back to the newest allowed start keeps the configured window size.
  const anonymous = Object.freeze(Array.from({ length: 30 }, () => Object.freeze({})))
  assert.equal(stableGroupContextWindowStart(anonymous, 20), 10)
})

test('a degenerate minimum still yields a usable window', () => {
  assert.equal(stableGroupContextWindowStart([], 20), 0)
  assert.equal(stableGroupContextWindow(rows(5), 0).length >= 1, true)
  assert.equal(stableGroupContextWindow(rows(5), -3).length >= 1, true)
  assert.deepEqual(stableGroupContextWindow(rows(5), 999), rows(5))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendRunReasoningSegment,
  MAX_RUN_REASONING_CODE_POINTS,
  MAX_RUN_REASONING_SEGMENTS,
  parseRunReasoningSegments,
  type RunReasoningSegment
} from '../../src/agent/run/run-reasoning-segment.js'

test('reasoning segments stay ordered and bounded by the total code-point budget', () => {
  let segments = Object.freeze([]) as readonly RunReasoningSegment[]
  for (let turn = 1; turn <= 5; turn += 1) {
    segments = appendRunReasoningSegment(segments, {
      step: turn - 1,
      turn,
      reasoning: { text: '思'.repeat(2_000), truncated: false }
    })
  }

  assert.equal(segments.length, 4)
  assert.equal(
    segments.reduce((sum, item) => sum + [...item.text].length, 0),
    MAX_RUN_REASONING_CODE_POINTS
  )
  assert.equal(segments.at(-1)?.truncated, false)
  assert.throws(() => parseRunReasoningSegments([
    { step: 1, turn: 2, text: '后', truncated: false },
    { step: 0, turn: 1, text: '前', truncated: false }
  ]), /order/i)
})

test('reasoning append preserves the frozen input for empty or exhausted content', () => {
  const empty = Object.freeze([]) as readonly RunReasoningSegment[]
  assert.equal(appendRunReasoningSegment(empty, {
    step: 0,
    turn: 1,
    reasoning: { text: '  ', truncated: false }
  }), empty)

  const full = parseRunReasoningSegments(Array.from(
    { length: MAX_RUN_REASONING_SEGMENTS },
    (_, index) => ({
      step: index,
      turn: index + 1,
      text: '思'.repeat(index < 2 ? 2_000 : 1_000),
      truncated: false
    })
  ))
  assert.equal(full.length, MAX_RUN_REASONING_SEGMENTS)
  assert.equal(appendRunReasoningSegment(full, {
    step: 6,
    turn: 7,
    reasoning: { text: '忽略', truncated: false }
  }), full)
})

test('reasoning append truncates only the new segment when the total budget is partial', () => {
  const existing = parseRunReasoningSegments([
    { step: 0, turn: 1, text: '思'.repeat(2_000), truncated: false },
    { step: 1, turn: 2, text: '思'.repeat(2_000), truncated: false },
    { step: 2, turn: 3, text: '思'.repeat(2_000), truncated: false },
    { step: 3, turn: 4, text: '思'.repeat(1_000), truncated: false }
  ])

  const appended = appendRunReasoningSegment(existing, {
    step: 4,
    turn: 5,
    reasoning: { text: '新'.repeat(2_000), truncated: false }
  })

  assert.equal(appended.length, 5)
  assert.deepEqual(appended.at(-1), {
    step: 4,
    turn: 5,
    text: '新'.repeat(1_000),
    truncated: true
  })
})

test('reasoning parser rejects malformed, oversized and unordered segments', () => {
  assert.throws(() => parseRunReasoningSegments([{
    step: 0,
    turn: 1,
    text: '思',
    truncated: false,
    secret: 'must-not-persist'
  }]), /unknown|key/i)
  assert.throws(() => parseRunReasoningSegments([
    { step: 0, turn: 1, text: '一', truncated: false },
    { step: 1, turn: 1, text: '重复', truncated: false }
  ]), /order/i)
  assert.throws(() => parseRunReasoningSegments([
    { step: 1, turn: 1, text: '先', truncated: false },
    { step: 0, turn: 2, text: '后', truncated: false }
  ]), /order/i)
  assert.throws(() => parseRunReasoningSegments([{
    step: 0,
    turn: 1,
    text: '思'.repeat(2_001),
    truncated: true
  }]), /length|limit|code point/i)
  assert.throws(() => parseRunReasoningSegments(Array.from(
    { length: MAX_RUN_REASONING_SEGMENTS + 1 },
    (_, index) => ({
      step: index,
      turn: index + 1,
      text: '思',
      truncated: false
    })
  )), /segment|limit/i)
})

test('reasoning parser normalizes NFC and rejects accessors without invoking them', () => {
  assert.deepEqual(parseRunReasoningSegments([{
    step: 0,
    turn: 1,
    text: 'e\u0301',
    truncated: false
  }]), [{
    step: 0,
    turn: 1,
    text: '\u00e9',
    truncated: false
  }])

  let reads = 0
  const hostile = {
    step: 0,
    turn: 1,
    truncated: false,
    get text () {
      reads += 1
      return '不应读取'
    }
  }
  assert.throws(() => parseRunReasoningSegments([hostile]), /data propert/i)
  assert.equal(reads, 0)
})

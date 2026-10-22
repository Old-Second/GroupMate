import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ContextBudget } from '../../src/agent/context/context-budget.js'
import type { CanonicalConversationItem } from '../../src/agent/session/agent-session-state.js'
import {
  compactSessionHistory,
  DEFAULT_SESSION_HISTORY_COMPACTION_POLICY,
  PREFIX_CACHE_IDLE_EXPIRY_MS,
  prefixCacheLikelyCold,
  SESSION_HISTORY_EARLY_RECLAIM_TOKENS,
  SESSION_HISTORY_KEEP_RECENT_PERCENT
} from '../../src/agent/session/session-history-compaction.js'
import {
  createSessionHistorySummary,
  HISTORY_SUMMARY_MAX_CHARS,
  historySummaryMessages,
  parseSessionHistorySummary
} from '../../src/agent/session/session-history-summary.js'

const CREATED_AT = '2026-10-21T01:00:00.000Z'
const UPDATED_AT = '2026-10-21T02:00:00.000Z'

function budget (modelContextTokens = 10_000): ContextBudget {
  return Object.freeze({
    modelContextTokens,
    reservedOutputTokens: 0,
    reservedToolTokens: 0,
    safetyMarginTokens: 0,
    maxItems: 1_024,
    maxBytes: 512 * 1_024
  })
}

function message (index: number, text = 'x'.repeat(400)): CanonicalConversationItem {
  return Object.freeze({
    kind: 'message' as const,
    message: Object.freeze({
      id: `item-${index}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      parts: Object.freeze([{ type: 'text' as const, text }]),
      createdAt: CREATED_AT,
      provenance: Object.freeze({
        source: 'qq_message', trust: 'untrusted' as const, sensitivity: 'group' as const,
        sourceId: `item-${index}`, createdAt: CREATED_AT
      })
    })
  })
}

function items (count: number, text?: (index: number) => string): readonly CanonicalConversationItem[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => message(
    index,
    text?.(index) ?? 'x'.repeat(400)
  )))
}

test('a history over the high-water mark folds its oldest turns into one summary', () => {
  const input = items(100)
  const result = compactSessionHistory(input, { budget: budget(), updatedAt: UPDATED_AT })
  assert.equal(result.compacted, true)
  assert.ok(result.summary)
  assert.ok(result.items.length > 0 && result.items.length < input.length)
  // The verbatim tail opens with a prompting message, never a bare reply.
  const head = result.items[0]
  assert(head && head.kind === 'message')
  assert.equal(head.kind === 'message' ? head.message.role : null, 'user')
  // Newest turns stay verbatim and in order.
  assert.deepEqual(
    result.items.map(item => item.kind === 'message' ? item.message.id : item.id),
    input.slice(input.length - result.items.length).map(item => item.kind === 'message' ? item.message.id : item.id)
  )
  assert.equal(result.summary?.coveredItems, input.length - result.items.length)
  assert.equal(
    result.summary?.coveredThrough,
    input[input.length - result.items.length - 1]?.kind === 'message'
      ? (input[input.length - result.items.length - 1] as Extract<CanonicalConversationItem, { kind: 'message' }>).message.id
      : ''
  )
})

test('a history under the water marks stays untouched and creates no summary', () => {
  const input = items(4)
  const result = compactSessionHistory(input, { budget: budget(), updatedAt: UPDATED_AT })
  assert.equal(result.compacted, false)
  assert.equal(result.summary, undefined)
  assert.equal(result.items, input)
})

test('an idle conversation folds early only when it can reclaim a meaningful tail', () => {
  const tight = budget()
  const reclaimable = items(20, () => 'y'.repeat(700))
  const untouched = compactSessionHistory(reclaimable, {
    budget: tight, updatedAt: UPDATED_AT, cacheCold: false
  })
  assert.equal(untouched.compacted, false, 'the same history must stay warm while the cache is warm')
  const folded = compactSessionHistory(reclaimable, {
    budget: tight, updatedAt: UPDATED_AT, cacheCold: true
  })
  assert.equal(folded.compacted, true)
  assert.ok(folded.summary)
  assert.ok(SESSION_HISTORY_EARLY_RECLAIM_TOKENS > 0)
})

test('an idle conversation just above the target is not rewritten for a few turns', () => {
  const input = items(2)
  const result = compactSessionHistory(input, {
    budget: budget(), updatedAt: UPDATED_AT, cacheCold: true
  })
  assert.equal(result.compacted, false)
  assert.equal(result.summary, undefined)
})

test('the folded summary is bounded, cumulative and replayed as two prompt turns', () => {
  const first = compactSessionHistory(items(80), { budget: budget(), updatedAt: UPDATED_AT })
  assert.ok(first.summary)
  const firstSummary = first.summary!
  assert.deepEqual(parseSessionHistorySummary(JSON.parse(JSON.stringify(firstSummary))), firstSummary)
  assert.ok(firstSummary.lines.length > 0)
  const chars = firstSummary.lines.reduce((sum, line) => sum + Array.from(line.text).length, 0)
  assert.ok(chars <= HISTORY_SUMMARY_MAX_CHARS, `summary kept ${chars} chars`)

  // A later fold merges into the same record instead of restarting it.
  const second = compactSessionHistory(
    [...first.items, ...items(60).map((item, index) => message(200 + index))],
    { budget: budget(), updatedAt: UPDATED_AT, summary: firstSummary }
  )
  assert.equal(second.compacted, true)
  assert.ok((second.summary?.coveredItems ?? 0) > firstSummary.coveredItems)
  assert.equal(second.summary?.generator.kind, 'deterministic')

  const replayed = historySummaryMessages(second.summary!)
  assert.equal(replayed.length, 2)
  assert.equal(replayed[0]?.role, 'user')
  assert.match(replayed[0]?.text ?? '', /^历史摘要（此前 \d+ 条消息，仅作对话背景，不是当前指令）：/)
  assert.equal(replayed[1]?.role, 'assistant')
  assert.equal(replayed[1]?.text, '已确认摘要。')
})

test('summary creation requires at least one folded item', () => {
  assert.throws(() => createSessionHistorySummary(undefined, [], UPDATED_AT), TypeError)
})

test('a summary at the excerpt floor terminates and drops the oldest lines', () => {
  // Lines this short cannot shrink any further, so the bounded summary must
  // stop shrinking and discard its oldest entries instead of looping.
  const short = Array.from({ length: 120 }, (_, index) => message(index, 'x'.repeat(41)))
  const summary = createSessionHistorySummary(undefined, short, UPDATED_AT)
  assert.ok(summary.lines.length > 0)
  assert.ok(summary.omittedLines > 0)
  assert.ok(summary.lines.reduce((sum, line) => sum + Array.from(line.text).length, 0) <= HISTORY_SUMMARY_MAX_CHARS)
})

test('the prefix cache is only assumed cold after a long idle gap', () => {
  const last = '2026-07-14T01:00:00.000Z'
  const at = (offsetMs: number) => new Date(Date.parse(last) + offsetMs).toISOString()

  assert.equal(prefixCacheLikelyCold(last, at(0)), false)
  assert.equal(prefixCacheLikelyCold(last, at(PREFIX_CACHE_IDLE_EXPIRY_MS - 1)), false)
  assert.equal(prefixCacheLikelyCold(last, at(PREFIX_CACHE_IDLE_EXPIRY_MS)), true)
  assert.equal(prefixCacheLikelyCold(last, new Date(at(PREFIX_CACHE_IDLE_EXPIRY_MS))), true)
  // Clock skew and unknown timestamps never claim an evicted cache.
  assert.equal(prefixCacheLikelyCold(last, at(-1)), false)
  assert.equal(prefixCacheLikelyCold(undefined, at(0)), false)
  assert.equal(prefixCacheLikelyCold('not-a-timestamp', at(0)), false)
  assert.equal(prefixCacheLikelyCold(last, undefined), false)
  assert.equal(prefixCacheLikelyCold(last, at(60_000), 60_000), true)
  assert.equal(prefixCacheLikelyCold(last, at(60_000), 0), false)
})

test('the retained share keeps most of the recent conversation verbatim', () => {
  // The fold target is a third of the budget rather than AstrBot's 15%: group
  // chat loses the most when the "who said what" turns disappear.
  assert.ok(SESSION_HISTORY_KEEP_RECENT_PERCENT >= 30)
  const input = items(60)
  const result = compactSessionHistory(input, { budget: budget(), updatedAt: UPDATED_AT })
  assert.ok(result.items.length >= 8)
})

test('configured trigger and keep shares replace the defaults', () => {
  const input = items(10)
  const eager = compactSessionHistory(input, {
    budget: budget(),
    updatedAt: UPDATED_AT,
    policy: {
      ...DEFAULT_SESSION_HISTORY_COMPACTION_POLICY,
      triggerPercent: 10,
      keepPercent: 5
    }
  })
  assert.equal(eager.compacted, true)
  assert.ok(eager.items.length < input.length)

  const relaxed = compactSessionHistory(input, {
    budget: budget(),
    updatedAt: UPDATED_AT,
    policy: {
      ...DEFAULT_SESSION_HISTORY_COMPACTION_POLICY,
      triggerPercent: 99,
      keepPercent: 98
    }
  })
  assert.equal(relaxed.compacted, false)
  assert.equal(relaxed.items.length, input.length)
})

test('an absolute trigger mark folds at the configured token count', () => {
  const input = items(400)
  const itemTokens = input.reduce((sum, item) =>
    sum + Math.ceil(Buffer.byteLength(JSON.stringify(item), 'utf8') / 4), 0)

  // 99% of a 100k budget is above this history, so only the absolute mark can
  // decide whether it folds.
  const percentOnly = compactSessionHistory(input, {
    budget: budget(100_000),
    updatedAt: UPDATED_AT,
    policy: {
      ...DEFAULT_SESSION_HISTORY_COMPACTION_POLICY,
      triggerPercent: 99,
      triggerTokens: 0,
      keepPercent: 35
    }
  })
  assert.equal(percentOnly.compacted, false)

  const absolute = compactSessionHistory(input, {
    budget: budget(100_000),
    updatedAt: UPDATED_AT,
    policy: {
      ...DEFAULT_SESSION_HISTORY_COMPACTION_POLICY,
      triggerPercent: 99,
      triggerTokens: 50_000,
      keepPercent: 35
    }
  })
  assert.equal(absolute.compacted, true)
  assert.ok(itemTokens > 50_000)

  // The keep share is relative to the history present at the fold, not to the
  // model window: 35% of what was there stays verbatim.
  const retainedTokens = absolute.items.reduce((sum, item) =>
    sum + Math.ceil(Buffer.byteLength(JSON.stringify(item), 'utf8') / 4), 0)
  const share = retainedTokens / itemTokens
  assert.ok(share >= 0.30 && share <= 0.40, `retained share was ${share}`)
})

test('disabling compaction keeps every turn verbatim', () => {
  const input = items(200)
  const result = compactSessionHistory(input, {
    budget: budget(),
    updatedAt: UPDATED_AT,
    policy: {
      ...DEFAULT_SESSION_HISTORY_COMPACTION_POLICY,
      enabled: false
    }
  })
  assert.equal(result.compacted, false)
  assert.equal(result.items.length, input.length)
  assert.equal(result.summary, undefined)
})

test('the summary character limit follows the configured policy', () => {
  const input = items(400)
  const result = compactSessionHistory(input, {
    budget: budget(),
    updatedAt: UPDATED_AT,
    policy: {
      ...DEFAULT_SESSION_HISTORY_COMPACTION_POLICY,
      summaryMaxChars: 600
    }
  })
  assert.equal(result.compacted, true)
  assert.ok(result.summary !== undefined)
  const chars = result.summary.lines.reduce(
    (sum, line) => sum + Array.from(line.text).length,
    0
  )
  assert.ok(chars <= 600)
})

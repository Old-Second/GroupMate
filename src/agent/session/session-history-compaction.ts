/**
 * Token-driven compression of the persisted conversation that leads every
 * prompt.
 *
 * The session block sits directly after the system instructions, so a window
 * that drops its oldest entry on every completed turn rewrites the prompt at
 * that position. A provider disk cache only credits a byte-identical prefix:
 * everything behind the dropped entry — the group window, memory and the
 * current request — is charged as a miss on every single turn.
 *
 * The conversation is therefore never trimmed to a fixed message count. Recent
 * turns stay verbatim up to a token target derived from the request budget;
 * once the history crosses a higher token mark — a share of the budget or an
 * absolute token count — everything older than the target is folded into one
 * persisted excerpt summary. The target is a share of the history actually
 * present when the fold happens, so "keep the last 35%" means the same thing
 * at a 32k window and at a 1M one. The next prompts replay
 * `system` + `[user: 历史摘要]` + `[assistant: 已确认摘要]` + the recent
 * verbatim turns, so the prefix stays byte-identical between compressions and
 * only the turn that crosses the mark pays for the rewrite.
 *
 * A provider prefix that is already cold can be rewritten for free, so a large
 * enough reclaimable tail is folded early after a long idle gap instead of
 * waiting for the high-water mark.
 */

import type { ContextBudget } from '../context/context-budget.js'
import {
  type CanonicalConversationItem,
  type SessionHistorySummary
} from './agent-session-state.js'
import {
  createSessionHistorySummary,
  historySummaryMessages,
  HISTORY_SUMMARY_MAX_CHARS
} from './session-history-summary.js'

/** Fold back to this share of the available input budget. */
export const SESSION_HISTORY_KEEP_RECENT_PERCENT = 35

/** Fold once the replayed history reaches this share of the budget. */
export const SESSION_HISTORY_HIGH_WATER_PERCENT = 65

/** Default provider prefix-cache retention estimate, used only to time folds. */
export const PREFIX_CACHE_IDLE_EXPIRY_MS = 6 * 60 * 60 * 1_000

/** Skip an idle-time fold that would reclaim less than this many tokens. */
export const SESSION_HISTORY_EARLY_RECLAIM_TOKENS = 1_024

/** Items reserved for system, group, memory and the current request. */
export const SESSION_HISTORY_ITEM_RESERVE = 80

/** Share of the item high-water mark kept verbatim after an item-triggered fold. */
export const SESSION_HISTORY_ITEM_RETAINED_PERCENT = 60

/**
 * Deployment-tunable compaction behaviour. The trigger may be an absolute
 * token count (`triggerTokens`) or a share of the available input budget, so
 * the same kernel serves a 32k model and a 1M one: a 65% trigger leaves a third
 * of the window free for the group window, memory and the reply, while an
 * absolute mark keeps "fold at 256k" stable when the declared window changes.
 * The keep share is always relative to the history present at the fold, so
 * "keep 35%" keeps 35% of what was actually there.
 */
export interface SessionHistoryCompactionPolicy {
  /** `false` keeps history verbatim until the structural byte/item bounds hit. */
  readonly enabled: boolean
  /** Fold once the replayed history reaches this share of available input. */
  readonly triggerPercent: number
  /** Absolute history token mark; `0` falls back to `triggerPercent`. */
  readonly triggerTokens: number
  /** Share of the history present at the fold kept verbatim. */
  readonly keepPercent: number
  /** Idle time after which the provider prefix is assumed evicted. */
  readonly cacheIdleExpiryMs: number
  /** Do not fold early for less than this much reclaimable history. */
  readonly minReclaimTokens: number
  /** Total excerpt characters the rolling summary may keep. */
  readonly summaryMaxChars: number
}

export const DEFAULT_SESSION_HISTORY_COMPACTION_POLICY: SessionHistoryCompactionPolicy =
  Object.freeze({
    enabled: true,
    triggerPercent: SESSION_HISTORY_HIGH_WATER_PERCENT,
    triggerTokens: 0,
    keepPercent: SESSION_HISTORY_KEEP_RECENT_PERCENT,
    cacheIdleExpiryMs: PREFIX_CACHE_IDLE_EXPIRY_MS,
    minReclaimTokens: SESSION_HISTORY_EARLY_RECLAIM_TOKENS,
    summaryMaxChars: HISTORY_SUMMARY_MAX_CHARS
  })

export interface SessionHistoryCompactionOptions {
  readonly budget: ContextBudget
  readonly updatedAt: string
  readonly summary?: SessionHistorySummary
  /**
   * Whether the provider's cached prefix for this conversation is expected to
   * be gone already. Folding then costs nothing extra, so it happens early.
   */
  readonly cacheCold?: boolean
  readonly policy?: SessionHistoryCompactionPolicy
}

export interface SessionHistoryCompactionResult {
  readonly items: readonly CanonicalConversationItem[]
  readonly summary?: SessionHistorySummary
  readonly compacted: boolean
}

/**
 * The same byte-quarter estimate the context planner uses
 * (`context-byte-quarter-v1`), applied to the canonical item as persisted.
 */
function estimateTokens (value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4))
}

function isUserMessage (item: CanonicalConversationItem | undefined): boolean {
  return item?.kind === 'message' && item.message.role === 'user'
}

function unchanged (
  items: readonly CanonicalConversationItem[],
  summary: SessionHistorySummary | undefined
): SessionHistoryCompactionResult {
  return Object.freeze({
    items,
    ...(summary === undefined ? {} : { summary }),
    compacted: false
  })
}

function validPolicy (policy: SessionHistoryCompactionPolicy): boolean {
  return typeof policy.enabled === 'boolean' &&
    Number.isSafeInteger(policy.triggerPercent) &&
    policy.triggerPercent >= 1 && policy.triggerPercent <= 99 &&
    Number.isSafeInteger(policy.triggerTokens) &&
    policy.triggerTokens >= 0 &&
    Number.isSafeInteger(policy.keepPercent) &&
    policy.keepPercent >= 1 && policy.keepPercent <= 98 &&
    Number.isSafeInteger(policy.cacheIdleExpiryMs) && policy.cacheIdleExpiryMs > 0 &&
    Number.isSafeInteger(policy.minReclaimTokens) && policy.minReclaimTokens >= 0 &&
    Number.isSafeInteger(policy.summaryMaxChars) && policy.summaryMaxChars >= 200 &&
    policy.summaryMaxChars <= 20_000
}

/**
 * Folds the oldest turns into the persistent summary when the conversation has
 * outgrown its replay target.
 *
 * The result is either the input untouched or a frozen tail plus an updated
 * summary, never an empty tail: the newest item always stays verbatim, and the
 * tail starts with a user message whenever one is available so the replay never
 * opens with a reply whose prompting message was folded away.
 */
export function compactSessionHistory (
  items: readonly CanonicalConversationItem[],
  options: SessionHistoryCompactionOptions
): SessionHistoryCompactionResult {
  const policy = options.policy !== undefined && validPolicy(options.policy)
    ? options.policy
    : DEFAULT_SESSION_HISTORY_COMPACTION_POLICY
  if (!policy.enabled) return unchanged(items, options.summary)
  const availableTokens = options.budget.modelContextTokens -
    options.budget.reservedOutputTokens -
    options.budget.reservedToolTokens -
    options.budget.safetyMarginTokens
  if (!Number.isSafeInteger(availableTokens) || availableTokens <= 0 || items.length === 0) {
    return unchanged(items, options.summary)
  }
  const itemTokens = items.map(estimateTokens)
  const itemTotal = itemTokens.reduce((sum, value) => sum + value, 0)
  const summaryTokens = options.summary === undefined
    ? 0
    : estimateTokens(historySummaryMessages(options.summary))
  // An absolute mark lets a deployment fold at 256k tokens regardless of how
  // large a window it declares; it can never exceed what one request may carry.
  const highWaterTokens = policy.triggerTokens > 0
    ? Math.min(policy.triggerTokens, availableTokens)
    : Math.floor(availableTokens * policy.triggerPercent / 100)
  // The keep share is relative to the history actually being folded, so
  // "keep 35%" retains 35% of the turns that existed at the moment of the fold
  // instead of a window-dependent share that can exceed the trigger itself.
  // It is capped by the same share of the available input budget so a history
  // far above the high-water mark cannot fold down to something that crosses
  // the mark again on the very next turn.
  const keepRecentTokens = Math.max(1, Math.min(
    Math.floor(itemTotal * policy.keepPercent / 100),
    Math.floor(availableTokens * policy.keepPercent / 100)
  ))
  // The context item budget covers the whole prompt, so the conversation may
  // only claim the part the system, group and memory blocks do not need.
  const itemReserve = Math.min(
    SESSION_HISTORY_ITEM_RESERVE,
    Math.floor(options.budget.maxItems / 4)
  )
  const itemHighWater = Math.max(2, options.budget.maxItems - itemReserve)
  const itemRetained = Math.max(
    1,
    Math.floor(itemHighWater * SESSION_HISTORY_ITEM_RETAINED_PERCENT / 100)
  )

  const overTokens = itemTotal + summaryTokens > highWaterTokens
  const overItems = items.length > itemHighWater
  // Rewriting the prefix is only free once the provider cache is gone, and it
  // is only worth doing while the history is close enough to the fold point
  // that reclaiming the tail actually buys turns before the next fold.
  const coldCacheReclaim = options.cacheCold === true &&
    itemTotal > keepRecentTokens + policy.minReclaimTokens &&
    itemTotal >= Math.floor(highWaterTokens / 2)
  if (!overTokens && !overItems && !coldCacheReclaim) return unchanged(items, options.summary)

  // Walk backwards until the verbatim tail reaches its token target. The tail
  // is a fixed share of the folded history, so a fold cuts the replayed history
  // by that share and the next few turns stay cache-warm.
  let cut = items.length
  let retainedTokens = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    retainedTokens += itemTokens[index]!
    if (retainedTokens >= keepRecentTokens) {
      cut = index
      break
    }
  }
  if (cut >= items.length) cut = items.length - 1
  if (overItems) {
    cut = Math.max(cut, items.length - itemRetained)
  }
  cut = Math.max(0, Math.min(cut, items.length - 1))

  // Boundary repair: the replayed tail must not open with a reply whose
  // prompting message fell outside the window.
  for (let index = cut; index < items.length; index += 1) {
    if (isUserMessage(items[index])) {
      cut = index
      break
    }
  }
  if (cut <= 0) return unchanged(items, options.summary)

  const folded = items.slice(0, cut)
  const retained = items.slice(cut)
  const summary = createSessionHistorySummary(
    options.summary,
    folded,
    options.updatedAt,
    policy.summaryMaxChars
  )
  return Object.freeze({
    items: Object.freeze(retained),
    summary,
    compacted: true
  })
}

/**
 * Whether the provider prefix cache for a conversation is likely already gone.
 *
 * The estimate is deliberately conservative: providers clear an unused prefix
 * cache after hours to days, so a gap shorter than this is never treated as
 * cold. Treating a warm cache as cold would rewrite the prompt for nothing;
 * treating a cold cache as warm only defers the fold to the high-water mark,
 * which is the normal path anyway.
 */
export function prefixCacheLikelyCold (
  lastActivityAt: string | undefined,
  now: string | Date | undefined,
  expiryMs: number = PREFIX_CACHE_IDLE_EXPIRY_MS
): boolean {
  const last = Date.parse(lastActivityAt ?? '')
  const current = now instanceof Date ? now.getTime() : Date.parse(now ?? '')
  if (!Number.isFinite(last) || !Number.isFinite(current)) return false
  const ttl = Number.isSafeInteger(expiryMs) && expiryMs > 0
    ? expiryMs
    : PREFIX_CACHE_IDLE_EXPIRY_MS
  return current - last >= ttl
}

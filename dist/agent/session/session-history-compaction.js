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
 * once the history crosses a higher token mark, everything older than the
 * target is folded into one persisted excerpt summary. The next prompts replay
 * `system` + `[user: 历史摘要]` + `[assistant: 已确认摘要]` + the recent
 * verbatim turns, so the prefix stays byte-identical between compressions and
 * only the turn that crosses the mark pays for the rewrite.
 *
 * A provider prefix that is already cold can be rewritten for free, so a large
 * enough reclaimable tail is folded early after a long idle gap instead of
 * waiting for the high-water mark.
 */
import { createSessionHistorySummary, historySummaryMessages, HISTORY_SUMMARY_MAX_CHARS } from './session-history-summary.js';
/** Fold back to this share of the available input budget. */
export const SESSION_HISTORY_KEEP_RECENT_PERCENT = 35;
/** Fold once the replayed history reaches this share of the budget. */
export const SESSION_HISTORY_HIGH_WATER_PERCENT = 65;
/** Default provider prefix-cache retention estimate, used only to time folds. */
export const PREFIX_CACHE_IDLE_EXPIRY_MS = 6 * 60 * 60 * 1_000;
/** Skip an idle-time fold that would reclaim less than this many tokens. */
export const SESSION_HISTORY_EARLY_RECLAIM_TOKENS = 1_024;
/** Items reserved for system, group, memory and the current request. */
export const SESSION_HISTORY_ITEM_RESERVE = 80;
/** Share of the item high-water mark kept verbatim after an item-triggered fold. */
export const SESSION_HISTORY_ITEM_RETAINED_PERCENT = 60;
export const DEFAULT_SESSION_HISTORY_COMPACTION_POLICY = Object.freeze({
    enabled: true,
    triggerPercent: SESSION_HISTORY_HIGH_WATER_PERCENT,
    keepPercent: SESSION_HISTORY_KEEP_RECENT_PERCENT,
    cacheIdleExpiryMs: PREFIX_CACHE_IDLE_EXPIRY_MS,
    minReclaimTokens: SESSION_HISTORY_EARLY_RECLAIM_TOKENS,
    summaryMaxChars: HISTORY_SUMMARY_MAX_CHARS
});
/**
 * The same byte-quarter estimate the context planner uses
 * (`context-byte-quarter-v1`), applied to the canonical item as persisted.
 */
function estimateTokens(value) {
    return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4));
}
function isUserMessage(item) {
    return item?.kind === 'message' && item.message.role === 'user';
}
function unchanged(items, summary) {
    return Object.freeze({
        items,
        ...(summary === undefined ? {} : { summary }),
        compacted: false
    });
}
function validPolicy(policy) {
    return typeof policy.enabled === 'boolean' &&
        Number.isSafeInteger(policy.triggerPercent) &&
        policy.triggerPercent >= 1 && policy.triggerPercent <= 99 &&
        Number.isSafeInteger(policy.keepPercent) &&
        policy.keepPercent >= 1 && policy.keepPercent <= 98 &&
        policy.keepPercent < policy.triggerPercent &&
        Number.isSafeInteger(policy.cacheIdleExpiryMs) && policy.cacheIdleExpiryMs > 0 &&
        Number.isSafeInteger(policy.minReclaimTokens) && policy.minReclaimTokens >= 0 &&
        Number.isSafeInteger(policy.summaryMaxChars) && policy.summaryMaxChars >= 200 &&
        policy.summaryMaxChars <= 20_000;
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
export function compactSessionHistory(items, options) {
    const policy = options.policy !== undefined && validPolicy(options.policy)
        ? options.policy
        : DEFAULT_SESSION_HISTORY_COMPACTION_POLICY;
    if (!policy.enabled)
        return unchanged(items, options.summary);
    const availableTokens = options.budget.modelContextTokens -
        options.budget.reservedOutputTokens -
        options.budget.reservedToolTokens -
        options.budget.safetyMarginTokens;
    if (!Number.isSafeInteger(availableTokens) || availableTokens <= 0 || items.length === 0) {
        return unchanged(items, options.summary);
    }
    const itemTokens = items.map(estimateTokens);
    const itemTotal = itemTokens.reduce((sum, value) => sum + value, 0);
    const summaryTokens = options.summary === undefined
        ? 0
        : estimateTokens(historySummaryMessages(options.summary));
    const highWaterTokens = Math.floor(availableTokens * policy.triggerPercent / 100);
    const keepRecentTokens = Math.floor(availableTokens * policy.keepPercent / 100);
    // The context item budget covers the whole prompt, so the conversation may
    // only claim the part the system, group and memory blocks do not need.
    const itemReserve = Math.min(SESSION_HISTORY_ITEM_RESERVE, Math.floor(options.budget.maxItems / 4));
    const itemHighWater = Math.max(2, options.budget.maxItems - itemReserve);
    const itemRetained = Math.max(1, Math.floor(itemHighWater * SESSION_HISTORY_ITEM_RETAINED_PERCENT / 100));
    const overTokens = itemTotal + summaryTokens > highWaterTokens;
    const overItems = items.length > itemHighWater;
    const coldCacheReclaim = options.cacheCold === true &&
        itemTotal > keepRecentTokens + policy.minReclaimTokens;
    if (!overTokens && !overItems && !coldCacheReclaim)
        return unchanged(items, options.summary);
    // Walk backwards until the verbatim tail reaches its token target. The tail
    // was chosen to be about a third of the budget, so a fold roughly halves the
    // replayed history and the next few turns stay cache-warm.
    let cut = items.length;
    let retainedTokens = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
        retainedTokens += itemTokens[index];
        if (retainedTokens >= keepRecentTokens) {
            cut = index;
            break;
        }
    }
    if (cut >= items.length)
        cut = items.length - 1;
    if (overItems) {
        cut = Math.max(cut, items.length - itemRetained);
    }
    cut = Math.max(0, Math.min(cut, items.length - 1));
    // Boundary repair: the replayed tail must not open with a reply whose
    // prompting message fell outside the window.
    for (let index = cut; index < items.length; index += 1) {
        if (isUserMessage(items[index])) {
            cut = index;
            break;
        }
    }
    if (cut <= 0)
        return unchanged(items, options.summary);
    const folded = items.slice(0, cut);
    const retained = items.slice(cut);
    const summary = createSessionHistorySummary(options.summary, folded, options.updatedAt, policy.summaryMaxChars);
    return Object.freeze({
        items: Object.freeze(retained),
        summary,
        compacted: true
    });
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
export function prefixCacheLikelyCold(lastActivityAt, now, expiryMs = PREFIX_CACHE_IDLE_EXPIRY_MS) {
    const last = Date.parse(lastActivityAt ?? '');
    const current = now instanceof Date ? now.getTime() : Date.parse(now ?? '');
    if (!Number.isFinite(last) || !Number.isFinite(current))
        return false;
    const ttl = Number.isSafeInteger(expiryMs) && expiryMs > 0
        ? expiryMs
        : PREFIX_CACHE_IDLE_EXPIRY_MS;
    return current - last >= ttl;
}

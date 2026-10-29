import { parsePresentationCost } from '../../agent/contracts/presentation-trace.js';
import { parseRunUsageSummary } from '../../agent/run/run-usage.js';
/**
 * Token and reference-cost totals grouped by billing day, group and actor.
 *
 * This module deliberately sits outside `observability/`: that directory is the
 * redacted surface audited against identity fields, while aggregation needs the
 * real group and user identifiers as map keys. The boundary is kept here instead —
 * identity never reaches a metric label, never leaves this bounded in-memory
 * window, and every projected row carries a masked identifier, so a snapshot can
 * be rendered to the owner or written to a log without leaking one.
 */
export const USAGE_AGGREGATE_LIMITS = Object.freeze({
    maxDays: 7,
    maxGroupsPerDay: 32,
    maxActorsPerDay: 64,
    maxRows: 16,
    maxIdentifierLength: 64
});
const MASK_PREFIX = '****';
const MASK_VISIBLE_CHARS = 4;
const BEIJING_OFFSET_MS = 8 * 3_600_000;
export function usageAggregationEnabled(config) {
    return config.usageAggregationEnabled !== false;
}
/**
 * Keeps the trailing characters only. The owner can still tell two groups apart
 * while neither a reply nor a log line carries a complete identifier.
 */
export function maskUsageIdentifier(value) {
    if (typeof value !== 'string' || value.length <= MASK_VISIBLE_CHARS)
        return MASK_PREFIX;
    return `${MASK_PREFIX}${value.slice(-MASK_VISIBLE_CHARS)}`;
}
/** Billing day in Asia/Shanghai, matching the DeepSeek peak and off-peak calendar. */
export function usageBillingDay(occurredAt) {
    const instant = Date.parse(occurredAt);
    if (!Number.isFinite(instant))
        throw new TypeError('usage occurrence is invalid');
    return new Date(instant + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}
function boundedIdentifier(value, label) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.length > USAGE_AGGREGATE_LIMITS.maxIdentifierLength) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function safeSum(left, right, label) {
    const sum = left + right;
    if (!Number.isSafeInteger(sum))
        throw new RangeError(`${label} exceeded safe integer range`);
    return sum;
}
function unavailableCost(catalogVersion) {
    return Object.freeze({ kind: 'unavailable', catalogVersion, billingAuthority: false });
}
/**
 * Same degradation rules as the per-run accumulation in `run-usage.ts`: a missing
 * quote or a different catalog version makes the whole total unavailable rather
 * than silently mixing incomparable prices, and any upper bound dominates.
 */
function mergeCost(prior, next) {
    if (next === undefined || next.kind === 'unavailable') {
        return unavailableCost(next?.catalogVersion ?? prior?.catalogVersion ?? null);
    }
    if (prior === undefined)
        return next;
    if (prior.kind === 'unavailable' || prior.catalogVersion !== next.catalogVersion) {
        return unavailableCost(prior.kind === 'unavailable' ? prior.catalogVersion : null);
    }
    return parsePresentationCost({
        kind: prior.kind === 'upper_bound' || next.kind === 'upper_bound' ? 'upper_bound' : 'exact',
        currency: 'CNY',
        billingAuthority: false,
        catalogVersion: next.catalogVersion,
        picoYuan: (BigInt(prior.picoYuan) + BigInt(next.picoYuan)).toString(10)
    });
}
function mergeAvailability(prior, next) {
    if (prior === 'unavailable' || next === 'unavailable')
        return 'unavailable';
    return prior === 'partial' || next === 'partial' ? 'partial' : 'complete';
}
function createTotals() {
    return {
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        availability: 'complete',
        cost: undefined
    };
}
function accumulate(target, usage) {
    const merged = target.runs === 0
        ? mergeCost(undefined, usage.cost)
        : mergeCost(target.cost, usage.cost);
    target.runs = safeSum(target.runs, 1, 'usage run count');
    target.inputTokens = safeSum(target.inputTokens, usage.inputTokens, 'usage input tokens');
    target.outputTokens = safeSum(target.outputTokens, usage.outputTokens, 'usage output tokens');
    target.totalTokens = safeSum(target.totalTokens, usage.totalTokens, 'usage total tokens');
    target.cacheHitTokens = safeSum(target.cacheHitTokens, usage.cacheHitTokens, 'usage cache hit tokens');
    target.cacheMissTokens = safeSum(target.cacheMissTokens, usage.cacheMissTokens, 'usage cache miss tokens');
    target.availability = mergeAvailability(target.availability, usage.availability);
    target.cost = merged;
}
function freezeTotals(totals) {
    const { cost, ...counts } = totals;
    return Object.freeze({ ...counts, cost: cost ?? unavailableCost(null) });
}
/**
 * Projects the one journal event that carries identity, terminal token counts and
 * reference cost together. Returns `null` for every other event type.
 */
export function projectUsageAggregateInput(event) {
    if (event?.type !== 'run.terminal_committed')
        return null;
    const checkpoint = event.checkpoint;
    const scope = checkpoint.sessionAddress.scope;
    const routedActor = checkpoint.presentationRoute?.actorId;
    const scopedActor = scope.kind === 'group' ? undefined : scope.userId;
    const actorId = routedActor !== undefined && routedActor.length > 0
        ? routedActor
        : scopedActor ?? null;
    return Object.freeze({
        occurredAt: event.occurredAt,
        botId: boundedIdentifier(checkpoint.sessionAddress.botId, 'usage bot ID'),
        scope: scope.kind === 'private'
            ? Object.freeze({
                kind: 'private',
                userId: boundedIdentifier(scope.userId, 'usage user ID')
            })
            : Object.freeze({
                kind: 'group',
                groupId: boundedIdentifier(scope.groupId, 'usage group ID')
            }),
        actorId: actorId === null ? null : boundedIdentifier(actorId, 'usage actor ID'),
        usage: parseRunUsageSummary(checkpoint.usage)
    });
}
class BoundedKeySet {
    #values = new Set();
    #capacity;
    constructor(capacity) {
        this.#capacity = capacity;
    }
    accept(value) {
        if (this.#values.has(value))
            return false;
        this.#values.add(value);
        if (this.#values.size > this.#capacity) {
            const oldest = this.#values.values().next().value;
            if (oldest !== undefined)
                this.#values.delete(oldest);
        }
        return true;
    }
    clear() {
        this.#values.clear();
    }
}
export class UsageAggregator {
    #now;
    #days = new Map();
    #groups = new Map();
    #actors = new Map();
    #seenRuns = new BoundedKeySet(256);
    #total = createTotals();
    #currentLevel = 'basic';
    #windowStartedAt;
    #windowResetCount = 0;
    #observedRuns = 0;
    #rejectedRuns = 0;
    #droppedGroupRuns = 0;
    #droppedActorRuns = 0;
    constructor(options = {}) {
        this.#now = options.now ?? (() => new Date());
        this.#windowStartedAt = this.#safeNow();
    }
    /** Best-effort projection hook; a rejected event never reaches the totals. */
    record(event) {
        if (this.#currentLevel === 'off')
            return;
        let input;
        try {
            input = projectUsageAggregateInput(event);
        }
        catch {
            this.#rejectedRuns += 1;
            return;
        }
        if (input === null)
            return;
        this.accept(input, event.runRef);
    }
    accept(input, dedupeKey) {
        if (this.#currentLevel === 'off')
            return;
        let day;
        try {
            day = usageBillingDay(input.occurredAt);
        }
        catch {
            this.#rejectedRuns += 1;
            return;
        }
        if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) {
            this.#rejectedRuns += 1;
            return;
        }
        if (!this.#seenRuns.accept(dedupeKey))
            return;
        const dayTotals = this.#acceptDay(day);
        if (dayTotals === null) {
            this.#rejectedRuns += 1;
            return;
        }
        this.#observedRuns += 1;
        accumulate(this.#total, input.usage);
        accumulate(dayTotals, input.usage);
        const groupId = input.scope.kind === 'private' ? null : input.scope.groupId;
        if (groupId !== null) {
            const totals = this.#acceptScope(this.#groups, USAGE_AGGREGATE_LIMITS.maxGroupsPerDay, day, input.botId, groupId);
            if (totals === null)
                this.#droppedGroupRuns += 1;
            else
                accumulate(totals, input.usage);
        }
        if (input.actorId !== null) {
            const totals = this.#acceptScope(this.#actors, USAGE_AGGREGATE_LIMITS.maxActorsPerDay, day, input.botId, input.actorId);
            if (totals === null)
                this.#droppedActorRuns += 1;
            else
                accumulate(totals, input.usage);
        }
    }
    setCurrentLevel(level) {
        if (level === 'off' && this.#currentLevel !== 'off')
            this.#clear();
        this.#currentLevel = level;
    }
    snapshot() {
        return Object.freeze({
            schemaVersion: 1,
            windowStartedAt: this.#windowStartedAt,
            windowResetCount: this.#windowResetCount,
            observedRuns: this.#observedRuns,
            rejectedRuns: this.#rejectedRuns,
            droppedGroupRuns: this.#droppedGroupRuns,
            droppedActorRuns: this.#droppedActorRuns,
            total: freezeTotals(this.#total),
            days: Object.freeze([...this.#days.entries()]
                .sort((left, right) => right[0].localeCompare(left[0]))
                .map(([day, totals]) => Object.freeze({ day, totals: freezeTotals(totals) }))),
            groups: scopeRows(this.#groups),
            actors: scopeRows(this.#actors)
        });
    }
    #acceptDay(day) {
        const existing = this.#days.get(day);
        if (existing !== undefined)
            return existing;
        if (this.#days.size >= USAGE_AGGREGATE_LIMITS.maxDays) {
            const oldest = [...this.#days.keys()].sort()[0];
            if (oldest === undefined || day < oldest)
                return null;
            this.#days.delete(oldest);
            this.#forgetDay(oldest);
        }
        const created = createTotals();
        this.#days.set(day, created);
        return created;
    }
    #acceptScope(entries, limit, day, botId, id) {
        const key = `${day}\u0000${botId}\u0000${id}`;
        const existing = entries.get(key);
        if (existing !== undefined)
            return existing.totals;
        let sameDay = 0;
        for (const entry of entries.values())
            if (entry.day === day)
                sameDay += 1;
        if (sameDay >= limit)
            return null;
        const totals = createTotals();
        entries.set(key, { day, botId, id, totals });
        return totals;
    }
    #forgetDay(day) {
        for (const [key, entry] of this.#groups) {
            if (entry.day === day)
                this.#groups.delete(key);
        }
        for (const [key, entry] of this.#actors) {
            if (entry.day === day)
                this.#actors.delete(key);
        }
    }
    #clear() {
        this.#days.clear();
        this.#groups.clear();
        this.#actors.clear();
        this.#seenRuns.clear();
        this.#total = createTotals();
        this.#observedRuns = 0;
        this.#rejectedRuns = 0;
        this.#droppedGroupRuns = 0;
        this.#droppedActorRuns = 0;
        this.#windowResetCount += 1;
        this.#windowStartedAt = this.#safeNow();
    }
    #safeNow() {
        try {
            return this.#now().toISOString();
        }
        catch {
            return new Date(0).toISOString();
        }
    }
}
function scopeRows(entries) {
    return Object.freeze([...entries.values()]
        .map(entry => Object.freeze({
        day: entry.day,
        maskedId: maskUsageIdentifier(entry.id),
        totals: freezeTotals(entry.totals)
    }))
        .sort((left, right) => (right.totals.totalTokens - left.totals.totalTokens ||
        right.day.localeCompare(left.day) ||
        left.maskedId.localeCompare(right.maskedId)))
        .slice(0, USAGE_AGGREGATE_LIMITS.maxRows));
}

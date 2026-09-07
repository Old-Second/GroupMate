/**
 * Keeps replayed host image links usable.
 *
 * The host signs image downloads with a scene key that rotates roughly every 57
 * minutes, so a link stored in conversation history is dead long before the
 * conversation is. Rather than guessing an age at which a link stopped working,
 * this service stamps every replayed link with the current key and marks the
 * ones the host no longer serves as expired, so the context projection can keep
 * their text and leave only the unusable image reference out.
 *
 * Every step fails open: without keys, without a probe, or past the probe
 * budget the caller ends up with the previous age-bounded behaviour rather than
 * a failed request.
 */
import { parseHostImageLink, refreshHostImageLink } from './host-image-link.js';
/**
 * How long a link that cannot be re-signed may still be replayed.
 *
 * This is the fallback for a link the host adapter cannot refresh; a refreshable
 * link is bounded by the key expiry instead of by an assumed age.
 */
export const UNREFRESHABLE_LINK_MAX_AGE_MS = 10 * 60 * 1_000;
/** Links younger than this were captured with the current key already. */
const PROBE_MIN_AGE_MS = 5 * 60 * 1_000;
const MAX_CANDIDATES = 16;
const DEFAULT_PROBE_BUDGET_MS = 500;
const DEFAULT_MAX_PROBES = 4;
function isoOrNull(valueMs) {
    if (!Number.isFinite(valueMs))
        return null;
    try {
        return new Date(valueMs).toISOString();
    }
    catch {
        return null;
    }
}
export class HostImageLinkService {
    #keySource;
    #probe;
    #now;
    #probeBudgetMs;
    #maxProbes;
    #liveness = new Map();
    constructor(options) {
        this.#keySource = options.keySource;
        this.#probe = options.probe;
        this.#now = options.now ?? (() => Date.now());
        this.#probeBudgetMs = options.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS;
        this.#maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES;
    }
    async resolve(candidates, context, signal) {
        const decisions = new Map();
        const refreshable = new Map();
        for (const candidate of candidates) {
            if (refreshable.size >= MAX_CANDIDATES)
                break;
            if (parseHostImageLink(candidate.resourceId) === null)
                continue;
            const existing = refreshable.get(candidate.resourceId);
            // The newest capture of the same link is the most favourable one.
            if (existing === undefined ||
                (candidate.capturedAtMs ?? 0) > (existing.capturedAtMs ?? 0)) {
                refreshable.set(candidate.resourceId, candidate);
            }
        }
        if (refreshable.size === 0)
            return decisions;
        const keys = await this.#currentKeys(context.botId, signal);
        for (const candidate of refreshable.values()) {
            const refreshed = keys === null
                ? null
                : refreshHostImageLink(candidate.resourceId, keys);
            if (refreshed === null) {
                // No current key: fall back to a bounded replay age.
                const expiresAt = candidate.capturedAtMs === null
                    ? null
                    : isoOrNull(candidate.capturedAtMs + UNREFRESHABLE_LINK_MAX_AGE_MS);
                if (expiresAt !== null) {
                    decisions.set(candidate.resourceId, Object.freeze({
                        link: candidate.resourceId,
                        expiresAt
                    }));
                }
                continue;
            }
            const expiresAt = keys === null ? null : isoOrNull(keys.expiresAtMs);
            if (expiresAt === null)
                continue;
            decisions.set(candidate.resourceId, Object.freeze({
                link: refreshed,
                expiresAt
            }));
        }
        if (keys === null)
            return decisions;
        await this.#applyLiveness(refreshable, decisions, context, signal);
        return decisions;
    }
    async #currentKeys(botId, signal) {
        try {
            const keys = await this.#keySource.keys(botId, signal ?? new AbortController().signal);
            if (keys === null)
                return null;
            return keys.expiresAtMs > this.#now() ? keys : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Leaves out links the host no longer serves.
     *
     * A re-signed link still fails when the stored file itself is gone, and that
     * failure is sticky: the dead reference stays in history and rejects every
     * later request. Probing is bounded and only definitive answers are cached.
     */
    async #applyLiveness(refreshable, decisions, context, signal) {
        const expire = (resourceId) => {
            const decision = decisions.get(resourceId);
            if (decision === undefined)
                return;
            const capturedAtMs = refreshable.get(resourceId)?.capturedAtMs ??
                context.referenceAtMs - 1_000;
            decisions.set(resourceId, Object.freeze({
                link: decision.link,
                expiresAt: isoOrNull(capturedAtMs) ?? decision.expiresAt
            }));
        };
        const probe = this.#probe;
        const pending = [];
        for (const [resourceId, candidate] of refreshable) {
            if (!decisions.has(resourceId))
                continue;
            const link = parseHostImageLink(resourceId);
            if (link === null)
                continue;
            const known = this.#liveness.get(link.fileKey);
            if (known === 'gone') {
                expire(resourceId);
                continue;
            }
            if (known === 'alive' || probe === undefined)
                continue;
            const ageMs = candidate.capturedAtMs === null
                ? Number.POSITIVE_INFINITY
                : context.referenceAtMs - candidate.capturedAtMs;
            // A link captured within the current key period was signed with it.
            if (ageMs < PROBE_MIN_AGE_MS)
                continue;
            pending.push({ resourceId, fileKey: link.fileKey });
        }
        if (probe === undefined || pending.length === 0)
            return;
        const deadline = this.#now() + this.#probeBudgetMs;
        let probes = 0;
        for (const entry of pending) {
            if (probes >= this.#maxProbes || this.#now() >= deadline)
                return;
            if (signal?.aborted === true)
                return;
            const decision = decisions.get(entry.resourceId);
            if (decision === undefined)
                continue;
            probes += 1;
            let liveness = 'unknown';
            try {
                const budget = AbortSignal.timeout(Math.max(1, deadline - this.#now()));
                const scope = signal === undefined
                    ? budget
                    : AbortSignal.any([signal, budget]);
                liveness = await probe.probe(decision.link, scope);
            }
            catch {
                liveness = 'unknown';
            }
            if (liveness === 'unknown')
                continue;
            this.#liveness.set(entry.fileKey, liveness);
            if (liveness === 'gone')
                expire(entry.resourceId);
        }
    }
}

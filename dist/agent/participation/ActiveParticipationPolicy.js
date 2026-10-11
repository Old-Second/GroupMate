import { isTrustedParticipationEvent } from './ParticipationContract.js';
import { ParticipationState } from './ParticipationState.js';
export const ACTIVE_PARTICIPATION_POLICY_VERSION = 2;
export const ACTIVE_PARTICIPATION_LIMITS = Object.freeze({
    scopes: 64, cooldownMs: 30_000, groupPerHour: 6, globalPerHour: 30, hourMs: 3_600_000
});
/** Candidate policy only: host admission, authority and actual effects stay behind their existing ports. */
export class ActiveParticipationPolicy {
    now;
    enabled;
    #state;
    #scopes = new Map();
    #issued = new WeakSet();
    #admitted = new WeakSet();
    #finished = new WeakSet();
    #closed = false;
    #lastNow = 0;
    #globalAdmittedAt = [];
    constructor(now, enabled) {
        this.now = now;
        this.enabled = enabled;
        this.#state = new ParticipationState(now);
    }
    #time() {
        const time = this.now();
        if (!Number.isSafeInteger(time) || time < this.#lastNow)
            throw new TypeError('active participation clock invalid');
        this.#lastNow = time;
        return time;
    }
    #available() {
        // Configuration reloads construct a new policy. Once disabled, this graph cannot revive old work.
        if (!this.enabled())
            this.close();
        return !this.#closed;
    }
    #pruneQuota(times, time) {
        while (times[0] !== undefined && time - times[0] >= ACTIVE_PARTICIPATION_LIMITS.hourMs)
            times.shift();
    }
    #scope(ref, time) {
        let scope = this.#scopes.get(ref);
        if (scope === undefined) {
            if (this.#scopes.size === ACTIVE_PARTICIPATION_LIMITS.scopes) {
                let oldest;
                let touched = Infinity;
                for (const [key, value] of this.#scopes) {
                    // Eviction cannot reset a charged hourly budget. Unknown scopes fail closed while all slots are live.
                    const disposable = value.admittedAt.every(at => time - at >= ACTIVE_PARTICIPATION_LIMITS.hourMs) &&
                        time - value.touchedAt >= 120_000;
                    if (disposable && value.touchedAt < touched) {
                        oldest = key;
                        touched = value.touchedAt;
                    }
                }
                if (oldest === undefined)
                    return null;
                this.#scopes.delete(oldest);
            }
            scope = { touchedAt: time, admittedAt: [], lastPassiveAt: null, recentActor: null, repliedAt: null };
            this.#scopes.set(ref, scope);
        }
        scope.touchedAt = time;
        return scope;
    }
    select(event, input) {
        const ignore = (reason) => Object.freeze({ kind: 'ignore', reason });
        if (!isTrustedParticipationEvent(event))
            return ignore('untrusted');
        if (!this.#available() || !event.eligible)
            return ignore('disabled');
        const time = this.#time();
        this.#state.observe(event);
        if (event.at > time || time - event.at >= 15_000)
            return ignore('unavailable');
        const scope = this.#scope(event.scopeRef, time);
        const continuation = scope !== null && scope.recentActor === event.actorRef && scope.repliedAt !== null && time - scope.repliedAt < 120_000;
        if (!event.addressed && event.acknowledgement)
            return ignore('acknowledgement');
        if (!event.addressed && !continuation && !input.sampled)
            return ignore('sample_miss');
        if (!event.addressed && input.gateAllows !== true)
            return ignore('gate_rejected');
        if (!event.addressed && scope === null)
            return ignore('unavailable');
        const candidate = this.#state.offer(event, event.addressed ? 'direct' : continuation ? 'continuation' : 'sampled');
        // A pending explicit request may own this scope; its route must never be reused for a newer event.
        if (candidate === null || candidate.messageRef !== event.messageRef)
            return ignore('unavailable');
        this.#issued.add(candidate);
        return Object.freeze({ kind: 'candidate', candidate });
    }
    current(candidate) {
        if (!this.#available() || !this.#issued.has(candidate) || this.#finished.has(candidate))
            return false;
        // An explicit task uses RunEngine's budget and live scene proof; topic/15-second TTL cannot cancel it.
        return candidate.source === 'direct' || (this.#scopes.has(candidate.scopeRef) && this.#state.current(candidate) === 'current');
    }
    /** Call only after obtaining the shared RunAdmission lease; this class creates no pool or queue. */
    admit(candidate) {
        if (!this.current(candidate))
            return false;
        if (this.#admitted.has(candidate))
            return false;
        if (candidate.source === 'direct') {
            this.#admitted.add(candidate);
            return true;
        }
        const time = this.#time(), scope = this.#scopes.get(candidate.scopeRef);
        if (scope === undefined)
            return false;
        this.#pruneQuota(this.#globalAdmittedAt, time);
        this.#pruneQuota(scope.admittedAt, time);
        if (scope.admittedAt.length >= ACTIVE_PARTICIPATION_LIMITS.groupPerHour || this.#globalAdmittedAt.length >= ACTIVE_PARTICIPATION_LIMITS.globalPerHour ||
            (scope.lastPassiveAt !== null && time - scope.lastPassiveAt < ACTIVE_PARTICIPATION_LIMITS.cooldownMs))
            return false;
        // Unknown or failed effects do not refund a reservation or immediately retry the candidate.
        scope.admittedAt.push(time);
        scope.lastPassiveAt = time;
        this.#globalAdmittedAt.push(time);
        this.#admitted.add(candidate);
        return true;
    }
    finish(candidate, delivered) {
        if (!this.#issued.has(candidate) || this.#finished.has(candidate))
            return;
        const accepted = this.#admitted.has(candidate) && this.current(candidate);
        this.#finished.add(candidate);
        this.#state.discard(candidate);
        if (!delivered || !accepted)
            return;
        const scope = this.#scopes.get(candidate.scopeRef);
        if (scope === undefined)
            return;
        scope.recentActor = candidate.actorRef;
        scope.repliedAt = this.#time();
    }
    stats() {
        const base = this.#state.stats();
        this.#pruneQuota(this.#globalAdmittedAt, this.#time());
        return Object.freeze({ scopes: this.#scopes.size, candidates: base.candidates,
            bytes: base.bytes + this.#scopes.size * 512 + 512, globalAdmitted: this.#globalAdmittedAt.length });
    }
    close() { this.#closed = true; this.#scopes.clear(); this.#globalAdmittedAt.length = 0; this.#state.close(); }
}

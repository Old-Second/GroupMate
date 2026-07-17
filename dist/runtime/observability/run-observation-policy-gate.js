import { createFrozenObservationPolicy, parseFrozenObservationPolicy } from '../../agent/run/run-observation.js';
import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js';
import { parseTraceCandidate } from '../../agent/run/run-trace.js';
import { parseObservationEvent } from './observation-event.js';
const CAPACITY = 32;
const TTL_MS = 600_000;
const LEVEL_ORDER = Object.freeze({
    off: 0,
    basic: 1,
    diagnostic: 2
});
export class RunObservationPolicyMismatchError extends Error {
    constructor() {
        super('run observation policy mismatch');
        this.name = 'RunObservationPolicyMismatchError';
    }
}
function safeNow(now) {
    try {
        const value = now();
        return Number.isFinite(value) ? Math.trunc(value) : 0;
    }
    catch {
        return 0;
    }
}
function canonicalPolicy(policy) {
    return JSON.stringify(policy);
}
function eventRunRef(event) {
    return event.value.runRef;
}
export class RunObservationPolicyGate {
    #now;
    #entries = new Map();
    #currentLevel = 'basic';
    #missingDrops = 0;
    #evictions = 0;
    constructor(options = {}) {
        this.#now = options.now ?? Date.now;
    }
    register(runRef, value) {
        if (typeof runRef !== 'string' || !RUN_REF_PATTERN.test(runRef)) {
            throw new TypeError('run observation policy reference is invalid');
        }
        const policy = parseFrozenObservationPolicy(value);
        const deterministic = createFrozenObservationPolicy({
            levelAtStart: policy.levelAtStart,
            runRef
        });
        if (canonicalPolicy(policy) !== canonicalPolicy(deterministic)) {
            this.#entries.delete(runRef);
            throw new RunObservationPolicyMismatchError();
        }
        const canonical = canonicalPolicy(policy);
        const existing = this.#entries.get(runRef);
        if (existing !== undefined && existing.canonical !== canonical) {
            this.#entries.delete(runRef);
            throw new RunObservationPolicyMismatchError();
        }
        const now = safeNow(this.#now);
        this.#entries.delete(runRef);
        this.#entries.set(runRef, { policy, canonical, touchedAt: now });
        while (this.#entries.size > CAPACITY) {
            const oldest = this.#entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.#entries.delete(oldest);
            this.#evictions += 1;
        }
    }
    allow(value) {
        let event;
        try {
            event = parseObservationEvent(value);
        }
        catch {
            return false;
        }
        const runRef = eventRunRef(event);
        if (runRef === 'unavailable')
            return this.#currentLevel !== 'off';
        return this.#allowRun(runRef);
    }
    allowCommittedCandidate(value) {
        let candidate;
        try {
            candidate = parseTraceCandidate(value);
        }
        catch {
            return false;
        }
        const entry = this.#entry(candidate.runRef);
        if (entry === null)
            return false;
        if (entry.canonical !== canonicalPolicy(candidate.policy))
            return false;
        return this.#effectiveLevel(entry.policy.levelAtStart) !== 'off';
    }
    setCurrentLevel(level) {
        if (!Object.hasOwn(LEVEL_ORDER, level)) {
            throw new TypeError('run observation level is invalid');
        }
        this.#currentLevel = level;
    }
    snapshot() {
        this.#purgeExpired();
        return Object.freeze({
            schemaVersion: 1,
            currentLevel: this.#currentLevel,
            entries: this.#entries.size,
            missingDrops: this.#missingDrops,
            evictions: this.#evictions
        });
    }
    #allowRun(runRef) {
        const entry = this.#entry(runRef);
        return entry !== null && this.#effectiveLevel(entry.policy.levelAtStart) !== 'off';
    }
    #entry(runRef) {
        const entry = this.#entries.get(runRef);
        const now = safeNow(this.#now);
        if (entry === undefined || now - entry.touchedAt >= TTL_MS) {
            if (entry !== undefined)
                this.#entries.delete(runRef);
            this.#missingDrops += 1;
            return null;
        }
        entry.touchedAt = now;
        this.#entries.delete(runRef);
        this.#entries.set(runRef, entry);
        return entry;
    }
    #purgeExpired() {
        const now = safeNow(this.#now);
        for (const [runRef, entry] of this.#entries) {
            if (now - entry.touchedAt >= TTL_MS)
                this.#entries.delete(runRef);
        }
    }
    #effectiveLevel(start) {
        return LEVEL_ORDER[start] <= LEVEL_ORDER[this.#currentLevel]
            ? start
            : this.#currentLevel;
    }
}

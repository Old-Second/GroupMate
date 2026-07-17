import { parseObservationEvent } from './observation-event.js';
const SINK_ORDER = Object.freeze([
    'metrics', 'trace', 'log'
]);
const FAILURE_CODES = new Set([
    'timeout', 'rejected', 'overflow', 'unavailable'
]);
const NORMAL_CONCURRENCY = 2;
const NORMAL_MAX_PENDING = 4;
const SUBSCRIBER_TIMEOUT_MS = 500;
const PRIORITY_RANK = Object.freeze({
    normal_success: 0,
    progress_delivery: 1,
    normal: 2
});
function safeTimestamp(now) {
    let value;
    try {
        value = now();
    }
    catch {
        value = 0;
    }
    if (!Number.isFinite(value))
        value = 0;
    try {
        return new Date(value).toISOString();
    }
    catch {
        return new Date(0).toISOString();
    }
}
function exactFailureData(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('sink failure is invalid');
    }
    const input = value;
    const keys = ['schemaVersion', 'sink', 'code', 'occurredAt'];
    let actual;
    try {
        actual = Reflect.ownKeys(input);
    }
    catch {
        throw new TypeError('sink failure is invalid');
    }
    if (actual.length !== keys.length || actual.some(key => (typeof key !== 'string' || !keys.includes(key)))) {
        throw new TypeError('sink failure keys are invalid');
    }
    const result = {};
    for (const key of keys) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(input, key);
        }
        catch {
            throw new TypeError('sink failure is invalid');
        }
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true) {
            throw new TypeError('sink failure property is invalid');
        }
        result[key] = descriptor.value;
    }
    return result;
}
export function parseSafeSinkFailure(value) {
    const input = exactFailureData(value);
    if (input.schemaVersion !== 1 || typeof input.sink !== 'string' ||
        !SINK_ORDER.includes(input.sink) ||
        typeof input.code !== 'string' || !FAILURE_CODES.has(input.code) ||
        typeof input.occurredAt !== 'string') {
        throw new TypeError('sink failure fields are invalid');
    }
    try {
        if (new Date(input.occurredAt).toISOString() !== input.occurredAt) {
            throw new TypeError('sink failure timestamp is invalid');
        }
    }
    catch {
        throw new TypeError('sink failure timestamp is invalid');
    }
    return Object.freeze({
        schemaVersion: 1,
        sink: input.sink,
        code: input.code,
        occurredAt: input.occurredAt
    });
}
export function observationPriorityFor(event) {
    if (event.type === 'terminal_snapshot' &&
        (event.value.status === 'failed' || event.value.status === 'cancelled')) {
        return 'reserved';
    }
    if (event.type === 'presentation' &&
        (event.value.postprocessAnomaly || event.value.outcome === 'partial' ||
            event.value.outcome === 'failed' || event.value.outcome === 'unknown')) {
        return 'reserved';
    }
    if (event.type === 'presentation' && event.value.profile === 'progress') {
        return 'progress_delivery';
    }
    if (event.type === 'terminal_snapshot' && event.value.status === 'completed') {
        return 'normal_success';
    }
    if (event.type === 'presentation' &&
        (event.value.outcome === 'complete' || event.value.outcome === 'skipped')) {
        return 'normal_success';
    }
    return 'normal';
}
export class ObservationHub {
    #sinks;
    #onSinkFailure;
    #now;
    #normalPending = [];
    #activeJobs = new Set();
    #normalInFlight = 0;
    #reservedInFlight = 0;
    #sequence = 0;
    constructor(options) {
        if (!Array.isArray(options.subscribers) || options.subscribers.length > 3) {
            throw new TypeError('observation subscriber set is invalid');
        }
        const byName = new Map();
        for (const subscriber of options.subscribers) {
            let name;
            let observe;
            try {
                name = subscriber.name;
                observe = subscriber.observe;
            }
            catch {
                throw new TypeError('observation subscriber set is invalid');
            }
            if (subscriber === null || typeof subscriber !== 'object' ||
                !SINK_ORDER.includes(name) || typeof observe !== 'function' || byName.has(name)) {
                throw new TypeError('observation subscriber set is invalid');
            }
            byName.set(name, Object.freeze({
                name,
                observe: (event, signal) => Reflect.apply(observe, subscriber, [event, signal])
            }));
        }
        this.#sinks = Object.freeze(SINK_ORDER.flatMap(name => {
            const subscriber = byName.get(name);
            return subscriber === undefined
                ? []
                : [{
                        subscriber,
                        quarantined: new Set(),
                        accepted: 0,
                        dropped: 0,
                        failed: 0
                    }];
        }));
        this.#onSinkFailure = options.onSinkFailure;
        this.#now = options.now ?? Date.now;
    }
    publish(value) {
        const event = parseObservationEvent(value);
        const priority = observationPriorityFor(event);
        const job = Object.freeze({
            sequence: this.#sequence,
            priority,
            event
        });
        this.#sequence += 1;
        if (priority === 'reserved') {
            if (this.#reservedInFlight === 1) {
                this.#dropJob(job, 'overflow');
                return 'dropped';
            }
            this.#startReserved(job);
            return 'accepted';
        }
        if (this.#normalInFlight < NORMAL_CONCURRENCY) {
            this.#startNormal(job);
            return 'accepted';
        }
        if (this.#normalPending.length < NORMAL_MAX_PENDING) {
            this.#normalPending.push(job);
            return 'accepted';
        }
        const rank = PRIORITY_RANK[priority];
        const evictable = this.#normalPending
            .filter(pending => PRIORITY_RANK[pending.priority] < rank)
            .sort((left, right) => left.sequence - right.sequence)[0];
        if (evictable === undefined) {
            this.#dropJob(job, 'overflow');
            return 'dropped';
        }
        const index = this.#normalPending.indexOf(evictable);
        this.#normalPending.splice(index, 1, job);
        this.#dropJob(evictable, 'overflow');
        return 'accepted';
    }
    async drain() {
        while (this.#normalInFlight > 0 || this.#reservedInFlight > 0 ||
            this.#normalPending.length > 0 || this.#activeJobs.size > 0) {
            const active = [...this.#activeJobs];
            if (active.length === 0)
                await Promise.resolve();
            else
                await Promise.all(active);
        }
    }
    snapshot() {
        return Object.freeze({
            schemaVersion: 1,
            normalInFlight: this.#normalInFlight,
            normalPending: this.#normalPending.length,
            reservedInFlight: this.#reservedInFlight,
            sinks: Object.freeze(this.#sinks.map(state => Object.freeze({
                name: state.subscriber.name,
                accepted: state.accepted,
                dropped: state.dropped,
                failed: state.failed,
                quarantined: state.quarantined.size
            })))
        });
    }
    #startNormal(job) {
        this.#normalInFlight += 1;
        let task;
        task = this.#fanOut(job).finally(() => {
            this.#normalInFlight -= 1;
            this.#activeJobs.delete(task);
            this.#startNextNormal();
        });
        this.#activeJobs.add(task);
    }
    #startReserved(job) {
        this.#reservedInFlight = 1;
        let task;
        task = this.#fanOut(job).finally(() => {
            this.#reservedInFlight = 0;
            this.#activeJobs.delete(task);
        });
        this.#activeJobs.add(task);
    }
    #startNextNormal() {
        if (this.#normalInFlight >= NORMAL_CONCURRENCY || this.#normalPending.length === 0)
            return;
        let selected = 0;
        for (let index = 1; index < this.#normalPending.length; index += 1) {
            const current = this.#normalPending[index];
            const winner = this.#normalPending[selected];
            const currentRank = PRIORITY_RANK[current.priority];
            const winnerRank = PRIORITY_RANK[winner.priority];
            if (currentRank > winnerRank ||
                (currentRank === winnerRank && current.sequence < winner.sequence)) {
                selected = index;
            }
        }
        const [next] = this.#normalPending.splice(selected, 1);
        this.#startNormal(next);
        this.#startNextNormal();
    }
    async #fanOut(job) {
        for (const state of this.#sinks) {
            await this.#invoke(state, job.event);
        }
    }
    async #invoke(state, event) {
        if (state.quarantined.size > 0) {
            state.dropped += 1;
            this.#reportFailure(state.subscriber.name, 'unavailable');
            return;
        }
        const controller = new AbortController();
        let settled = false;
        const call = Promise.resolve()
            .then(async () => {
            state.accepted += 1;
            await state.subscriber.observe(event, controller.signal);
        })
            .then(() => {
            settled = true;
            return 'fulfilled';
        })
            .catch(() => {
            settled = true;
            return 'rejected';
        });
        let timeout;
        const timed = new Promise(resolve => {
            timeout = setTimeout(() => resolve('timeout'), SUBSCRIBER_TIMEOUT_MS);
        });
        const outcome = await Promise.race([call, timed]);
        if (timeout !== undefined)
            clearTimeout(timeout);
        if (outcome === 'timeout') {
            controller.abort();
            state.failed += 1;
            this.#reportFailure(state.subscriber.name, 'timeout');
            if (!settled) {
                state.quarantined.add(call);
                void call.then(() => {
                    state.quarantined.delete(call);
                });
            }
            return;
        }
        if (outcome === 'rejected') {
            state.failed += 1;
            this.#reportFailure(state.subscriber.name, 'rejected');
        }
    }
    #dropJob(_job, code) {
        for (const state of this.#sinks) {
            state.dropped += 1;
            this.#reportFailure(state.subscriber.name, code);
        }
    }
    #reportFailure(sink, code) {
        if (this.#onSinkFailure === undefined)
            return;
        const failure = Object.freeze({
            schemaVersion: 1,
            sink,
            code,
            occurredAt: safeTimestamp(this.#now)
        });
        try {
            this.#onSinkFailure(failure);
        }
        catch {
            // Failure reporting is intentionally non-recursive and best-effort.
        }
    }
}

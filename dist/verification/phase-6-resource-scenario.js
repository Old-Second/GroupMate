import { createHash } from 'node:crypto';
import { AgentError, serializeAgentError } from '../agent/contracts/error.js';
import { ModelProviderError } from '../agent/model/model-adapter.js';
import { createDefaultRunBudget } from '../agent/run/run-budget.js';
import { createInitialRunCheckpoint, nextRunCheckpoint } from '../agent/run/run-checkpoint.js';
import { createRunEvent } from '../agent/run/run-events.js';
import { RUN_RESOURCE_LIMITS } from '../agent/run/run-limits.js';
import { RUN_STORE_LUA_MARKER, RUN_STORE_METADATA_KEY, RUN_STORE_NAMESPACE } from '../agent/run/redis-run-store.js';
import { createFrozenObservationPolicy, createRunTerminalSnapshot } from '../agent/run/run-observation.js';
import { createTraceCandidate } from '../agent/run/run-trace.js';
import { createProductionYunzaiAgent } from '../runtime/production-yunzai-agent.js';
import { TRACE_BYTES_KEY, TRACE_FAILURE_INDEX_KEY, TRACE_GENERATION_KEY, TRACE_KEY_PREFIX, TRACE_STORE_LUA_MARKER, TRACE_SUCCESS_INDEX_KEY } from '../runtime/observability/redis-trace-store.js';
export const PHASE_6_RESOURCE_SCENARIOS = Object.freeze([
    'idle',
    'singleTextRun',
    'dualTextRun',
    'alreadyVisible',
    'checkpointResume',
    'traceBasic',
    'traceDiagnostic',
    'pictureSuccess',
    'pictureFailure'
]);
export const PHASE_6_RESOURCE_OUTCOMES = Object.freeze({
    idle: 'idle',
    singleTextRun: 'completed',
    dualTextRun: 'completed',
    alreadyVisible: 'visible_output',
    checkpointResume: 'resumed',
    traceBasic: 'trace_retained',
    traceDiagnostic: 'trace_retained',
    pictureSuccess: 'picture_success',
    pictureFailure: 'picture_failure'
});
export const PHASE_6_REDIS_RESOURCE_KINDS = Object.freeze([
    'run_checkpoint',
    'run_event',
    'run_tombstone',
    'run_reference',
    'run_index',
    'run_metadata',
    'trace_record',
    'trace_success_index',
    'trace_failure_index',
    'trace_metadata'
]);
function utf8Bytes(value) {
    return value === null || value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
}
function emptyRunUsage() {
    return {
        bytes: 0,
        checkpoints: 0,
        events: 0,
        tombstones: 0,
        indexes: 0,
        references: 0,
        tombstoneBytes: 0
    };
}
/**
 * This fake executes only the two checked production Lua protocols. Direct
 * GET/SET support is shared by the real session and tool idempotency adapters.
 */
class Phase6ResourceRedis {
    #entries = new Map();
    #sortedSets = new Map();
    #traceLengths = new Map();
    #now;
    constructor(now) {
        this.#now = now;
    }
    async get(key) {
        this.#purge(key);
        return this.#entries.get(key)?.value ?? null;
    }
    async set(key, value, options) {
        this.#purge(key);
        if (options?.NX === true && this.#entries.has(key))
            return null;
        if (options?.XX === true && !this.#entries.has(key))
            return null;
        this.#entries.set(key, {
            value,
            ...(options?.EX === undefined
                ? {}
                : { expiresAtMs: this.#now() + options.EX * 1_000 })
        });
        return 'OK';
    }
    async getDel(key) {
        const value = await this.get(key);
        this.#entries.delete(key);
        return value;
    }
    async del(key) {
        const keys = typeof key === 'string' ? [key] : key;
        let removed = 0;
        for (const item of keys) {
            this.#purge(item);
            if (this.#entries.delete(item))
                removed += 1;
        }
        return removed;
    }
    async ttl(key) {
        this.#purge(key);
        const entry = this.#entries.get(key);
        if (entry === undefined)
            return -2;
        if (entry.expiresAtMs === undefined)
            return -1;
        return Math.floor((entry.expiresAtMs - this.#now()) / 1_000);
    }
    async scan(cursor, options) {
        this.#purgeAll();
        const prefix = options.MATCH.endsWith('*')
            ? options.MATCH.slice(0, -1)
            : options.MATCH;
        const keys = [...this.#entries.keys()]
            .filter(key => options.MATCH.endsWith('*') ? key.startsWith(prefix) : key === prefix)
            .sort();
        const page = keys.slice(cursor, cursor + options.COUNT);
        return {
            cursor: cursor + options.COUNT >= keys.length ? 0 : cursor + options.COUNT,
            keys: page
        };
    }
    async eval(script, options) {
        this.#purgeAll();
        const marker = script.split('\n', 1)[0];
        const operation = options.arguments[0] ?? '';
        if (marker === TRACE_STORE_LUA_MARKER) {
            return this.#evalTrace(operation, options.keys, options.arguments);
        }
        if (marker !== RUN_STORE_LUA_MARKER)
            throw new TypeError('unsupported Lua protocol');
        return this.#evalRun(operation, options.keys, options.arguments);
    }
    resourceUsage() {
        this.#purgeAll();
        const valueKind = (kind, predicate, includeKey = false) => {
            const values = [...this.#entries.entries()].filter(([key]) => predicate(key));
            return Object.freeze({
                kind,
                records: values.length,
                bytes: values.reduce((total, [key, entry]) => (total + utf8Bytes(entry.value) + (includeKey ? utf8Bytes(key) : 0)), 0)
            });
        };
        const indexKind = (kind, key) => {
            const members = [...(this.#sortedSets.get(key)?.keys() ?? [])];
            return Object.freeze({
                kind,
                records: members.length,
                bytes: members.reduce((total, member) => total + utf8Bytes(member), 0)
            });
        };
        const runMetadataExists = this.#entries.has(RUN_STORE_METADATA_KEY);
        const traceMetadataKeys = [TRACE_BYTES_KEY, TRACE_GENERATION_KEY]
            .filter(key => this.#entries.has(key));
        return Object.freeze([
            valueKind('run_checkpoint', key => key.startsWith(`${RUN_STORE_NAMESPACE}checkpoint:`)),
            valueKind('run_event', key => key.startsWith(`${RUN_STORE_NAMESPACE}events:`)),
            valueKind('run_tombstone', key => key.startsWith(`${RUN_STORE_NAMESPACE}tombstone:`)),
            valueKind('run_reference', key => key.startsWith(`${RUN_STORE_NAMESPACE}reference:`), true),
            valueKind('run_index', key => key.startsWith(RUN_STORE_NAMESPACE) &&
                key !== RUN_STORE_METADATA_KEY &&
                !key.startsWith(`${RUN_STORE_NAMESPACE}checkpoint:`) &&
                !key.startsWith(`${RUN_STORE_NAMESPACE}events:`) &&
                !key.startsWith(`${RUN_STORE_NAMESPACE}tombstone:`) &&
                !key.startsWith(`${RUN_STORE_NAMESPACE}reference:`)),
            Object.freeze({
                kind: 'run_metadata',
                records: runMetadataExists ? 1 : 0,
                // The RunStore 8 MiB metadata value is an accounting source, not part
                // of the value-payload budget it records.
                bytes: 0
            }),
            valueKind('trace_record', key => key.startsWith(TRACE_KEY_PREFIX), true),
            indexKind('trace_success_index', TRACE_SUCCESS_INDEX_KEY),
            indexKind('trace_failure_index', TRACE_FAILURE_INDEX_KEY),
            Object.freeze({
                kind: 'trace_metadata',
                records: traceMetadataKeys.length,
                bytes: this.#traceMetadataPayloadBytes()
            })
        ]);
    }
    #evalRun(operation, keys, args) {
        const [checkpointKey, eventKey, tombstoneKey, referenceKey] = keys;
        if (operation === 'load') {
            return [
                checkpointKey === undefined ? false : this.#value(checkpointKey) ?? false,
                eventKey === undefined ? false : this.#value(eventKey) ?? false
            ];
        }
        if (operation === 'reconcile') {
            const metadataKey = keys[0];
            if (metadataKey !== RUN_STORE_METADATA_KEY ||
                (this.#value(metadataKey) ?? '') !== args[1] || args[2] === undefined) {
                return 'conflict';
            }
            this.#entries.set(metadataKey, { value: args[2] });
            return 'ok';
        }
        const metadataKey = keys.at(-1);
        if (operation === 'tombstone_delete_corrupt') {
            const key = keys[0];
            const current = this.#value(key);
            if (current === null) {
                if (metadataKey !== undefined)
                    this.#entries.delete(metadataKey);
                return 'missing';
            }
            if (current !== args[1]) {
                if (metadataKey !== undefined)
                    this.#entries.delete(metadataKey);
                return 'conflict';
            }
            if (key !== undefined)
                this.#entries.delete(key);
            if (metadataKey !== undefined)
                this.#entries.delete(metadataKey);
            return 'ok';
        }
        const usage = this.#parseRunUsage(this.#value(metadataKey));
        if (metadataKey !== RUN_STORE_METADATA_KEY || usage === null)
            return 'reconcile';
        if (operation === 'create') {
            if ([checkpointKey, eventKey, tombstoneKey].some(key => (key !== undefined && this.#entries.has(key))))
                return 'conflict';
            if (referenceKey !== undefined && this.#entries.has(referenceKey)) {
                return 'reference_conflict';
            }
            const projected = {
                ...usage,
                bytes: usage.bytes + utf8Bytes(args[1]) + utf8Bytes(args[2]) +
                    utf8Bytes(referenceKey) + utf8Bytes(args[4]),
                checkpoints: usage.checkpoints + 1,
                events: usage.events + 1,
                references: usage.references + 1
            };
            if (this.#runBudgetExceeded(projected))
                return 'budget';
            this.#setDirect(checkpointKey, args[1], Number(args[3]));
            this.#setDirect(eventKey, args[2], Number(args[3]));
            this.#setDirect(referenceKey, args[4], Number(args[3]));
            this.#saveRunUsage(metadataKey, projected);
            return 'ok';
        }
        if (operation === 'upgrade' || operation === 'cas') {
            const expectedCheckpoint = args[1];
            const expectedEvents = args[2];
            const replacementCheckpoint = args[3];
            const replacementEvents = args[4];
            const ttlSeconds = Number(args[5]);
            const referenceValue = args[6];
            if (this.#value(checkpointKey) !== expectedCheckpoint ||
                this.#value(eventKey) !== expectedEvents ||
                (operation === 'upgrade'
                    ? tombstoneKey !== undefined && this.#entries.has(tombstoneKey)
                    : this.#value(referenceKey) !== referenceValue))
                return 'conflict';
            if (operation === 'upgrade' && referenceKey !== undefined && this.#entries.has(referenceKey)) {
                return 'reference_conflict';
            }
            const projected = {
                ...usage,
                bytes: usage.bytes - utf8Bytes(expectedCheckpoint) - utf8Bytes(expectedEvents) +
                    utf8Bytes(replacementCheckpoint) + utf8Bytes(replacementEvents) +
                    (operation === 'upgrade' ? utf8Bytes(referenceKey) + utf8Bytes(referenceValue) : 0),
                references: usage.references + (operation === 'upgrade' ? 1 : 0)
            };
            if (this.#runBudgetExceeded(projected))
                return 'budget';
            this.#setDirect(checkpointKey, replacementCheckpoint, ttlSeconds);
            this.#setDirect(eventKey, replacementEvents, ttlSeconds);
            this.#setDirect(referenceKey, referenceValue, ttlSeconds);
            this.#saveRunUsage(metadataKey, projected);
            return 'ok';
        }
        if (operation === 'commit_terminal') {
            const oldCheckpoint = this.#value(checkpointKey);
            const oldEvents = this.#value(eventKey);
            if (oldCheckpoint !== args[1] || oldEvents !== args[2] ||
                tombstoneKey === undefined || this.#entries.has(tombstoneKey) ||
                this.#value(referenceKey) !== args[5])
                return 'conflict';
            const projected = {
                ...usage,
                bytes: usage.bytes - utf8Bytes(oldCheckpoint) - utf8Bytes(oldEvents) + utf8Bytes(args[3]),
                checkpoints: usage.checkpoints - 1,
                events: usage.events - 1,
                tombstones: usage.tombstones + 1,
                tombstoneBytes: usage.tombstoneBytes + utf8Bytes(args[3])
            };
            if (this.#runBudgetExceeded(projected))
                return 'budget';
            let deleted = 0;
            if (checkpointKey !== undefined && this.#entries.delete(checkpointKey))
                deleted += 1;
            if (eventKey !== undefined && this.#entries.delete(eventKey))
                deleted += 1;
            this.#setDirect(tombstoneKey, args[3], Number(args[4]));
            this.#setDirect(referenceKey, args[5], Number(args[4]));
            this.#saveRunUsage(metadataKey, projected);
            return [
                'ok', deleted, 1, utf8Bytes(oldCheckpoint), utf8Bytes(oldEvents), utf8Bytes(args[3])
            ];
        }
        if (operation === 'admission_acquire' || operation === 'approval_index_create') {
            const key = keys[0];
            if (key === undefined || this.#entries.has(key))
                return 'conflict';
            const projected = {
                ...usage,
                bytes: usage.bytes + utf8Bytes(args[1]),
                indexes: usage.indexes + 1
            };
            if (this.#runBudgetExceeded(projected))
                return 'budget';
            this.#setDirect(key, args[1], Number(args[2]));
            this.#saveRunUsage(metadataKey, projected);
            return 'ok';
        }
        if (operation === 'admission_recover') {
            const key = keys[0];
            const current = this.#value(key) ?? '';
            if (key === undefined || current !== args[1])
                return 'conflict';
            const projected = {
                ...usage,
                bytes: usage.bytes - utf8Bytes(current) + utf8Bytes(args[2]),
                indexes: usage.indexes + (current === '' ? 1 : 0)
            };
            if (this.#runBudgetExceeded(projected))
                return 'budget';
            this.#setDirect(key, args[2], Number(args[3]));
            this.#saveRunUsage(metadataKey, projected);
            return 'ok';
        }
        if (operation === 'admission_release' || operation === 'approval_index_delete') {
            const key = keys[0];
            const current = this.#value(key);
            if (key === undefined || current !== args[1])
                return 'conflict';
            const projected = {
                ...usage,
                bytes: usage.bytes - utf8Bytes(current),
                indexes: usage.indexes - 1
            };
            this.#entries.delete(key);
            this.#saveRunUsage(metadataKey, projected);
            return 'ok';
        }
        return 'invalid_operation';
    }
    #evalTrace(operation, keys, args) {
        const traceKey = keys[0];
        if (keys[1] !== TRACE_SUCCESS_INDEX_KEY || keys[2] !== TRACE_FAILURE_INDEX_KEY ||
            keys[3] !== TRACE_BYTES_KEY || keys[4] !== TRACE_GENERATION_KEY) {
            throw new TypeError('invalid trace protocol keys');
        }
        if (operation === 'upsert' || operation === 'append') {
            const generation = Number(this.#value(TRACE_GENERATION_KEY) ?? '0');
            if (Number(args[1]) !== generation)
                return ['stale_generation', String(generation)];
            this.#cleanupTrace(Number(args[2]));
            if (traceKey === undefined)
                throw new TypeError('trace key is invalid');
            if (operation === 'upsert') {
                const raw = args[3];
                const expiresAtMs = Number(args[4]);
                if (raw === undefined)
                    throw new TypeError('trace value is invalid');
                const existing = this.#value(traceKey);
                if (existing !== null)
                    return [existing === raw ? 'unchanged' : 'conflict', String(generation)];
                const length = utf8Bytes(raw) + 2 * utf8Bytes(traceKey);
                if (!this.#ensureTraceCapacity(traceKey, 0, length, 1)) {
                    return ['capacity', String(generation)];
                }
                this.#entries.set(traceKey, { value: raw, expiresAtMs });
                this.#traceLengths.set(traceKey, length);
                this.#zadd(args[5] === 'failure' ? TRACE_FAILURE_INDEX_KEY : TRACE_SUCCESS_INDEX_KEY, traceKey, expiresAtMs);
                this.#saveTraceBytes();
                return ['stored', String(generation)];
            }
            const expected = args[3];
            const replacement = args[4];
            if (expected === undefined || replacement === undefined) {
                throw new TypeError('trace append value is invalid');
            }
            const current = this.#value(traceKey);
            if (current === null)
                return ['not_found', String(generation)];
            if (current !== expected)
                return ['conflict', String(generation)];
            if (current === replacement)
                return ['unchanged', String(generation)];
            const oldLength = this.#traceLengths.get(traceKey) ??
                utf8Bytes(current) + 2 * utf8Bytes(traceKey);
            const newLength = utf8Bytes(replacement) + 2 * utf8Bytes(traceKey);
            const delta = newLength - oldLength;
            if (delta > 0 && !this.#ensureTraceCapacity(traceKey, oldLength, newLength, 0, traceKey)) {
                return ['capacity', String(generation)];
            }
            this.#entries.set(traceKey, { value: replacement, expiresAtMs: Number(args[5]) });
            this.#traceLengths.set(traceKey, newLength);
            if (args[6] === 'failure') {
                this.#zrem(TRACE_SUCCESS_INDEX_KEY, traceKey);
                this.#zadd(TRACE_FAILURE_INDEX_KEY, traceKey, Number(args[5]));
            }
            this.#saveTraceBytes();
            return ['stored', String(generation)];
        }
        if (operation === 'delete_corrupt') {
            if (traceKey !== undefined && this.#value(traceKey) === args[1])
                this.#removeTrace(traceKey);
            this.#saveTraceBytes();
            return 'ok';
        }
        if (operation === 'missing_state') {
            if (traceKey === undefined)
                throw new TypeError('trace key is invalid');
            const score = this.#sortedSets.get(TRACE_SUCCESS_INDEX_KEY)?.get(traceKey) ??
                this.#sortedSets.get(TRACE_FAILURE_INDEX_KEY)?.get(traceKey);
            if (score !== undefined && score <= Number(args[1])) {
                this.#removeTrace(traceKey);
                this.#saveTraceBytes();
                return 'expired';
            }
            return 'not_retained';
        }
        if (operation === 'list') {
            this.#cleanupTrace(Number(args[1]));
            const limit = Number(args[2]);
            return [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]
                .flatMap(index => this.#zrange(index, true).slice(0, limit))
                .flatMap(key => {
                const raw = this.#value(key);
                return raw === null ? [] : [key, raw];
            });
        }
        if (operation === 'usage') {
            this.#cleanupTrace(Number(args[1]));
            const usage = this.#traceUsage();
            return [usage.records, usage.bytes];
        }
        if (operation === 'clear')
            return this.#clearTrace(Number(args[1]));
        if (operation === 'advance_clear') {
            const generation = Number(this.#value(TRACE_GENERATION_KEY) ?? '0') + 1;
            this.#entries.set(TRACE_GENERATION_KEY, { value: String(generation) });
            return [generation, ...this.#clearTrace(Number(args[1]))];
        }
        return 'invalid_operation';
    }
    #parseRunUsage(raw) {
        if (raw === null || !/^\d+\|\d+\|\d+\|\d+\|\d+\|\d+\|\d+$/.test(raw))
            return null;
        const values = raw.split('|').map(Number);
        if (values.length !== 7 || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
            return null;
        }
        return {
            bytes: values[0],
            checkpoints: values[1],
            events: values[2],
            tombstones: values[3],
            indexes: values[4],
            references: values[5],
            tombstoneBytes: values[6]
        };
    }
    #saveRunUsage(key, usage) {
        if (key !== RUN_STORE_METADATA_KEY)
            throw new TypeError('run metadata key is invalid');
        this.#entries.set(key, { value: [
                usage.bytes,
                usage.checkpoints,
                usage.events,
                usage.tombstones,
                usage.indexes,
                usage.references,
                usage.tombstoneBytes
            ].join('|') });
    }
    #runBudgetExceeded(usage) {
        if (Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0))
            return true;
        return usage.bytes > RUN_RESOURCE_LIMITS.namespaceBytes ||
            usage.checkpoints > RUN_RESOURCE_LIMITS.checkpointKeys ||
            usage.events > RUN_RESOURCE_LIMITS.eventKeys ||
            usage.tombstones > RUN_RESOURCE_LIMITS.tombstoneKeys ||
            usage.indexes > RUN_RESOURCE_LIMITS.indexAdmissionKeys ||
            usage.references > RUN_RESOURCE_LIMITS.referenceKeys;
    }
    #value(key) {
        return key === undefined ? null : this.#entries.get(key)?.value ?? null;
    }
    #setDirect(key, value, ttlSeconds) {
        if (key === undefined || value === undefined || !Number.isSafeInteger(ttlSeconds) ||
            ttlSeconds <= 0)
            throw new TypeError('invalid Lua SET arguments');
        this.#entries.set(key, { value, expiresAtMs: this.#now() + ttlSeconds * 1_000 });
    }
    #traceUsage() {
        const keys = new Set([
            ...this.#zrange(TRACE_SUCCESS_INDEX_KEY),
            ...this.#zrange(TRACE_FAILURE_INDEX_KEY)
        ]);
        return {
            records: keys.size,
            bytes: this.#traceNamespaceBytes()
        };
    }
    #ensureTraceCapacity(key, oldLength, newLength, addedRecords, skip) {
        let usage = this.#traceUsage();
        let guard = 64;
        while ((usage.records + addedRecords > 64 ||
            this.#projectedTraceBytes(key, oldLength, newLength) > 2 * 1024 * 1024) && guard > 0) {
            const victim = [
                ...this.#zrange(TRACE_SUCCESS_INDEX_KEY),
                ...this.#zrange(TRACE_FAILURE_INDEX_KEY)
            ].find(key => key !== skip);
            if (victim === undefined)
                return false;
            this.#removeTrace(victim);
            usage = this.#traceUsage();
            guard -= 1;
        }
        return usage.records + addedRecords <= 64 &&
            this.#projectedTraceBytes(key, oldLength, newLength) <= 2 * 1024 * 1024;
    }
    #projectedTraceBytes(key, oldLength, newLength) {
        const dataBytes = Math.max(0, this.#traceDataBytes() - oldLength + newLength);
        let metadataBytes = this.#traceEntryMetadataBytes();
        if (oldLength > 0)
            metadataBytes -= utf8Bytes(key) + utf8Bytes(String(oldLength));
        if (newLength > 0)
            metadataBytes += utf8Bytes(key) + utf8Bytes(String(newLength));
        return dataBytes + Math.max(0, metadataBytes) + this.#traceCounterMetadataBytes(dataBytes) +
            this.#traceGenerationMetadataBytes();
    }
    #traceNamespaceBytes() {
        const dataBytes = this.#traceDataBytes();
        return dataBytes + this.#traceMetadataPayloadBytes();
    }
    #traceMetadataPayloadBytes() {
        const dataBytes = this.#traceDataBytes();
        return this.#traceEntryMetadataBytes() + this.#traceCounterMetadataBytes(dataBytes) +
            this.#traceGenerationMetadataBytes();
    }
    #traceDataBytes() {
        return [...this.#traceLengths.values()].reduce((total, value) => total + value, 0);
    }
    #traceEntryMetadataBytes() {
        return [...this.#traceLengths.entries()].reduce((total, [key, length]) => (total + utf8Bytes(key) + utf8Bytes(String(length))), 0);
    }
    #traceCounterMetadataBytes(dataBytes) {
        return dataBytes === 0 ? 0 : utf8Bytes('__total') + utf8Bytes(String(dataBytes));
    }
    #traceGenerationMetadataBytes() {
        return utf8Bytes(this.#entries.get(TRACE_GENERATION_KEY)?.value);
    }
    #cleanupTrace(nowMs) {
        let remaining = 64;
        for (const index of [TRACE_SUCCESS_INDEX_KEY, TRACE_FAILURE_INDEX_KEY]) {
            for (const key of this.#zrange(index)) {
                if (remaining <= 0)
                    break;
                const score = this.#sortedSets.get(index)?.get(key);
                if (score === undefined || score > nowMs)
                    break;
                this.#removeTrace(key);
                remaining -= 1;
            }
        }
        this.#saveTraceBytes();
    }
    #clearTrace(limit) {
        const before = this.#traceUsage();
        const keys = [
            ...this.#zrange(TRACE_SUCCESS_INDEX_KEY),
            ...this.#zrange(TRACE_FAILURE_INDEX_KEY)
        ].slice(0, limit);
        for (const key of keys)
            this.#removeTrace(key);
        const after = this.#traceUsage();
        this.#saveTraceBytes();
        return [keys.length, before.bytes - after.bytes, after.records, after.bytes];
    }
    #saveTraceBytes() {
        const bytes = this.#traceDataBytes();
        if (bytes === 0)
            this.#entries.delete(TRACE_BYTES_KEY);
        else
            this.#entries.set(TRACE_BYTES_KEY, { value: String(bytes) });
    }
    #removeTrace(key) {
        this.#entries.delete(key);
        this.#traceLengths.delete(key);
        this.#zrem(TRACE_SUCCESS_INDEX_KEY, key);
        this.#zrem(TRACE_FAILURE_INDEX_KEY, key);
    }
    #zadd(index, member, score) {
        const values = this.#sortedSets.get(index) ?? new Map();
        values.set(member, score);
        this.#sortedSets.set(index, values);
    }
    #zrem(index, member) {
        this.#sortedSets.get(index)?.delete(member);
    }
    #zrange(index, reverse = false) {
        return [...(this.#sortedSets.get(index)?.entries() ?? [])]
            .sort((left, right) => {
            const score = left[1] - right[1];
            if (score !== 0)
                return reverse ? -score : score;
            const lexical = left[0].localeCompare(right[0]);
            return reverse ? -lexical : lexical;
        })
            .map(([member]) => member);
    }
    #purge(key) {
        const expiry = this.#entries.get(key)?.expiresAtMs;
        if (expiry !== undefined && expiry <= this.#now())
            this.#entries.delete(key);
    }
    #purgeAll() {
        for (const key of this.#entries.keys())
            this.#purge(key);
    }
}
const CREATED_AT = '2026-07-17T00:00:00.000Z';
const CREATED_AT_MS = Date.parse(CREATED_AT);
const EMPTY_FINGERPRINT = createHash('sha256').update('[]').digest('hex');
function traceEvent(runId, sessionId, sequence, type, occurredAt) {
    return createRunEvent({
        eventId: `phase6-resource-event-${sequence}`,
        runId,
        sessionId,
        sequence,
        occurredAt,
        type,
        payload: Object.freeze({})
    });
}
export function createPhase6SmallTraceCandidate(seed, status = 'completed', finishedAtMs = CREATED_AT_MS) {
    if (!Number.isSafeInteger(finishedAtMs) || finishedAtMs < 0) {
        throw new TypeError('trace fixture time is invalid');
    }
    const finishedAt = new Date(finishedAtMs).toISOString();
    const deadlineAt = new Date(finishedAtMs + 4 * 60 * 1_000).toISOString();
    const runRef = createHash('sha256').update(`phase6-resource-trace:${seed}`).digest('hex').slice(0, 32);
    const runId = `phase6-resource-run-${seed}`;
    const sessionId = `phase6-resource-session-${seed}`;
    const budget = createDefaultRunBudget({ providerTimeoutMs: 120_000, outputTokens: 64 });
    const policy = createFrozenObservationPolicy({ levelAtStart: 'diagnostic', runRef });
    const initial = createInitialRunCheckpoint({
        profileId: 'standard',
        profileVersion: 1,
        runId,
        sessionId,
        sessionAddress: Object.freeze({
            botId: 'phase6-resource-bot',
            scope: Object.freeze({ kind: 'private', userId: `phase6-resource-user-${seed}` })
        }),
        runRef,
        requestRef: createHash('sha256').update(`phase6-resource-request:${seed}`).digest('hex').slice(0, 32),
        requestKind: 'ordinary_chat',
        presentationRoute: Object.freeze({
            schemaVersion: 1,
            requestKind: 'ordinary_chat',
            profile: 'ordinary',
            presentationIntent: Object.freeze({
                schemaVersion: 1,
                kind: 'ordinary',
                forcePicture: false
            }),
            sessionAddress: Object.freeze({
                botId: 'phase6-resource-bot',
                scope: Object.freeze({ kind: 'private', userId: `phase6-resource-user-${seed}` })
            }),
            actorId: `phase6-resource-user-${seed}`
        }),
        observationPolicy: policy,
        model: Object.freeze({
            model: 'fixture-model', streaming: false, maxOutputTokens: 64,
            reasoning: Object.freeze({ enabled: false })
        }),
        toolSnapshot: Object.freeze({
            id: 'phase6-resource-snapshot', fingerprint: EMPTY_FINGERPRINT, manifest: Object.freeze([])
        }),
        budgetLimits: budget.limits,
        budgetCounters: budget.initialCounters,
        deadlineAt,
        createdAt: finishedAt,
        event: traceEvent(runId, sessionId, 0, 'run.created', finishedAt)
    });
    const preparing = nextRunCheckpoint(initial, 'preparing', {}, [], finishedAt);
    const calling = nextRunCheckpoint(preparing, 'calling_model', {}, [], finishedAt);
    let terminal;
    if (status === 'completed') {
        const output = Object.freeze({
            id: `phase6-resource-output-${seed}`,
            role: 'assistant',
            parts: Object.freeze([{ type: 'text', text: 'fixture' }]),
            createdAt: finishedAt,
            provenance: Object.freeze({
                source: 'model',
                trust: 'untrusted',
                sensitivity: 'group',
                sourceId: runId,
                createdAt: finishedAt
            })
        });
        terminal = nextRunCheckpoint(calling, 'completed', {
            output,
            completion: Object.freeze({ kind: 'reply_text', text: 'fixture' })
        }, [traceEvent(runId, sessionId, calling.nextEventSequence, 'run.completed', finishedAt)], finishedAt);
    }
    else {
        terminal = nextRunCheckpoint(calling, 'failed', {
            error: serializeAgentError(new AgentError({
                code: 'provider_unavailable',
                stage: 'model.response',
                retryable: false,
                userMessage: 'fixture'
            }))
        }, [traceEvent(runId, sessionId, calling.nextEventSequence, 'run.failed', finishedAt)], finishedAt);
    }
    return createTraceCandidate({ checkpoint: terminal, snapshot: createRunTerminalSnapshot(terminal) });
}
const settings = Object.freeze({
    schemaVersion: 1,
    quoteReply: true,
    enableRobotAt: false,
    enableMarkdown: false,
    enableSuggestedResponses: false,
    forwardReasoning: false,
    blockWords: Object.freeze([]),
    promptBlockWords: Object.freeze([]),
    tts: Object.freeze({
        enabled: false,
        mode: 'vits-uma-genshin-honkai',
        activeVoice: 'fixture',
        alsoSendText: false,
        autoFallbackThreshold: 299,
        filter: null,
        azureEmotionEnabled: false
    }),
    picture: Object.freeze({
        userEnabled: false,
        autoEnabled: false,
        autoThreshold: 1_200,
        deviceScaleFactor: 1,
        closeBrowserAfterRender: true,
        showQRCode: false,
        live2d: null
    })
});
const pictureSettings = Object.freeze({
    ...settings,
    picture: Object.freeze({ ...settings.picture, userEnabled: true })
});
const disabledBymPolicy = Object.freeze({
    enabled: false,
    assistantLabel: 'GroupMate',
    recognizeLeadingAlias: true,
    ratePercent: 0,
    disabledGroupIds: Object.freeze([]),
    thinkingMode: 'default',
    reasoningEffort: 'default',
    preset: '',
    retaliationWords: Object.freeze([]),
    retaliationBlacklistActorIds: Object.freeze([]),
    retaliationPrompt: '',
    retaliationRecallEnabled: false,
    retaliationRecallSeconds: 100
});
function hostFixture() {
    const visibleMessages = [];
    const members = new Map([
        ['phase6-resource-bot', Object.freeze({
                user_id: 'phase6-resource-bot', role: 'owner', nickname: 'GroupMate'
            })],
        ['7', Object.freeze({ user_id: '7', role: 'owner', nickname: 'owner' })],
        ['8', Object.freeze({ user_id: '8', role: 'member', nickname: 'member' })]
    ]);
    const group = Object.freeze({
        getMemberMap: async () => members,
        sendMsg: async (message) => {
            visibleMessages.push(message);
            return Object.freeze({ message_id: `visible-${visibleMessages.length}` });
        },
        recallMsg: async () => true,
        muteMember: async () => undefined,
        kickMember: async () => undefined,
        setCard: async () => undefined,
        setTitle: async () => undefined
    });
    const friend = Object.freeze({
        sendMsg: async (message) => {
            visibleMessages.push(message);
            return Object.freeze({ message_id: `visible-${visibleMessages.length}` });
        },
        recallMsg: async () => true
    });
    const bot = Object.freeze({
        uin: 'phase6-resource-bot',
        pickGroup: () => group,
        pickFriend: () => friend,
        getFriendList: async () => Object.freeze(['7'])
    });
    return { bot, group, visibleMessages };
}
function groupEvent(actorId, marker, host, input = {}) {
    const prefix = input.picture === true ? '#图片chat1 ' : '#chat1 ';
    const msg = input.rawMessage ?? `${prefix}${marker}`;
    return {
        isGroup: true,
        group_id: input.groupId ?? `group-${actorId}`,
        self_id: 'phase6-resource-bot',
        user_id: actorId,
        message_id: input.messageId ?? `message-${actorId}-${marker}`,
        msg,
        message: input.message ?? Object.freeze([{ type: 'text', text: msg }]),
        sender: Object.freeze({
            user_id: actorId,
            role: input.owner === true ? 'owner' : 'member',
            nickname: actorId
        }),
        bot: host.bot,
        group: host.group,
        ...(input.owner === true ? { isMaster: true, atme: true } : {}),
        ...(input.sourceMessageId === undefined
            ? {}
            : { source: Object.freeze({ message_id: input.sourceMessageId }) })
    };
}
function textTurn(text = 'fixture response') {
    return Object.freeze({ text, toolCalls: Object.freeze([]), finishReason: 'stop' });
}
function toolTurn(callId, name, args) {
    return Object.freeze({
        text: '',
        toolCalls: Object.freeze([Object.freeze({
                index: 0,
                callId,
                name,
                argumentsText: JSON.stringify(args),
                arguments: Object.freeze({ ...args })
            })]),
        finishReason: 'tool_calls'
    });
}
class ScenarioModel {
    #scenario;
    #dualWaiters = [];
    #dualArrived = 0;
    constructor(scenario) {
        this.#scenario = scenario;
    }
    async complete(request) {
        if (this.#scenario === 'traceBasic') {
            throw new ModelProviderError({
                code: 'provider_unavailable',
                stage: 'fixture.provider',
                retryable: false,
                userMessage: 'fixture unavailable'
            });
        }
        if (this.#scenario === 'dualTextRun') {
            this.#dualArrived += 1;
            if (this.#dualArrived < 2) {
                await new Promise(resolve => { this.#dualWaiters.push(resolve); });
            }
            else {
                for (const resolve of this.#dualWaiters.splice(0))
                    resolve();
            }
        }
        if (this.#scenario === 'alreadyVisible') {
            return toolTurn('phase6-resource-dice', 'sendDice', { count: 1 });
        }
        return textTurn();
    }
    async generate() {
        return Object.freeze([]);
    }
}
class ApprovalScenarioModel {
    async complete(request) {
        return request.messages.some(message => message.role === 'tool')
            ? textTurn('resumed fixture')
            : toolTurn('phase6-resource-approval', 'jinyan', { userId: '8', seconds: 60 });
    }
    async generate() {
        return Object.freeze([]);
    }
}
function graphFixture(input) {
    const dispatches = [];
    let monotonic = 0;
    const botPicker = Object.freeze({ pick: async () => input.host.bot });
    const png = Object.freeze({
        kind: 'buffer',
        data: new Uint8Array([137, 80, 78, 71]),
        mimeType: 'image/png',
        byteLength: 4
    });
    const options = {
        bridge: {
            config: Object.freeze({
                openAiCompatibilityProfile: 'standard',
                model: 'fixture-model',
                toolPolicyProfile: input.scenario === 'checkpointResume' ? 'safe' : 'compatible',
                toolApprovalTtlSeconds: 120,
                observabilityLevel: input.observabilityLevel
            }),
            redis: input.redis,
            getMasterIds: async () => Object.freeze(['7']),
            getBotId: () => 'phase6-resource-bot',
            segment: () => Object.freeze({}),
            botPicker
        },
        botPicker,
        outboundHost: Object.freeze({
            async forTarget(target) {
                return Object.freeze({
                    async dispatch(part) {
                        const messageId = `delivery-${dispatches.length + 1}`;
                        dispatches.push(Object.freeze({ target, part, messageId }));
                        return Object.freeze({ message_id: messageId });
                    },
                    async recall() { return true; }
                });
            }
        }),
        presentationSettings: Object.freeze({
            load: async () => input.scenario === 'pictureSuccess' || input.scenario === 'pictureFailure'
                ? pictureSettings
                : settings
        }),
        pendingConfig: Object.freeze({
            getEnabled: async () => false,
            setEnabled: async () => undefined
        }),
        hooks: Object.freeze({
            forActiveEvent: () => Object.freeze({
                postprocess: async ({ text }) => Object.freeze({ text }),
                convertText: async ({ text }) => Object.freeze([
                    { kind: 'text', text }
                ]),
                notifyResponsePost: () => undefined
            })
        }),
        chatPolicy: Object.freeze({
            entryMode: () => 'prefix',
            snapshot: async () => Object.freeze({
                toggleMode: 'prefix',
                enablePrivateChat: true,
                whitelist: Object.freeze([]),
                blacklist: Object.freeze([]),
                imgOcr: false,
                groupMerge: false,
                enableGroupContext: false,
                thinkingMode: 'default',
                reasoningEffort: 'default',
                assistantLabel: 'GroupMate',
                promptPrefixOverride: '',
                actorCastApi: ''
            }),
            isMuted: async () => false,
            ocrText: async () => Object.freeze([]),
            appendAzureEmotionFeedback: async ({ prompt }) => prompt,
            clearAzureEmotionFeedback: async () => undefined
        }),
        chatPreferences: Object.freeze({
            load: async () => Object.freeze({
                usePicture: false, useTTS: false, ttsRole: 'fixture',
                ttsRoleAzure: 'fixture', ttsRoleVoiceVox: 'fixture'
            }),
            patch: async () => Object.freeze({
                usePicture: false, useTTS: false, ttsRole: 'fixture',
                ttsRoleAzure: 'fixture', ttsRoleVoiceVox: 'fixture'
            })
        }),
        ttsAdministration: Object.freeze({
            getMode: () => 'vits-uma-genshin-honkai',
            setMode: () => undefined,
            isConfigured: () => false,
            selectVoice: () => Object.freeze({ kind: 'unsupported', message: 'unsupported' }),
            missingConfigurationMessage: () => 'missing'
        }),
        billing: Object.freeze({
            queryLastHundredDays: async () => Object.freeze({
                hardLimitUsd: 0, totalUsageUsd: 0, expiresAt: new Date(0)
            })
        }),
        bymPolicy: Object.freeze({ snapshot: () => disabledBymPolicy }),
        buttonPolicy: Object.freeze({
            snapshot: () => Object.freeze({ markdownEnabled: false, openAiConfigured: false })
        }),
        pictureRenderer: Object.freeze({
            render: async () => {
                input.pictureCounters.activePages += 1;
                input.pictureCounters.borrowedBrowserHandles += 1;
                try {
                    return input.scenario === 'pictureFailure'
                        ? Object.freeze({ kind: 'not_rendered', code: 'render_failed' })
                        : Object.freeze({ kind: 'rendered', resource: png, source: 'local' });
                }
                finally {
                    input.pictureCounters.activePages -= 1;
                    input.pictureCounters.borrowedBrowserHandles -= 1;
                }
            }
        }),
        tts: Object.freeze({
            synthesize: async () => Object.freeze({
                kind: 'failed_definite',
                code: 'synthesis_rejected'
            })
        }),
        modelFactory: () => input.model,
        random: () => 0.5,
        now: () => new Date(CREATED_AT),
        monotonicNow: () => { monotonic += 1; return monotonic; }
    };
    return Object.freeze({ graph: createProductionYunzaiAgent(options), dispatches });
}
function exactRecord(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    const actual = Object.keys(value);
    if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function observationCount(value, label) {
    if (value === 'unavailable' || value === 'not_attempted')
        return value;
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new TypeError(`${label} is invalid`);
    return Number(value);
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0)
        throw new TypeError(`${label} is invalid`);
    return Number(value);
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new TypeError(`${label} is invalid`);
    return Number(value);
}
export function validatePhase6ResourceSample(value, expectedScenario) {
    const sample = exactRecord(value, [
        'scenario', 'baselineRssBytes', 'retainedRssBytes', 'peakRssBytes',
        'wallTimeMs', 'userCpuMicros', 'systemCpuMicros', 'redisResources',
        'outcome', 'activePages', 'borrowedBrowserHandles', 'newChromiumProcesses'
    ], 'Phase 6 resource sample');
    if (sample.scenario !== expectedScenario ||
        sample.outcome !== PHASE_6_RESOURCE_OUTCOMES[expectedScenario]) {
        throw new TypeError('Phase 6 resource sample outcome is invalid');
    }
    const baseline = positiveInteger(sample.baselineRssBytes, 'baseline RSS');
    const retained = positiveInteger(sample.retainedRssBytes, 'retained RSS');
    const peak = positiveInteger(sample.peakRssBytes, 'peak RSS');
    if (peak < baseline || peak < retained)
        throw new TypeError('Phase 6 peak RSS is invalid');
    if (!Array.isArray(sample.redisResources) ||
        sample.redisResources.length !== PHASE_6_REDIS_RESOURCE_KINDS.length) {
        throw new TypeError('Phase 6 Redis resources are incomplete');
    }
    const resources = sample.redisResources.map((value, index) => {
        const item = exactRecord(value, ['kind', 'records', 'bytes'], 'Phase 6 Redis resource');
        if (item.kind !== PHASE_6_REDIS_RESOURCE_KINDS[index]) {
            throw new TypeError('Phase 6 Redis resource order is invalid');
        }
        observationCount(item.records, 'Redis records');
        observationCount(item.bytes, 'Redis bytes');
        return value;
    });
    Object.freeze(resources);
    nonNegativeInteger(sample.wallTimeMs, 'wall time');
    nonNegativeInteger(sample.userCpuMicros, 'user CPU');
    nonNegativeInteger(sample.systemCpuMicros, 'system CPU');
    nonNegativeInteger(sample.activePages, 'active pages');
    nonNegativeInteger(sample.borrowedBrowserHandles, 'borrowed browser handles');
    nonNegativeInteger(sample.newChromiumProcesses, 'Chromium processes');
    return Object.freeze(value);
}
export function normalizeMaxRssBytes(rawMaxRss, currentRssBytes) {
    if (!Number.isSafeInteger(rawMaxRss) || rawMaxRss <= 0 ||
        !Number.isSafeInteger(currentRssBytes) || currentRssBytes <= 0) {
        throw new TypeError('maxRSS observation is invalid');
    }
    const normalized = rawMaxRss >= currentRssBytes ? rawMaxRss : rawMaxRss * 1_024;
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        throw new TypeError('maxRSS normalization overflowed');
    }
    return normalized;
}
function settleMs(value) {
    const current = value ?? 25;
    if (!Number.isSafeInteger(current) || current < 0 || current > 1_000) {
        throw new TypeError('resource scenario settle time is invalid');
    }
    return current;
}
export async function runPhase6ResourceScenario(scenario, options = {}) {
    if (!PHASE_6_RESOURCE_SCENARIOS.includes(scenario)) {
        throw new TypeError(`unknown Phase 6 resource scenario: ${String(scenario)}`);
    }
    const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    const resourceUsage = options.resourceUsage ?? (() => process.resourceUsage());
    const collect = options.gc ?? globalThis.gc;
    const redis = new Phase6ResourceRedis(() => CREATED_AT_MS);
    const host = hostFixture();
    const pictureCounters = { activePages: 0, borrowedBrowserHandles: 0 };
    const model = scenario === 'checkpointResume'
        ? new ApprovalScenarioModel()
        : new ScenarioModel(scenario);
    const primary = graphFixture({
        scenario,
        redis,
        host,
        model,
        observabilityLevel: scenario === 'traceDiagnostic' ? 'diagnostic' : 'basic',
        pictureCounters
    });
    const graphs = [primary.graph];
    collect?.();
    let baselineRssBytes = memoryUsage().rss;
    const observations = [baselineRssBytes];
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    const runChat = async (actorId, marker, picture = false, graph = primary.graph) => {
        const handled = await graph.chatController.chatgpt1(groupEvent(actorId, marker, host, { picture }));
        if (!handled)
            throw new Error('resource chat scenario was not handled');
        observations.push(memoryUsage().rss);
    };
    try {
        if (scenario === 'singleTextRun')
            await runChat('single', 'single text');
        if (scenario === 'dualTextRun') {
            await Promise.all([
                runChat('dual-a', 'dual text a'),
                runChat('dual-b', 'dual text b')
            ]);
        }
        if (scenario === 'alreadyVisible') {
            await runChat('visible', '骰子请求，请投掷 1 个骰子');
            if (host.visibleMessages.length !== 1)
                throw new Error('visible tool output was not confirmed');
        }
        if (scenario === 'checkpointResume') {
            const approvalEvent = groupEvent('7', '请禁言 QQ:8 60 秒', host, {
                groupId: 'resume-group',
                owner: true,
                messageId: 'resume-original',
                rawMessage: '#chat1 请禁言 QQ:8 60 秒',
                message: Object.freeze([
                    Object.freeze({ type: 'text', text: '#chat1 请禁言 ' }),
                    Object.freeze({ type: 'at', qq: '8', text: '@member' }),
                    Object.freeze({ type: 'text', text: ' 60' })
                ])
            });
            if (!await primary.graph.chatController.chatgpt1(approvalEvent)) {
                throw new Error('approval pause was not handled');
            }
            const approvalDelivery = primary.dispatches.at(-1);
            if (approvalDelivery === undefined)
                throw new Error('approval delivery is missing');
            const recovery = graphFixture({
                scenario,
                redis,
                host,
                model: new ApprovalScenarioModel(),
                observabilityLevel: 'basic',
                pictureCounters
            });
            graphs.push(recovery.graph);
            const confirmation = groupEvent('7', 'confirmation', host, {
                groupId: 'resume-group',
                owner: true,
                rawMessage: '确认',
                messageId: 'resume-confirmation',
                sourceMessageId: approvalDelivery.messageId,
                message: Object.freeze([Object.freeze({ type: 'text', text: '确认' })])
            });
            if (!await recovery.graph.approvalController.confirmToolOperation(confirmation)) {
                throw new Error('checkpoint resume was not handled');
            }
            observations.push(memoryUsage().rss);
        }
        if (scenario === 'traceBasic') {
            await runChat('trace-basic', 'trace basic failure');
            await primary.graph.observability.hub.drain();
            if ((await primary.graph.observability.traceStore.usage()).records < 1) {
                throw new Error('basic trace was not retained');
            }
        }
        if (scenario === 'traceDiagnostic') {
            for (let index = 0; index < 64; index += 1) {
                await runChat(`trace-${index}`, `trace diagnostic ${index}`);
            }
            await primary.graph.observability.hub.drain();
            const recent = await primary.graph.observability.traceStore.listRecent(1);
            if ((await primary.graph.observability.traceStore.usage()).records !== 64 ||
                recent[0] === undefined)
                throw new Error('diagnostic trace capacity was not filled');
            collect?.();
            baselineRssBytes = memoryUsage().rss;
            observations.splice(0, observations.length, baselineRssBytes);
            const replies = [];
            await primary.graph.diagnosticsController.handleStatus(Object.freeze({
                authorized: true,
                commandArgument: '',
                replyText: async (text) => { replies.push(text); }
            }));
            observations.push(memoryUsage().rss);
            await primary.graph.diagnosticsController.handleInspect(Object.freeze({
                authorized: true,
                commandArgument: recent[0].runRef,
                replyText: async (text) => { replies.push(text); }
            }));
            observations.push(memoryUsage().rss);
            if (replies.length !== 2)
                throw new Error('diagnostic queries did not reply');
        }
        if (scenario === 'pictureSuccess' || scenario === 'pictureFailure') {
            for (let index = 0; index < 3; index += 1) {
                await runChat(`picture-${index}`, `picture ${index}`, true);
            }
        }
        await primary.graph.observability.hub.drain();
        collect?.();
        const wait = settleMs(options.settleMs);
        if (wait > 0)
            await new Promise(resolve => setTimeout(resolve, wait));
        const retainedRssBytes = memoryUsage().rss;
        observations.push(retainedRssBytes);
        const cpu = process.cpuUsage(cpuStart);
        const wallTimeMs = Math.max(0, Math.trunc(performance.now() - wallStart));
        const rawMaxRss = resourceUsage().maxRSS;
        const peakRssBytes = Math.max(...observations, normalizeMaxRssBytes(rawMaxRss, retainedRssBytes));
        const sample = Object.freeze({
            scenario,
            baselineRssBytes,
            retainedRssBytes,
            peakRssBytes,
            wallTimeMs,
            userCpuMicros: nonNegativeInteger(cpu.user, 'user CPU'),
            systemCpuMicros: nonNegativeInteger(cpu.system, 'system CPU'),
            redisResources: redis.resourceUsage(),
            outcome: PHASE_6_RESOURCE_OUTCOMES[scenario],
            activePages: pictureCounters.activePages,
            borrowedBrowserHandles: pictureCounters.borrowedBrowserHandles,
            newChromiumProcesses: 0
        });
        return validatePhase6ResourceSample(sample, scenario);
    }
    finally {
        for (const graph of graphs.reverse())
            await graph.shutdown('phase6_resource_scenario');
    }
}
export async function main() {
    const scenario = process.argv[2];
    const sample = await runPhase6ResourceScenario(scenario);
    process.stdout.write(JSON.stringify(sample));
}

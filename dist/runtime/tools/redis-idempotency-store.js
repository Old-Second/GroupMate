import { parseToolResult } from '../../agent/tools/tool-result.js';
const namespace = 'GROUPMATE:TOOL:IDEMPOTENCY:v1:';
const maxRecordBytes = 8 * 1024;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function code(value) {
    return typeof value === 'string' && codePattern.test(value);
}
function date(value) {
    return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function ttl(value) {
    if (!Number.isInteger(value) || value < 30 || value > 86_400)
        throw new TypeError('idempotency TTL is invalid');
}
function redisKey(botIdHash, key) {
    if (!code(botIdHash) || !code(key))
        throw new TypeError('idempotency key hash is invalid');
    return `${namespace}${encodeURIComponent(botIdHash)}:${encodeURIComponent(key)}`;
}
function exact(record, keys) {
    const actual = Object.keys(record);
    return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function parseOutcome(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return null;
    const outcome = value;
    if (outcome.status === 'success') {
        if (!exact(outcome, ['status', 'effect', 'completedAt']) ||
            !['none', 'background', 'visible'].includes(outcome.effect) || !date(outcome.completedAt))
            return null;
        return Object.freeze({ status: 'success', effect: outcome.effect, completedAt: outcome.completedAt });
    }
    if (outcome.status === 'failed') {
        if (!exact(outcome, ['status', 'effect', 'errorCode', 'completedAt']) || outcome.effect !== 'none' ||
            !code(outcome.errorCode) || !date(outcome.completedAt))
            return null;
        try {
            parseToolResult({
                status: 'failed', effect: 'none', errorCode: outcome.errorCode,
                userMessage: '工具执行失败。', retryable: false
            });
        }
        catch {
            return null;
        }
        return Object.freeze({
            status: 'failed', effect: 'none', errorCode: outcome.errorCode, completedAt: outcome.completedAt
        });
    }
    return null;
}
function parseState(raw) {
    if (Buffer.byteLength(raw, 'utf8') > maxRecordBytes)
        return null;
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return null;
    const state = value;
    if (state.schemaVersion !== 1 || typeof state.state !== 'string')
        return null;
    if (state.state === 'running') {
        if (!exact(state, ['schemaVersion', 'state', 'toolName', 'toolVersion', 'runIdHash', 'callIdHash', 'startedAt']) ||
            state.toolVersion !== 1 || !code(state.toolName) || !code(state.runIdHash) || !code(state.callIdHash) || !date(state.startedAt))
            return null;
        return Object.freeze({ kind: 'running' });
    }
    if (state.state === 'completed') {
        if (!exact(state, ['schemaVersion', 'state', 'outcome']))
            return null;
        const outcome = parseOutcome(state.outcome);
        return outcome === null ? null : Object.freeze({ kind: 'completed', outcome });
    }
    if (state.state === 'indeterminate') {
        if (!exact(state, ['schemaVersion', 'state', 'updatedAt']) || !date(state.updatedAt))
            return null;
        return Object.freeze({ kind: 'indeterminate' });
    }
    return null;
}
export class RedisIdempotencyStore {
    #client;
    #botIdHash;
    constructor(options) {
        if (!code(options.botIdHash))
            throw new TypeError('bot namespace hash is invalid');
        this.#client = options.client;
        this.#botIdHash = options.botIdHash;
    }
    async reserve(record, ttlSeconds) {
        ttl(ttlSeconds);
        if (record.schemaVersion !== 1 || record.toolVersion !== 1 || !code(record.key) ||
            !code(record.toolName) || !code(record.runIdHash) || !code(record.callIdHash) || !date(record.startedAt)) {
            throw new TypeError('idempotency record is invalid');
        }
        const key = redisKey(this.#botIdHash, record.key);
        const raw = JSON.stringify({
            schemaVersion: 1,
            state: 'running',
            toolName: record.toolName,
            toolVersion: 1,
            runIdHash: record.runIdHash,
            callIdHash: record.callIdHash,
            startedAt: record.startedAt
        });
        const result = await this.#client.set(key, raw, { EX: ttlSeconds, NX: true });
        if (result !== null)
            return Object.freeze({ kind: 'acquired' });
        const existing = await this.#client.get(key);
        if (existing === null) {
            const retried = await this.#client.set(key, raw, { EX: ttlSeconds, NX: true });
            return retried === null ? Object.freeze({ kind: 'indeterminate' }) : Object.freeze({ kind: 'acquired' });
        }
        return parseState(existing) ?? Object.freeze({ kind: 'indeterminate' });
    }
    async complete(keyHash, outcome, ttlSeconds) {
        ttl(ttlSeconds);
        const parsed = parseOutcome(outcome);
        if (parsed === null)
            throw new TypeError('stored tool outcome is invalid');
        const raw = JSON.stringify({ schemaVersion: 1, state: 'completed', outcome: parsed });
        const result = await this.#client.set(redisKey(this.#botIdHash, keyHash), raw, { EX: ttlSeconds, XX: true });
        if (result === null)
            throw new Error('idempotency reservation is missing');
    }
    async markIndeterminate(keyHash, ttlSeconds) {
        ttl(ttlSeconds);
        const raw = JSON.stringify({ schemaVersion: 1, state: 'indeterminate', updatedAt: new Date().toISOString() });
        const result = await this.#client.set(redisKey(this.#botIdHash, keyHash), raw, { EX: ttlSeconds, XX: true });
        if (result === null)
            throw new Error('idempotency reservation is missing');
    }
}

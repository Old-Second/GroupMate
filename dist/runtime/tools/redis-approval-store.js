const namespace = 'GROUPMATE:TOOL:APPROVAL:v1:';
const maxRecordBytes = 16 * 1024;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const profiles = new Set(['compatible', 'safe', 'strict']);
const storedKeys = [
    'schemaVersion', 'rawVersion', 'toolName', 'toolVersion', 'profile', 'runId', 'callId',
    'snapshotId', 'argumentHash', 'pendingCallId', 'botIdHash', 'actorIdHash', 'channelHash',
    'targetHash', 'summaryCode', 'createdAt', 'expiresAt'
];
function boundedCode(value) {
    return typeof value === 'string' && codePattern.test(value);
}
function validDate(value) {
    return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function exactKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function validateTtl(ttlSeconds) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) {
        throw new TypeError('tool control TTL is invalid');
    }
}
function storedRecord(record) {
    return {
        schemaVersion: 1,
        rawVersion: record.rawVersion,
        toolName: record.toolName,
        toolVersion: 1,
        profile: record.profile,
        runId: record.runId,
        callId: record.callId,
        snapshotId: record.snapshotId,
        argumentHash: record.argumentHash,
        pendingCallId: record.pendingCallId,
        botIdHash: record.botIdHash,
        actorIdHash: record.actorIdHash,
        channelHash: record.channelHash,
        targetHash: record.targetHash,
        summaryCode: record.summaryCode,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt
    };
}
function parseRecord(raw, tokenHash, expectedBotIdHash) {
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
    const record = value;
    if (!exactKeys(record, storedKeys) || record.schemaVersion !== 1 || record.toolVersion !== 1 ||
        !profiles.has(record.profile) || record.botIdHash !== expectedBotIdHash ||
        !validDate(record.createdAt) || !validDate(record.expiresAt))
        return null;
    for (const key of storedKeys) {
        if (['schemaVersion', 'toolVersion', 'profile', 'createdAt', 'expiresAt'].includes(key))
            continue;
        if (!boundedCode(record[key]))
            return null;
    }
    return Object.freeze({ ...record, tokenHash });
}
export function redisApprovalKey(botIdHash, tokenHash) {
    if (!boundedCode(botIdHash) || !boundedCode(tokenHash))
        throw new TypeError('approval key hash is invalid');
    return `${namespace}${encodeURIComponent(botIdHash)}:${encodeURIComponent(tokenHash)}`;
}
export class RedisApprovalStore {
    #client;
    #botIdHash;
    constructor(options) {
        if (!boundedCode(options.botIdHash))
            throw new TypeError('bot namespace hash is invalid');
        this.#client = options.client;
        this.#botIdHash = options.botIdHash;
    }
    async create(record, ttlSeconds) {
        validateTtl(ttlSeconds);
        if (record.botIdHash !== this.#botIdHash || !boundedCode(record.tokenHash)) {
            throw new TypeError('approval record namespace is invalid');
        }
        const stored = storedRecord(record);
        const raw = JSON.stringify(stored);
        if (parseRecord(raw, record.tokenHash, this.#botIdHash) === null || Buffer.byteLength(raw, 'utf8') > maxRecordBytes) {
            throw new TypeError('approval record is invalid');
        }
        const result = await this.#client.set(redisApprovalKey(this.#botIdHash, record.tokenHash), raw, { EX: ttlSeconds, NX: true });
        if (result === null)
            throw new Error('approval record already exists');
    }
    async get(tokenHash) {
        const key = redisApprovalKey(this.#botIdHash, tokenHash);
        const raw = await this.#client.get(key);
        if (raw === null)
            return null;
        const record = parseRecord(raw, tokenHash, this.#botIdHash);
        if (record === null)
            await this.#client.del(key);
        return record;
    }
    async consume(tokenHash, expectedRawVersion) {
        if (!boundedCode(expectedRawVersion))
            return null;
        const key = redisApprovalKey(this.#botIdHash, tokenHash);
        const raw = await this.#client.get(key);
        if (raw === null)
            return null;
        const checked = parseRecord(raw, tokenHash, this.#botIdHash);
        if (checked === null) {
            await this.#client.del(key);
            return null;
        }
        if (checked.rawVersion !== expectedRawVersion)
            return null;
        const consumedRaw = await this.#client.getDel(key);
        if (consumedRaw !== raw)
            return null;
        return parseRecord(consumedRaw, tokenHash, this.#botIdHash);
    }
}

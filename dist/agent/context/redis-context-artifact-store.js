import { decodeContextArtifactV1, encodeContextArtifactV1, parseContextArtifactV1 } from './context-artifact.js';
import { CONTEXT_ARTIFACT_RESOURCE_LIMITS, contextArtifactNamespaceUsageWithinLimits } from './context-resource-limits.js';
export const CONTEXT_ARTIFACT_STORE_NAMESPACE = 'GROUPMATE:CONTEXT_ARTIFACT:v1:';
export const CONTEXT_ARTIFACT_METADATA_KEY = `${CONTEXT_ARTIFACT_STORE_NAMESPACE}namespace-budget`;
export const CONTEXT_ARTIFACT_STORE_LUA_MARKER = '-- GROUPMATE_CONTEXT_ARTIFACT_STORE_V1';
export function redisContextArtifactKey(artifactId) {
    if (!/^artifact:[0-9a-f]{64}$/.test(artifactId)) {
        throw new TypeError('context artifact ID is invalid');
    }
    return `${CONTEXT_ARTIFACT_STORE_NAMESPACE}${artifactId}`;
}
export const CONTEXT_ARTIFACT_STORE_LUA_SCRIPT = `${CONTEXT_ARTIFACT_STORE_LUA_MARKER}
local operation = ARGV[1]

if operation == 'read' then
  if redis.call('EXISTS', KEYS[1]) == 0 then return 'missing' end
  local valueLength = redis.call('STRLEN', KEYS[1])
  if valueLength > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.artifactBytes} then return 'too_large' end
  return {'exact', redis.call('GET', KEYS[1])}
end

if operation == 'metadata_snapshot' then
  local metadataLength = redis.call('STRLEN', KEYS[1])
  if metadataLength > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes} then return 'oversized' end
  local current = redis.call('GET', KEYS[1])
  if not current then return 'missing' end
  return {'exact', current}
end

if operation == 'reconcile' then
  local expectedKind = ARGV[2]
  local metadataLength = redis.call('STRLEN', KEYS[1])
  if expectedKind == 'missing' then
    if redis.call('EXISTS', KEYS[1]) ~= 0 then return 'conflict' end
  elseif expectedKind == 'exact' then
    if metadataLength > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes} or
      redis.call('GET', KEYS[1]) ~= ARGV[3] then return 'conflict' end
  elseif expectedKind == 'oversized' then
    if metadataLength <= ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes} then return 'conflict' end
  else
    return 'invalid_snapshot'
  end
  redis.call('SET', KEYS[1], ARGV[4])
  return 'ok'
end

local minimumExpiresAtMs = tonumber(ARGV[3])
local redisTime = redis.call('TIME')
local redisNowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
if not minimumExpiresAtMs or minimumExpiresAtMs <= redisNowMs or
  minimumExpiresAtMs > redisNowMs + ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs} then
  return 'invalid_expiry'
end
if operation == 'validate_expiry' then return 'ok' end

local artifactKey = KEYS[1]
local metadataKey = KEYS[2]
local expected = ARGV[2]
local existing = nil
if redis.call('EXISTS', artifactKey) ~= 0 then
  if redis.call('STRLEN', artifactKey) > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.artifactBytes} then
    return 'corrupt'
  end
  existing = redis.call('GET', artifactKey)
end

local function readMetadata()
  local metadataLength = redis.call('STRLEN', metadataKey)
  if metadataLength > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes} then return nil end
  local metadata = redis.call('GET', metadataKey)
  if not metadata then return nil end
  local count, valueBytes = string.match(metadata, '^1|(%d+)|(%d+)$')
  if not count or not valueBytes then return nil end
  count = tonumber(count)
  valueBytes = tonumber(valueBytes)
  if count > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys} or
    valueBytes > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes} then return nil end
  return count, valueBytes
end

local function extendAtLeast()
  local ttl = redis.call('PTTL', artifactKey)
  if ttl < 0 then return false end
  local horizonBoundMs = redisNowMs + ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.maximumExpiryHorizonMs}
  local lowerExistingExpiryMs = redisNowMs + ttl
  if lowerExistingExpiryMs > horizonBoundMs then return false end
  local freshRedisTime = redis.call('TIME')
  local freshRedisNowMs = tonumber(freshRedisTime[1]) * 1000 +
    math.floor(tonumber(freshRedisTime[2]) / 1000)
  local upperExistingExpiryMs = freshRedisNowMs + ttl
  local targetExpiresAtMs = minimumExpiresAtMs
  if upperExistingExpiryMs > targetExpiresAtMs then targetExpiresAtMs = upperExistingExpiryMs end
  if targetExpiresAtMs > horizonBoundMs then targetExpiresAtMs = horizonBoundMs end
  redis.call('PEXPIREAT', artifactKey, targetExpiresAtMs)
  return true
end

if operation == 'touch' then
  if not existing then return 'missing' end
  if existing ~= expected then return 'corrupt' end
  local count, valueBytes = readMetadata()
  if not count or count < 1 or valueBytes < string.len(expected) then return 'reconcile' end
  if not extendAtLeast() then return 'corrupt_ttl' end
  return 'ok'
end

if operation ~= 'put' then return 'invalid_operation' end
if existing then
  if existing ~= expected then return 'corrupt' end
  local count, valueBytes = readMetadata()
  if not count or count < 1 or valueBytes < string.len(expected) then return 'reconcile' end
  if not extendAtLeast() then return 'corrupt_ttl' end
  return 'existing'
end

local count, valueBytes = readMetadata()
if not count then return 'reconcile' end
local projectedCount = count + 1
local projectedBytes = valueBytes + string.len(expected)
if projectedCount > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys} or
  projectedBytes > ${CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes} then
  return 'capacity'
end
redis.call('SET', artifactKey, expected)
redis.call('PEXPIREAT', artifactKey, minimumExpiresAtMs)
redis.call('SET', metadataKey, '1|' .. projectedCount .. '|' .. projectedBytes)
return 'stored'
`;
const READY = (artifact) => Object.freeze({
    status: 'ready',
    artifact
});
const MISSING = Object.freeze({ status: 'missing' });
const unavailable = (code) => Object.freeze({ status: 'unavailable', code });
const REDIS_UNAVAILABLE = unavailable('redis_unavailable');
const ARTIFACT_CORRUPT = unavailable('artifact_corrupt');
const METADATA_CORRUPT = unavailable('metadata_corrupt');
const CAPACITY = Object.freeze({
    status: 'unavailable',
    code: 'namespace_capacity'
});
function validateExpiry(minimumExpiresAtMs) {
    if (!Number.isSafeInteger(minimumExpiresAtMs) || minimumExpiresAtMs <= 0) {
        throw new TypeError('context artifact expiry is invalid');
    }
    return minimumExpiresAtMs;
}
function canonicalArtifact(value) {
    const artifact = parseContextArtifactV1(value);
    return Object.freeze({ artifact, encoded: encodeContextArtifactV1(artifact) });
}
export class RedisContextArtifactStore {
    #client;
    #mutationInitialized = false;
    #mutationInitialization = null;
    #reconciliation = null;
    constructor(options) {
        if (options === null || typeof options !== 'object' ||
            options.client === null || typeof options.client !== 'object') {
            throw new TypeError('context artifact store options are invalid');
        }
        this.#client = options.client;
    }
    async get(artifactId) {
        const key = redisContextArtifactKey(artifactId);
        const read = await this.#readRaw(key);
        if (read.status === 'unavailable')
            return unavailable(read.code);
        if (read.status === 'too_large')
            return ARTIFACT_CORRUPT;
        if (read.status === 'missing') {
            const reconciled = await this.#reconcile();
            if (reconciled !== 'ok')
                return unavailable(reconciled);
            return MISSING;
        }
        return this.#decodeExpected(read.raw, artifactId);
    }
    async putIfAbsent(artifactValue, minimumExpiresAtMsValue) {
        const candidate = canonicalArtifact(artifactValue);
        const minimumExpiresAtMs = validateExpiry(minimumExpiresAtMsValue);
        const key = redisContextArtifactKey(candidate.artifact.artifactId);
        const expiryValidation = await this.#validateRedisExpiry(minimumExpiresAtMs);
        if (expiryValidation !== 'ok')
            return unavailable(expiryValidation);
        const initialized = await this.#ensureMutationReconciled();
        if (initialized !== 'ok')
            return unavailable(initialized);
        let reconciledCapacity = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            let result;
            try {
                result = await this.#client.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
                    keys: [key, CONTEXT_ARTIFACT_METADATA_KEY],
                    arguments: ['put', candidate.encoded, String(minimumExpiresAtMs)]
                });
            }
            catch {
                return REDIS_UNAVAILABLE;
            }
            if (result === 'stored' || result === 'existing') {
                return await this.#verifiedWinner(candidate.artifact, candidate.encoded);
            }
            if (result === 'invalid_expiry')
                throw new TypeError('context artifact expiry is invalid');
            if (result === 'corrupt' || result === 'corrupt_ttl')
                return ARTIFACT_CORRUPT;
            if (result !== 'reconcile' && result !== 'capacity')
                return METADATA_CORRUPT;
            if (result === 'capacity' && reconciledCapacity)
                return CAPACITY;
            if (result === 'capacity')
                reconciledCapacity = true;
            const reconciled = await this.#reconcile();
            if (reconciled !== 'ok')
                return unavailable(reconciled);
        }
        return METADATA_CORRUPT;
    }
    async touchAtLeast(expectedArtifactValue, minimumExpiresAtMsValue) {
        const expected = canonicalArtifact(expectedArtifactValue);
        const minimumExpiresAtMs = validateExpiry(minimumExpiresAtMsValue);
        const key = redisContextArtifactKey(expected.artifact.artifactId);
        const expiryValidation = await this.#validateRedisExpiry(minimumExpiresAtMs);
        if (expiryValidation !== 'ok')
            return unavailable(expiryValidation);
        const initialized = await this.#ensureMutationReconciled();
        if (initialized !== 'ok')
            return unavailable(initialized);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            let result;
            try {
                result = await this.#client.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
                    keys: [key, CONTEXT_ARTIFACT_METADATA_KEY],
                    arguments: ['touch', expected.encoded, String(minimumExpiresAtMs)]
                });
            }
            catch {
                return REDIS_UNAVAILABLE;
            }
            if (result === 'invalid_expiry')
                throw new TypeError('context artifact expiry is invalid');
            if (result === 'missing') {
                const reconciled = await this.#reconcile();
                if (reconciled !== 'ok')
                    return unavailable(reconciled);
                return MISSING;
            }
            if (result === 'reconcile') {
                const reconciled = await this.#reconcile();
                if (reconciled !== 'ok')
                    return unavailable(reconciled);
                continue;
            }
            if (result === 'corrupt' || result === 'corrupt_ttl')
                return ARTIFACT_CORRUPT;
            if (result !== 'ok')
                return METADATA_CORRUPT;
            return await this.#verifiedWinner(expected.artifact, expected.encoded);
        }
        return METADATA_CORRUPT;
    }
    async #verifiedWinner(expected, encoded) {
        const read = await this.#readRaw(redisContextArtifactKey(expected.artifactId));
        if (read.status === 'unavailable')
            return unavailable(read.code);
        if (read.status !== 'exact' || read.raw !== encoded)
            return ARTIFACT_CORRUPT;
        const decoded = this.#decodeExpected(read.raw, expected.artifactId);
        if (decoded.status !== 'ready' || encodeContextArtifactV1(decoded.artifact) !== encoded) {
            return ARTIFACT_CORRUPT;
        }
        return decoded;
    }
    async #readRaw(key) {
        let result;
        try {
            result = await this.#client.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
                keys: [key],
                arguments: ['read']
            });
        }
        catch {
            return Object.freeze({ status: 'unavailable', code: 'redis_unavailable' });
        }
        if (result === 'missing' || result === 'too_large') {
            return Object.freeze({ status: result });
        }
        if (Array.isArray(result) && result.length === 2 && result[0] === 'exact' &&
            typeof result[1] === 'string' &&
            Buffer.byteLength(result[1], 'utf8') <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.artifactBytes) {
            return Object.freeze({ status: 'exact', raw: result[1] });
        }
        return Object.freeze({ status: 'unavailable', code: 'metadata_corrupt' });
    }
    #decodeExpected(raw, artifactId) {
        try {
            const artifact = decodeContextArtifactV1(raw);
            return artifact.artifactId === artifactId ? READY(artifact) : ARTIFACT_CORRUPT;
        }
        catch {
            return ARTIFACT_CORRUPT;
        }
    }
    async #validateRedisExpiry(minimumExpiresAtMs) {
        let result;
        try {
            result = await this.#client.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
                keys: [],
                arguments: ['validate_expiry', '', String(minimumExpiresAtMs)]
            });
        }
        catch {
            return 'redis_unavailable';
        }
        if (result === 'invalid_expiry')
            throw new TypeError('context artifact expiry is invalid');
        return result === 'ok' ? 'ok' : 'metadata_corrupt';
    }
    async #ensureMutationReconciled() {
        if (this.#mutationInitialized)
            return 'ok';
        const pending = this.#mutationInitialization ?? this.#reconcile();
        if (this.#mutationInitialization === null)
            this.#mutationInitialization = pending;
        try {
            const result = await pending;
            if (result === 'ok')
                this.#mutationInitialized = true;
            return result;
        }
        finally {
            if (this.#mutationInitialization === pending)
                this.#mutationInitialization = null;
        }
    }
    async #reconcile() {
        const pending = this.#reconciliation ?? this.#performReconcile();
        if (this.#reconciliation === null)
            this.#reconciliation = pending;
        try {
            return await pending;
        }
        finally {
            if (this.#reconciliation === pending)
                this.#reconciliation = null;
        }
    }
    async #performReconcile() {
        for (let attempt = 0; attempt < CONTEXT_ARTIFACT_RESOURCE_LIMITS.maxMetadataCasAttempts; attempt += 1) {
            const snapshotResult = await this.#metadataSnapshot();
            if (snapshotResult.status !== 'ready')
                return snapshotResult.code;
            const snapshot = snapshotResult.snapshot;
            const scanned = await this.#scanUsage();
            if (scanned.status !== 'ok')
                return scanned.code;
            const nextMetadata = `1|${scanned.keys}|${scanned.valueBytes}`;
            if (Buffer.byteLength(nextMetadata, 'utf8') > CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes) {
                return 'metadata_corrupt';
            }
            let result;
            try {
                result = await this.#client.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
                    keys: [CONTEXT_ARTIFACT_METADATA_KEY],
                    arguments: [
                        'reconcile',
                        snapshot.kind,
                        snapshot.kind === 'exact' ? snapshot.raw : '',
                        nextMetadata
                    ]
                });
            }
            catch {
                return 'redis_unavailable';
            }
            if (result === 'ok')
                return 'ok';
            if (result !== 'conflict')
                return 'metadata_corrupt';
        }
        return 'reconcile_conflict';
    }
    async #metadataSnapshot() {
        let result;
        try {
            result = await this.#client.eval(CONTEXT_ARTIFACT_STORE_LUA_SCRIPT, {
                keys: [CONTEXT_ARTIFACT_METADATA_KEY],
                arguments: ['metadata_snapshot']
            });
        }
        catch {
            return Object.freeze({ status: 'unavailable', code: 'redis_unavailable' });
        }
        if (result === 'missing' || result === 'oversized') {
            return Object.freeze({
                status: 'ready',
                snapshot: Object.freeze({ kind: result })
            });
        }
        if (Array.isArray(result) && result.length === 2 && result[0] === 'exact' &&
            typeof result[1] === 'string' &&
            Buffer.byteLength(result[1], 'utf8') <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.metadataBytes) {
            return Object.freeze({
                status: 'ready',
                snapshot: Object.freeze({ kind: 'exact', raw: result[1] })
            });
        }
        return Object.freeze({ status: 'unavailable', code: 'metadata_corrupt' });
    }
    async #scanUsage() {
        let cursor = 0;
        let calls = 0;
        const dataKeys = new Set();
        do {
            if (calls >= CONTEXT_ARTIFACT_RESOURCE_LIMITS.maxReconcileScanCalls) {
                return Object.freeze({ status: 'unavailable', code: 'reconcile_incomplete' });
            }
            let page;
            try {
                page = await this.#client.scan(cursor, {
                    MATCH: `${CONTEXT_ARTIFACT_STORE_NAMESPACE}*`,
                    COUNT: CONTEXT_ARTIFACT_RESOURCE_LIMITS.reconcileScanCount
                });
            }
            catch {
                return Object.freeze({ status: 'unavailable', code: 'redis_unavailable' });
            }
            calls += 1;
            if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 || !Array.isArray(page.keys)) {
                return Object.freeze({ status: 'unavailable', code: 'reconcile_incomplete' });
            }
            for (const key of page.keys) {
                if (key === CONTEXT_ARTIFACT_METADATA_KEY)
                    continue;
                if (!key.startsWith(`${CONTEXT_ARTIFACT_STORE_NAMESPACE}artifact:`) ||
                    !/^artifact:[0-9a-f]{64}$/.test(key.slice(CONTEXT_ARTIFACT_STORE_NAMESPACE.length))) {
                    return Object.freeze({ status: 'unavailable', code: 'metadata_corrupt' });
                }
                dataKeys.add(key);
                if (dataKeys.size >= CONTEXT_ARTIFACT_RESOURCE_LIMITS.maxReconcileDataKeys) {
                    return Object.freeze({ status: 'unavailable', code: 'namespace_capacity' });
                }
            }
            cursor = page.cursor;
        } while (cursor !== 0);
        let valueBytes = 0;
        let liveKeys = 0;
        for (const key of dataKeys) {
            const read = await this.#readRaw(key);
            if (read.status === 'unavailable') {
                return Object.freeze({ status: 'unavailable', code: read.code });
            }
            if (read.status === 'missing')
                continue;
            if (read.status === 'too_large') {
                return Object.freeze({ status: 'unavailable', code: 'artifact_corrupt' });
            }
            liveKeys += 1;
            const artifactId = key.slice(CONTEXT_ARTIFACT_STORE_NAMESPACE.length);
            const decoded = this.#decodeExpected(read.raw, artifactId);
            if (decoded.status !== 'ready') {
                return Object.freeze({ status: 'unavailable', code: 'artifact_corrupt' });
            }
            valueBytes += Buffer.byteLength(read.raw, 'utf8');
            if (!Number.isSafeInteger(valueBytes)) {
                return Object.freeze({ status: 'unavailable', code: 'namespace_capacity' });
            }
        }
        if (!contextArtifactNamespaceUsageWithinLimits(liveKeys, valueBytes)) {
            return Object.freeze({ status: 'unavailable', code: 'namespace_capacity' });
        }
        return Object.freeze({ status: 'ok', keys: liveKeys, valueBytes });
    }
}

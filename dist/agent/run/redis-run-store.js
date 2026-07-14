import { createHash } from 'node:crypto';
import { AgentError } from '../contracts/error.js';
import { canonicalSessionKey } from '../session/conversation-scope.js';
import { RunCheckpointCodec } from './run-checkpoint.js';
import { RUN_RESOURCE_LIMITS } from './run-limits.js';
import { isTerminalRunStatus } from './run-state.js';
import { checkpointWithAppendedEvents, createRunTombstone, parseRunTombstone, RunStoreConflictError } from './run-store.js';
export const RUN_STORE_NAMESPACE = 'GROUPMATE:RUN:v1:';
export const RUN_STORE_LUA_MARKER = '-- GROUPMATE_RUN_STORE_V1';
export const RUN_STORE_METADATA_KEY = `${RUN_STORE_NAMESPACE}approval-index:namespace-budget`;
export const RUN_STORE_LUA_SCRIPT = `${RUN_STORE_LUA_MARKER}
local operation = ARGV[1]

if operation == 'load' then
  return { redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false }
end

if operation == 'reconcile' then
  local current = redis.call('GET', KEYS[1]) or ''
  if current ~= ARGV[2] then return 'conflict' end
  redis.call('SET', KEYS[1], ARGV[3])
  return 'ok'
end

local metadataKey = KEYS[#KEYS]
local metadata = redis.call('GET', metadataKey)
if not metadata then return 'reconcile' end
local bytes, checkpoints, events, tombstones, indexes = string.match(
  metadata,
  '^(%d+)|(%d+)|(%d+)|(%d+)|(%d+)$'
)
if not bytes then return 'reconcile' end
local current = {
  bytes = tonumber(bytes),
  checkpoints = tonumber(checkpoints),
  events = tonumber(events),
  tombstones = tonumber(tombstones),
  indexes = tonumber(indexes)
}

local function exceeds(value)
  return value.bytes > ${RUN_RESOURCE_LIMITS.namespaceBytes} or
    value.checkpoints > ${RUN_RESOURCE_LIMITS.checkpointKeys} or
    value.events > ${RUN_RESOURCE_LIMITS.eventKeys} or
    value.tombstones > ${RUN_RESOURCE_LIMITS.tombstoneKeys} or
    value.indexes > ${RUN_RESOURCE_LIMITS.indexAdmissionKeys}
end

local function invalid(value)
  return value.bytes < 0 or value.checkpoints < 0 or value.events < 0 or
    value.tombstones < 0 or value.indexes < 0
end

local function save(value)
  redis.call('SET', metadataKey, table.concat({
    value.bytes,
    value.checkpoints,
    value.events,
    value.tombstones,
    value.indexes
  }, '|'))
end

if operation == 'create' then
  if redis.call('EXISTS', KEYS[1], KEYS[2], KEYS[3]) > 0 then return 'conflict' end
  local projected = {
    bytes = current.bytes + string.len(ARGV[2]) + string.len(ARGV[3]),
    checkpoints = current.checkpoints + 1,
    events = current.events + 1,
    tombstones = current.tombstones,
    indexes = current.indexes
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
  redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
  save(projected)
  return 'ok'
end

if operation == 'cas' then
  local oldCheckpoint = redis.call('GET', KEYS[1])
  local oldEvents = redis.call('GET', KEYS[2])
  if oldCheckpoint ~= ARGV[2] or oldEvents ~= ARGV[3] then return 'conflict' end
  local terminal = ARGV[7] == '1'
  local projected = {
    bytes = current.bytes - string.len(oldCheckpoint) - string.len(oldEvents),
    checkpoints = current.checkpoints - 1,
    events = current.events - 1,
    tombstones = current.tombstones,
    indexes = current.indexes
  }
  if terminal then
    if redis.call('EXISTS', KEYS[3]) > 0 then return 'conflict' end
    projected.bytes = projected.bytes + string.len(ARGV[8])
    projected.tombstones = projected.tombstones + 1
  else
    projected.bytes = projected.bytes + string.len(ARGV[4]) + string.len(ARGV[5])
    projected.checkpoints = projected.checkpoints + 1
    projected.events = projected.events + 1
  end
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  if terminal then
    redis.call('DEL', KEYS[1], KEYS[2])
    redis.call('SET', KEYS[3], ARGV[8], 'EX', tonumber(ARGV[9]))
  else
    redis.call('SET', KEYS[1], ARGV[4], 'EX', tonumber(ARGV[6]))
    redis.call('SET', KEYS[2], ARGV[5], 'EX', tonumber(ARGV[6]))
  end
  save(projected)
  return 'ok'
end

if operation == 'finish' then
  local oldCheckpoint = redis.call('GET', KEYS[1])
  local oldEvents = redis.call('GET', KEYS[2])
  if oldCheckpoint ~= ARGV[2] or oldEvents ~= ARGV[3] or
    redis.call('EXISTS', KEYS[3]) > 0 then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(oldCheckpoint) - string.len(oldEvents) + string.len(ARGV[4]),
    checkpoints = current.checkpoints - 1,
    events = current.events - 1,
    tombstones = current.tombstones + 1,
    indexes = current.indexes
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('SET', KEYS[3], ARGV[4], 'EX', tonumber(ARGV[5]))
  save(projected)
  return 'ok'
end

if operation == 'admission_acquire' then
  if redis.call('EXISTS', KEYS[1]) > 0 then return 'conflict' end
  local projected = {
    bytes = current.bytes + string.len(ARGV[2]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes + 1
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]), 'NX')
  save(projected)
  return 'ok'
end

if operation == 'admission_recover' then
  local claim = redis.call('GET', KEYS[1]) or ''
  if claim ~= ARGV[2] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(claim) + string.len(ARGV[3]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes
  }
  if claim == '' then projected.indexes = projected.indexes + 1 end
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))
  save(projected)
  return 'ok'
end

if operation == 'admission_release' then
  local claim = redis.call('GET', KEYS[1])
  if claim ~= ARGV[2] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(claim),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes - 1
  }
  if invalid(projected) then return 'reconcile' end
  redis.call('DEL', KEYS[1])
  save(projected)
  return 'ok'
end

if operation == 'approval_index_create' then
  if redis.call('EXISTS', KEYS[1]) > 0 then return 'conflict' end
  local projected = {
    bytes = current.bytes + string.len(ARGV[2]),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes + 1
  }
  if invalid(projected) then return 'reconcile' end
  if exceeds(projected) then return 'budget' end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]), 'NX')
  save(projected)
  return 'ok'
end

if operation == 'approval_index_delete' then
  local value = redis.call('GET', KEYS[1])
  if value ~= ARGV[2] then return 'conflict' end
  local projected = {
    bytes = current.bytes - string.len(value),
    checkpoints = current.checkpoints,
    events = current.events,
    tombstones = current.tombstones,
    indexes = current.indexes - 1
  }
  if invalid(projected) then return 'reconcile' end
  redis.call('DEL', KEYS[1])
  save(projected)
  return 'ok'
end

return 'invalid_operation'
`;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVE_TTL_SECONDS = 600;
const APPROVAL_WAIT_TTL_SECONDS = 600;
const TOMBSTONE_TTL_SECONDS = 86_400;
const NAMESPACE_SCAN_COUNT = 128;
function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
function checkedRunId(runId) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
        throw new TypeError('run ID is invalid');
    }
    return runId;
}
export function redisRunKeys(runId) {
    const id = digest(checkedRunId(runId));
    return Object.freeze({
        checkpoint: `${RUN_STORE_NAMESPACE}checkpoint:${id}`,
        events: `${RUN_STORE_NAMESPACE}events:${id}`,
        tombstone: `${RUN_STORE_NAMESPACE}tombstone:${id}`
    });
}
export function redisAdmissionKey(address) {
    return `${RUN_STORE_NAMESPACE}admission:${digest(canonicalSessionKey(address))}`;
}
function storageUnavailable(operation, cause) {
    return new AgentError({
        code: 'storage_unavailable',
        stage: 'run.store',
        retryable: true,
        userMessage: '任务状态暂时无法保存，请稍后重试。',
        details: { operation },
        cause
    });
}
function checkpointInvalid(operation, cause) {
    return new AgentError({
        code: 'checkpoint_invalid',
        stage: 'run.checkpoint',
        retryable: false,
        userMessage: '任务状态已损坏或不兼容，请重新发起。',
        details: { operation },
        cause
    });
}
function runBudgetExceeded(operation) {
    return new AgentError({
        code: 'run_budget_exceeded',
        stage: 'run.store',
        retryable: false,
        userMessage: '当前任务队列已达到资源上限，请稍后重试。',
        details: { operation }
    });
}
function emptyNamespaceUsage() {
    return { bytes: 0, checkpoints: 0, events: 0, tombstones: 0, indexes: 0 };
}
function encodeNamespaceUsage(usage) {
    return [
        usage.bytes,
        usage.checkpoints,
        usage.events,
        usage.tombstones,
        usage.indexes
    ].join('|');
}
function namespaceLimitExceeded(usage) {
    return usage.bytes > RUN_RESOURCE_LIMITS.namespaceBytes ||
        usage.checkpoints > RUN_RESOURCE_LIMITS.checkpointKeys ||
        usage.events > RUN_RESOURCE_LIMITS.eventKeys ||
        usage.tombstones > RUN_RESOURCE_LIMITS.tombstoneKeys ||
        usage.indexes > RUN_RESOURCE_LIMITS.indexAdmissionKeys;
}
async function auditNamespace(client) {
    const usage = emptyNamespaceUsage();
    const seen = new Set();
    let cursor = 0;
    try {
        do {
            const page = await client.scan(cursor, {
                MATCH: `${RUN_STORE_NAMESPACE}*`,
                COUNT: NAMESPACE_SCAN_COUNT
            });
            if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 ||
                !Array.isArray(page.keys)) {
                throw new TypeError('invalid namespace scan result');
            }
            for (const key of page.keys) {
                if (key === RUN_STORE_METADATA_KEY || seen.has(key))
                    continue;
                seen.add(key);
                const raw = await client.get(key);
                if (raw === null)
                    continue;
                usage.bytes += Buffer.byteLength(raw, 'utf8');
                if (key.startsWith(`${RUN_STORE_NAMESPACE}checkpoint:`))
                    usage.checkpoints += 1;
                else if (key.startsWith(`${RUN_STORE_NAMESPACE}events:`))
                    usage.events += 1;
                else if (key.startsWith(`${RUN_STORE_NAMESPACE}tombstone:`))
                    usage.tombstones += 1;
                else
                    usage.indexes += 1;
                if (namespaceLimitExceeded(usage))
                    throw runBudgetExceeded('namespace_reconcile');
            }
            cursor = page.cursor;
        } while (cursor !== 0);
        return usage;
    }
    catch (error) {
        if (error instanceof AgentError)
            throw error;
        throw storageUnavailable('namespace_reconcile', error);
    }
}
async function evaluate(client, operation, keys, args) {
    try {
        return await client.eval(RUN_STORE_LUA_SCRIPT, {
            keys: [...keys],
            arguments: [operation, ...args]
        });
    }
    catch (error) {
        throw storageUnavailable(operation, error);
    }
}
async function reconcileNamespace(client) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        let expected;
        try {
            expected = await client.get(RUN_STORE_METADATA_KEY);
        }
        catch (error) {
            throw storageUnavailable('namespace_metadata', error);
        }
        const usage = await auditNamespace(client);
        const result = await evaluate(client, 'reconcile', [RUN_STORE_METADATA_KEY], [
            expected ?? '',
            encodeNamespaceUsage(usage)
        ]);
        if (result === 'ok')
            return;
        if (result !== 'conflict') {
            throw storageUnavailable('namespace_reconcile', new TypeError('unexpected Lua result'));
        }
    }
    throw new RunStoreConflictError();
}
async function mutate(client, operation, keys, args) {
    let reconciled = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = await evaluate(client, operation, [...keys, RUN_STORE_METADATA_KEY], args);
        if (result === 'reconcile' || (result === 'budget' && !reconciled)) {
            await reconcileNamespace(client);
            reconciled = true;
            continue;
        }
        return result;
    }
    throw new RunStoreConflictError();
}
function requireMutationSuccess(result, operation) {
    if (result === 'ok')
        return;
    if (result === 'conflict')
        throw new RunStoreConflictError();
    if (result === 'budget')
        throw runBudgetExceeded(operation);
    throw storageUnavailable(operation, new TypeError('unexpected Lua result'));
}
function encodeTombstone(value) {
    const parsed = parseRunTombstone(value);
    const raw = JSON.stringify(parsed);
    if (Buffer.byteLength(raw, 'utf8') > RUN_RESOURCE_LIMITS.tombstoneBytes) {
        throw checkpointInvalid('encode_tombstone', new TypeError('tombstone byte limit exceeded'));
    }
    return raw;
}
export async function acquireAdmissionClaim(client, key, leaseId, ttlSeconds) {
    const result = await mutate(client, 'admission_acquire', [key], [
        leaseId,
        String(ttlSeconds)
    ]);
    if (result === 'conflict')
        return false;
    requireMutationSuccess(result, 'admission_acquire');
    return true;
}
export async function releaseAdmissionClaim(client, key, leaseId) {
    const result = await mutate(client, 'admission_release', [key], [leaseId]);
    if (result === 'conflict')
        return;
    requireMutationSuccess(result, 'admission_release');
}
export async function recoverAdmissionClaim(client, key, leaseId, ttlSeconds) {
    let expected;
    try {
        expected = await client.get(key);
    }
    catch (error) {
        throw storageUnavailable('admission_recover', error);
    }
    const result = await mutate(client, 'admission_recover', [key], [
        expected ?? '',
        leaseId,
        String(ttlSeconds)
    ]);
    requireMutationSuccess(result, 'admission_recover');
}
export async function createApprovalRunIndex(client, key, value, ttlSeconds) {
    if (!key.startsWith(`${RUN_STORE_NAMESPACE}approval-index:`) ||
        Buffer.byteLength(value, 'utf8') > 1_024 ||
        !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
        throw new TypeError('approval run index is invalid');
    }
    const result = await mutate(client, 'approval_index_create', [key], [
        value,
        String(ttlSeconds)
    ]);
    if (result === 'conflict')
        return false;
    requireMutationSuccess(result, 'approval_index_create');
    return true;
}
export async function deleteApprovalRunIndex(client, key, value) {
    if (!key.startsWith(`${RUN_STORE_NAMESPACE}approval-index:`) ||
        Buffer.byteLength(value, 'utf8') > 1_024) {
        throw new TypeError('approval run index is invalid');
    }
    const result = await mutate(client, 'approval_index_delete', [key], [value]);
    if (result === 'conflict')
        return;
    requireMutationSuccess(result, 'approval_index_delete');
}
export class RedisRunStore {
    #client;
    #codec = new RunCheckpointCodec();
    #activeTtlSeconds;
    constructor(options) {
        this.#client = options.client;
        this.#activeTtlSeconds = options.activeTtlSeconds ?? ACTIVE_TTL_SECONDS;
        if (!Number.isSafeInteger(this.#activeTtlSeconds) ||
            this.#activeTtlSeconds < 300 || this.#activeTtlSeconds > 86_400) {
            throw new TypeError('active run TTL is invalid');
        }
    }
    async create(checkpoint) {
        if (checkpoint.revision !== 0 || checkpoint.status !== 'created') {
            throw new RunStoreConflictError();
        }
        const encoded = this.#encode(checkpoint, 'create');
        const keys = redisRunKeys(checkpoint.runId);
        const result = await mutate(this.#client, 'create', [
            keys.checkpoint, keys.events, keys.tombstone
        ], [encoded.checkpoint, encoded.events, String(this.#activeTtlSeconds)]);
        requireMutationSuccess(result, 'create');
        return checkpoint;
    }
    async load(runId) {
        const keys = redisRunKeys(runId);
        const result = await evaluate(this.#client, 'load', [
            keys.checkpoint, keys.events
        ], []);
        if (!Array.isArray(result) || result.length !== 2) {
            throw storageUnavailable('load', new TypeError('unexpected Lua result'));
        }
        const checkpointRaw = result[0] === false || result[0] === null
            ? null
            : result[0];
        const eventsRaw = result[1] === false || result[1] === null
            ? null
            : result[1];
        if (checkpointRaw === null && eventsRaw === null)
            return null;
        if (typeof checkpointRaw !== 'string' || typeof eventsRaw !== 'string') {
            throw checkpointInvalid('load', new TypeError('split checkpoint is incomplete'));
        }
        try {
            const decoded = this.#codec.decode(checkpointRaw, eventsRaw);
            if (decoded.runId !== runId)
                throw new TypeError('run ID does not match its key');
            return decoded;
        }
        catch (error) {
            throw checkpointInvalid('load', error);
        }
    }
    async compareAndSet(expected, next) {
        if (next.runId !== expected.runId || next.sessionId !== expected.sessionId ||
            next.revision !== expected.revision + 1 || isTerminalRunStatus(expected.status)) {
            throw new RunStoreConflictError();
        }
        const expectedEncoded = this.#encode(expected, 'compare_expected');
        const nextEncoded = this.#encode(next, 'compare_next');
        const keys = redisRunKeys(expected.runId);
        const terminal = isTerminalRunStatus(next.status);
        const tombstone = terminal ? encodeTombstone(createRunTombstone(next)) : '';
        const activeTtlSeconds = next.status === 'waiting_approval'
            ? Math.max(this.#activeTtlSeconds, APPROVAL_WAIT_TTL_SECONDS)
            : this.#activeTtlSeconds;
        const result = await mutate(this.#client, 'cas', [
            keys.checkpoint, keys.events, keys.tombstone
        ], [
            expectedEncoded.checkpoint,
            expectedEncoded.events,
            nextEncoded.checkpoint,
            nextEncoded.events,
            String(activeTtlSeconds),
            terminal ? '1' : '0',
            tombstone,
            String(TOMBSTONE_TTL_SECONDS)
        ]);
        requireMutationSuccess(result, 'compare_and_set');
        return next;
    }
    async appendEvents(expected, events) {
        if (events.length === 0)
            return expected;
        return await this.compareAndSet(expected, checkpointWithAppendedEvents(expected, events));
    }
    async finish(expected, summary) {
        const parsed = parseRunTombstone(summary);
        if (parsed.runId !== expected.runId || parsed.sessionId !== expected.sessionId ||
            parsed.revision !== expected.revision + 1 || isTerminalRunStatus(expected.status)) {
            throw new RunStoreConflictError();
        }
        const encoded = this.#encode(expected, 'finish_expected');
        const keys = redisRunKeys(expected.runId);
        const result = await mutate(this.#client, 'finish', [
            keys.checkpoint, keys.events, keys.tombstone
        ], [
            encoded.checkpoint,
            encoded.events,
            encodeTombstone(parsed),
            String(TOMBSTONE_TTL_SECONDS)
        ]);
        requireMutationSuccess(result, 'finish');
        return parsed;
    }
    async loadTombstone(runId) {
        const key = redisRunKeys(runId).tombstone;
        let raw;
        try {
            raw = await this.#client.get(key);
        }
        catch (error) {
            throw storageUnavailable('load_tombstone', error);
        }
        if (raw === null)
            return null;
        if (Buffer.byteLength(raw, 'utf8') > RUN_RESOURCE_LIMITS.tombstoneBytes) {
            throw checkpointInvalid('load_tombstone', new TypeError('tombstone byte limit exceeded'));
        }
        try {
            const decoded = parseRunTombstone(JSON.parse(raw));
            if (decoded.runId !== runId)
                throw new TypeError('run ID does not match its tombstone key');
            return decoded;
        }
        catch (error) {
            throw checkpointInvalid('load_tombstone', error);
        }
    }
    #encode(checkpoint, operation) {
        try {
            return this.#codec.encode(checkpoint);
        }
        catch (error) {
            throw checkpointInvalid(operation, error);
        }
    }
}

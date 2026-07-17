import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js';
import { parseTraceCandidate } from '../../agent/run/run-trace.js';
import { parsePresentationObservation } from './observation-event.js';
import { mergeStoredTracePresentation, parseStoredTraceRecord } from './trace-record.js';
export const TRACE_KEY_PREFIX = 'GROUPMATE:OBS:TRACE:v1:';
export const TRACE_SUCCESS_INDEX_KEY = 'GROUPMATE:OBS:TRACE_SUCCESS_INDEX:v1';
export const TRACE_FAILURE_INDEX_KEY = 'GROUPMATE:OBS:TRACE_FAILURE_INDEX:v1';
export const TRACE_BYTES_KEY = 'GROUPMATE:OBS:TRACE_BYTES:v1';
export const TRACE_GENERATION_KEY = 'GROUPMATE:OBS:TRACE_GENERATION:v1';
export const TRACE_STORE_LUA_MARKER = '-- GROUPMATE_TRACE_STORE_V1';
const MAX_RECORDS = 64;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CLEAR = 64;
const MAX_STALE_CLEANUP = 64;
export const TRACE_STORE_LUA_SCRIPT = `${TRACE_STORE_LUA_MARKER}
local operation = ARGV[1]
local successIndex = KEYS[2]
local failureIndex = KEYS[3]
local bytesKey = KEYS[4]
local generationKey = KEYS[5]

local function currentGeneration()
  return tonumber(redis.call('GET', generationKey) or '0')
end

local function currentBytes()
  return tonumber(redis.call('HGET', bytesKey, '__total') or '0')
end

local function saveBytes(value)
  if value <= 0 then
    redis.call('DEL', bytesKey)
  else
    redis.call('HSET', bytesKey, '__total', value)
  end
end

local function removeKey(key)
  local length = tonumber(redis.call('HGET', bytesKey, key) or '0')
  redis.call('DEL', key)
  redis.call('ZREM', successIndex, key)
  redis.call('ZREM', failureIndex, key)
  redis.call('HDEL', bytesKey, key)
  return length
end

local function cleanupExpired(nowMs)
  local remaining = ${MAX_STALE_CLEANUP}
  local removedBytes = 0
  for _, index in ipairs({ successIndex, failureIndex }) do
    if remaining > 0 then
      local keys = redis.call('ZRANGEBYSCORE', index, '-inf', nowMs, 'LIMIT', 0, remaining)
      for _, key in ipairs(keys) do
        removedBytes = removedBytes + removeKey(key)
        remaining = remaining - 1
      end
    end
  end
  saveBytes(math.max(0, currentBytes() - removedBytes))
end

local function oldestEvictable(skip)
  local successes = redis.call('ZRANGE', successIndex, 0, -1)
  for _, key in ipairs(successes) do if key ~= skip then return key end end
  local failures = redis.call('ZRANGE', failureIndex, 0, -1)
  for _, key in ipairs(failures) do if key ~= skip then return key end end
  return nil
end

local function ensureCapacity(additionalBytes, additionalRecords, skip)
  local bytes = currentBytes()
  local records = redis.call('ZCARD', successIndex) + redis.call('ZCARD', failureIndex)
  local guard = ${MAX_RECORDS}
  while (records + additionalRecords > ${MAX_RECORDS} or bytes + additionalBytes > ${MAX_BYTES}) and guard > 0 do
    local victim = oldestEvictable(skip)
    if not victim then return false end
    bytes = math.max(0, bytes - removeKey(victim))
    records = records - 1
    guard = guard - 1
  end
  saveBytes(bytes)
  return records + additionalRecords <= ${MAX_RECORDS} and bytes + additionalBytes <= ${MAX_BYTES}
end

local function generationCheck(expected)
  local current = currentGeneration()
  if current ~= tonumber(expected) then return { 'stale_generation', tostring(current) } end
  return nil
end

local function clearBounded(limit)
  local beforeBytes = currentBytes()
  local removed = 0
  local removedBytes = 0
  for _, index in ipairs({ successIndex, failureIndex }) do
    if removed < limit then
      local keys = redis.call('ZRANGE', index, 0, limit - removed - 1)
      for _, key in ipairs(keys) do
        removedBytes = removedBytes + removeKey(key)
        removed = removed + 1
      end
    end
  end
  local remainingBytes = math.max(0, beforeBytes - removedBytes)
  saveBytes(remainingBytes)
  local remaining = redis.call('ZCARD', successIndex) + redis.call('ZCARD', failureIndex)
  return { removed, removedBytes, remaining, remainingBytes }
end

if operation == 'upsert' then
  local stale = generationCheck(ARGV[2])
  if stale then return stale end
  cleanupExpired(tonumber(ARGV[3]))
  local existing = redis.call('GET', KEYS[1])
  if existing then
    if existing == ARGV[4] then return { 'unchanged', ARGV[2] } end
    return { 'conflict', ARGV[2] }
  end
  local length = string.len(ARGV[4])
  if not ensureCapacity(length, 1, '') then return { 'capacity', ARGV[2] } end
  redis.call('SET', KEYS[1], ARGV[4])
  redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[5]))
  redis.call('HSET', bytesKey, KEYS[1], length)
  if ARGV[6] == 'failure' then
    redis.call('ZADD', failureIndex, tonumber(ARGV[5]), KEYS[1])
  else
    redis.call('ZADD', successIndex, tonumber(ARGV[5]), KEYS[1])
  end
  saveBytes(currentBytes() + length)
  return { 'stored', ARGV[2] }
end

if operation == 'append' then
  local stale = generationCheck(ARGV[2])
  if stale then return stale end
  cleanupExpired(tonumber(ARGV[3]))
  local existing = redis.call('GET', KEYS[1])
  if not existing then return { 'not_found', ARGV[2] } end
  if existing ~= ARGV[4] then return { 'conflict', ARGV[2] } end
  if existing == ARGV[5] then return { 'unchanged', ARGV[2] } end
  local delta = string.len(ARGV[5]) - string.len(existing)
  if delta > 0 and not ensureCapacity(delta, 0, KEYS[1]) then
    return { 'capacity', ARGV[2] }
  end
  redis.call('SET', KEYS[1], ARGV[5])
  redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[6]))
  redis.call('HSET', bytesKey, KEYS[1], string.len(ARGV[5]))
  if ARGV[7] == 'failure' then
    redis.call('ZREM', successIndex, KEYS[1])
    redis.call('ZADD', failureIndex, tonumber(ARGV[6]), KEYS[1])
  end
  saveBytes(math.max(0, currentBytes() + delta))
  return { 'stored', ARGV[2] }
end

if operation == 'delete_corrupt' then
  local existing = redis.call('GET', KEYS[1])
  if existing and existing == ARGV[2] then
    local length = removeKey(KEYS[1])
    saveBytes(math.max(0, currentBytes() - length))
  end
  return 'ok'
end

if operation == 'missing_state' then
  local nowMs = tonumber(ARGV[2])
  local successScore = redis.call('ZSCORE', successIndex, KEYS[1])
  local failureScore = redis.call('ZSCORE', failureIndex, KEYS[1])
  local score = successScore or failureScore
  if score and tonumber(score) <= nowMs then
    local length = removeKey(KEYS[1])
    saveBytes(math.max(0, currentBytes() - length))
    return 'expired'
  end
  return 'not_retained'
end

if operation == 'list' then
  cleanupExpired(tonumber(ARGV[2]))
  local output = {}
  for _, index in ipairs({ successIndex, failureIndex }) do
    local keys = redis.call('ZREVRANGE', index, 0, tonumber(ARGV[3]) - 1)
    for _, key in ipairs(keys) do
      local raw = redis.call('GET', key)
      if raw then
        table.insert(output, key)
        table.insert(output, raw)
      end
    end
  end
  return output
end

if operation == 'usage' then
  cleanupExpired(tonumber(ARGV[2]))
  return {
    redis.call('ZCARD', successIndex) + redis.call('ZCARD', failureIndex),
    currentBytes()
  }
end

if operation == 'clear' then return clearBounded(tonumber(ARGV[2])) end

if operation == 'advance_clear' then
  local generation = redis.call('INCR', generationKey)
  local cleared = clearBounded(tonumber(ARGV[2]))
  return { generation, cleared[1], cleared[2], cleared[3], cleared[4] }
end

return 'invalid_operation'
`;
function finiteNow(now) {
    try {
        const value = now();
        return Number.isFinite(value) ? Math.trunc(value) : 0;
    }
    catch {
        return 0;
    }
}
function numeric(value, label) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(number) || number < 0)
        throw new TypeError(`${label} is invalid`);
    return number;
}
function tuple(value, minimum, label) {
    if (!Array.isArray(value) || value.length < minimum) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function rejected(code) {
    return Object.freeze({ schemaVersion: 1, kind: 'rejected', code });
}
function retainedAs(record) {
    if (record.terminal.status === 'failed')
        return 'failed';
    if (record.terminal.status === 'cancelled')
        return 'cancelled';
    if (record.presentation.kind === 'observed' && (record.presentation.value.postprocessAnomaly ||
        record.presentation.value.outcome === 'partial' ||
        record.presentation.value.outcome === 'failed' ||
        record.presentation.value.outcome === 'unknown' ||
        record.presentation.value.deliveries.some(delivery => delivery.outcome !== 'sent')))
        return 'presentation_anomaly';
    if (record.policy.levelAtStart === 'diagnostic')
        return 'diagnostic';
    return 'sampled_success';
}
function indexClass(record) {
    const retention = retainedAs(record);
    return retention === 'failed' || retention === 'cancelled' ||
        retention === 'presentation_anomaly' ? 'failure' : 'success';
}
function sameEngineFact(left, right) {
    const { presentation: _leftPresentation, serializedBytes: _leftBytes, ...leftEngine } = left;
    const { presentation: _rightPresentation, serializedBytes: _rightBytes, ...rightEngine } = right;
    return JSON.stringify(leftEngine) === JSON.stringify(rightEngine);
}
export class RedisTraceStore {
    #client;
    #now;
    #generation = 0;
    #generationKnown = false;
    #barrierInProgress = false;
    constructor(options) {
        if (options.client === null || typeof options.client !== 'object' ||
            typeof options.client.eval !== 'function' || typeof options.client.get !== 'function') {
            throw new TypeError('trace Redis client is invalid');
        }
        this.#client = options.client;
        this.#now = options.now ?? Date.now;
    }
    async upsertEngine(value) {
        const candidate = parseTraceCandidate(value);
        const record = parseStoredTraceRecord(candidate);
        const key = `${TRACE_KEY_PREFIX}${record.runRef}`;
        const existingRaw = await this.#client.get(key);
        if (existingRaw !== null && existingRaw !== JSON.stringify(record)) {
            try {
                const existing = parseStoredTraceRecord(JSON.parse(existingRaw));
                if (sameEngineFact(existing, record)) {
                    return Object.freeze({ schemaVersion: 1, kind: 'unchanged' });
                }
            }
            catch {
                await this.#repairCorrupt(key, existingRaw);
                return rejected('corrupt');
            }
        }
        return await this.#writeWithGeneration('upsert', [
            String(finiteNow(this.#now)),
            JSON.stringify(record),
            String(Date.parse(record.expiresAt)),
            indexClass(record)
        ], record.runRef);
    }
    async appendPresentation(value) {
        const presentation = parsePresentationObservation(value);
        if (presentation.runRef === 'unavailable' ||
            presentation.terminalObservationId === 'unavailable' ||
            presentation.terminalObservationId === 'not_attempted')
            return rejected('not_found');
        const key = `${TRACE_KEY_PREFIX}${presentation.runRef}`;
        let raw;
        try {
            raw = await this.#client.get(key);
        }
        catch {
            return rejected('not_found');
        }
        if (raw === null)
            return rejected('not_found');
        let record;
        try {
            record = parseStoredTraceRecord(JSON.parse(raw));
        }
        catch {
            await this.#repairCorrupt(key, raw);
            return rejected('corrupt');
        }
        if (finiteNow(this.#now) >= Date.parse(record.expiresAt)) {
            await this.#repairCorrupt(key, raw);
            return rejected('expired');
        }
        let merged;
        try {
            merged = mergeStoredTracePresentation({ record, presentation });
        }
        catch {
            return rejected('conflict');
        }
        return await this.#writeWithGeneration('append', [
            String(finiteNow(this.#now)),
            raw,
            JSON.stringify(merged),
            String(Date.parse(record.expiresAt)),
            indexClass(merged)
        ], record.runRef);
    }
    async load(runRef) {
        this.#assertRunRef(runRef);
        const key = `${TRACE_KEY_PREFIX}${runRef}`;
        let raw;
        try {
            raw = await this.#client.get(key);
        }
        catch {
            return Object.freeze({ kind: 'unavailable' });
        }
        if (raw === null) {
            try {
                const state = await this.#eval('missing_state', [
                    String(finiteNow(this.#now))
                ], runRef);
                return Object.freeze({ kind: state === 'expired' ? 'expired' : 'not_retained' });
            }
            catch {
                return Object.freeze({ kind: 'unavailable' });
            }
        }
        let record;
        try {
            record = parseStoredTraceRecord(JSON.parse(raw));
        }
        catch {
            await this.#repairCorrupt(key, raw);
            return Object.freeze({ kind: 'corrupt' });
        }
        if (finiteNow(this.#now) >= Date.parse(record.expiresAt)) {
            await this.#repairCorrupt(key, raw);
            return Object.freeze({ kind: 'expired' });
        }
        return Object.freeze({ kind: 'found', record });
    }
    async listRecent(limit) {
        const bounded = this.#boundedLimit(limit, MAX_RECORDS, 'trace list limit');
        try {
            const result = await this.#eval('list', [String(finiteNow(this.#now)), String(bounded)]);
            const rawRows = tuple(result, 0, 'trace list result');
            if (rawRows.length % 2 !== 0)
                throw new TypeError('trace list result is invalid');
            const records = [];
            for (let index = 0; index < rawRows.length; index += 2) {
                const key = rawRows[index];
                const raw = rawRows[index + 1];
                if (typeof key !== 'string' || !key.startsWith(TRACE_KEY_PREFIX) ||
                    typeof raw !== 'string')
                    continue;
                try {
                    records.push(parseStoredTraceRecord(JSON.parse(raw)));
                }
                catch {
                    await this.#repairCorrupt(key, raw);
                }
            }
            const rows = records
                .sort((left, right) => {
                const time = Date.parse(right.terminal.finishedAt) - Date.parse(left.terminal.finishedAt);
                return time !== 0 ? time : left.runRef.localeCompare(right.runRef);
            })
                .slice(0, bounded)
                .map(record => Object.freeze({
                schemaVersion: 1,
                runRef: record.runRef,
                outcome: record.terminal.status,
                retention: retainedAs(record),
                finishedAt: record.terminal.finishedAt
            }));
            return Object.freeze(rows);
        }
        catch {
            return Object.freeze([]);
        }
    }
    async usage() {
        try {
            const result = tuple(await this.#eval('usage', [
                String(finiteNow(this.#now))
            ]), 2, 'trace usage result');
            return Object.freeze({
                schemaVersion: 1,
                records: numeric(result[0], 'trace usage records'),
                bytes: numeric(result[1], 'trace usage bytes')
            });
        }
        catch {
            return Object.freeze({ schemaVersion: 1, records: 0, bytes: 0 });
        }
    }
    async clear(maxRecords = 64) {
        const bounded = this.#boundedLimit(maxRecords, MAX_CLEAR, 'trace clear limit');
        return this.#clearReceipt(await this.#eval('clear', [String(bounded)]));
    }
    async advanceGenerationAndClear(maxRecords = 64) {
        const bounded = this.#boundedLimit(maxRecords, MAX_CLEAR, 'trace clear limit');
        this.#barrierInProgress = true;
        try {
            const result = tuple(await this.#eval('advance_clear', [String(bounded)]), 5, 'trace barrier result');
            const generation = numeric(result[0], 'trace generation');
            this.#generation = generation;
            this.#generationKnown = true;
            return Object.freeze({
                schemaVersion: 1,
                generation,
                clear: this.#clearReceipt(result.slice(1))
            });
        }
        finally {
            this.#barrierInProgress = false;
        }
    }
    async #writeWithGeneration(operation, rest, runRef) {
        this.#assertRunRef(runRef);
        const frozen = this.#generation;
        let result = await this.#eval(operation, [String(frozen), ...rest], runRef);
        let parsed = this.#writeResult(result);
        if (parsed.kind === 'stale' && !this.#generationKnown &&
            !this.#barrierInProgress && this.#generation === frozen) {
            this.#generation = parsed.generation;
            this.#generationKnown = true;
            result = await this.#eval(operation, [String(parsed.generation), ...rest], runRef);
            parsed = this.#writeResult(result);
        }
        if (parsed.kind === 'stale')
            return rejected('stale_generation');
        this.#generation = parsed.generation;
        this.#generationKnown = true;
        if (parsed.code === 'stored' || parsed.code === 'unchanged') {
            return Object.freeze({ schemaVersion: 1, kind: parsed.code });
        }
        if (parsed.code === 'conflict' || parsed.code === 'capacity' ||
            parsed.code === 'not_found')
            return rejected(parsed.code);
        return rejected('conflict');
    }
    #writeResult(value) {
        const result = tuple(value, 2, 'trace write result');
        const code = String(result[0]);
        const generation = numeric(result[1], 'trace write generation');
        return code === 'stale_generation'
            ? { kind: 'stale', generation }
            : { kind: 'result', code, generation };
    }
    async #repairCorrupt(key, raw) {
        try {
            await this.#client.eval(TRACE_STORE_LUA_SCRIPT, {
                keys: [
                    key,
                    TRACE_SUCCESS_INDEX_KEY,
                    TRACE_FAILURE_INDEX_KEY,
                    TRACE_BYTES_KEY,
                    TRACE_GENERATION_KEY
                ],
                arguments: ['delete_corrupt', raw]
            });
        }
        catch {
            // A failed repair remains a fixed corrupt/unavailable result to callers.
        }
    }
    async #eval(operation, args, runRef) {
        return await this.#client.eval(TRACE_STORE_LUA_SCRIPT, {
            keys: [
                runRef === undefined ? TRACE_KEY_PREFIX : `${TRACE_KEY_PREFIX}${runRef}`,
                TRACE_SUCCESS_INDEX_KEY,
                TRACE_FAILURE_INDEX_KEY,
                TRACE_BYTES_KEY,
                TRACE_GENERATION_KEY
            ],
            arguments: [operation, ...args]
        });
    }
    #clearReceipt(value) {
        const result = tuple(value, 4, 'trace clear result');
        return Object.freeze({
            schemaVersion: 1,
            removedRecords: numeric(result[0], 'trace removed records'),
            removedBytes: numeric(result[1], 'trace removed bytes'),
            remainingRecords: numeric(result[2], 'trace remaining records'),
            remainingBytes: numeric(result[3], 'trace remaining bytes')
        });
    }
    #boundedLimit(value, maximum, label) {
        if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
            throw new TypeError(`${label} is invalid`);
        }
        return value;
    }
    #assertRunRef(runRef) {
        if (typeof runRef !== 'string' || !RUN_REF_PATTERN.test(runRef)) {
            throw new TypeError('trace run reference is invalid');
        }
    }
}

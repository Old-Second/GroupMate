import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { decodeCanonicalMemoryRecordV1, encodeCanonicalMemoryRecordV1 } from './memory-canonical-wire.js';
import { MEMORY_HOT_CACHE_ACCOUNTING_V1, createMemoryHotCachePortV1 } from './memory-hot-cache.js';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit } from './memory-resource-limits.js';
export const MEMORY_HOT_CACHE_NAMESPACE = 'GROUPMATE:MEMORY_HOT:v1:';
export const MEMORY_HOT_CACHE_RECORDS_KEY = `${MEMORY_HOT_CACHE_NAMESPACE}records`;
export const MEMORY_HOT_CACHE_EXPIRES_KEY = `${MEMORY_HOT_CACHE_NAMESPACE}expires`;
export const MEMORY_HOT_CACHE_LRU_KEY = `${MEMORY_HOT_CACHE_NAMESPACE}lru`;
export const MEMORY_HOT_CACHE_METADATA_KEY = `${MEMORY_HOT_CACHE_NAMESPACE}metadata`;
export const MEMORY_HOT_CACHE_SCRIPT_VERSION_KEY = `${MEMORY_HOT_CACHE_NAMESPACE}script-version`;
export const MEMORY_HOT_CACHE_KEYS = Object.freeze([
    MEMORY_HOT_CACHE_RECORDS_KEY,
    MEMORY_HOT_CACHE_EXPIRES_KEY,
    MEMORY_HOT_CACHE_LRU_KEY,
    MEMORY_HOT_CACHE_METADATA_KEY,
    MEMORY_HOT_CACHE_SCRIPT_VERSION_KEY
]);
export const MEMORY_HOT_CACHE_LUA_MARKER = '-- GROUPMATE_MEMORY_HOT_CACHE_V1';
export const MEMORY_HOT_CACHE_SCRIPT_VERSION = '1';
export const MEMORY_HOT_CACHE_RECORD_FIELD_HASH_DOMAIN = 'groupmate.memory.hot.record-field.v1';
export const MEMORY_HOT_CACHE_COUNTER_FIELDS = Object.freeze({
    recordCount: 'record-count',
    generationCount: 'generation-count',
    recordEntryBytes: 'record-entry-bytes',
    expiryIndexBytes: 'expiry-index-bytes',
    lruIndexBytes: 'lru-index-bytes',
    dynamicMetadataBytes: 'dynamic-metadata-bytes'
});
function utf8Bytes(value) {
    return Buffer.byteLength(value, 'utf8');
}
function domainHash(domain, preimage) {
    return createHash('sha256')
        .update(domain, 'utf8')
        .update('\0')
        .update(preimage, 'utf8')
        .digest('hex');
}
function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function fixedCounter(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999_999_999) {
        return invalidMemoryValue();
    }
    return String(value).padStart(16, '0');
}
export function memoryHotCacheRecordFieldV1(head) {
    const input = inspectMemoryRecord(head, [
        'namespaceRef', 'namespaceGeneration', 'memoryId'
    ], ['revision', 'contentHash']);
    if (typeof input.namespaceRef !== 'string' || !/^[0-9a-f]{64}$/.test(input.namespaceRef) ||
        !memoryAsciiWithinLimit(input.memoryId, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
        !input.memoryId.startsWith('memory:') ||
        input.memoryId.length === 'memory:'.length)
        return invalidMemoryValue();
    const namespaceGeneration = positiveInteger(input.namespaceGeneration);
    const preimage = `{"namespaceRef":${JSON.stringify(input.namespaceRef)},` +
        `"namespaceGeneration":${namespaceGeneration},` +
        `"memoryId":${JSON.stringify(input.memoryId)}}`;
    return domainHash(MEMORY_HOT_CACHE_RECORD_FIELD_HASH_DOMAIN, preimage);
}
export function memoryHotCacheNamespaceFieldV1(namespaceRef) {
    if (!/^[0-9a-f]{64}$/.test(namespaceRef))
        return invalidMemoryValue();
    return `g:${namespaceRef}`;
}
export function memoryHotCacheHeadFieldV1(recordField) {
    if (!/^[0-9a-f]{64}$/.test(recordField))
        return invalidMemoryValue();
    return `h:${recordField}`;
}
export function memoryHotCacheHeadValueV1(revision, recordField) {
    if (!/^[0-9a-f]{64}$/.test(recordField))
        return invalidMemoryValue();
    return `${fixedCounter(positiveInteger(revision))}|${recordField}`;
}
const CALCULATED_MEMORY_HOT_CACHE_STATIC_BYTES = MEMORY_HOT_CACHE_KEYS.reduce((total, key) => total + utf8Bytes(key), 0) +
    utf8Bytes(MEMORY_HOT_CACHE_SCRIPT_VERSION) +
    Object.values(MEMORY_HOT_CACHE_COUNTER_FIELDS)
        .reduce((total, field) => total + utf8Bytes(field) + 16, 0);
if (CALCULATED_MEMORY_HOT_CACHE_STATIC_BYTES !== MEMORY_HOT_CACHE_ACCOUNTING_V1.staticBytes) {
    invalidMemoryValue();
}
export const MEMORY_HOT_CACHE_STATIC_BYTES = MEMORY_HOT_CACHE_ACCOUNTING_V1.staticBytes;
export function memoryHotCacheRecordEntryBytesV1(field, wire) {
    return utf8Bytes(field) + utf8Bytes(wire);
}
export function memoryHotCacheIndexEntryBytesV1(field) {
    return utf8Bytes(field) + 16;
}
export function memoryHotCacheMetadataEntryBytesV1(field, value) {
    return utf8Bytes(field) + utf8Bytes(value);
}
export const MEMORY_HOT_CACHE_LUA_SCRIPT = `${MEMORY_HOT_CACHE_LUA_MARKER}
local operation = ARGV[1]
local recordsKey = KEYS[1]
local expiresKey = KEYS[2]
local lruKey = KEYS[3]
local metadataKey = KEYS[4]
local versionKey = KEYS[5]
local VERSION = '${MEMORY_HOT_CACHE_SCRIPT_VERSION}'
local STATIC_BYTES = ${MEMORY_HOT_CACHE_STATIC_BYTES}
local RECORD_LIMIT = ${MEMORY_RESOURCE_LIMITS.redisHotRecords}
local GENERATION_LIMIT = ${MEMORY_RESOURCE_LIMITS.deploymentNamespaces}
local BYTE_LIMIT = ${MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes}
local RECORD_WIRE_LIMIT = ${MEMORY_RESOURCE_LIMITS.recordWireBytes}
local TTL_MS = ${MEMORY_RESOURCE_LIMITS.redisHotAbsoluteTtlMs}
local MAX_SAFE_FIXED = '9007199254740991'
local ZERO_FIXED = '0000000000000000'
local RECORD_FIELD_BYTES = ${MEMORY_HOT_CACHE_ACCOUNTING_V1.recordFieldBytes}
local INDEX_ENTRY_BYTES = ${MEMORY_HOT_CACHE_ACCOUNTING_V1.indexEntryBytes}
local HEAD_METADATA_BYTES = ${MEMORY_HOT_CACHE_ACCOUNTING_V1.headMetadataBytes}
local GENERATION_METADATA_BYTES = ${MEMORY_HOT_CACHE_ACCOUNTING_V1.generationMetadataBytes}
local COUNTER_RECORDS = '${MEMORY_HOT_CACHE_COUNTER_FIELDS.recordCount}'
local COUNTER_GENERATIONS = '${MEMORY_HOT_CACHE_COUNTER_FIELDS.generationCount}'
local COUNTER_RECORD_BYTES = '${MEMORY_HOT_CACHE_COUNTER_FIELDS.recordEntryBytes}'
local COUNTER_EXPIRY_BYTES = '${MEMORY_HOT_CACHE_COUNTER_FIELDS.expiryIndexBytes}'
local COUNTER_LRU_BYTES = '${MEMORY_HOT_CACHE_COUNTER_FIELDS.lruIndexBytes}'
local COUNTER_METADATA_BYTES = '${MEMORY_HOT_CACHE_COUNTER_FIELDS.dynamicMetadataBytes}'

local function fixed(value)
  return string.format('%016d', value)
end

local function nowMs()
  local current = redis.call('TIME')
  return tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end

local function emptyState()
  return redis.call('HLEN', recordsKey) == 0 and
    redis.call('ZCARD', expiresKey) == 0 and
    redis.call('ZCARD', lruKey) == 0 and
    redis.call('HLEN', metadataKey) == 0
end

local function initialize()
  local version = redis.call('GET', versionKey)
  if version then return version == VERSION end
  if not emptyState() then return false end
  redis.call('SET', versionKey, VERSION)
  redis.call('HSET', metadataKey,
    COUNTER_RECORDS, '0000000000000000',
    COUNTER_GENERATIONS, '0000000000000000',
    COUNTER_RECORD_BYTES, '0000000000000000',
    COUNTER_EXPIRY_BYTES, '0000000000000000',
    COUNTER_LRU_BYTES, '0000000000000000',
    COUNTER_METADATA_BYTES, '0000000000000000')
  return true
end

local function validFixed(value)
  return value and string.len(value) == 16 and string.match(value, '^%d+$') ~= nil and
    value <= MAX_SAFE_FIXED
end

local function validPositiveFixed(value)
  return validFixed(value) and value ~= ZERO_FIXED
end

local function validRecordField(field)
  return field and string.len(field) == 64 and string.match(field, '^[0-9a-f]+$') ~= nil
end

local function validHeadValue(value, field)
  return validRecordField(field) and value and string.len(value) == 81 and
    validPositiveFixed(string.sub(value, 1, 16)) and string.sub(value, 17, 17) == '|' and
    string.sub(value, 18) == field
end

local function readCounter(field, limit)
  local raw = redis.call('HGET', metadataKey, field)
  if not validFixed(raw) then return nil end
  local value = tonumber(raw)
  if not value or value < 0 or value > limit then return nil end
  return value
end

local function totalBytes(state)
  return STATIC_BYTES + state.recordBytes + state.expiryBytes + state.lruBytes + state.metadataBytes
end

local function validState(state, allowOverLimit)
  if not state or state.records < 0 or state.records > RECORD_LIMIT or
    state.generations < 0 or state.generations > GENERATION_LIMIT or
    state.recordBytes < 0 or state.expiryBytes < 0 or state.lruBytes < 0 or
    state.metadataBytes < 0 or state.records % 1 ~= 0 or state.generations % 1 ~= 0 or
    state.recordBytes % 1 ~= 0 or state.expiryBytes % 1 ~= 0 or
    state.lruBytes % 1 ~= 0 or state.metadataBytes % 1 ~= 0 then return false end
  return state.expiryBytes == state.records * INDEX_ENTRY_BYTES and
    state.lruBytes == state.records * INDEX_ENTRY_BYTES and
    state.metadataBytes == state.records * HEAD_METADATA_BYTES +
      state.generations * GENERATION_METADATA_BYTES and
    state.recordBytes >= state.records * RECORD_FIELD_BYTES and
    state.recordBytes <= state.records * (RECORD_FIELD_BYTES + RECORD_WIRE_LIMIT) and
    (allowOverLimit or totalBytes(state) <= BYTE_LIMIT)
end

local function readState()
  if redis.call('GET', versionKey) ~= VERSION then return nil end
  local state = {
    records = readCounter(COUNTER_RECORDS, RECORD_LIMIT),
    generations = readCounter(COUNTER_GENERATIONS, GENERATION_LIMIT),
    recordBytes = readCounter(COUNTER_RECORD_BYTES, BYTE_LIMIT),
    expiryBytes = readCounter(COUNTER_EXPIRY_BYTES, BYTE_LIMIT),
    lruBytes = readCounter(COUNTER_LRU_BYTES, BYTE_LIMIT),
    metadataBytes = readCounter(COUNTER_METADATA_BYTES, BYTE_LIMIT)
  }
  if not state.records or not state.generations or not state.recordBytes or
    not state.expiryBytes or not state.lruBytes or not state.metadataBytes or
    not validState(state) or
    redis.call('HLEN', recordsKey) ~= state.records or
    redis.call('ZCARD', expiresKey) ~= state.records or
    redis.call('ZCARD', lruKey) ~= state.records or
    redis.call('HLEN', metadataKey) ~= 6 + state.records + state.generations then return nil end
  return state
end

local function saveState(state)
  redis.call('HSET', metadataKey,
    COUNTER_RECORDS, fixed(state.records),
    COUNTER_GENERATIONS, fixed(state.generations),
    COUNTER_RECORD_BYTES, fixed(state.recordBytes),
    COUNTER_EXPIRY_BYTES, fixed(state.expiryBytes),
    COUNTER_LRU_BYTES, fixed(state.lruBytes),
    COUNTER_METADATA_BYTES, fixed(state.metadataBytes))
end

local function boundedWire(field)
  if redis.call('HSTRLEN', recordsKey, field) > RECORD_WIRE_LIMIT then
    return nil, 'oversize'
  end
  local wire = redis.call('HGET', recordsKey, field)
  if not wire then return nil, 'missing' end
  return wire, 'exact'
end

local function removeRecord(state, field, wire, headField, headValue)
  if string.len(wire) > RECORD_WIRE_LIMIT then return false end
  local currentWire, wireStatus = boundedWire(field)
  if wireStatus ~= 'exact' or currentWire ~= wire or
    redis.call('HGET', metadataKey, headField) ~= headValue or
    not redis.call('ZSCORE', expiresKey, field) or
    not redis.call('ZSCORE', lruKey, field) then return false end
  local projected = {
    records = state.records - 1,
    generations = state.generations,
    recordBytes = state.recordBytes - string.len(field) - string.len(wire),
    expiryBytes = state.expiryBytes - string.len(field) - 16,
    lruBytes = state.lruBytes - string.len(field) - 16,
    metadataBytes = state.metadataBytes - string.len(headField) - string.len(headValue)
  }
  if not validState(projected) then return false end
  redis.call('HDEL', recordsKey, field)
  redis.call('ZREM', expiresKey, field)
  redis.call('ZREM', lruKey, field)
  redis.call('HDEL', metadataKey, headField)
  saveState(projected)
  state.records = projected.records
  state.generations = projected.generations
  state.recordBytes = projected.recordBytes
  state.expiryBytes = projected.expiryBytes
  state.lruBytes = projected.lruBytes
  state.metadataBytes = projected.metadataBytes
  return true
end

local function removeVictim(state, field)
  if not validRecordField(field) then return false end
  local wire, wireStatus = boundedWire(field)
  local headField = 'h:' .. field
  local headValue = redis.call('HGET', metadataKey, headField)
  if wireStatus ~= 'exact' or not validHeadValue(headValue, field) then
    return false
  end
  return removeRecord(state, field, wire, headField, headValue)
end

local function cleanupExpired(state, currentTime, limit)
  local victims = redis.call('ZRANGEBYSCORE', expiresKey, '-inf', currentTime, 'LIMIT', 0, limit)
  local removed = 0
  for _, field in ipairs(victims) do
    if not removeVictim(state, field) then return -1 end
    removed = removed + 1
  end
  return removed
end

local function evictOldest(state, skipField)
  local victims = redis.call('ZRANGE', lruKey, 0, 1)
  for _, field in ipairs(victims) do
    if field ~= skipField then
      if not removeVictim(state, field) then return -1 end
      return 1
    end
  end
  return 0
end

if operation == 'put' then
  if not initialize() then return 'version' end
  local state = readState()
  if not state then return 'metadata' end
  local field, generationField, headField = ARGV[2], ARGV[3], ARGV[4]
  local generationRaw, revisionRaw = ARGV[5], ARGV[6]
  local wire, validUntilMs = ARGV[7], tonumber(ARGV[8])
  local generation, revision = tonumber(generationRaw), tonumber(revisionRaw)
  local currentTime = nowMs()
  if not validPositiveFixed(generationRaw) or not validPositiveFixed(revisionRaw) or
    not generation or not revision or not validUntilMs or
    string.len(wire) > RECORD_WIRE_LIMIT then return 'metadata' end
  if validUntilMs <= currentTime then return 'expired' end
  local removed = cleanupExpired(state, currentTime, 32)
  if removed < 0 then return 'metadata' end
  local fenceRaw = redis.call('HGET', metadataKey, generationField)
  if fenceRaw then
    local fence = tonumber(fenceRaw)
    if not fence or not validPositiveFixed(fenceRaw) then return 'metadata' end
    if fence > generation then return 'stale' end
    if fence < generation then
      redis.call('HSET', metadataKey, generationField, generationRaw)
    end
  else
    if state.generations >= GENERATION_LIMIT then return 'capacity' end
    local generationBytes = string.len(generationField) + 16
    while totalBytes(state) + generationBytes > BYTE_LIMIT and removed < 32 do
      local evicted = evictOldest(state, field)
      if evicted < 0 then return 'metadata' end
      if evicted == 0 then break end
      removed = removed + evicted
    end
    if totalBytes(state) + generationBytes > BYTE_LIMIT then return 'capacity' end
    local projected = {
      records = state.records,
      generations = state.generations + 1,
      recordBytes = state.recordBytes,
      expiryBytes = state.expiryBytes,
      lruBytes = state.lruBytes,
      metadataBytes = state.metadataBytes + generationBytes
    }
    if not validState(projected) then return 'metadata' end
    redis.call('HSET', metadataKey, generationField, generationRaw)
    state.generations = projected.generations
    state.metadataBytes = projected.metadataBytes
    saveState(state)
  end
  local expectedHead = revisionRaw .. '|' .. field
  local existing, existingStatus = boundedWire(field)
  if existingStatus == 'oversize' then return 'metadata' end
  local existingHead = redis.call('HGET', metadataKey, headField)
  if existingStatus == 'exact' then
    if not validHeadValue(existingHead, field) or
      not redis.call('ZSCORE', expiresKey, field) or
      not redis.call('ZSCORE', lruKey, field) then return 'metadata' end
    local existingRevision = tonumber(string.sub(existingHead, 1, 16))
    if not existingRevision then return 'metadata' end
    if existingRevision > revision then return 'stale' end
    if existingRevision == revision then
      if existing ~= wire then return 'conflict' end
      redis.call('ZADD', lruKey, currentTime, field)
      saveState(state)
      return 'unchanged'
    end
    local projected = {
      records = state.records,
      generations = state.generations,
      recordBytes = state.recordBytes - string.len(existing) + string.len(wire),
      expiryBytes = state.expiryBytes,
      lruBytes = state.lruBytes,
      metadataBytes = state.metadataBytes - string.len(existingHead) + string.len(expectedHead)
    }
    if not validState(projected, true) then return 'metadata' end
    while totalBytes(projected) > BYTE_LIMIT and removed < 32 do
      local evicted = evictOldest(state, field)
      if evicted < 0 then return 'metadata' end
      if evicted == 0 then break end
      removed = removed + evicted
      projected.recordBytes = state.recordBytes - string.len(existing) + string.len(wire)
      projected.expiryBytes = state.expiryBytes
      projected.lruBytes = state.lruBytes
      projected.metadataBytes = state.metadataBytes - string.len(existingHead) + string.len(expectedHead)
      projected.records = state.records
      if not validState(projected, true) then return 'metadata' end
    end
    if totalBytes(projected) > BYTE_LIMIT then return 'capacity' end
    if not validState(projected) then return 'metadata' end
    redis.call('HSET', recordsKey, field, wire)
    redis.call('HSET', metadataKey, headField, expectedHead)
    redis.call('ZADD', expiresKey, currentTime + TTL_MS, field)
    redis.call('ZADD', lruKey, currentTime, field)
    saveState(projected)
    return 'stored'
  end
  if existingHead or redis.call('ZSCORE', expiresKey, field) or
    redis.call('ZSCORE', lruKey, field) then return 'metadata' end
  local recordBytes = string.len(field) + string.len(wire)
  local indexBytes = string.len(field) + 16
  local headBytes = string.len(headField) + string.len(expectedHead)
  local projected = {
    records = state.records + 1,
    generations = state.generations,
    recordBytes = state.recordBytes + recordBytes,
    expiryBytes = state.expiryBytes + indexBytes,
    lruBytes = state.lruBytes + indexBytes,
    metadataBytes = state.metadataBytes + headBytes
  }
  while (projected.records > RECORD_LIMIT or totalBytes(projected) > BYTE_LIMIT) and removed < 32 do
    local evicted = evictOldest(state, field)
    if evicted < 0 then return 'metadata' end
    if evicted == 0 then break end
    removed = removed + evicted
    projected.records = state.records + 1
    projected.recordBytes = state.recordBytes + recordBytes
    projected.expiryBytes = state.expiryBytes + indexBytes
    projected.lruBytes = state.lruBytes + indexBytes
    projected.metadataBytes = state.metadataBytes + headBytes
  end
  if projected.records > RECORD_LIMIT or totalBytes(projected) > BYTE_LIMIT then
    return 'capacity'
  end
  if not validState(projected) then return 'metadata' end
  redis.call('HSET', recordsKey, field, wire)
  redis.call('ZADD', expiresKey, currentTime + TTL_MS, field)
  redis.call('ZADD', lruKey, currentTime, field)
  redis.call('HSET', metadataKey, headField, expectedHead)
  saveState(projected)
  return 'stored'
end

if operation == 'namespace_invalidate' and not initialize() then return 'version' end
if redis.call('GET', versionKey) == false and emptyState() then return 'missing' end
local state = readState()
if not state then return 'metadata' end

if operation == 'usage' then
  return {
    'usage', fixed(state.records), fixed(state.generations), fixed(state.recordBytes),
    fixed(state.expiryBytes), fixed(state.lruBytes), fixed(state.metadataBytes),
    fixed(STATIC_BYTES), fixed(totalBytes(state))
  }
end

if operation == 'record_invalidate' then
  local field, generationField, headField = ARGV[2], ARGV[3], ARGV[4]
  local generationRaw, deletedRevisionRaw = ARGV[5], ARGV[6]
  local fenceRaw = redis.call('HGET', metadataKey, generationField)
  if not validPositiveFixed(generationRaw) or not validPositiveFixed(deletedRevisionRaw) or
    (fenceRaw and not validPositiveFixed(fenceRaw)) then return 'metadata' end
  if not fenceRaw or fenceRaw ~= generationRaw then return 'unchanged' end
  local wire, wireStatus = boundedWire(field)
  if wireStatus == 'oversize' then return 'metadata' end
  if wireStatus == 'missing' then
    if redis.call('HGET', metadataKey, headField) or
      redis.call('ZSCORE', expiresKey, field) or redis.call('ZSCORE', lruKey, field) then
      return 'metadata'
    end
    return 'unchanged'
  end
  local headValue = redis.call('HGET', metadataKey, headField)
  if not validHeadValue(headValue, field) then return 'metadata' end
  if string.sub(headValue, 1, 16) > deletedRevisionRaw then return 'unchanged' end
  if not removeRecord(state, field, wire, headField, headValue) then return 'metadata' end
  return 'invalidated'
end

if operation == 'namespace_invalidate' then
  local generationField, deletedRaw, nextRaw = ARGV[2], ARGV[3], ARGV[4]
  local fenceRaw = redis.call('HGET', metadataKey, generationField)
  if not validPositiveFixed(deletedRaw) or not validPositiveFixed(nextRaw) or
    (fenceRaw and not validPositiveFixed(fenceRaw)) then return 'metadata' end
  if tonumber(nextRaw) ~= tonumber(deletedRaw) + 1 then return 'metadata' end
  if fenceRaw and fenceRaw >= nextRaw then return 'unchanged' end
  if not fenceRaw then
    if state.generations >= GENERATION_LIMIT then return 'capacity' end
    local generationBytes = string.len(generationField) + 16
    local removed = cleanupExpired(state, nowMs(), 32)
    if removed < 0 then return 'metadata' end
    while totalBytes(state) + generationBytes > BYTE_LIMIT and removed < 32 do
      local evicted = evictOldest(state, '')
      if evicted < 0 then return 'metadata' end
      if evicted == 0 then break end
      removed = removed + evicted
    end
    if totalBytes(state) + generationBytes > BYTE_LIMIT then return 'capacity' end
    local projected = {
      records = state.records,
      generations = state.generations + 1,
      recordBytes = state.recordBytes,
      expiryBytes = state.expiryBytes,
      lruBytes = state.lruBytes,
      metadataBytes = state.metadataBytes + generationBytes
    }
    if not validState(projected) then return 'metadata' end
    state = projected
  elseif fenceRaw > deletedRaw then
    return 'unchanged'
  end
  redis.call('HSET', metadataKey, generationField, nextRaw)
  saveState(state)
  return 'invalidated'
end

if operation == 'peek' then
  local field, generationField, headField = ARGV[2], ARGV[3], ARGV[4]
  local generationRaw, expectedHead = ARGV[5], ARGV[6]
  local fenceRaw = redis.call('HGET', metadataKey, generationField)
  if not fenceRaw then return 'missing' end
  if not validPositiveFixed(generationRaw) or not validPositiveFixed(fenceRaw) or
    not validHeadValue(expectedHead, field) then return 'metadata' end
  if fenceRaw > generationRaw then return 'stale' end
  if fenceRaw < generationRaw then return 'missing' end
  local wire, wireStatus = boundedWire(field)
  if wireStatus == 'oversize' then return 'metadata' end
  if wireStatus == 'missing' then
    if redis.call('HGET', metadataKey, headField) or
      redis.call('ZSCORE', expiresKey, field) or redis.call('ZSCORE', lruKey, field) then
      return 'metadata'
    end
    return 'missing'
  end
  local headValue = redis.call('HGET', metadataKey, headField)
  if not validHeadValue(headValue, field) or
    not redis.call('ZSCORE', lruKey, field) then return 'metadata' end
  local currentHead = string.sub(headValue, 1, 16)
  if headValue ~= expectedHead then
    if currentHead > string.sub(expectedHead, 1, 16) then return 'stale' end
    return 'mismatch'
  end
  local expiry = tonumber(redis.call('ZSCORE', expiresKey, field))
  if not expiry then return 'metadata' end
  if expiry <= nowMs() then
    if not removeRecord(state, field, wire, headField, headValue) then return 'metadata' end
    return 'expired'
  end
  return {'candidate', wire}
end

if operation == 'confirm_hit' then
  local field, generationField, headField = ARGV[2], ARGV[3], ARGV[4]
  local generationRaw, expectedHead, wire = ARGV[5], ARGV[6], ARGV[7]
  local validUntilMs = tonumber(ARGV[8])
  local fenceRaw = redis.call('HGET', metadataKey, generationField)
  local headValue = redis.call('HGET', metadataKey, headField)
  if not validPositiveFixed(generationRaw) or not validPositiveFixed(fenceRaw) or
    not validHeadValue(headValue, field) or string.len(wire) > RECORD_WIRE_LIMIT or
    not validHeadValue(expectedHead, field) then return 'metadata' end
  if fenceRaw ~= generationRaw then return 'stale' end
  if headValue ~= expectedHead then return 'mismatch' end
  local currentWire, wireStatus = boundedWire(field)
  if wireStatus == 'oversize' then return 'metadata' end
  if wireStatus ~= 'exact' or currentWire ~= wire then return 'mismatch' end
  local expiry = tonumber(redis.call('ZSCORE', expiresKey, field))
  if not expiry or not redis.call('ZSCORE', lruKey, field) then return 'metadata' end
  local currentTime = nowMs()
  if expiry <= currentTime or not validUntilMs or validUntilMs <= currentTime then
    if not removeRecord(state, field, wire, headField, expectedHead) then return 'metadata' end
    return 'expired'
  end
  redis.call('ZADD', lruKey, currentTime, field)
  return 'hit'
end

if operation == 'delete_corrupt' then
  local field, headField, wire = ARGV[2], ARGV[3], ARGV[4]
  local headValue = redis.call('HGET', metadataKey, headField)
  local currentWire, wireStatus = boundedWire(field)
  if wireStatus == 'oversize' then return 'metadata' end
  if wireStatus ~= 'exact' or currentWire ~= wire then return 'unchanged' end
  if not validHeadValue(headValue, field) then return 'metadata' end
  if not removeRecord(state, field, wire, headField, headValue) then return 'metadata' end
  return 'invalidated'
end

return 'invalid_operation'
`;
function redisStringArray(value, length) {
    if (!Array.isArray(value) || utilTypes.isProxy(value))
        return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !Object.hasOwn(descriptors, 'length'))
        return null;
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = descriptors[key];
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            descriptor.enumerable !== true || typeof descriptor.value !== 'string')
            return null;
        result.push(descriptor.value);
    }
    return Object.freeze(result);
}
function exactStatus(value) {
    return typeof value === 'string' ? value : null;
}
export class RedisMemoryHotCache {
    #evaluate;
    #port;
    constructor(optionsValue) {
        const options = inspectMemoryRecord(optionsValue, ['client']);
        if (options.client === null || typeof options.client !== 'object' ||
            utilTypes.isProxy(options.client))
            return invalidMemoryValue();
        const client = options.client;
        const ownDescriptor = Object.getOwnPropertyDescriptor(client, 'eval');
        const prototype = Object.getPrototypeOf(client);
        const prototypeDescriptor = prototype === null
            ? undefined
            : Object.getOwnPropertyDescriptor(prototype, 'eval');
        const descriptor = ownDescriptor ?? prototypeDescriptor;
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
            return invalidMemoryValue();
        }
        const evaluate = descriptor.value;
        this.#evaluate = async (script, options) => await Reflect.apply(evaluate, client, [script, options]);
        this.#port = createMemoryHotCachePortV1({
            execute: async (request, signal) => await this.#executeAdapter(request, signal)
        });
    }
    async execute(request, signal) {
        return await this.#port.execute(request, signal);
    }
    async #eval(argumentsValue) {
        try {
            return await this.#evaluate(MEMORY_HOT_CACHE_LUA_SCRIPT, {
                keys: [...MEMORY_HOT_CACHE_KEYS],
                arguments: [...argumentsValue]
            });
        }
        catch {
            return null;
        }
    }
    async #executeAdapter(request, _signal) {
        if (request.operation === 'record.put')
            return await this.#put(request.record);
        if (request.operation === 'record.get')
            return await this.#get(request.head);
        if (request.operation === 'record.invalidate') {
            return await this.#recordInvalidate(request);
        }
        if (request.operation === 'namespace.invalidate') {
            return await this.#namespaceInvalidate(request);
        }
        return await this.#usage();
    }
    async #put(record) {
        const wire = encodeCanonicalMemoryRecordV1(record);
        const field = memoryHotCacheRecordFieldV1({
            namespaceRef: record.namespaceRef,
            namespaceGeneration: record.namespaceGeneration,
            memoryId: record.memoryId
        });
        const result = exactStatus(await this.#eval([
            'put',
            field,
            memoryHotCacheNamespaceFieldV1(record.namespaceRef),
            memoryHotCacheHeadFieldV1(field),
            fixedCounter(record.namespaceGeneration),
            fixedCounter(record.revision),
            wire,
            String(Date.parse(record.retention.validUntil))
        ]));
        if (result === 'stored' || result === 'unchanged')
            return Object.freeze({ status: result });
        if (result === 'stale' || result === 'expired' || result === 'capacity') {
            return Object.freeze({
                status: 'skipped',
                reason: result === 'capacity' ? 'capacity' : result
            });
        }
        return Object.freeze({ status: 'unavailable' });
    }
    async #get(head) {
        const field = memoryHotCacheRecordFieldV1(head);
        const headField = memoryHotCacheHeadFieldV1(field);
        const generationField = memoryHotCacheNamespaceFieldV1(head.namespaceRef);
        const generationRaw = fixedCounter(head.namespaceGeneration);
        const headValue = memoryHotCacheHeadValueV1(head.revision, field);
        const peek = await this.#eval([
            'peek', field, generationField, headField, generationRaw, headValue
        ]);
        const status = exactStatus(peek);
        if (status === 'missing')
            return Object.freeze({ status: 'miss', reason: 'not_found' });
        if (status === 'expired' || status === 'stale' || status === 'mismatch' || status === 'corrupt') {
            return Object.freeze({ status: 'miss', reason: status });
        }
        const tuple = redisStringArray(peek, 2);
        if (tuple === null || tuple[0] !== 'candidate' ||
            utf8Bytes(tuple[1]) > MEMORY_RESOURCE_LIMITS.recordWireBytes) {
            return Object.freeze({ status: 'unavailable' });
        }
        const wire = tuple[1];
        let record;
        try {
            record = decodeCanonicalMemoryRecordV1(wire);
        }
        catch {
            await this.#deleteCorrupt(field, headField, wire);
            return Object.freeze({ status: 'miss', reason: 'corrupt' });
        }
        const matches = record.namespaceRef === head.namespaceRef &&
            record.namespaceGeneration === head.namespaceGeneration &&
            record.memoryId === head.memoryId && record.revision === head.revision &&
            record.contentHash === head.contentHash;
        if (!matches) {
            await this.#deleteCorrupt(field, headField, wire);
            return Object.freeze({ status: 'miss', reason: 'mismatch' });
        }
        const confirmed = exactStatus(await this.#eval([
            'confirm_hit', field, generationField, headField, generationRaw, headValue, wire,
            String(Date.parse(record.retention.validUntil))
        ]));
        if (confirmed === 'hit')
            return Object.freeze({ status: 'hit', record });
        if (confirmed === 'expired' || confirmed === 'stale' ||
            confirmed === 'mismatch' || confirmed === 'corrupt') {
            return Object.freeze({ status: 'miss', reason: confirmed });
        }
        return Object.freeze({ status: 'unavailable' });
    }
    async #deleteCorrupt(field, headField, wire) {
        await this.#eval(['delete_corrupt', field, headField, wire]);
    }
    async #recordInvalidate(request) {
        const field = memoryHotCacheRecordFieldV1({
            namespaceRef: request.namespaceRef,
            namespaceGeneration: request.namespaceGeneration,
            memoryId: request.memoryId
        });
        const result = exactStatus(await this.#eval([
            'record_invalidate',
            field,
            memoryHotCacheNamespaceFieldV1(request.namespaceRef),
            memoryHotCacheHeadFieldV1(field),
            fixedCounter(request.namespaceGeneration),
            fixedCounter(request.deletedRevision)
        ]));
        return result === 'invalidated' || result === 'unchanged' || result === 'missing'
            ? Object.freeze({ status: result === 'missing' ? 'unchanged' : result })
            : Object.freeze({ status: 'unavailable' });
    }
    async #namespaceInvalidate(request) {
        const result = exactStatus(await this.#eval([
            'namespace_invalidate',
            memoryHotCacheNamespaceFieldV1(request.namespaceRef),
            fixedCounter(request.deletedGeneration),
            fixedCounter(request.nextGeneration)
        ]));
        return result === 'invalidated' || result === 'unchanged'
            ? Object.freeze({ status: result })
            : result === 'capacity'
                ? Object.freeze({ status: 'skipped', reason: 'capacity' })
                : Object.freeze({ status: 'unavailable' });
    }
    async #usage() {
        const result = redisStringArray(await this.#eval(['usage']), 9);
        if (result === null || result[0] !== 'usage' ||
            result.slice(1).some(value => !/^\d{16}$/.test(value))) {
            return Object.freeze({ status: 'unavailable' });
        }
        const values = result.slice(1).map(Number);
        if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
            return Object.freeze({ status: 'unavailable' });
        }
        const [recordCount, generationCount, recordEntryBytes, expiryIndexBytes, lruIndexBytes, dynamicMetadataBytes, staticBytes, totalLogicalBytes] = values;
        return Object.freeze({
            status: 'usage',
            value: Object.freeze({
                schemaVersion: 1,
                recordCount,
                generationCount,
                recordEntryBytes,
                expiryIndexBytes,
                lruIndexBytes,
                dynamicMetadataBytes,
                staticBytes,
                totalLogicalBytes
            })
        });
    }
}

import { randomUUID } from 'node:crypto';
import { AgentError } from '../contracts/error.js';
import { canonicalSessionKey, legacySessionKey, parseCanonicalSessionKey, parseLegacySessionKey, serializeConversationScope } from './conversation-scope.js';
const canonicalNamespace = 'GROUPMATE:SESSION:v1:';
const legacyPattern = 'CHATGPT:CONVERSATIONS:*';
function cancelledError() {
    return new AgentError({
        code: 'cancelled',
        stage: 'session',
        retryable: false,
        userMessage: '操作已取消。'
    });
}
function assertNotAborted(signal) {
    if (signal?.aborted === true)
        throw cancelledError();
}
function storageUnavailable(stage, operation, cause) {
    return new AgentError({
        code: 'storage_unavailable',
        stage,
        retryable: true,
        userMessage: '会话存储暂时不可用，请稍后重试。',
        details: { operation },
        cause
    });
}
function invalidData(stage, operation, cause) {
    return new AgentError({
        code: 'storage_invalid_data',
        stage,
        retryable: false,
        userMessage: '会话数据无法读取，请重新开始对话。',
        details: { operation },
        cause
    });
}
function summary(record, source) {
    return {
        address: { botId: record.botId, scope: record.scope },
        sessionId: record.sessionId,
        startedBy: record.startedBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        turnCount: record.turnCount,
        source
    };
}
export class RedisSessionStore {
    client;
    codec;
    now;
    generateId;
    scanCount;
    constructor(options) {
        this.client = options.client;
        this.codec = options.codec;
        this.now = options.now ?? (() => new Date());
        this.generateId = options.generateId ?? randomUUID;
        const scanCount = options.scanCount ?? 100;
        if (!Number.isSafeInteger(scanCount) || scanCount <= 0 || scanCount > 1000) {
            throw new TypeError('scan count must be a safe integer between 1 and 1000');
        }
        this.scanCount = scanCount;
    }
    async get(address, options = {}) {
        assertNotAborted(options.signal);
        const canonicalKey = canonicalSessionKey(address);
        const canonicalRaw = await this.read(canonicalKey, 'session.read', 'get_canonical');
        assertNotAborted(options.signal);
        if (canonicalRaw !== null)
            return this.decodeCanonical(canonicalRaw, address);
        const oldKey = legacySessionKey(address.scope);
        const legacyRaw = await this.read(oldKey, 'session.read', 'get_legacy');
        assertNotAborted(options.signal);
        if (legacyRaw === null)
            return null;
        const ttl = await this.readTtl(oldKey);
        assertNotAborted(options.signal);
        if (ttl === 0 || ttl === -2)
            return null;
        if (ttl < -2)
            throw invalidData('session.migrate', 'legacy_ttl', new TypeError('invalid TTL'));
        const migrated = this.decodeLegacy(legacyRaw, address);
        const encoded = this.encode(migrated);
        await this.write(canonicalKey, encoded, ttl > 0 ? { EX: ttl } : undefined, 'session.migrate');
        assertNotAborted(options.signal);
        await this.remove(oldKey, 'session.migrate', 'delete_legacy');
        return migrated;
    }
    async save(record, options = {}) {
        assertNotAborted(options.signal);
        const ttlSeconds = this.validateTtl(options.ttlSeconds);
        const address = { botId: record.botId, scope: record.scope };
        const encoded = this.encode(record);
        await this.write(canonicalSessionKey(address), encoded, ttlSeconds === undefined ? undefined : { EX: ttlSeconds }, 'session.save');
        assertNotAborted(options.signal);
        await this.remove(legacySessionKey(record.scope), 'session.save', 'delete_legacy');
    }
    async delete(address, options = {}) {
        assertNotAborted(options.signal);
        const deleted = await this.remove([canonicalSessionKey(address), legacySessionKey(address.scope)], 'session.delete', 'delete_both');
        return deleted > 0;
    }
    async *list(query, options = {}) {
        assertNotAborted(options.signal);
        const limit = this.validateLimit(options.limit);
        const seen = new Set();
        let yielded = 0;
        const canonicalPattern = `${canonicalNamespace}${encodeURIComponent(query.botId)}:*`;
        for await (const key of this.scan(canonicalPattern, options.signal)) {
            if (yielded >= limit)
                return;
            const address = parseCanonicalSessionKey(key);
            if (address === null || address.botId !== query.botId)
                continue;
            const raw = await this.read(key, 'session.list', 'get_canonical');
            if (raw === null)
                continue;
            try {
                const record = this.codec.decodeCanonical(raw, address);
                const scopeId = serializeConversationScope(address.scope);
                if (seen.has(scopeId))
                    continue;
                seen.add(scopeId);
                yielded += 1;
                yield summary(record, 'canonical');
            }
            catch {
                // Corrupt entries are isolated so one session cannot break a bounded listing.
            }
        }
        for await (const key of this.scan(legacyPattern, options.signal)) {
            if (yielded >= limit)
                return;
            const scope = parseLegacySessionKey(key);
            if (scope === null)
                continue;
            const scopeId = serializeConversationScope(scope);
            if (seen.has(scopeId))
                continue;
            const raw = await this.read(key, 'session.list', 'get_legacy');
            if (raw === null)
                continue;
            const address = { botId: query.botId, scope };
            try {
                const record = this.codec.decodeLegacy(raw, {
                    address,
                    now: this.now(),
                    sessionId: this.generateId()
                });
                seen.add(scopeId);
                yielded += 1;
                yield summary(record, 'legacy');
            }
            catch {
                // Corrupt legacy entries are skipped and remain available for manual recovery.
            }
        }
    }
    async deleteAll(query, options = {}) {
        assertNotAborted(options.signal);
        const canonicalPattern = `${canonicalNamespace}${encodeURIComponent(query.botId)}:*`;
        let deleted = await this.deletePattern(canonicalPattern, options.signal);
        deleted += await this.deletePattern(legacyPattern, options.signal);
        return deleted;
    }
    async fork(source, target, startedBy, options = {}) {
        assertNotAborted(options.signal);
        const sourceRecord = await this.get(source, options);
        if (sourceRecord === null) {
            throw new AgentError({
                code: 'invalid_session',
                stage: 'session.fork',
                retryable: false,
                userMessage: '源会话不存在，无法加入。'
            });
        }
        const timestamp = this.now().toISOString();
        const draft = {
            schemaVersion: 1,
            sessionId: this.generateId(),
            botId: target.botId,
            scope: target.scope,
            startedBy,
            createdAt: timestamp,
            updatedAt: timestamp,
            turnCount: sourceRecord.turnCount,
            state: sourceRecord.state
        };
        const forked = this.decodeCanonical(this.encode(draft), target);
        await this.save(forked, options);
        return forked;
    }
    async *scan(pattern, signal) {
        let cursor = 0;
        do {
            assertNotAborted(signal);
            let page;
            try {
                page = await this.client.scan(cursor, { MATCH: pattern, COUNT: this.scanCount });
            }
            catch (error) {
                throw storageUnavailable('session.scan', 'scan', error);
            }
            for (const key of page.keys) {
                assertNotAborted(signal);
                yield key;
            }
            cursor = page.cursor;
        } while (cursor !== 0);
    }
    async deletePattern(pattern, signal) {
        let deleted = 0;
        while (true) {
            assertNotAborted(signal);
            let page;
            try {
                page = await this.client.scan(0, { MATCH: pattern, COUNT: this.scanCount });
            }
            catch (error) {
                throw storageUnavailable('session.deleteAll', 'scan', error);
            }
            if (page.keys.length === 0)
                return deleted;
            deleted += await this.remove(page.keys, 'session.deleteAll', 'delete_page');
        }
    }
    async read(key, stage, operation) {
        try {
            return await this.client.get(key);
        }
        catch (error) {
            throw storageUnavailable(stage, operation, error);
        }
    }
    async readTtl(key) {
        try {
            return await this.client.ttl(key);
        }
        catch (error) {
            throw storageUnavailable('session.migrate', 'ttl_legacy', error);
        }
    }
    async write(key, value, options, stage) {
        try {
            await this.client.set(key, value, options);
        }
        catch (error) {
            throw storageUnavailable(stage, 'set_canonical', error);
        }
    }
    async remove(key, stage, operation) {
        try {
            return await this.client.del(key);
        }
        catch (error) {
            throw storageUnavailable(stage, operation, error);
        }
    }
    encode(record) {
        try {
            return this.codec.encode(record);
        }
        catch (error) {
            throw invalidData('session.write', 'encode', error);
        }
    }
    decodeCanonical(raw, address) {
        try {
            return this.codec.decodeCanonical(raw, address);
        }
        catch (error) {
            throw invalidData('session.read', 'decode_canonical', error);
        }
    }
    decodeLegacy(raw, address) {
        try {
            return this.codec.decodeLegacy(raw, {
                address,
                now: this.now(),
                sessionId: this.generateId()
            });
        }
        catch (error) {
            throw invalidData('session.read', 'decode_legacy', error);
        }
    }
    validateTtl(ttlSeconds) {
        if (ttlSeconds === undefined)
            return undefined;
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
            throw new TypeError('session TTL must be a positive safe integer');
        }
        return ttlSeconds;
    }
    validateLimit(limit) {
        if (limit === undefined)
            return 500;
        if (!Number.isSafeInteger(limit) || limit <= 0)
            throw new TypeError('list limit must be positive');
        return Math.min(limit, 1000);
    }
}

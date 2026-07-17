const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_IN_FLIGHT = 2;
const MAX_WAITERS_PER_OPERATION = 2;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_CACHE_GROUPS = 8;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 1024 * 1024;
const GROUP_HISTORY_TIMEOUT = Symbol('group_history_timeout');
const MAX_HISTORY_ITEMS = 64;
const MAX_HISTORY_TEXT = 4_096;
const MAX_IDENTIFIER = 128;
const MAX_DISPLAY_NAME = 256;
function boundedCharacters(value, maximum) {
    if (typeof value !== 'string')
        return '';
    return [...value.normalize('NFC')].slice(0, maximum).join('');
}
function ownData(record, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
function identifierText(value) {
    return typeof value === 'string' || typeof value === 'number'
        ? boundedCharacters(String(value), MAX_IDENTIFIER)
        : '';
}
function messageText(value) {
    if (typeof value === 'string')
        return value;
    try {
        if (!Array.isArray(value))
            return '';
    }
    catch {
        return '';
    }
    const rawLength = ownData(value, 'length');
    const length = typeof rawLength === 'number' && Number.isSafeInteger(rawLength)
        ? Math.min(Math.max(rawLength, 0), 256)
        : 0;
    const fragments = [];
    for (let index = 0; index < length; index += 1) {
        const segment = ownData(value, String(index));
        if (typeof segment === 'string') {
            fragments.push(segment);
            continue;
        }
        if (segment === null || typeof segment !== 'object' || Array.isArray(segment))
            continue;
        const type = ownData(segment, 'type');
        if (type === 'text') {
            const data = ownData(segment, 'data');
            const nestedText = data !== null && typeof data === 'object' && !Array.isArray(data)
                ? ownData(data, 'text')
                : undefined;
            const directText = ownData(segment, 'text');
            if (typeof nestedText === 'string')
                fragments.push(nestedText);
            else if (typeof directText === 'string')
                fragments.push(directText);
        }
        else if (type === 'at') {
            const target = ownData(segment, 'text') ?? ownData(segment, 'qq');
            if (typeof target === 'string' || typeof target === 'number')
                fragments.push(`@${target}`);
        }
        else if (type === 'image') {
            fragments.push('[图片]');
        }
    }
    return fragments.join('');
}
function snapshotRow(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const messageId = identifierText(ownData(raw, 'message_id') ?? ownData(raw, 'seq'));
    const rawMessage = ownData(raw, 'raw_message');
    const text = boundedCharacters(typeof rawMessage === 'string' ? rawMessage : messageText(ownData(raw, 'message')), MAX_HISTORY_TEXT).trim();
    if (text === '')
        return null;
    const rawSender = ownData(raw, 'sender');
    const sender = rawSender !== null && typeof rawSender === 'object' &&
        !Array.isArray(rawSender)
        ? rawSender
        : Object.freeze({});
    const userId = identifierText(ownData(sender, 'user_id')) || 'unknown';
    const cardValue = ownData(sender, 'card');
    const nicknameValue = ownData(sender, 'nickname');
    const card = typeof cardValue === 'string' || typeof cardValue === 'number'
        ? boundedCharacters(String(cardValue), MAX_DISPLAY_NAME)
        : '';
    const nickname = typeof nicknameValue === 'string' || typeof nicknameValue === 'number'
        ? boundedCharacters(String(nicknameValue), MAX_DISPLAY_NAME)
        : '';
    const rawTime = ownData(raw, 'time');
    const time = typeof rawTime === 'number' && Number.isFinite(rawTime)
        ? Math.trunc(rawTime)
        : undefined;
    return Object.freeze({
        ...(messageId === '' ? {} : { message_id: messageId }),
        raw_message: text,
        sender: Object.freeze({ user_id: userId, card, nickname }),
        ...(time === undefined ? {} : { time })
    });
}
function snapshotRows(raw, limit, maximumBytes) {
    const boundedLimit = Number.isSafeInteger(limit)
        ? Math.min(Math.max(limit, 1), MAX_HISTORY_ITEMS)
        : MAX_HISTORY_ITEMS;
    const rows = raw.slice(-boundedLimit).flatMap(value => {
        const row = snapshotRow(value);
        return row === null ? [] : [row];
    });
    while (rows.length > 0 && Buffer.byteLength(JSON.stringify(rows), 'utf8') > maximumBytes) {
        rows.shift();
    }
    return Object.freeze(rows);
}
export class GroupHistoryReadCoordinator {
    #timeoutMs;
    #maxInFlight;
    #cacheTtlMs;
    #maxCacheGroups;
    #maxEntryBytes;
    #maxCacheBytes;
    #now;
    #onDiagnostic;
    #inFlight = new Map();
    #cache = new Map();
    #cacheBytes = 0;
    constructor(options = {}) {
        this.#timeoutMs = typeof options.timeoutMs === 'number' &&
            Number.isInteger(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= 30_000
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS;
        this.#maxInFlight = typeof options.maxInFlight === 'number' &&
            Number.isInteger(options.maxInFlight) && options.maxInFlight >= 1 &&
            options.maxInFlight <= 16
            ? options.maxInFlight
            : DEFAULT_MAX_IN_FLIGHT;
        this.#cacheTtlMs = typeof options.cacheTtlMs === 'number' &&
            Number.isInteger(options.cacheTtlMs) && options.cacheTtlMs >= 1 &&
            options.cacheTtlMs <= 5 * 60_000
            ? options.cacheTtlMs
            : DEFAULT_CACHE_TTL_MS;
        this.#maxCacheGroups = typeof options.maxCacheGroups === 'number' &&
            Number.isInteger(options.maxCacheGroups) && options.maxCacheGroups >= 1 &&
            options.maxCacheGroups <= 64
            ? options.maxCacheGroups
            : DEFAULT_MAX_CACHE_GROUPS;
        this.#maxEntryBytes = typeof options.maxEntryBytes === 'number' &&
            Number.isInteger(options.maxEntryBytes) && options.maxEntryBytes >= 64 &&
            options.maxEntryBytes <= 2 * 1024 * 1024
            ? options.maxEntryBytes
            : DEFAULT_MAX_ENTRY_BYTES;
        this.#maxCacheBytes = typeof options.maxCacheBytes === 'number' &&
            Number.isInteger(options.maxCacheBytes) && options.maxCacheBytes >= 64 &&
            options.maxCacheBytes <= 8 * 1024 * 1024
            ? options.maxCacheBytes
            : DEFAULT_MAX_CACHE_BYTES;
        this.#now = options.now ?? Date.now;
        this.#onDiagnostic = options.onDiagnostic;
    }
    async read(input) {
        let entry = this.#inFlight.get(input.key);
        if (entry === undefined) {
            if (this.#inFlight.size >= this.#maxInFlight)
                return this.#fallback(input.key, 'capacity');
            const startedAt = this.#now();
            const expiresAt = startedAt + this.#cacheTtlMs;
            const operation = Promise.resolve()
                .then(async () => snapshotRows(await input.load(), input.limit, this.#maxEntryBytes))
                .then(value => {
                if (this.#now() < expiresAt) {
                    this.#store(input.key, value, expiresAt);
                }
                return value;
            });
            entry = { operation, waiters: 0 };
            this.#inFlight.set(input.key, entry);
            void operation.then(() => {
                if (this.#inFlight.get(input.key) === entry)
                    this.#inFlight.delete(input.key);
            }, () => {
                if (this.#inFlight.get(input.key) === entry)
                    this.#inFlight.delete(input.key);
            });
        }
        if (entry.waiters >= MAX_WAITERS_PER_OPERATION)
            return this.#fallback(input.key, 'capacity');
        entry.waiters += 1;
        const operation = entry.operation;
        void operation.catch(() => undefined);
        let timer;
        try {
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(GROUP_HISTORY_TIMEOUT), this.#timeoutMs);
                timer.unref?.();
            });
            return await Promise.race([operation, timeout]);
        }
        catch (error) {
            if (error === GROUP_HISTORY_TIMEOUT)
                return this.#fallback(input.key, 'timeout');
            this.#report('read_rejected');
            return this.#cached(input.key) ?? Object.freeze([]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            entry.waiters -= 1;
        }
    }
    #cached(key) {
        const entry = this.#cache.get(key);
        if (entry === undefined)
            return null;
        if (this.#now() >= entry.expiresAt) {
            this.#cache.delete(key);
            this.#cacheBytes -= entry.bytes;
            return null;
        }
        this.#cache.delete(key);
        this.#cache.set(key, entry);
        return entry.value;
    }
    #fallback(key, reason) {
        const cached = this.#cached(key);
        this.#report(`${reason}_${cached === null ? 'without' : 'with'}_cache`);
        return cached ?? Object.freeze([]);
    }
    #report(code) {
        try {
            this.#onDiagnostic?.(code);
        }
        catch {
            // Diagnostic delivery is fail-open by design.
        }
    }
    #store(key, value, expiresAt) {
        const now = this.#now();
        for (const [cachedKey, entry] of this.#cache) {
            if (now < entry.expiresAt)
                continue;
            this.#cache.delete(cachedKey);
            this.#cacheBytes -= entry.bytes;
        }
        const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
        const existing = this.#cache.get(key);
        if (existing !== undefined) {
            this.#cache.delete(key);
            this.#cacheBytes -= existing.bytes;
        }
        if (bytes > this.#maxCacheBytes)
            return;
        this.#cache.set(key, Object.freeze({ value, bytes, expiresAt }));
        this.#cacheBytes += bytes;
        while (this.#cache.size > this.#maxCacheGroups || this.#cacheBytes > this.#maxCacheBytes) {
            const oldestKey = this.#cache.keys().next().value;
            if (oldestKey === undefined)
                break;
            const oldest = this.#cache.get(oldestKey);
            this.#cache.delete(oldestKey);
            if (oldest !== undefined)
                this.#cacheBytes -= oldest.bytes;
        }
    }
}

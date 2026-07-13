function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new TypeError(`${label} must be a positive integer`);
    return value;
}
function deepFreeze(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value)) {
        value.forEach(deepFreeze);
        return Object.freeze(value);
    }
    for (const child of Object.values(value))
        deepFreeze(child);
    return Object.freeze(value);
}
function clonePendingCall(raw) {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('pending call is invalid');
    const call = value;
    const keys = [
        'schemaVersion', 'pendingCallId', 'toolName', 'toolVersion', 'profile', 'call',
        'input', 'intent', 'argumentHash', 'createdAt', 'expiresAt'
    ];
    if (Object.keys(call).length !== keys.length || Object.keys(call).some(key => !keys.includes(key)) ||
        call.schemaVersion !== 1 || call.toolVersion !== 1 || typeof call.pendingCallId !== 'string' ||
        typeof call.argumentHash !== 'string')
        throw new TypeError('pending call is invalid');
    return deepFreeze(value);
}
export class InMemoryPendingCallStore {
    #now;
    #maxEntries;
    #maxEntryBytes;
    #maxTotalBytes;
    #ttlMs;
    #entries = new Map();
    #totalBytes = 0;
    constructor(options) {
        this.#now = options.now;
        this.#maxEntries = positiveInteger(options.maxEntries, 'max entries');
        this.#maxEntryBytes = positiveInteger(options.maxEntryBytes, 'max entry bytes');
        this.#maxTotalBytes = positiveInteger(options.maxTotalBytes, 'max total bytes');
        this.#ttlMs = positiveInteger(options.ttlMs, 'TTL');
    }
    put(call) {
        this.#purgeExpired();
        let raw;
        try {
            raw = JSON.stringify(call);
        }
        catch {
            throw new TypeError('pending call is not serializable');
        }
        const bytes = Buffer.byteLength(raw, 'utf8');
        if (bytes > this.#maxEntryBytes || bytes > this.#maxTotalBytes) {
            throw new RangeError('pending call exceeds byte limit');
        }
        const cloned = clonePendingCall(raw);
        this.delete(cloned.pendingCallId);
        while (this.#entries.size >= this.#maxEntries || this.#totalBytes + bytes > this.#maxTotalBytes) {
            const oldest = this.#entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.delete(oldest);
        }
        this.#entries.set(cloned.pendingCallId, {
            call: cloned,
            bytes,
            expiresAtMs: this.#now() + this.#ttlMs
        });
        this.#totalBytes += bytes;
    }
    take(pendingCallId, argumentHash) {
        this.#purgeExpired();
        const stored = this.#entries.get(pendingCallId);
        if (stored === undefined || stored.call.argumentHash !== argumentHash)
            return null;
        this.delete(pendingCallId);
        return stored.call;
    }
    delete(pendingCallId) {
        const stored = this.#entries.get(pendingCallId);
        if (stored === undefined)
            return false;
        this.#entries.delete(pendingCallId);
        this.#totalBytes -= stored.bytes;
        return true;
    }
    #purgeExpired() {
        const now = this.#now();
        for (const [id, stored] of this.#entries) {
            if (stored.expiresAtMs <= now)
                this.delete(id);
        }
    }
}

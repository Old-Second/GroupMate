import { constants } from 'node:fs';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
export const GROUPMATE_DISK_LOG_LIMITS = Object.freeze({
    maxFileBytes: 32 * 1024 * 1024,
    retentionMs: 30 * 24 * 60 * 60 * 1_000,
    maxDirectoryBytes: 512 * 1024 * 1024,
    maxQueueRecords: 256,
    maxQueueBytes: 8 * 1024 * 1024,
    maxEntryBytes: 4 * 1024 * 1024
});
const FILE_NAME_PATTERN = /^groupmate-(\d{4})-(\d{2})-(\d{2})\.(\d{4})\.jsonl$/;
const FAILURE_LIMIT_MS = 60_000;
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LOG_FILE_OPEN_FLAGS = constants.O_WRONLY |
    constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
function localDate(now) {
    const year = String(now.getFullYear()).padStart(4, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function fileName(date, index) {
    return `groupmate-${date}.${String(index).padStart(4, '0')}.jsonl`;
}
function fileMetadata(name) {
    const match = FILE_NAME_PATTERN.exec(name);
    if (match === null)
        return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dateStart = new Date(year, month - 1, day);
    if (dateStart.getFullYear() !== year || dateStart.getMonth() !== month - 1 ||
        dateStart.getDate() !== day) {
        return null;
    }
    return {
        name,
        date: `${match[1]}-${match[2]}-${match[3]}`,
        index: Number(match[4]),
        dateStart: dateStart.getTime()
    };
}
function limitFor(key, overrides) {
    const maximum = GROUPMATE_DISK_LOG_LIMITS[key];
    const value = overrides?.[key];
    if (value === undefined)
        return maximum;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new TypeError(`disk log ${key} override is invalid`);
    }
    return value;
}
export class GroupMateDiskLog {
    #directory;
    #now;
    #onFailure;
    #limits;
    #queue = [];
    #sequence = 0;
    #pendingBytes = 0;
    #pendingRecords = 0;
    #lastExpiryCleanupDate = null;
    #lastFailureAt = null;
    #pump = null;
    constructor(options) {
        this.#directory = options.directory;
        this.#now = options.now ?? (() => new Date());
        this.#onFailure = options.onFailure;
        this.#limits = Object.freeze({
            maxFileBytes: limitFor('maxFileBytes', options.limits),
            retentionMs: limitFor('retentionMs', options.limits),
            maxDirectoryBytes: limitFor('maxDirectoryBytes', options.limits),
            maxQueueRecords: limitFor('maxQueueRecords', options.limits),
            maxQueueBytes: limitFor('maxQueueBytes', options.limits),
            maxEntryBytes: limitFor('maxEntryBytes', options.limits)
        });
    }
    record(event) {
        const now = this.#safeNow();
        let line;
        try {
            const serialized = JSON.stringify({
                schemaVersion: 1,
                sequence: this.#sequence + 1,
                recordedAt: now.toISOString(),
                event
            });
            if (typeof serialized !== 'string')
                throw new TypeError('disk log entry is invalid');
            line = `${serialized}\n`;
        }
        catch {
            this.#reportFailure('serialization_failed');
            return;
        }
        const bytes = Buffer.byteLength(line);
        if (bytes > this.#limits.maxEntryBytes) {
            this.#reportFailure('entry_too_large');
            return;
        }
        if (this.#pendingRecords + 1 > this.#limits.maxQueueRecords ||
            this.#pendingBytes + bytes > this.#limits.maxQueueBytes) {
            this.#reportFailure('queue_overflow');
            return;
        }
        this.#sequence += 1;
        this.#pendingRecords += 1;
        this.#pendingBytes += bytes;
        this.#queue.push({ line, bytes, date: localDate(now), recordedAt: now });
        this.#ensurePump();
    }
    async drain() {
        while (this.#pump !== null || this.#queue.length > 0) {
            this.#ensurePump();
            const pump = this.#pump;
            if (pump !== null)
                await pump;
        }
    }
    #ensurePump() {
        if (this.#pump !== null)
            return;
        const pump = this.#flush();
        this.#pump = pump;
        void pump.finally(() => {
            if (this.#pump !== pump)
                return;
            this.#pump = null;
            if (this.#queue.length > 0)
                this.#ensurePump();
        });
    }
    async #flush() {
        while (this.#queue.length > 0) {
            const entry = this.#queue.shift();
            try {
                await this.#write(entry);
            }
            catch {
                this.#reportFailure('write_failed');
            }
            finally {
                this.#pendingRecords -= 1;
                this.#pendingBytes -= entry.bytes;
            }
        }
    }
    async #write(entry) {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const directory = await open(this.#directory, DIRECTORY_OPEN_FLAGS);
        try {
            if (!(await directory.stat()).isDirectory())
                throw new TypeError('disk log directory is invalid');
            await directory.chmod(0o700);
        }
        finally {
            await directory.close();
        }
        if (this.#lastExpiryCleanupDate !== entry.date) {
            await this.#removeExpiredFiles(entry.recordedAt);
            this.#lastExpiryCleanupDate = entry.date;
        }
        const target = await this.#targetFor(entry);
        if (target === null) {
            this.#reportFailure('directory_cap_exceeded');
            return;
        }
        const targetPath = path.join(this.#directory, target);
        const file = await open(targetPath, LOG_FILE_OPEN_FLAGS, 0o600);
        try {
            if (!(await file.stat()).isFile())
                throw new TypeError('disk log target is invalid');
            await file.chmod(0o600);
            await file.writeFile(entry.line);
        }
        finally {
            await file.close();
        }
    }
    async #removeExpiredFiles(now) {
        const cutoff = now.getTime() - this.#limits.retentionMs;
        for (const file of await this.#matchingFiles()) {
            if (file.dateStart < cutoff)
                await unlink(file.path);
        }
    }
    async #targetFor(entry) {
        const files = await this.#matchingFiles();
        const sameDate = files.filter(file => file.date === entry.date);
        const latest = sameDate.at(-1);
        let target;
        if (latest === undefined) {
            target = fileName(entry.date, 1);
        }
        else if (latest.bytes === 0 || latest.bytes + entry.bytes <= this.#limits.maxFileBytes) {
            target = latest.name;
        }
        else if (latest.index < 9_999) {
            target = fileName(entry.date, latest.index + 1);
        }
        else {
            return null;
        }
        let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
        for (const file of files) {
            if (totalBytes + entry.bytes <= this.#limits.maxDirectoryBytes)
                break;
            if (file.name === target)
                continue;
            await unlink(file.path);
            totalBytes -= file.bytes;
        }
        return totalBytes + entry.bytes <= this.#limits.maxDirectoryBytes ? target : null;
    }
    async #matchingFiles() {
        const entries = await readdir(this.#directory, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const metadata = fileMetadata(entry.name);
            if (metadata === null)
                continue;
            const filePath = path.join(this.#directory, entry.name);
            const details = await stat(filePath);
            if (!details.isFile())
                continue;
            files.push({ ...metadata, path: filePath, bytes: details.size });
        }
        files.sort((left, right) => left.name.localeCompare(right.name));
        return files;
    }
    #safeNow() {
        try {
            const value = this.#now();
            const timestamp = value.getTime();
            return Number.isFinite(timestamp) ? new Date(timestamp) : new Date(0);
        }
        catch {
            return new Date(0);
        }
    }
    #reportFailure(code) {
        const now = this.#safeNow().getTime();
        if (this.#lastFailureAt !== null && now - this.#lastFailureAt < FAILURE_LIMIT_MS)
            return;
        this.#lastFailureAt = now;
        try {
            this.#onFailure?.(Object.freeze({ event: 'groupmate.disk_log.failure', code }));
        }
        catch { }
    }
}

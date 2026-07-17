import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises';
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
const LOG_FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const LOG_FILE_OPEN_FLAGS = constants.O_WRONLY |
    constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_BUFFER_BYTES = 64 * 1024;
const MAX_LINE_PREFIX_BYTES = 128;
const SEQUENCE_PLACEHOLDER = Number.MAX_SAFE_INTEGER;
const SEQUENCE_MARKER = `"sequence":${SEQUENCE_PLACEHOLDER}`;
const SEQUENCE_PREFIX_PATTERN = /^\{"schemaVersion":1,"sequence":([1-9]\d*),/;
function isMissingPathError(error) {
    return error !== null && typeof error === 'object' &&
        'code' in error && error.code === 'ENOENT';
}
function relativeDescendant(root, target) {
    const relative = path.relative(root, target);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        throw new TypeError('disk log directory boundary is invalid');
    }
    return relative;
}
async function createDirectoryWithoutSymlinks(directory, configuredRoot) {
    const relative = relativeDescendant(configuredRoot, directory);
    let current = await realpath(configuredRoot);
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        let details;
        try {
            details = await lstat(current);
        }
        catch (error) {
            if (!isMissingPathError(error))
                throw error;
            try {
                await mkdir(current, { mode: 0o700 });
            }
            catch (mkdirError) {
                if (mkdirError === null || typeof mkdirError !== 'object' ||
                    !('code' in mkdirError) || mkdirError.code !== 'EEXIST')
                    throw mkdirError;
            }
            details = await lstat(current);
        }
        if (details.isSymbolicLink() || !details.isDirectory()) {
            throw new TypeError('disk log ancestor is invalid');
        }
    }
    return current;
}
function openedDirectoryPath(descriptor, fallback) {
    return process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : fallback;
}
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
async function maximumDurableSequence(filePath) {
    const file = await open(filePath, LOG_FILE_READ_FLAGS);
    try {
        if (!(await file.stat()).isFile())
            return null;
        const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
        const prefix = Buffer.allocUnsafe(MAX_LINE_PREFIX_BYTES);
        let prefixBytes = 0;
        let position = 0;
        let maximum = null;
        while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0)
                break;
            position += bytesRead;
            let offset = 0;
            while (offset < bytesRead) {
                const newline = buffer.indexOf(0x0a, offset);
                const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
                const available = MAX_LINE_PREFIX_BYTES - prefixBytes;
                const copied = Math.min(Math.max(available, 0), end - offset);
                if (copied > 0) {
                    buffer.copy(prefix, prefixBytes, offset, offset + copied);
                    prefixBytes += copied;
                }
                if (newline === -1 || newline >= bytesRead)
                    break;
                const match = SEQUENCE_PREFIX_PATTERN.exec(prefix.subarray(0, prefixBytes).toString('ascii'));
                if (match !== null) {
                    const sequence = Number(match[1]);
                    if (Number.isSafeInteger(sequence) && sequence > 0 &&
                        (maximum === null || sequence > maximum))
                        maximum = sequence;
                }
                prefixBytes = 0;
                offset = newline + 1;
            }
        }
        return maximum;
    }
    finally {
        await file.close();
    }
}
export class GroupMateDiskLog {
    #directory;
    #trustedRoot;
    #now;
    #onFailure;
    #limits;
    #queue = [];
    #writerDates = new Set();
    #sequence = 0;
    #sequenceBase = null;
    #pendingBytes = 0;
    #pendingRecords = 0;
    #lastExpiryCleanupDate = null;
    #lastFailureAt = null;
    #pump = null;
    constructor(options) {
        this.#directory = path.resolve(options.directory);
        this.#trustedRoot = path.resolve(options.trustedRoot);
        relativeDescendant(this.#trustedRoot, this.#directory);
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
        const localSequence = this.#sequence + 1;
        let line;
        try {
            const serialized = JSON.stringify({
                schemaVersion: 1,
                sequence: SEQUENCE_PLACEHOLDER,
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
        this.#queue.push({ line, bytes, localSequence, date: localDate(now), recordedAt: now });
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
        const safeDirectory = await createDirectoryWithoutSymlinks(this.#directory, this.#trustedRoot);
        const directory = await open(safeDirectory, DIRECTORY_OPEN_FLAGS);
        try {
            const opened = await directory.stat();
            const current = await lstat(safeDirectory);
            if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory() ||
                opened.dev !== current.dev || opened.ino !== current.ino) {
                throw new TypeError('disk log directory is invalid');
            }
            await directory.chmod(0o700);
            const operationRoot = openedDirectoryPath(directory.fd, safeDirectory);
            if (this.#sequenceBase === null) {
                this.#sequenceBase = await this.#recoverSequence(operationRoot);
            }
            const materialized = this.#materialize(entry);
            if (this.#lastExpiryCleanupDate !== materialized.date) {
                await this.#removeExpiredFiles(materialized.recordedAt, operationRoot);
                this.#lastExpiryCleanupDate = materialized.date;
            }
            const target = await this.#targetFor(materialized, operationRoot);
            if (target === null) {
                this.#reportFailure('directory_cap_exceeded');
                return;
            }
            const targetPath = path.join(operationRoot, target);
            const file = await open(targetPath, LOG_FILE_OPEN_FLAGS, 0o600);
            try {
                if (!(await file.stat()).isFile())
                    throw new TypeError('disk log target is invalid');
                await file.chmod(0o600);
                await file.writeFile(materialized.line);
                this.#writerDates.add(materialized.date);
            }
            finally {
                await file.close();
            }
        }
        finally {
            await directory.close();
        }
    }
    async #recoverSequence(operationRoot) {
        const files = await this.#matchingFiles(operationRoot);
        for (let index = files.length - 1; index >= 0; index -= 1) {
            const file = files[index];
            if (file === undefined)
                continue;
            const sequence = await maximumDurableSequence(file.path);
            if (sequence !== null)
                return sequence;
        }
        return 0;
    }
    #materialize(entry) {
        if (this.#sequenceBase === null)
            throw new TypeError('disk log sequence is unavailable');
        const sequence = this.#sequenceBase + entry.localSequence;
        if (!Number.isSafeInteger(sequence) || sequence <= 0) {
            throw new TypeError('disk log sequence is exhausted');
        }
        const line = entry.line.replace(SEQUENCE_MARKER, `"sequence":${sequence}`);
        if (line === entry.line)
            throw new TypeError('disk log sequence marker is missing');
        return Object.freeze({ ...entry, line, bytes: Buffer.byteLength(line) });
    }
    async #removeExpiredFiles(now, operationRoot) {
        const cutoff = now.getTime() - this.#limits.retentionMs;
        for (const file of await this.#matchingFiles(operationRoot)) {
            if (file.dateStart < cutoff)
                await unlink(file.path);
        }
    }
    async #targetFor(entry, operationRoot) {
        const files = await this.#matchingFiles(operationRoot);
        const sameDate = files.filter(file => file.date === entry.date);
        const latest = sameDate.at(-1);
        let target;
        if (latest === undefined) {
            target = fileName(entry.date, 1);
        }
        else if (!this.#writerDates.has(entry.date) && (this.#sequenceBase ?? 0) > 0) {
            if (latest.index >= 9_999)
                return null;
            target = fileName(entry.date, latest.index + 1);
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
    async #matchingFiles(operationRoot) {
        const entries = await readdir(operationRoot, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const metadata = fileMetadata(entry.name);
            if (metadata === null)
                continue;
            const filePath = path.join(operationRoot, entry.name);
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

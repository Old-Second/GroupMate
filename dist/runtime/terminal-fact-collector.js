import { parseRunTerminalSnapshot } from '../agent/run/run-observation.js';
import { parseTerminalCommitReceipt } from '../agent/run/run-store.js';
export class TerminalFactCollector {
    #capacity;
    #onCommitted;
    #entries = new Map();
    constructor(options) {
        const capacity = options.capacity ?? 256;
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256) {
            throw new TypeError('terminal fact collector capacity is invalid');
        }
        this.#capacity = capacity;
        this.#onCommitted = options.onCommitted;
    }
    acceptSnapshot(value) {
        let snapshot;
        try {
            snapshot = parseRunTerminalSnapshot(value);
        }
        catch {
            return;
        }
        const entry = this.#entry(snapshot.observationId);
        entry.snapshot = snapshot;
        this.#commit(snapshot.observationId, entry);
    }
    acceptCommitReceipt(value) {
        let receipt;
        try {
            receipt = parseTerminalCommitReceipt(value);
        }
        catch {
            return;
        }
        const entry = this.#entry(receipt.observationId);
        entry.receipt = receipt;
        this.#commit(receipt.observationId, entry);
    }
    #entry(observationId) {
        const existing = this.#entries.get(observationId);
        if (existing !== undefined) {
            this.#entries.delete(observationId);
            this.#entries.set(observationId, existing);
            return existing;
        }
        const entry = { committed: false };
        this.#entries.set(observationId, entry);
        while (this.#entries.size > this.#capacity) {
            const oldest = this.#entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.#entries.delete(oldest);
        }
        return entry;
    }
    #commit(observationId, entry) {
        if (entry.committed || entry.snapshot === undefined || entry.receipt === undefined)
            return;
        if (entry.snapshot.observationId !== entry.receipt.observationId ||
            entry.snapshot.runRef !== entry.receipt.runRef ||
            entry.snapshot.revision !== entry.receipt.revision)
            return;
        entry.committed = true;
        this.#onCommitted(entry.snapshot, entry.receipt);
    }
}

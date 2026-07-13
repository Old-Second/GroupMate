function delivery(kind) {
    return Object.freeze({ kind });
}
export class ProgressOutputController {
    #maxMessages;
    #maxCharacters;
    #hash;
    #send;
    #audit;
    #reservedTexts = new Map();
    #attempts = 0;
    constructor(options) {
        if (!Number.isSafeInteger(options.maxMessages) || options.maxMessages <= 0 ||
            !Number.isSafeInteger(options.maxCharacters) || options.maxCharacters <= 0) {
            throw new TypeError('progress output limits are invalid');
        }
        this.#maxMessages = options.maxMessages;
        this.#maxCharacters = options.maxCharacters;
        this.#hash = options.hash;
        this.#send = options.send;
        this.#audit = options.audit;
    }
    #event(request, outcome, sequence, characters, bytes) {
        return Object.freeze({
            event: 'groupmate.progress.output',
            runIdHash: this.#hash(request.runId),
            callIdHash: this.#hash(request.callId),
            snapshotIdHash: this.#hash(request.snapshotId),
            sequence,
            outcome,
            characters,
            bytes
        });
    }
    async deliver(request) {
        const normalized = request.text.trim().normalize('NFC');
        const characters = [...normalized].length;
        const bytes = Buffer.byteLength(normalized, 'utf8');
        if (normalized === '' || characters > this.#maxCharacters) {
            await this.#audit(this.#event(request, 'invalid', null, characters, bytes));
            return delivery('invalid');
        }
        const duplicateSequence = this.#reservedTexts.get(normalized);
        if (duplicateSequence !== undefined) {
            await this.#audit(this.#event(request, 'duplicate', duplicateSequence, characters, bytes));
            return delivery('duplicate');
        }
        if (this.#attempts >= this.#maxMessages) {
            await this.#audit(this.#event(request, 'suppressed', null, characters, bytes));
            return delivery('suppressed');
        }
        this.#attempts += 1;
        const sequence = this.#attempts;
        this.#reservedTexts.set(normalized, sequence);
        try {
            await this.#send(normalized, request.target, request.signal);
            await this.#audit(this.#event(request, 'sent', sequence, characters, bytes));
            return Object.freeze({ kind: 'sent', sequence });
        }
        catch (error) {
            try {
                await this.#audit(this.#event(request, 'indeterminate', sequence, characters, bytes));
            }
            catch { }
            throw error;
        }
    }
}

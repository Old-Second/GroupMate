export function ordinaryProfile(input) {
    if (typeof input.forcePicture !== 'boolean' || typeof input.quoteCurrentRequest !== 'boolean') {
        throw new TypeError('ordinary presentation profile is invalid');
    }
    return Object.freeze({
        kind: 'ordinary',
        forcePicture: input.forcePicture,
        quoteCurrentRequest: input.quoteCurrentRequest
    });
}
export function proactiveProfile(input) {
    if (input.recallAfterMs !== null &&
        (!Number.isSafeInteger(input.recallAfterMs) || input.recallAfterMs < 1_000 ||
            input.recallAfterMs > 3_600_000 || input.recallAfterMs % 1_000 !== 0)) {
        throw new TypeError('proactive presentation recall delay is invalid');
    }
    return Object.freeze({
        kind: 'proactive',
        maxParts: 3,
        quoteProbability: 0.1,
        delayPerCodePointMs: 200,
        maxDelayMs: 3_000,
        recallAfterMs: input.recallAfterMs
    });
}
export const RECOVERED_LEGACY_PROFILE = Object.freeze({ kind: 'recovered_legacy_plain_text' });

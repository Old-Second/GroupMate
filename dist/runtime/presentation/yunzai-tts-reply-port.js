export const TTS_SYNTHESIS_TIMEOUT_MS = 120_000;
const DEFINITE_CODES = new Set([
    'empty_after_filter',
    'unsupported_mode',
    'unsupported_voice',
    'aborted_before_dispatch',
    'synthesis_rejected'
]);
const UNKNOWN_CODES = new Set([
    'synthesis_exception',
    'synthesis_abort_after_dispatch',
    'synthesis_timeout'
]);
function ownData(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor : null;
    }
    catch {
        return null;
    }
}
function exactDataRecord(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    try {
        const ownKeys = Reflect.ownKeys(value);
        return ownKeys.every(key => typeof key === 'string' && keys.includes(key)) &&
            keys.every(key => ownData(value, key) !== null);
    }
    catch {
        return false;
    }
}
function validIdentifier(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function canonicalTarget(value) {
    if (!exactDataRecord(value, ['botId', 'scope']))
        return null;
    const botId = ownData(value, 'botId')?.value;
    const scope = ownData(value, 'scope')?.value;
    if (!validIdentifier(botId) || scope === null || typeof scope !== 'object')
        return null;
    if (exactDataRecord(scope, ['kind', 'userId']) &&
        ownData(scope, 'kind')?.value === 'private' &&
        validIdentifier(ownData(scope, 'userId')?.value)) {
        return Object.freeze({
            botId,
            scope: Object.freeze({
                kind: 'private', userId: ownData(scope, 'userId')?.value
            })
        });
    }
    if (exactDataRecord(scope, ['kind', 'groupId']) &&
        ownData(scope, 'kind')?.value === 'group' &&
        validIdentifier(ownData(scope, 'groupId')?.value)) {
        return Object.freeze({
            botId,
            scope: Object.freeze({
                kind: 'group', groupId: ownData(scope, 'groupId')?.value
            })
        });
    }
    if (exactDataRecord(scope, ['kind', 'groupId', 'userId']) &&
        ownData(scope, 'kind')?.value === 'group_user' &&
        validIdentifier(ownData(scope, 'groupId')?.value) &&
        validIdentifier(ownData(scope, 'userId')?.value)) {
        return Object.freeze({
            botId,
            scope: Object.freeze({
                kind: 'group', groupId: ownData(scope, 'groupId')?.value
            })
        });
    }
    return null;
}
function normalizedText(value, maximum) {
    if (typeof value !== 'string')
        return null;
    try {
        const normalized = value.trim().normalize('NFC');
        if (maximum !== undefined && [...normalized].length > maximum)
            return null;
        return normalized;
    }
    catch {
        return null;
    }
}
function normalizedMode(value) {
    return value === 'vits-uma-genshin-honkai' || value === 'azure' || value === 'voicevox'
        ? value
        : null;
}
function normalizedResource(value) {
    if (value === null || typeof value !== 'object')
        return null;
    const kind = ownData(value, 'kind')?.value;
    const contentKey = kind === 'buffer' ? 'data' : kind === 'remote_url' ? 'url' : 'path';
    if (!exactDataRecord(value, ['kind', contentKey, 'mimeType', 'byteLength']))
        return null;
    const mimeType = ownData(value, 'mimeType')?.value;
    const byteLength = ownData(value, 'byteLength')?.value;
    if (typeof mimeType !== 'string' || !mimeType.startsWith('audio/') ||
        mimeType.length > 256 || typeof byteLength !== 'number' ||
        !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 8 * 1024 * 1024) {
        return null;
    }
    if (kind === 'buffer') {
        const data = ownData(value, 'data')?.value;
        if (!(data instanceof Uint8Array) || data.byteLength !== byteLength)
            return null;
        return Object.freeze({
            kind: 'buffer', data: new Uint8Array(data), mimeType, byteLength
        });
    }
    if (kind === 'remote_url') {
        const url = ownData(value, 'url')?.value;
        if (typeof url !== 'string' || url.length === 0 || url.length > 4_096)
            return null;
        return Object.freeze({ kind: 'remote_url', url, mimeType, byteLength });
    }
    if (kind === 'local_path') {
        const path = ownData(value, 'path')?.value;
        if (typeof path !== 'string' || path.length === 0 || path.length > 4_096)
            return null;
        return Object.freeze({ kind: 'local_path', path, mimeType, byteLength });
    }
    return null;
}
function projectedBackendResult(value) {
    if (value === null || typeof value !== 'object')
        return null;
    const kind = ownData(value, 'kind')?.value;
    if (kind === 'ready') {
        const audio = normalizedResource(ownData(value, 'audio')?.value);
        return audio === null ? null : Object.freeze({ kind: 'ready', audio });
    }
    const code = ownData(value, 'code')?.value;
    if (kind === 'failed_definite' && DEFINITE_CODES.has(code)) {
        return Object.freeze({
            kind: 'failed_definite',
            code: code
        });
    }
    if (kind === 'outcome_unknown' && UNKNOWN_CODES.has(code)) {
        return Object.freeze({
            kind: 'outcome_unknown',
            code: code
        });
    }
    return null;
}
function raceBackend(invoke, signal) {
    return new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = () => finish(Object.freeze({ kind: 'abort' }));
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(Object.freeze({ kind: 'timeout' })), TTS_SYNTHESIS_TIMEOUT_MS);
        try {
            void invoke().then(value => finish(Object.freeze({ kind: 'fulfilled', value })), () => finish(Object.freeze({ kind: 'exception' })));
        }
        catch {
            finish(Object.freeze({ kind: 'exception' }));
        }
    });
}
function definite(code) {
    return Object.freeze({ kind: 'failed_definite', code });
}
function isAborted(signal) {
    return signal?.aborted === true;
}
export function createYunzaiTtsReplyPort(input) {
    return Object.freeze({
        async synthesize(unsafeInput, signal) {
            let backendDispatched = false;
            try {
                const text = normalizedText(unsafeInput?.text);
                if (text === null || text === '')
                    return definite('empty_after_filter');
                const mode = normalizedMode(unsafeInput?.mode);
                if (mode === null)
                    return definite('unsupported_mode');
                const voice = normalizedText(unsafeInput?.voice, 256);
                if (voice === null || voice === '')
                    return definite('unsupported_voice');
                const target = canonicalTarget(unsafeInput?.target);
                if (target === null)
                    return definite('synthesis_rejected');
                let emotion;
                if (unsafeInput.emotion !== undefined) {
                    const normalized = normalizedText(unsafeInput.emotion, 64);
                    if (normalized === null || normalized === '')
                        return definite('synthesis_rejected');
                    emotion = normalized;
                }
                let emotionDegree;
                if (unsafeInput.emotionDegree !== undefined) {
                    if (typeof unsafeInput.emotionDegree !== 'number' ||
                        !Number.isFinite(unsafeInput.emotionDegree) ||
                        unsafeInput.emotionDegree < 0.01 || unsafeInput.emotionDegree > 2) {
                        return definite('synthesis_rejected');
                    }
                    emotionDegree = unsafeInput.emotionDegree;
                }
                if (isAborted(signal))
                    return definite('aborted_before_dispatch');
                let recordEncoding;
                try {
                    recordEncoding = await input.targets.forTarget(target);
                }
                catch {
                    return definite('synthesis_rejected');
                }
                if (recordEncoding !== 'default' && recordEncoding !== 'shamrock_passthrough') {
                    return definite('synthesis_rejected');
                }
                if (isAborted(signal))
                    return definite('aborted_before_dispatch');
                const safeInput = Object.freeze({
                    text,
                    mode,
                    voice,
                    ...(emotion === undefined ? {} : { emotion }),
                    ...(emotionDegree === undefined ? {} : { emotionDegree }),
                    recordEncoding
                });
                const raced = await raceBackend(async () => {
                    backendDispatched = true;
                    return await input.backend.synthesize(safeInput, signal);
                }, signal);
                if (raced.kind === 'abort') {
                    return Object.freeze({
                        kind: 'outcome_unknown', code: 'synthesis_abort_after_dispatch'
                    });
                }
                if (raced.kind === 'timeout') {
                    return Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_timeout' });
                }
                if (raced.kind === 'exception') {
                    return Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_exception' });
                }
                return projectedBackendResult(raced.value) ?? Object.freeze({
                    kind: 'outcome_unknown', code: 'synthesis_exception'
                });
            }
            catch {
                return backendDispatched
                    ? Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_exception' })
                    : definite('synthesis_rejected');
            }
        }
    });
}
export const UNAVAILABLE_TTS_REPLY_PORT = Object.freeze({
    synthesize: async () => definite('synthesis_rejected')
});

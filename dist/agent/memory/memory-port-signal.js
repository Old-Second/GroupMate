import { types as utilTypes } from 'node:util';
import { invalidMemoryValue } from './memory-namespace.js';
const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const eventTargetAddEventListener = EventTarget.prototype.addEventListener;
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener;
function nativeSignalAborted(signal) {
    if (typeof abortSignalAbortedGetter !== 'function')
        return invalidMemoryValue();
    try {
        return Reflect.apply(abortSignalAbortedGetter, signal, []) === true;
    }
    catch {
        return invalidMemoryValue();
    }
}
function parseNativeAbortSignal(value) {
    if (value === undefined)
        return undefined;
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
        return invalidMemoryValue();
    }
    let prototype;
    let keys;
    try {
        prototype = Object.getPrototypeOf(value);
        keys = Reflect.ownKeys(value);
    }
    catch {
        return invalidMemoryValue();
    }
    if (prototype !== AbortSignal.prototype)
        return invalidMemoryValue();
    for (const key of keys) {
        if (typeof key !== 'symbol')
            return invalidMemoryValue();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
            utilTypes.isProxy(descriptor.value) ||
            (key.description === 'kAborted' && typeof descriptor.value !== 'boolean')) {
            return invalidMemoryValue();
        }
    }
    nativeSignalAborted(value);
    return value;
}
export function createMemoryPortSignalScopeV1(value) {
    const source = parseNativeAbortSignal(value);
    if (source === undefined) {
        return Object.freeze({
            signal: undefined,
            isAborted: () => false,
            close: () => undefined
        });
    }
    const controller = new AbortController();
    let aborted = false;
    let listening = false;
    const abort = () => {
        if (aborted)
            return;
        aborted = true;
        controller.abort();
    };
    if (nativeSignalAborted(source)) {
        abort();
    }
    else {
        try {
            Reflect.apply(eventTargetAddEventListener, source, ['abort', abort, { once: true }]);
            listening = true;
        }
        catch {
            return invalidMemoryValue();
        }
        if (nativeSignalAborted(source))
            abort();
    }
    const close = () => {
        if (!listening)
            return;
        listening = false;
        try {
            Reflect.apply(eventTargetRemoveEventListener, source, ['abort', abort]);
        }
        catch {
            // The source was validated before listener registration. Cleanup failure is non-authoritative.
        }
    };
    return Object.freeze({
        signal: controller.signal,
        isAborted: () => aborted,
        close
    });
}

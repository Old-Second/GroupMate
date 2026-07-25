import { types as utilTypes } from 'node:util';
const MODES = new Set([
    'off', 'explicit', 'shadow', 'automatic'
]);
function currentMode(source) {
    try {
        const value = Reflect.apply(source, undefined, []);
        return typeof value === 'string' && MODES.has(value)
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function runtimeModule(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
        throw new TypeError('production personal memory module is invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'createProductionPersonalMemoryRuntimeV1');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
        throw new TypeError('production personal memory module is invalid');
    }
    return value;
}
export async function initializeProductionPersonalMemoryRuntimeV1(options) {
    const mode = currentMode(options.deploymentMode);
    if (mode === null || mode === 'off')
        return null;
    const loadModule = options.loadModule ?? (async () => (await import('./production-personal-memory-runtime.js')));
    const module = runtimeModule(await loadModule());
    return await module.createProductionPersonalMemoryRuntimeV1(Object.freeze({
        botInstanceId: options.botInstanceId,
        storageDirectory: options.storageDirectory,
        deploymentMode: options.deploymentMode,
        groupAllowlist: options.groupAllowlist,
        recallMaxItems: options.recallMaxItems,
        recallMaxTokens: options.recallMaxTokens,
        recallTimeoutMs: options.recallTimeoutMs
    }));
}

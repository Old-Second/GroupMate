import { types as utilTypes } from 'node:util';
let configuredPort = null;
function validPort(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
        return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'observe');
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'function' && !utilTypes.isProxy(descriptor.value);
}
export function configureProductionGroupMemoryObservationPortV1(port) {
    if (configuredPort !== null || !validPort(port)) {
        throw new Error('群记忆自动候选观察端口已配置或无效。');
    }
    configuredPort = port;
}
export function observeProductionGroupMessageV1(event) {
    try {
        configuredPort?.observe(event);
    }
    catch { /* observation is a side channel: the host message path must never see an error from it */ }
}

import { types as utilTypes } from 'node:util';
let configuredPort = null;
function validPort(value) {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
        return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'handle');
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'function' && !utilTypes.isProxy(descriptor.value);
}
export function configureProductionPersonalMemoryCommandPortV1(port) {
    if (configuredPort !== null || !validPort(port)) {
        throw new Error('个人长期记忆命令端口已配置或无效。');
    }
    configuredPort = port;
}
export function productionPersonalMemoryCommandGatewayV1() {
    return Object.freeze({
        async handle(request) {
            if (configuredPort !== null)
                return await configuredPort.handle(request);
            await request.replyText('个人长期记忆当前未启用，请联系机器人主人检查锅巴中的长期记忆模式。');
            return true;
        }
    });
}

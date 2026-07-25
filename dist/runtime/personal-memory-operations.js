import { types as utilTypes } from 'node:util';
const MODES = Object.freeze(['off', 'explicit', 'shadow', 'automatic']);
const ACTIONS = Object.freeze(['verify', 'rebuild_lexical']);
const STATUS_FIELDS = Object.freeze([
    'schemaVersion', 'status', 'canonical', 'lexical', 'extraction', 'hotCache', 'semantic'
]);
const MAXIMUM_COUNTER = Number.MAX_SAFE_INTEGER;
function exactRecord(value, fields) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        utilTypes.isProxy(value))
        throw new TypeError('长期记忆运维数据无效。');
    const keys = Object.keys(value);
    if (keys.length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
        throw new TypeError('长期记忆运维数据无效。');
    }
    const result = {};
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('长期记忆运维数据无效。');
        }
        result[field] = descriptor.value;
    }
    return result;
}
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value)) {
        throw new TypeError('长期记忆运维数据无效。');
    }
    return value;
}
function counter(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
        value > MAXIMUM_COUNTER || Object.is(value, -0)) {
        throw new TypeError('长期记忆运维数据无效。');
    }
    return value;
}
function counterRecord(value, fields) {
    const input = exactRecord(value, fields);
    return Object.freeze(Object.fromEntries(fields.map(field => [field, counter(input[field])])));
}
function modeValue(value) {
    return enumValue(value, MODES);
}
function actionValue(value) {
    try {
        return enumValue(value, ACTIONS);
    }
    catch {
        throw new TypeError('长期记忆维护动作无效。');
    }
}
function parseStatus(value, mode) {
    const input = exactRecord(value, STATUS_FIELDS);
    if (input.schemaVersion !== 1)
        throw new TypeError('长期记忆运维数据无效。');
    const status = enumValue(input.status, ['ready', 'degraded', 'maintenance']);
    const canonical = counterRecord(input.canonical, [
        'namespaces', 'activeRecords', 'logicalBytes', 'sqliteFileBytes'
    ]);
    const lexicalInput = exactRecord(input.lexical, [
        'status', 'records', 'logicalBytes', 'sqliteFileBytes', 'lagRecords'
    ]);
    const lexical = Object.freeze({
        status: enumValue(lexicalInput.status, ['ready', 'lagging', 'rebuilding', 'unavailable']),
        records: counter(lexicalInput.records),
        logicalBytes: counter(lexicalInput.logicalBytes),
        sqliteFileBytes: counter(lexicalInput.sqliteFileBytes),
        lagRecords: counter(lexicalInput.lagRecords)
    });
    const extractionInput = exactRecord(input.extraction, [
        'status', 'pendingRecords', 'deadLetterRecords', 'logicalBytes'
    ]);
    const extraction = Object.freeze({
        status: enumValue(extractionInput.status, ['idle', 'running', 'paused', 'unavailable']),
        pendingRecords: counter(extractionInput.pendingRecords),
        deadLetterRecords: counter(extractionInput.deadLetterRecords),
        logicalBytes: counter(extractionInput.logicalBytes)
    });
    const hotCacheInput = exactRecord(input.hotCache, ['status', 'records', 'logicalBytes']);
    const hotCache = Object.freeze({
        status: enumValue(hotCacheInput.status, ['disabled', 'ready', 'unavailable']),
        records: counter(hotCacheInput.records),
        logicalBytes: counter(hotCacheInput.logicalBytes)
    });
    const semanticInput = exactRecord(input.semantic, ['embedding', 'vector', 'rerank']);
    if (semanticInput.embedding !== 'disabled' || semanticInput.vector !== 'disabled' ||
        semanticInput.rerank !== 'disabled')
        throw new TypeError('长期记忆运维数据无效。');
    return Object.freeze({
        schemaVersion: 1,
        status,
        mode,
        canonical,
        lexical,
        extraction,
        hotCache,
        semantic: Object.freeze({
            embedding: 'disabled',
            vector: 'disabled',
            rerank: 'disabled'
        })
    });
}
function parseMaintenanceResult(value, action) {
    const input = exactRecord(value, ['schemaVersion', 'status', 'action', 'affectedRecords']);
    if (input.schemaVersion !== 1 || input.status !== 'completed' || input.action !== action) {
        throw new TypeError('长期记忆运维数据无效。');
    }
    return Object.freeze({
        schemaVersion: 1,
        status: 'completed',
        action,
        affectedRecords: counter(input.affectedRecords)
    });
}
function unavailableStatus(mode) {
    return Object.freeze({ schemaVersion: 1, status: 'unavailable', mode });
}
function unavailableResult(action) {
    return Object.freeze({ schemaVersion: 1, status: 'unavailable', action });
}
export function createPersonalMemoryOperationsGatewayV1(options) {
    if (typeof options?.mode !== 'function' || typeof options?.port !== 'function') {
        throw new TypeError('长期记忆运维配置无效。');
    }
    const currentMode = () => {
        try {
            return modeValue(Reflect.apply(options.mode, undefined, []));
        }
        catch {
            return 'off';
        }
    };
    const currentPort = () => {
        try {
            const port = Reflect.apply(options.port, undefined, []);
            return port !== null && typeof port?.inspect === 'function' &&
                typeof port?.execute === 'function' ? port : null;
        }
        catch {
            return null;
        }
    };
    return Object.freeze({
        async inspect(signal) {
            const mode = currentMode();
            if (mode === 'off')
                return Object.freeze({ schemaVersion: 1, status: 'off', mode });
            const port = currentPort();
            if (port === null)
                return unavailableStatus(mode);
            try {
                return parseStatus(await port.inspect(signal), mode);
            }
            catch {
                return unavailableStatus(mode);
            }
        },
        async execute(actionInput, signal) {
            const action = actionValue(actionInput);
            const mode = currentMode();
            if (mode === 'off') {
                return Object.freeze({ schemaVersion: 1, status: 'disabled', action });
            }
            const port = currentPort();
            if (port === null)
                return unavailableResult(action);
            try {
                return parseMaintenanceResult(await port.execute(Object.freeze({
                    schemaVersion: 1,
                    action
                }), signal), action);
            }
            catch {
                return unavailableResult(action);
            }
        }
    });
}
export function formatPersonalMemoryOperationsStatusV1(value) {
    if (value.status === 'off')
        return '已关闭；未初始化长期记忆存储。';
    if (value.status === 'unavailable')
        return '当前运行实例尚未提供长期记忆状态。';
    return [
        `${value.canonical.namespaces} 个命名空间`,
        `${value.canonical.activeRecords} 条有效记忆`,
        `canonical ${value.canonical.logicalBytes} B`,
        `词法索引 ${value.lexical.status}/${value.lexical.records} 条`,
        `候选队列 ${value.extraction.pendingRecords} 条`,
        `死信 ${value.extraction.deadLetterRecords} 条`,
        `热缓存 ${value.hotCache.status}/${value.hotCache.records} 条`,
        '语义外发关闭'
    ].join('；');
}
let configuredPort = null;
export function configureProductionPersonalMemoryOperationsPortV1(port) {
    if (configuredPort !== null || typeof port?.inspect !== 'function' ||
        typeof port?.execute !== 'function') {
        throw new Error('长期记忆运维端口已配置或无效。');
    }
    configuredPort = port;
}
export function productionPersonalMemoryOperationsGatewayV1(mode) {
    return createPersonalMemoryOperationsGatewayV1({ mode, port: () => configuredPort });
}

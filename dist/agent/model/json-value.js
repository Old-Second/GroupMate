const DEFAULT_MAX_BYTES = 1_024 * 1_024;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 8_192;
function assertPositiveInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${field} must be a positive integer`);
    }
}
function cloneJsonValue(value, depth, options, state) {
    state.nodes += 1;
    if (state.nodes > options.maxNodes)
        throw new TypeError('JSON value node limit exceeded');
    if (depth > options.maxDepth)
        throw new TypeError('JSON value depth limit exceeded');
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new TypeError('JSON value contains a non-finite number');
        return value;
    }
    if (typeof value !== 'object')
        throw new TypeError('JSON value contains an unsupported value');
    if (state.ancestors.has(value))
        throw new TypeError('JSON value contains a cycle');
    state.ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return Object.freeze(value.map(item => cloneJsonValue(item, depth + 1, options, state)));
        }
        let prototype;
        let descriptors;
        let symbols;
        try {
            prototype = Object.getPrototypeOf(value);
            descriptors = Object.getOwnPropertyDescriptors(value);
            symbols = Object.getOwnPropertySymbols(value);
        }
        catch {
            throw new TypeError('JSON value object cannot be inspected safely');
        }
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('JSON value must contain only plain objects');
        }
        if (symbols.length > 0)
            throw new TypeError('JSON value cannot contain symbol keys');
        const entries = [];
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError('JSON value cannot contain accessors or hidden properties');
            }
            entries.push([
                key,
                cloneJsonValue(descriptor.value, depth + 1, options, state)
            ]);
        }
        return Object.freeze(Object.fromEntries(entries));
    }
    finally {
        state.ancestors.delete(value);
    }
}
export function jsonByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
export function parseJsonValue(value, inputOptions = {}) {
    const options = {
        maxBytes: inputOptions.maxBytes ?? DEFAULT_MAX_BYTES,
        maxDepth: inputOptions.maxDepth ?? DEFAULT_MAX_DEPTH,
        maxNodes: inputOptions.maxNodes ?? DEFAULT_MAX_NODES
    };
    assertPositiveInteger(options.maxBytes, 'JSON value byte limit');
    assertPositiveInteger(options.maxDepth, 'JSON value depth limit');
    assertPositiveInteger(options.maxNodes, 'JSON value node limit');
    const parsed = cloneJsonValue(value, 0, options, {
        nodes: 0,
        ancestors: new Set()
    });
    if (jsonByteLength(parsed) > options.maxBytes) {
        throw new TypeError('JSON value byte limit exceeded');
    }
    return parsed;
}

/** delete_msg has no message_id. TRSS wraps its OneBot acknowledgements in an array. */
export function normalizeYunzaiHostRecallResult(value) {
    if (typeof value === 'boolean')
        return value;
    if (value === null || typeof value !== 'object')
        return null;
    if (arrayState(value) === true) {
        const length = ownData(value, 'length')?.value;
        if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 16)
            return null;
        const results = [];
        for (let index = 0; index < Number(length); index += 1) {
            const item = ownData(value, String(index));
            if (item?.found !== true || (item.value !== null && typeof item.value === 'object' &&
                arrayState(item.value) !== false))
                return null;
            results.push(normalizeYunzaiHostRecallResult(item.value));
        }
        return results.every(result => result === true) ? true
            : results.every(result => result === false) ? false : null;
    }
    const status = ownData(value, 'status');
    const retcode = ownData(value, 'retcode');
    const data = ownData(value, 'data');
    if (status?.found !== true || retcode?.found !== true || data?.found !== true)
        return null;
    if (status.value === 'ok' && retcode.value === 0)
        return true;
    return status.value === 'failed' && Number.isSafeInteger(retcode.value) && retcode.value !== 0 ? false : null;
}
function ownData(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined)
            return Object.freeze({ found: false });
        if (!Object.hasOwn(descriptor, 'value'))
            return null;
        return Object.freeze({ found: true, value: descriptor.value });
    }
    catch {
        return null;
    }
}
function arrayState(value) {
    try {
        return Array.isArray(value);
    }
    catch {
        return null;
    }
}
/**
 * Projects a successful OneBot response envelope into the strict outbound
 * receipt shape. This function belongs at the trusted Yunzai host boundary;
 * it deliberately reads only own data descriptors so ordinary getters cannot
 * widen the core receipt classifier. Proxy descriptor traps still belong to
 * the trusted host adapter, but any trap failure is caught and fails closed.
 */
export function normalizeYunzaiHostDispatchResult(value) {
    if (value === null || typeof value !== 'object')
        return value;
    const valueIsArray = arrayState(value);
    if (valueIsArray === null)
        return null;
    if (valueIsArray)
        return value;
    const status = ownData(value, 'status');
    const retcode = ownData(value, 'retcode');
    const envelopeClaimed = status === null || retcode === null ||
        status.found || retcode.found;
    if (!envelopeClaimed)
        return value;
    const nested = ownData(value, 'data');
    if (status?.found !== true || status.value !== 'ok' ||
        retcode?.found !== true || retcode.value !== 0 ||
        nested?.found !== true || nested.value === null ||
        typeof nested.value !== 'object')
        return null;
    const nestedIsArray = arrayState(nested.value);
    if (nestedIsArray !== false)
        return null;
    const rootSnake = ownData(value, 'message_id');
    const rootCamel = ownData(value, 'messageId');
    if (rootSnake === null || rootCamel === null || rootSnake.found || rootCamel.found)
        return null;
    const snake = ownData(nested.value, 'message_id');
    const camel = ownData(nested.value, 'messageId');
    if (snake?.found !== true || camel === null ||
        (camel.found && camel.value !== snake.value))
        return null;
    return Object.freeze({ message_id: snake.value });
}

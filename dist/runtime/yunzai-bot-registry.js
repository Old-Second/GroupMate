/**
 * Enumerates the live Yunzai bot instances of the host process.
 *
 * TRSS-Yunzai keeps every logged-in account id in the `Bot.uin` array and the
 * matching instance in `Bot.bots[id]` (also exposed as `Bot[id]`), while
 * `Bot.adapter` only lists adapter descriptors. Legacy single-account hosts are
 * themselves the bot instance. Callers receive real instances only, so a group
 * lookup such as `bot.gl` or a send through `bot.pickGroup` never runs against
 * an aggregate proxy or an undefined entry.
 */
function hostBot() {
    try {
        const host = Reflect.get(globalThis, 'Bot');
        return host === undefined || host === null ? null : host;
    }
    catch {
        return null;
    }
}
function botIdentifier(value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        return null;
    }
    const normalized = String(value).trim();
    return /^\d{1,32}$/.test(normalized) ? normalized : null;
}
function instanceOf(host, botId) {
    for (const candidate of [
        () => Reflect.get(host, 'bots'),
        () => host
    ]) {
        try {
            const container = candidate();
            if (container === undefined || container === null)
                continue;
            const instance = Reflect.get(container, botId);
            if (instance !== undefined && instance !== null && typeof instance === 'object') {
                return instance;
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
function looksLikeBot(value) {
    try {
        return typeof Reflect.get(value, 'pickGroup') === 'function' ||
            Reflect.get(value, 'gl') !== undefined;
    }
    catch {
        return false;
    }
}
export function listYunzaiBots() {
    const host = hostBot();
    if (host === null)
        return Object.freeze([]);
    let accountIds = null;
    try {
        const uin = Reflect.get(host, 'uin');
        if (Array.isArray(uin))
            accountIds = uin;
    }
    catch {
        accountIds = null;
    }
    // Legacy single-account hosts are the bot instance themselves.
    if (accountIds === null) {
        return looksLikeBot(host) ? Object.freeze([host]) : Object.freeze([]);
    }
    const bots = [];
    const seen = new Set();
    for (const value of accountIds) {
        const botId = botIdentifier(value);
        if (botId === null)
            continue;
        const instance = instanceOf(host, botId);
        if (instance === null || seen.has(instance))
            continue;
        seen.add(instance);
        bots.push(instance);
    }
    return Object.freeze(bots);
}
/**
 * Sends a group message through a bot instance.
 *
 * TRSS-Yunzai instances only expose `pickGroup(group_id).sendMsg(message)`,
 * while legacy single-account clients also accept `sendGroupMsg(group_id,
 * message)`. Preferring the picker keeps both host generations working without
 * hitting the aggregate `Bot.sendGroupMsg(bot_id, group_id, message)` signature.
 */
export async function sendYunzaiGroupMessage(bot, groupId, message) {
    const pickGroup = Reflect.get(bot, 'pickGroup');
    if (typeof pickGroup === 'function') {
        const group = await Reflect.apply(pickGroup, bot, [groupId]);
        if (group !== null && typeof group === 'object') {
            const sendMsg = Reflect.get(group, 'sendMsg');
            if (typeof sendMsg === 'function') {
                return await Reflect.apply(sendMsg, group, [message]);
            }
        }
    }
    const sendGroupMsg = Reflect.get(bot, 'sendGroupMsg');
    if (typeof sendGroupMsg === 'function') {
        return await Reflect.apply(sendGroupMsg, bot, [groupId, message]);
    }
    throw new TypeError('host bot cannot send group messages');
}

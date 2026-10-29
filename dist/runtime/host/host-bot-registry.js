import { normalizedText } from './host-config-values.js';
// A conversation only needs the bot that is currently answering it, so the table stays small and
// evicts in insertion order; re-remembering an id moves it back to the newest slot.
const REMEMBERED_BOT_LIMIT = 8;
const IDENTIFIER_CHARACTERS = 128;
function record(value) {
    return value !== null && typeof value === 'object'
        ? value
        : {};
}
export function createHostBotRegistry(dependencies) {
    const rememberedBots = new Map();
    const rememberBot = (botId, bot) => {
        if (bot === null || typeof bot !== 'object' || botId === '')
            return;
        rememberedBots.delete(botId);
        rememberedBots.set(botId, bot);
        while (rememberedBots.size > REMEMBERED_BOT_LIMIT) {
            const oldest = rememberedBots.keys().next().value;
            if (oldest === undefined)
                break;
            rememberedBots.delete(oldest);
        }
    };
    const configuredBotId = (event) => {
        const source = record(event);
        let value = source.self_id ?? record(source.bot).uin;
        if (value === undefined || value === null || String(value) === '') {
            const globalBot = record(dependencies.hostBot());
            const candidates = Array.isArray(globalBot.uin)
                ? globalBot.uin
                : [globalBot.uin];
            const configured = dependencies.config.trssBotUin;
            // Truthiness, not a presence check: an operator who leaves the TRSS account id blank, at 0 or
            // at NaN must fall through to the host's own account list exactly as before.
            value = Boolean(configured) &&
                candidates.some(item => String(item) === String(configured))
                ? configured
                : candidates.filter(item => item !== undefined && item !== null).at(-1);
        }
        const botId = normalizedText(String(value ?? ''), IDENTIFIER_CHARACTERS);
        if (botId === '')
            throw new TypeError('Yunzai bot identity is unavailable');
        rememberBot(botId, source.bot);
        return botId;
    };
    const botPicker = Object.freeze({
        async pick(botId) {
            const known = rememberedBots.get(String(botId));
            if (known !== undefined)
                return known;
            const globalBot = dependencies.hostBot();
            if (globalBot === null || typeof globalBot !== 'object')
                return null;
            const indexed = globalBot[String(botId)];
            if (indexed !== undefined && indexed !== null)
                return indexed;
            const uin = globalBot.uin;
            if (!Array.isArray(uin) && String(uin ?? '') === String(botId)) {
                return globalBot;
            }
            return null;
        }
    });
    const masterIds = async () => {
        const hostConfig = record(await dependencies.loadHostConfig());
        const value = hostConfig.masterQQ;
        return Object.freeze((Array.isArray(value) ? value : [value])
            .filter((item) => typeof item === 'string' || typeof item === 'number'));
    };
    const eventActorId = (event) => {
        const source = record(event);
        return normalizedText(String(record(source.sender).user_id ?? source.user_id ?? ''), IDENTIFIER_CHARACTERS);
    };
    const eventTarget = (event) => {
        const botId = configuredBotId(event);
        const actorId = eventActorId(event);
        const source = record(event);
        if (source.isGroup === true) {
            return Object.freeze({
                botId,
                scope: Object.freeze({
                    kind: 'group',
                    groupId: normalizedText(String(source.group_id ?? ''), IDENTIFIER_CHARACTERS)
                })
            });
        }
        return Object.freeze({
            botId,
            scope: Object.freeze({ kind: 'private', userId: actorId })
        });
    };
    return Object.freeze({
        rememberBot, configuredBotId, botPicker, masterIds, eventActorId, eventTarget
    });
}

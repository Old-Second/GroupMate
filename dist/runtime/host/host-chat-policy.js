import path from 'node:path';
import { configuredReasoningEffort, configuredThinkingMode, finiteInteger, normalizedStringList, normalizedText } from './host-config-values.js';
import { resolveTtsMode } from './host-config-projection.js';
import { resolvePluginPath } from '../plugin-context.js';
const ACTOR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CAST_CHARACTERS = 8_192;
const OCR_TEXT_CHARACTERS = 2_000;
const MAX_OCR_IMAGES = 8;
const MAX_IMAGE_URL_CHARACTERS = 4_096;
const MAX_SESSION_TTL_SECONDS = 31_536_000;
// Operator-facing nudges appended when the previous reply mishandled the emotion markup. The keys
// are the raw Redis flag values, so they stay strings.
const EMOTION_CORRECTIONS = Object.freeze({
    1: '(上一次回复没有添加情绪，请确保接下来的对话正确使用情绪和情绪格式，回复时忽略此内容。)',
    2: '(不要使用给出情绪范围的词和错误的情绪格式，请确保接下来的对话正确选择情绪，回复时忽略此内容。)',
    3: '(不要给出多个情绪[]项，请确保接下来的对话给且只给出一个正确情绪项，回复时忽略此内容。)'
});
function record(value) {
    return value !== null && typeof value === 'object'
        ? value
        : {};
}
// Exported because the host bootstrap also hands these to the tool runtime and the TTS backend, not
// only to the chat policy. Both are pure: the image list is derived from the event and the voice
// lookup from the injected table.
export function collectEventImageUrls(event) {
    const message = record(event).message;
    if (!Array.isArray(message))
        return Object.freeze([]);
    const urls = [];
    for (const item of message) {
        // The cap is counted before de-duplication, which is what the legacy loop did.
        if (urls.length >= MAX_OCR_IMAGES || item === null || typeof item !== 'object' ||
            item.type !== 'image')
            continue;
        const segment = item;
        const data = record(segment.data);
        const value = segment.url ?? segment.file ?? data.url ?? data.file;
        if (typeof value === 'string' && value.length <= MAX_IMAGE_URL_CHARACTERS)
            urls.push(value);
    }
    return Object.freeze([...new Set(urls)]);
}
export function findAzureVoice(voices, voice) {
    return voices.find(item => item.code === voice || item.name === voice);
}
export function createHostChatPolicy(dependencies) {
    // Resolved once, exactly as the legacy bootstrap did: changing the entry mode rebuilds the QQ
    // command rules, which only happens on restart. `guoba-schema.ts` documents that to operators.
    const bootstrapEntryMode = dependencies.config.toggleMode === 'prefix' ? 'prefix' : 'at';
    const actorCast = async (actorId) => {
        if (!ACTOR_ID_PATTERN.test(actorId))
            return '';
        try {
            const raw = await dependencies.readTextFile(resolvePluginPath(path.join('resources/ChatGPTCache/user', `${actorId}.json`)));
            const parsed = JSON.parse(raw);
            return normalizedText(record(record(parsed).cast).api, CAST_CHARACTERS);
        }
        catch {
            // A missing or malformed cast file means the actor simply has no override.
            return '';
        }
    };
    const ocrText = async (event) => {
        const bot = record(record(event).bot);
        const imageOcr = bot.imageOcr;
        if (typeof imageOcr !== 'function')
            return Object.freeze([]);
        const result = [];
        for (const image of collectEventImageUrls(event)) {
            try {
                const response = record(await imageOcr.call(bot, image));
                const words = Array.isArray(response.wordslist) ? response.wordslist : [];
                const text = normalizedText(words.map(item => record(item).words ?? '').join('\n'), OCR_TEXT_CHARACTERS);
                if (text !== '')
                    result.push(text);
            }
            catch {
                // OCR is best effort: an image the host cannot read must not change the reply.
            }
        }
        return Object.freeze(result);
    };
    const azureVoice = (voice) => findAzureVoice(dependencies.azureVoices, voice);
    const appendAzureEmotionFeedback = async (input) => {
        const { actorId, prompt, preferences } = input;
        if (resolveTtsMode(dependencies.config) !== 'azure' ||
            dependencies.config.enhanceAzureTTSEmotion !== true ||
            dependencies.config.azureTTSEmotion !== true || preferences.useTTS !== true ||
            azureVoice(preferences.ttsRoleAzure)?.emotion === undefined)
            return prompt;
        const flag = await dependencies.redis.get(`CHATGPT:WRONG_EMOTION:${actorId}`);
        const addition = EMOTION_CORRECTIONS[String(flag)];
        return typeof addition === 'string' ? `${prompt}${addition}` : prompt;
    };
    return Object.freeze({
        entryMode: () => bootstrapEntryMode,
        async snapshot(event) {
            const config = dependencies.config;
            const actorId = dependencies.eventActorId(event);
            const ttl = finiteInteger(config.conversationPreserveTime, 0, 0, MAX_SESSION_TTL_SECONDS);
            return Object.freeze({
                toggleMode: bootstrapEntryMode,
                enablePrivateChat: config.enablePrivateChat === true,
                whitelist: normalizedStringList(config.whitelist),
                blacklist: normalizedStringList(config.blacklist),
                imgOcr: config.imgOcr === true,
                groupMerge: config.groupMerge === true,
                enableGroupContext: config.enableGroupContext === true,
                thinkingMode: configuredThinkingMode(config.apiThinkingMode),
                reasoningEffort: configuredReasoningEffort(config.apiReasoningEffort),
                ...(ttl > 0 ? { sessionTtlSeconds: ttl } : {}),
                assistantLabel: normalizedText(config.assistantLabel, 128, 'GroupMate'),
                promptPrefixOverride: normalizedText(config.promptPrefixOverride, 8_192),
                actorCastApi: await actorCast(actorId)
            });
        },
        async isMuted(target) {
            if (await dependencies.redis.get('CHATGPT:SHUT_UP:ALL'))
                return true;
            const scope = target.scope;
            const groupId = scope.kind === 'group' || scope.kind === 'group_user' ? scope.groupId : '';
            return groupId !== '' &&
                Boolean(await dependencies.redis.get(`CHATGPT:SHUT_UP:${groupId}`));
        },
        ocrText,
        appendAzureEmotionFeedback,
        clearAzureEmotionFeedback: async (actorId) => {
            await dependencies.redis.del(`CHATGPT:WRONG_EMOTION:${actorId}`);
        }
    });
}

const DEFAULTS = Object.freeze({
    quoteReply: true,
    enableRobotAt: true,
    enableMarkdown: false,
    enableSuggestedResponses: false,
    forwardReasoning: true,
    defaultUsePicture: false,
    defaultUseTTS: false,
    defaultTTSRole: '纳西妲',
    azureTTSSpeaker: 'zh-CN-XiaochenNeural',
    voicevoxTTSSpeaker: '护士机器子T',
    ttsMode: 'vits-uma-genshin-honkai',
    alsoSendText: false,
    ttsAutoFallbackThreshold: 299,
    autoUsePicture: true,
    autoUsePictureThreshold: 1_200,
    cloudDPR: 1,
    closeBrowserAfterRender: true,
    showQRCode: true,
    live2d: false,
    live2dModel: '/live2d/Murasame/Murasame.model3.json',
    live2dOptionScale: 0.1,
    live2dOptionPositionX: 0,
    live2dOptionPositionY: 0,
    live2dOptionRotation: 0,
    live2dOptionAlpha: 1
});
function nfcText(value) {
    return value.trim().normalize('NFC');
}
function boundedText(value, maximum, fallback) {
    if (typeof value !== 'string')
        return fallback;
    const normalized = nfcText(value);
    return normalized !== '' && [...normalized].length <= maximum ? normalized : fallback;
}
function booleanValue(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function finiteClamped(value, fallback, minimum, maximum, truncate = false) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const number = truncate ? Math.trunc(value) : value;
    return Math.min(Math.max(number, minimum), maximum);
}
function normalizedWords(value) {
    if (!Array.isArray(value))
        return Object.freeze([]);
    const words = [];
    const seen = new Set();
    for (const item of value) {
        if (words.length >= 256)
            break;
        if (typeof item !== 'string')
            continue;
        const normalized = nfcText(item);
        if (normalized === '')
            continue;
        const bounded = [...normalized].slice(0, 128).join('');
        if (seen.has(bounded))
            continue;
        seen.add(bounded);
        words.push(bounded);
    }
    return Object.freeze(words);
}
function filterFrom(value) {
    if (typeof value !== 'string')
        return null;
    const matched = /^\/([\s\S]*)\/([a-z]*)$/.exec(value);
    if (matched === null)
        return null;
    const source = matched[1] ?? '';
    const flags = matched[2] ?? '';
    if ([...source].length > 512 || [...flags].length > 8 ||
        /[^dgimsuy]/.test(flags) || new Set(flags).size !== flags.length)
        return null;
    try {
        new RegExp(source, flags);
    }
    catch {
        return null;
    }
    return Object.freeze({ source, flags });
}
function ttsMode(value) {
    return value === 'azure' || value === 'voicevox' || value === 'vits-uma-genshin-honkai'
        ? value
        : DEFAULTS.ttsMode;
}
function parseUserJson(value) {
    if (value === null)
        return Object.freeze({});
    try {
        const parsed = JSON.parse(value);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return Object.freeze({});
        }
        const record = parsed;
        const result = {};
        if (Object.hasOwn(record, 'usePicture') && typeof record.usePicture === 'boolean') {
            result.usePicture = record.usePicture;
        }
        if (Object.hasOwn(record, 'useTTS') && typeof record.useTTS === 'boolean') {
            result.useTTS = record.useTTS;
        }
        for (const key of ['ttsRole', 'ttsRoleAzure', 'ttsRoleVoiceVox']) {
            if (!Object.hasOwn(record, key) || typeof record[key] !== 'string')
                continue;
            const normalized = nfcText(record[key]);
            if (normalized !== '' && [...normalized].length <= 256)
                result[key] = normalized;
        }
        return Object.freeze(result);
    }
    catch {
        return Object.freeze({});
    }
}
export function createPresentationSettingsPort(source) {
    return Object.freeze({
        async load(actorId) {
            const config = source.currentSafeConfig();
            let userJson = null;
            try {
                userJson = await source.loadUserJson(actorId);
            }
            catch { }
            const user = parseUserJson(userJson);
            const mode = ttsMode(config.ttsMode);
            const defaultRole = boundedText(config.defaultTTSRole, 256, DEFAULTS.defaultTTSRole);
            const azureRole = boundedText(config.azureTTSSpeaker, 256, DEFAULTS.azureTTSSpeaker);
            const voicevoxRole = boundedText(config.voicevoxTTSSpeaker, 256, DEFAULTS.voicevoxTTSSpeaker);
            const selectedRoles = Object.freeze({
                'vits-uma-genshin-honkai': boundedText(user.ttsRole, 256, defaultRole),
                azure: boundedText(user.ttsRoleAzure, 256, azureRole),
                voicevox: boundedText(user.ttsRoleVoiceVox, 256, voicevoxRole)
            });
            const live2dEnabled = booleanValue(config.live2d, DEFAULTS.live2d);
            const tts = Object.freeze({
                enabled: user.useTTS ?? booleanValue(config.defaultUseTTS, DEFAULTS.defaultUseTTS),
                mode,
                activeVoice: selectedRoles[mode],
                alsoSendText: booleanValue(config.alsoSendText, DEFAULTS.alsoSendText),
                autoFallbackThreshold: finiteClamped(config.ttsAutoFallbackThreshold, DEFAULTS.ttsAutoFallbackThreshold, 1, 24_000, true),
                filter: filterFrom(config.ttsRegex),
                azureEmotionEnabled: booleanValue(config.enhanceAzureTTSEmotion, false)
            });
            const picture = Object.freeze({
                userEnabled: user.usePicture ?? booleanValue(config.defaultUsePicture, DEFAULTS.defaultUsePicture),
                autoEnabled: booleanValue(config.autoUsePicture, DEFAULTS.autoUsePicture),
                autoThreshold: finiteClamped(config.autoUsePictureThreshold, DEFAULTS.autoUsePictureThreshold, 1, 24_000, true),
                deviceScaleFactor: finiteClamped(config.cloudDPR, DEFAULTS.cloudDPR, 0.5, 4),
                closeBrowserAfterRender: booleanValue(config.closeBrowserAfterRender, DEFAULTS.closeBrowserAfterRender),
                showQRCode: booleanValue(config.showQRCode, DEFAULTS.showQRCode),
                live2d: live2dEnabled
                    ? Object.freeze({
                        modelPath: boundedText(config.live2dModel, 512, DEFAULTS.live2dModel),
                        scale: finiteClamped(config.live2dOption_scale, DEFAULTS.live2dOptionScale, 0, 10),
                        positionX: finiteClamped(config.live2dOption_positionX, DEFAULTS.live2dOptionPositionX, -4096, 4096),
                        positionY: finiteClamped(config.live2dOption_positionY, DEFAULTS.live2dOptionPositionY, -4096, 4096),
                        rotation: finiteClamped(config.live2dOption_rotation, DEFAULTS.live2dOptionRotation, -360, 360),
                        alpha: finiteClamped(config.live2dOption_alpha, DEFAULTS.live2dOptionAlpha, 0, 1)
                    })
                    : null
            });
            return Object.freeze({
                schemaVersion: 1,
                quoteReply: booleanValue(config.quoteReply, DEFAULTS.quoteReply),
                enableRobotAt: booleanValue(config.enableRobotAt, DEFAULTS.enableRobotAt),
                enableMarkdown: booleanValue(config.enableMd, DEFAULTS.enableMarkdown),
                enableSuggestedResponses: booleanValue(config.enableSuggestedResponses, DEFAULTS.enableSuggestedResponses),
                forwardReasoning: booleanValue(config.forwardReasoning, DEFAULTS.forwardReasoning),
                blockWords: normalizedWords(config.blockWords),
                promptBlockWords: normalizedWords(config.promptBlockWords),
                tts,
                picture
            });
        }
    });
}

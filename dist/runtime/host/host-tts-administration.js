import { normalizedText } from './host-config-values.js';
import { resolveTtsMode } from './host-config-projection.js';
const RANDOM_VOICE = '随机';
const VOICE_CHARACTERS = 256;
const KEY_CHARACTERS = 16_384;
const URL_CHARACTERS = 2_048;
const VOICEVOX_STYLE_PATTERN = /^(.*?)-(.*)$/;
function selected(storedVoice, message) {
    return Object.freeze({ kind: 'selected', storedVoice, message });
}
function unsupported(message) {
    return Object.freeze({ kind: 'unsupported', message });
}
function randomSelection(mode) {
    return selected(RANDOM_VOICE, `当前语音模式为${mode},您的默认语音角色已被设置为 "${RANDOM_VOICE}" `);
}
export function createHostTtsAdministration(dependencies) {
    const ttsConfigured = (mode) => {
        const config = dependencies.config;
        if (mode === 'azure')
            return normalizedText(config.azureTTSKey, KEY_CHARACTERS) !== '';
        if (mode === 'voicevox')
            return normalizedText(config.voicevoxSpace, URL_CHARACTERS) !== '';
        return normalizedText(config.ttsSpace, URL_CHARACTERS) !== '';
    };
    const missingTtsConfiguration = (mode, operation) => {
        if (operation === 'enable') {
            if (mode === 'azure')
                return '您没有配置Azure Key，请前往锅巴面板进行配置';
            if (mode === 'voicevox')
                return '您没有配置VoiceVox API，请前往锅巴面板进行配置';
            return '您没有配置VITS API，请前往锅巴面板进行配置';
        }
        if (mode === 'azure')
            return '您没有配置azure 密钥，请前往后台管理或锅巴面板进行配置';
        if (mode === 'voicevox')
            return '您没有配置voicevox API，请前往后台管理或锅巴面板进行配置';
        return '您没有配置vits-uma-genshin-honkai API，请前往后台管理或锅巴面板进行配置';
    };
    const selectVitsVoice = (mode, voice) => {
        const resolved = voice === RANDOM_VOICE ? RANDOM_VOICE : dependencies.convertSpeaker(voice);
        return resolved === RANDOM_VOICE || dependencies.vitsSpeakers.includes(resolved)
            ? selected(resolved, `当前语音模式为${mode},您的默认语音角色已被设置为 "${resolved}" `)
            : unsupported(`抱歉，"${resolved}"我还不认识呢`);
    };
    const selectAzureVoice = (mode, voice) => {
        if (voice === RANDOM_VOICE)
            return randomSelection(mode);
        // Azure voices are chosen by display name here; the stored value is the voice code.
        const match = dependencies.azureVoices.find(item => item.name === voice);
        if (match === undefined) {
            return unsupported(`抱歉，没有"${voice}"这个角色，目前azure模式下支持的角色有${dependencies.azureVoices.map(item => item.name).join('、')}`);
        }
        const emotion = match.emotion !== undefined && dependencies.config.azureTTSEmotion === true
            ? '，此角色支持多情绪配置，建议重新使用设定并结束对话以获得最佳体验！'
            : '';
        return selected(match.code, `当前语音模式为${mode},您的默认语音角色已被设置为 ${voice}-${String(match.gender)}-${String(match.languageDetail)} ${emotion}`);
    };
    const selectVoiceVoxVoice = (mode, voice) => {
        if (voice === RANDOM_VOICE)
            return randomSelection(mode);
        const matched = VOICEVOX_STYLE_PATTERN.exec(voice);
        const name = matched?.[1] ?? voice;
        const style = matched?.[2];
        const match = dependencies.voiceVoxVoices.find(item => item.name === name);
        if (match === undefined) {
            return unsupported(`抱歉，没有"${name}"这个角色，目前voicevox模式下支持的角色有${dependencies.voiceVoxVoices.map(item => item.name).join('、')}`);
        }
        if (style !== undefined && !match.styles.some(item => item.name === style)) {
            return unsupported(`抱歉，"${name}"这个角色没有"${style}"这个风格，目前支持的风格有${match.styles.map(item => item.name).join('、')}`);
        }
        const storedVoice = `${match.name}${style === undefined ? '' : `-${style}`}`;
        return selected(storedVoice, `当前语音模式为${mode},您的默认语音角色已被设置为 "${storedVoice}" `);
    };
    const selectVoice = (mode, requested) => {
        const voice = normalizedText(requested, VOICE_CHARACTERS, RANDOM_VOICE);
        if (mode === 'vits-uma-genshin-honkai')
            return selectVitsVoice(mode, voice);
        if (mode === 'azure')
            return selectAzureVoice(mode, voice);
        return selectVoiceVoxVoice(mode, voice);
    };
    return Object.freeze({
        getMode: () => resolveTtsMode(dependencies.config),
        setMode: dependencies.setTtsMode,
        isConfigured: ttsConfigured,
        selectVoice,
        missingConfigurationMessage: missingTtsConfiguration
    });
}

export async function resolveToolVoice(input) {
    const settings = await input.settings.load(input.actorId);
    return selectToolVoice({ ...input, activeVoice: settings.tts.activeVoice });
}
export function selectToolVoice(input) {
    const requested = input.requested.trim();
    const voice = ['', '默认', 'default'].includes(requested.toLowerCase()) ? input.activeVoice : requested;
    if (voice === '随机')
        return voice;
    if (input.mode === 'vits-uma-genshin-honkai')
        return input.vits.includes(voice) ? voice : null;
    if (input.mode === 'azure')
        return input.azure.find(item => item.code === voice || item.name === voice)?.code ?? null;
    if (input.voicevox.some(item => item.name === voice || item.styles.some(style => `${item.name}-${style.name}` === voice)))
        return voice;
    return null;
}

const VITS_MODE = 'vits-uma-genshin-honkai';
function exceedsThreshold(textCharacters, threshold) {
    const parsedThreshold = Number.parseInt(String(threshold), 10);
    return Number.isFinite(parsedThreshold) && textCharacters > parsedThreshold;
}
export function shouldFallbackVitsToText({ ttsMode, textCharacters, threshold }) {
    return ttsMode === VITS_MODE && exceedsThreshold(textCharacters, threshold);
}
export function shouldSendTtsText({ alsoSendText, textCharacters, threshold }) {
    return alsoSendText || exceedsThreshold(textCharacters, threshold);
}

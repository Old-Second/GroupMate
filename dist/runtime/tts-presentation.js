import { createRequire } from 'node:module';
const VITS_MODE = 'vits-uma-genshin-honkai';
const emojiStrip = createRequire(import.meta.url)('emoji-strip');
const EMOTION_MARKER_SOURCE = String.raw `\[\s*['\x60’‘]?([\p{L}\p{N}_]+)[\x60’‘']?\s*[,，、]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\]`;
const MIN_AZURE_EMOTION_DEGREE = 0.01;
const MAX_AZURE_EMOTION_DEGREE = 2;
function normalized(value) {
    return value.trim().normalize('NFC');
}
function removeEmotionMarkers(value) {
    const expression = new RegExp(EMOTION_MARKER_SOURCE, 'gu');
    let emotion;
    let emotionDegree;
    const text = value.replace(expression, (_marker, candidate, degree) => {
        if (emotion === undefined) {
            emotion = normalized(candidate);
            const parsed = Number(degree);
            if (Number.isFinite(parsed)) {
                emotionDegree = Math.min(Math.max(parsed, MIN_AZURE_EMOTION_DEGREE), MAX_AZURE_EMOTION_DEGREE);
            }
        }
        return '';
    });
    return Object.freeze({
        text: normalized(text),
        ...(emotion === undefined ? {} : { emotion }),
        ...(emotionDegree === undefined ? {} : { emotionDegree })
    });
}
function filteredText(text, filter) {
    if (filter === null)
        return text;
    try {
        return text.replace(new RegExp(filter.source, filter.flags), '');
    }
    catch {
        return text;
    }
}
export function preprocessTtsText(input) {
    const original = normalized(typeof input.text === 'string' ? input.text : '');
    const useEmotion = input.mode === 'azure' && input.azureEmotionEnabled;
    const body = useEmotion
        ? removeEmotionMarkers(original)
        : Object.freeze({ text: original });
    const prepared = normalized(emojiStrip(filteredText(body.text, input.filter)).replace(/[-:_；*;\n]/g, '，'));
    return Object.freeze({
        bodyText: body.text,
        spokenText: prepared,
        ...(body.emotion === undefined ? {} : { emotion: body.emotion }),
        ...(body.emotionDegree === undefined ? {} : { emotionDegree: body.emotionDegree })
    });
}
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

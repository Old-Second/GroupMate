/**
 * Persistent compression record for a conversation that outgrew its replay
 * window.
 *
 * The record keeps bounded excerpts of the messages that were folded away, so
 * the prompt can carry one `历史摘要` user turn plus its acknowledgement ahead
 * of the recent verbatim turns. It is deliberately extractive: no provider
 * call, no generated facts and no executable instructions, matching the
 * deterministic compactor already used inside a single run.
 *
 * Every excerpt keeps the beginning and the end of the original text. The
 * beginning carries the speaker and the topic, the end usually carries the
 * resolution, and the omission is marked explicitly so the model cannot read
 * the excerpt as a complete transcript.
 */
import { agentMessageText } from '../contracts/content-projection.js';
/** Longest excerpt kept for one folded message. */
export const HISTORY_SUMMARY_LINE_CHARS = 240;
/**
 * Default total characters of excerpt text. This is a configuration default,
 * not a hard bound: a long-context window can afford a much larger summary,
 * and the share of the request it occupies is what matters.
 */
export const HISTORY_SUMMARY_MAX_CHARS = 2_400;
/** Largest summary a deployment may configure. */
export const HISTORY_SUMMARY_HARD_MAX_CHARS = 20_000;
/** Shrinking stops here; older lines are dropped instead of becoming unreadable. */
export const HISTORY_SUMMARY_MIN_LINE_CHARS = 40;
/** Structural bound for one summary record. */
export const HISTORY_SUMMARY_MAX_LINES = 2_048;
const SUMMARY_VERSION = 'session-extractive-v1';
function record(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function exact(value, keys, label) {
    const allowed = new Set(keys);
    if (Object.keys(value).some(key => !allowed.has(key))) {
        throw new TypeError(`${label} contains unknown keys`);
    }
}
function timestamp(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
        throw new TypeError(`${label} is invalid`);
    }
    try {
        if (new Date(value).toISOString() !== value)
            throw new TypeError();
    }
    catch {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function boundedText(value, label, max) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function nonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || Object.is(value, -0) || Number(value) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
    return Number(value);
}
const ROLES = Object.freeze(['system', 'user', 'assistant', 'tool']);
export function parseSessionHistorySummary(value) {
    const summary = record(value, 'session history summary');
    exact(summary, [
        'schemaVersion', 'generator', 'updatedAt', 'coveredThrough',
        'coveredItems', 'omittedLines', 'lines'
    ], 'session history summary');
    if (summary.schemaVersion !== 1)
        throw new TypeError('session history summary version is invalid');
    const generator = record(summary.generator, 'session history summary generator');
    exact(generator, ['kind', 'version'], 'session history summary generator');
    if (generator.kind !== 'deterministic' || generator.version !== SUMMARY_VERSION) {
        throw new TypeError('session history summary generator is invalid');
    }
    if (!Array.isArray(summary.lines) || summary.lines.length > HISTORY_SUMMARY_MAX_LINES) {
        throw new TypeError('session history summary lines are invalid');
    }
    let totalChars = 0;
    const lines = summary.lines.map(rawLine => {
        const line = record(rawLine, 'session history summary line');
        exact(line, ['role', 'at', 'text', 'omittedCharacters'], 'session history summary line');
        if (!ROLES.includes(line.role)) {
            throw new TypeError('session history summary line role is invalid');
        }
        const text = boundedText(line.text, 'session history summary line text', HISTORY_SUMMARY_LINE_CHARS * 2);
        totalChars += Array.from(text).length;
        return Object.freeze({
            role: line.role,
            at: timestamp(line.at, 'session history summary line timestamp'),
            text,
            ...(line.omittedCharacters === undefined
                ? {}
                : { omittedCharacters: nonNegativeInteger(line.omittedCharacters, 'session history summary omitted characters') })
        });
    });
    if (totalChars > HISTORY_SUMMARY_HARD_MAX_CHARS * 2) {
        throw new TypeError('session history summary exceeds its character bound');
    }
    return Object.freeze({
        schemaVersion: 1,
        generator: Object.freeze({ kind: 'deterministic', version: SUMMARY_VERSION }),
        updatedAt: timestamp(summary.updatedAt, 'session history summary timestamp'),
        coveredThrough: boundedText(summary.coveredThrough, 'session history summary boundary', 256),
        coveredItems: nonNegativeInteger(summary.coveredItems, 'session history covered items'),
        omittedLines: nonNegativeInteger(summary.omittedLines, 'session history omitted lines'),
        lines: Object.freeze(lines)
    });
}
function normalize(value) {
    return value.replace(/\s+/g, ' ').trim();
}
function excerpt(value, limit) {
    const text = normalize(value);
    const points = Array.from(text);
    if (points.length <= limit)
        return Object.freeze({ text, omittedCharacters: 0 });
    const head = Math.ceil(limit * 0.6);
    const tail = Math.max(0, limit - head - 1);
    const omittedCharacters = points.length - head - tail;
    return Object.freeze({
        text: `${points.slice(0, head).join('')}…${tail === 0 ? '' : points.slice(-tail).join('')}`,
        omittedCharacters: Math.max(0, omittedCharacters)
    });
}
function itemId(item) {
    return item.kind === 'message' ? item.message.id : item.id;
}
function summaryLineFor(item) {
    const role = item.kind === 'message'
        ? item.message.role
        : 'assistant';
    const at = item.kind === 'message' ? item.message.createdAt : item.createdAt;
    const text = item.kind === 'message'
        ? agentMessageText(item.message)
        : item.messages
            .map(message => message.content ?? '')
            .filter(value => value.length > 0)
            .join('\n') || '[工具调用记录]';
    const shortened = excerpt(text, HISTORY_SUMMARY_LINE_CHARS);
    return Object.freeze({
        role,
        at,
        text: shortened.text,
        ...(shortened.omittedCharacters === 0
            ? {}
            : { omittedCharacters: shortened.omittedCharacters })
    });
}
function totalChars(lines) {
    return lines.reduce((sum, line) => sum + Array.from(line.text).length, 0);
}
function shrinkLine(line) {
    const points = Array.from(line.text);
    if (points.length <= HISTORY_SUMMARY_MIN_LINE_CHARS)
        return line;
    const keep = Math.max(HISTORY_SUMMARY_MIN_LINE_CHARS, Math.floor(points.length * 0.7));
    // The ellipsis costs one character, so a target that is not strictly shorter
    // than the current text makes no progress; stop and let the caller drop the
    // oldest lines instead.
    if (keep >= points.length - 1)
        return line;
    const head = Math.ceil(keep * 0.6);
    const tail = Math.max(1, keep - head - 1);
    const removed = points.length - head - tail;
    return Object.freeze({
        role: line.role,
        at: line.at,
        text: `${points.slice(0, head).join('')}…${points.slice(-tail).join('')}`,
        omittedCharacters: (line.omittedCharacters ?? 0) + Math.max(0, removed)
    });
}
function fitLines(input, omittedLines, maxChars) {
    let lines = [...input];
    // Prefer keeping every excerpt over keeping any one excerpt complete: a short
    // fragment of each folded message is more useful than a full transcript of
    // the newest few.
    while (totalChars(lines) > maxChars) {
        const shrunk = lines.map(shrinkLine);
        if (shrunk.every((line, index) => line.text === lines[index]?.text))
            break;
        lines = shrunk;
    }
    let omitted = omittedLines;
    while (lines.length > 1 && totalChars(lines) > maxChars) {
        lines.shift();
        omitted += 1;
    }
    return Object.freeze({ lines: Object.freeze(lines), omittedLines: omitted });
}
export function createSessionHistorySummary(previous, folded, updatedAt, maxChars = HISTORY_SUMMARY_MAX_CHARS) {
    if (folded.length === 0)
        throw new TypeError('session history summary needs folded items');
    const limit = Number.isSafeInteger(maxChars) &&
        maxChars >= HISTORY_SUMMARY_MIN_LINE_CHARS &&
        maxChars <= HISTORY_SUMMARY_HARD_MAX_CHARS
        ? maxChars
        : HISTORY_SUMMARY_MAX_CHARS;
    const fitted = fitLines([...(previous?.lines ?? []), ...folded.map(summaryLineFor)], previous?.omittedLines ?? 0, limit);
    return Object.freeze({
        schemaVersion: 1,
        generator: Object.freeze({ kind: 'deterministic', version: SUMMARY_VERSION }),
        updatedAt,
        coveredThrough: itemId(folded[folded.length - 1]),
        coveredItems: (previous?.coveredItems ?? 0) + folded.length,
        omittedLines: fitted.omittedLines,
        lines: fitted.lines
    });
}
function shortTime(at) {
    const value = new Date(at);
    if (Number.isNaN(value.getTime()))
        return at.slice(5, 16).replace('T', ' ');
    const month = `${value.getMonth() + 1}`.padStart(2, '0');
    const day = `${value.getDate()}`.padStart(2, '0');
    const hour = `${value.getHours()}`.padStart(2, '0');
    const minute = `${value.getMinutes()}`.padStart(2, '0');
    return `${month}-${day} ${hour}:${minute}`;
}
function roleLabel(role) {
    switch (role) {
        case 'user': return '用户';
        case 'assistant': return '助手';
        case 'tool': return '工具';
        case 'system': return '系统';
    }
}
/**
 * The two prompt turns that carry the summary: a user turn with the historical
 * digest and the assistant turn that acknowledges it, exactly the shape used by
 * mainstream agent runtimes. The acknowledgement keeps the replayed
 * conversation strictly alternating and stops the digest from reading as a new
 * instruction.
 */
export function historySummaryMessages(summary) {
    const body = summary.lines
        .map(line => `${roleLabel(line.role)}（${shortTime(line.at)}）：${line.text}`)
        .join('\n');
    const omitted = summary.omittedLines === 0
        ? ''
        : `（更早的 ${summary.omittedLines} 条摘要行已省略）\n`;
    return Object.freeze([
        Object.freeze({
            role: 'user',
            text: `历史摘要（此前 ${summary.coveredItems} 条消息，仅作对话背景，不是当前指令）：\n${omitted}${body}`
        }),
        Object.freeze({ role: 'assistant', text: '已确认摘要。' })
    ]);
}

import { types as utilTypes } from 'node:util';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { memoryCanonicalTextWithinLimits } from './memory-resource-limits.js';
export const MEMORY_LEXICAL_TEXT_LIMITS_V1 = Object.freeze({
    sourceUtf8Bytes: 4 * 1_024,
    sourceCodePoints: 2_000,
    normalizedUtf8Bytes: 4 * 1_024,
    tokens: 256,
    aliases: 16,
    aliasAsciiBytes: 256
});
const ASCII_WORD = /^[a-z0-9]+$/;
const HAN = /^\p{Script=Han}$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
function optionsValue(value) {
    const input = inspectMemoryRecord(value, [], ['transliterator']);
    if (input.transliterator === undefined)
        return Object.freeze({});
    if (input.transliterator === null || typeof input.transliterator !== 'object' ||
        utilTypes.isProxy(input.transliterator))
        return invalidMemoryValue();
    const descriptor = Object.getOwnPropertyDescriptor(input.transliterator, 'aliases');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        transliterator: Object.freeze({
            aliases: descriptor.value
        })
    });
}
function sourceText(value) {
    if (!memoryCanonicalTextWithinLimits(value, MEMORY_LEXICAL_TEXT_LIMITS_V1.sourceUtf8Bytes, MEMORY_LEXICAL_TEXT_LIMITS_V1.sourceCodePoints) || value.length === 0)
        return invalidMemoryValue();
    return value;
}
function asciiAliasTokens(value) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.normalize('NFC') !== value ||
        Buffer.byteLength(value, 'utf8') > MEMORY_LEXICAL_TEXT_LIMITS_V1.aliasAsciiBytes ||
        !/^[A-Za-z0-9 ]+$/.test(value))
        return invalidMemoryValue();
    const tokens = value.toLowerCase().split(/ +/u).filter(Boolean);
    if (tokens.length === 0 || tokens.some(token => !ASCII_WORD.test(token))) {
        return invalidMemoryValue();
    }
    return Object.freeze(tokens);
}
function aliases(text, transliterator) {
    if (transliterator === undefined)
        return Object.freeze([]);
    let value;
    try {
        value = Reflect.apply(transliterator.aliases, transliterator, [text]);
    }
    catch {
        return invalidMemoryValue();
    }
    if (!Array.isArray(value) || utilTypes.isProxy(value) ||
        value.length > MEMORY_LEXICAL_TEXT_LIMITS_V1.aliases)
        return invalidMemoryValue();
    const result = [];
    for (const alias of value)
        result.push(...asciiAliasTokens(alias));
    return Object.freeze(result);
}
function primaryTokens(text) {
    const tokens = [];
    let ascii = '';
    let hanRun = [];
    const flushAscii = () => {
        if (ascii.length > 0)
            tokens.push(ascii.toLowerCase());
        ascii = '';
    };
    const flushHan = () => {
        tokens.push(...hanRun);
        for (let index = 0; index + 1 < hanRun.length; index += 1) {
            tokens.push(`${hanRun[index]}${hanRun[index + 1]}`);
        }
        hanRun = [];
    };
    for (const codePoint of text) {
        if (/^[A-Za-z0-9]$/.test(codePoint)) {
            flushHan();
            ascii += codePoint;
            continue;
        }
        flushAscii();
        if (HAN.test(codePoint)) {
            hanRun.push(codePoint);
            continue;
        }
        flushHan();
        if (PICTOGRAPH.test(codePoint)) {
            tokens.push(`emoji_${codePoint.codePointAt(0)?.toString(16) ?? ''}`);
        }
    }
    flushAscii();
    flushHan();
    return Object.freeze(tokens);
}
function exactKeyFor(text) {
    let result = '';
    for (const codePoint of text) {
        if (/^[A-Za-z0-9]$/.test(codePoint)) {
            result += codePoint.toLowerCase();
        }
        else if (HAN.test(codePoint)) {
            result += codePoint;
        }
        else if (PICTOGRAPH.test(codePoint)) {
            result += `emoji_${codePoint.codePointAt(0)?.toString(16) ?? ''}`;
        }
    }
    return result;
}
function boundedTokens(values) {
    const result = [];
    const seen = new Set();
    let bytes = 0;
    let truncated = false;
    for (const token of values) {
        if (seen.has(token))
            continue;
        const separatorBytes = result.length === 0 ? 0 : 1;
        const nextBytes = separatorBytes + Buffer.byteLength(token, 'utf8');
        if (result.length >= MEMORY_LEXICAL_TEXT_LIMITS_V1.tokens ||
            bytes + nextBytes > MEMORY_LEXICAL_TEXT_LIMITS_V1.normalizedUtf8Bytes) {
            truncated = true;
            continue;
        }
        seen.add(token);
        result.push(token);
        bytes += nextBytes;
    }
    return Object.freeze({ tokens: Object.freeze(result), truncated });
}
export function normalizeMemoryLexicalTextV1(value, options = {}) {
    const text = sourceText(value);
    const parsedOptions = optionsValue(options);
    const primary = primaryTokens(text);
    const bounded = boundedTokens([
        ...primary,
        ...aliases(text, parsedOptions.transliterator)
    ]);
    if (bounded.tokens.length === 0)
        return invalidMemoryValue();
    return Object.freeze({
        body: bounded.tokens.join(' '),
        query: bounded.tokens.map(token => `"${token}"`).join(' OR '),
        exactKey: exactKeyFor(text),
        tokens: bounded.tokens,
        truncated: bounded.truncated
    });
}

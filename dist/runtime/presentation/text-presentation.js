export function codePointLength(value) {
    return [...value].length;
}
export function repairCodeFences(value) {
    const count = value.split('```').length - 1;
    const appendClosing = count % 2 === 1 && !value.endsWith('```');
    if (appendClosing)
        return `${value}\n\`\`\``;
    if (count > 0 && value.endsWith('```'))
        return value.replace(/```$/, '\n```');
    return value;
}
function filterResponseChunk(value) {
    if (value.trim() === '' || value.trim() === '```' || value.trim() === '<EMPTY>')
        return null;
    return value.trim().replace(/^<EMPTY>|<EMPTY>$/g, '').trim() || null;
}
export function splitProactiveText(value, maximum) {
    const regex = /(?<!\?)[。？\n](?!\?)/g;
    const raw = [];
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(value)) !== null) {
        if (raw.length >= maximum - 1)
            break;
        raw.push(Object.freeze({
            text: value.slice(lastIndex, match.index),
            delimiter: match[0]
        }));
        lastIndex = match.index + match[0].length;
    }
    raw.push(Object.freeze({ text: value.slice(lastIndex), delimiter: '' }));
    const parts = [];
    for (const item of raw.slice(0, maximum)) {
        const filtered = filterResponseChunk(item.delimiter === '？' ? `${item.text}？` : item.text);
        if (filtered !== null)
            parts.push(filtered);
    }
    return Object.freeze(parts);
}
export function textPart(atoms, buttons) {
    return Object.freeze({
        media: 'text',
        atoms: Object.freeze([...atoms]),
        ...(buttons === undefined ? {} : { buttons })
    });
}
export function plainTextPart(text) {
    return textPart(Object.freeze([{ kind: 'text', text }]));
}
export function citationForwardPart(citations) {
    return Object.freeze({
        media: 'forward',
        title: '参考资料',
        nodes: Object.freeze(citations.map(citation => Object.freeze({
            kind: 'text',
            text: [citation.title, citation.text, citation.sourceUrl].filter(Boolean).join('\n')
        })))
    });
}
export function reasoningForwardPart(text) {
    return Object.freeze({
        media: 'forward',
        title: '思考过程',
        nodes: Object.freeze([{ kind: 'text', text }])
    });
}

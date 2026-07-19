import { MAX_CONTEXT_SPANS, parseContextSpanV1 } from './context-span.js';
import { inspectContextArray, inspectContextRecord, invalidContextValue, requireContextAscii, requireSafeInteger } from './context-token-estimator.js';
export function parseContextSourceRequest(value) {
    const input = inspectContextRecord(value, [
        'namespaceRef', 'sceneRef', 'activeParticipantRefs'
    ]);
    const activeParticipantRefs = Object.freeze(inspectContextArray(input.activeParticipantRefs, MAX_CONTEXT_SPANS).map(requireContextAscii));
    if (new Set(activeParticipantRefs).size !== activeParticipantRefs.length) {
        return invalidContextValue();
    }
    return Object.freeze({
        namespaceRef: requireContextAscii(input.namespaceRef),
        sceneRef: requireContextAscii(input.sceneRef),
        activeParticipantRefs
    });
}
export function parseContextSourceLimits(value) {
    const input = inspectContextRecord(value, ['maxItems', 'maxBytes', 'deadlineMs']);
    const limits = Object.freeze({
        maxItems: requireSafeInteger(input.maxItems, { positive: true }),
        maxBytes: requireSafeInteger(input.maxBytes, { positive: true }),
        deadlineMs: requireSafeInteger(input.deadlineMs, { positive: true })
    });
    if (limits.maxItems > MAX_CONTEXT_SPANS || limits.maxBytes > 512 * 1_024) {
        return invalidContextValue();
    }
    return limits;
}
function throwAbortReason(signal) {
    throw signal.reason;
}
export async function retrieveMemoryContextSpans(source, requestValue, limitsValue, signal = new AbortController().signal) {
    const request = parseContextSourceRequest(requestValue);
    const limits = parseContextSourceLimits(limitsValue);
    if (signal.aborted)
        return throwAbortReason(signal);
    let raw;
    try {
        raw = await source.retrieve(request, limits, signal);
    }
    catch {
        if (signal.aborted)
            return throwAbortReason(signal);
        return invalidContextValue();
    }
    if (signal.aborted)
        return throwAbortReason(signal);
    const values = inspectContextArray(raw, limits.maxItems);
    const spans = Object.freeze(values.map(parseContextSpanV1));
    let bytes;
    try {
        bytes = Buffer.byteLength(JSON.stringify(spans), 'utf8');
    }
    catch {
        return invalidContextValue();
    }
    if (bytes > limits.maxBytes)
        return invalidContextValue();
    const anchors = new Set([request.sceneRef, ...request.activeParticipantRefs]);
    for (const span of spans) {
        if (span.namespaceRef !== request.namespaceRef || span.source !== 'memory' ||
            span.provenance.kind !== 'memory_record' ||
            !span.sourceRefs.some(ref => ref.ref === span.provenance.ref &&
                ref.contentHash === span.provenance.contentHash) ||
            !span.sourceRefs.some(ref => anchors.has(ref.ref)))
            return invalidContextValue();
    }
    return spans;
}

import { contextArtifactToSpan, MAX_CONTEXT_ARTIFACT_REFS, parseContextArtifactV1 } from './context-artifact.js';
import { createContextPlanV1, parseContextPlanV1 } from './context-plan.js';
import { contextSpanHash, MAX_CONTEXT_SPANS, parseContextSourceRefs, parseContextSpanV1 } from './context-span.js';
import { asciiContextCompare, canonicalizeContextJsonValue, canonicalJsonStringify, CONTEXT_TOKEN_ESTIMATOR_VERSION, estimateModelMessagesTokens, inspectContextArray, inspectContextRecord, invalidContextValue, requireContextAscii, requireContextHash, requireSafeInteger, serializeModelMessages, serializedModelMessagesBytes } from './context-token-estimator.js';
import { domainSeparatedContextHash } from './context-span.js';
export const CONTEXT_COMPACTION_REQUEST_HASH_DOMAIN = 'groupmate.context.compaction-request.v1';
export const MAX_CONTEXT_PLANNER_INPUT_BYTES = 512 * 1_024;
export const MAX_CONTEXT_COMPACTION_TOOL_CALLS = 8;
const BLOCKED_BUDGET = Object.freeze({
    status: 'blocked',
    code: 'context_budget_exceeded'
});
const BLOCKED_PROTOCOL = Object.freeze({
    status: 'blocked',
    code: 'tool_protocol_incomplete'
});
const PRIORITY_RANK = {
    critical: 4,
    high: 3,
    normal: 2,
    low: 1
};
const SOURCE_RANK = {
    system_instruction: 9,
    current_request: 8,
    approval: 7,
    runtime_fact: 6,
    tool_chain: 5,
    session_history: 4,
    group_context: 3,
    memory: 2,
    artifact: 1
};
function addSafe(left, right) {
    const value = left + right;
    return Number.isSafeInteger(value) ? value : invalidContextValue();
}
function parseBudget(value) {
    const input = inspectContextRecord(value, [
        'schemaVersion', 'maxInputTokens', 'maxSerializedMessageBytes', 'maxMessages',
        'estimatedToolTokens', 'reservedOutputTokens'
    ]);
    if (input.schemaVersion !== 1)
        return invalidContextValue();
    const budget = Object.freeze({
        schemaVersion: 1,
        maxInputTokens: requireSafeInteger(input.maxInputTokens, { positive: true }),
        maxSerializedMessageBytes: requireSafeInteger(input.maxSerializedMessageBytes, { positive: true }),
        maxMessages: requireSafeInteger(input.maxMessages, { positive: true }),
        estimatedToolTokens: requireSafeInteger(input.estimatedToolTokens),
        reservedOutputTokens: requireSafeInteger(input.reservedOutputTokens)
    });
    if (budget.maxSerializedMessageBytes > 512 * 1_024 || budget.maxMessages > 128) {
        return invalidContextValue();
    }
    return budget;
}
function validateSpanSet(spans, namespaceRef) {
    const ids = new Set();
    const orders = new Set();
    const byId = new Map(spans.map(span => [span.spanId, span]));
    for (const span of spans) {
        if (span.namespaceRef !== namespaceRef || ids.has(span.spanId) || orders.has(span.semanticOrder)) {
            return invalidContextValue();
        }
        ids.add(span.spanId);
        orders.add(span.semanticOrder);
    }
    for (const span of spans) {
        if (span.supersedes === null)
            continue;
        const target = byId.get(span.supersedes);
        if (target === undefined || span.requirement !== 'optional' || target.requirement !== 'optional' ||
            span.source !== target.source || span.semanticOrder <= target.semanticOrder) {
            return invalidContextValue();
        }
    }
}
function plannerInputBytes(input) {
    try {
        return Buffer.byteLength(JSON.stringify(input), 'utf8');
    }
    catch {
        return invalidContextValue();
    }
}
export function parseContextPlannerInputV1(value) {
    const preflight = canonicalizeContextJsonValue(value);
    if (Buffer.byteLength(canonicalJsonStringify(preflight), 'utf8') > MAX_CONTEXT_PLANNER_INPUT_BYTES) {
        return invalidContextValue();
    }
    const input = inspectContextRecord(value, [
        'schemaVersion', 'namespaceRef', 'generation', 'previousPlan', 'estimatorVersion',
        'capabilityHash', 'artifactPolicy', 'budget', 'spans', 'artifacts'
    ]);
    if (input.schemaVersion !== 1 || (input.artifactPolicy !== 'disabled' && input.artifactPolicy !== 'enabled')) {
        return invalidContextValue();
    }
    const spans = Object.freeze(inspectContextArray(input.spans, MAX_CONTEXT_SPANS).map(parseContextSpanV1));
    if (spans.some(span => span.kind === 'artifact' || span.source === 'artifact')) {
        return invalidContextValue();
    }
    const artifacts = Object.freeze(inspectContextArray(input.artifacts, MAX_CONTEXT_SPANS)
        .map(parseContextArtifactV1));
    if (spans.length + artifacts.length > MAX_CONTEXT_SPANS)
        return invalidContextValue();
    const parsed = Object.freeze({
        schemaVersion: 1,
        namespaceRef: requireContextAscii(input.namespaceRef),
        generation: requireSafeInteger(input.generation, { positive: true }),
        previousPlan: input.previousPlan === null ? null : parseContextPlanV1(input.previousPlan),
        estimatorVersion: requireContextAscii(input.estimatorVersion),
        capabilityHash: requireContextHash(input.capabilityHash),
        artifactPolicy: input.artifactPolicy,
        budget: parseBudget(input.budget),
        spans,
        artifacts
    });
    if (parsed.previousPlan === null) {
        if (parsed.generation < 1)
            return invalidContextValue();
    }
    else if (parsed.generation !== parsed.previousPlan.generation + 1 ||
        parsed.previousPlan.namespaceRef !== parsed.namespaceRef ||
        parsed.previousPlan.estimatorVersion !== parsed.estimatorVersion ||
        parsed.previousPlan.capabilityHash !== parsed.capabilityHash) {
        return invalidContextValue();
    }
    if (parsed.estimatorVersion !== CONTEXT_TOKEN_ESTIMATOR_VERSION)
        return invalidContextValue();
    validateSpanSet(parsed.spans, parsed.namespaceRef);
    if (plannerInputBytes(parsed) > MAX_CONTEXT_PLANNER_INPUT_BYTES)
        return invalidContextValue();
    return parsed;
}
function semanticOrder(left, right) {
    return left.semanticOrder - right.semanticOrder || asciiContextCompare(left.spanId, right.spanId);
}
function optionalKeepOrder(left, right) {
    return PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority] ||
        SOURCE_RANK[right.source] - SOURCE_RANK[left.source] ||
        right.originGeneration - left.originGeneration ||
        right.semanticOrder - left.semanticOrder ||
        asciiContextCompare(left.spanId, right.spanId);
}
function usageFor(spans) {
    let bytes = 2;
    let messages = 0;
    let nonemptySpans = 0;
    for (const span of spans) {
        if (span.messages.length === 0)
            continue;
        if (nonemptySpans > 0)
            bytes = addSafe(bytes, 1);
        bytes = addSafe(bytes, span.serializedBytes - 2);
        messages = addSafe(messages, span.messages.length);
        nonemptySpans += 1;
    }
    return Object.freeze({
        tokens: messages === 0 ? 0 : Math.max(1, Math.ceil(bytes / 4)),
        bytes,
        messages
    });
}
function atLeastPercent(used, maximum, percent) {
    return BigInt(used) * 100n >= BigInt(maximum) * BigInt(percent);
}
function atMostPercent(used, maximum, percent) {
    return BigInt(used) * 100n <= BigInt(maximum) * BigInt(percent);
}
function entersCompacting(usage, budget) {
    return atLeastPercent(usage.tokens, budget.maxInputTokens, 85) ||
        atLeastPercent(usage.bytes, budget.maxSerializedMessageBytes, 85) ||
        atLeastPercent(usage.messages, budget.maxMessages, 85);
}
function atOrBelowTarget(usage, budget) {
    return atMostPercent(usage.tokens, budget.maxInputTokens, 70) &&
        atMostPercent(usage.bytes, budget.maxSerializedMessageBytes, 70) &&
        atMostPercent(usage.messages, budget.maxMessages, 70);
}
function fitsHardBudget(usage, budget) {
    return usage.tokens <= budget.maxInputTokens &&
        usage.bytes <= budget.maxSerializedMessageBytes &&
        usage.messages <= budget.maxMessages;
}
function protocolIsGloballyValid(spans) {
    const seen = new Set();
    for (const span of spans) {
        if (span.toolProtocol === null)
            continue;
        for (const callId of span.toolProtocol.callIds) {
            if (seen.has(callId))
                return false;
            seen.add(callId);
        }
    }
    return true;
}
function finalWireProtocolIsValid(messages) {
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role === 'tool')
            return false;
        if (message?.role !== 'assistant' || message.toolCalls === undefined)
            continue;
        for (const [offset, call] of message.toolCalls.entries()) {
            const result = messages[index + offset + 1];
            if (result?.role !== 'tool' || result.toolCallId !== call.callId)
                return false;
        }
        index += message.toolCalls.length;
    }
    return true;
}
function requestJson(request) {
    return `{"schemaVersion":1,"namespaceRef":${JSON.stringify(request.namespaceRef)},"generation":${request.generation},"kind":${JSON.stringify(request.kind)},"sourceSpanIds":[${request.sourceSpanIds.map(value => JSON.stringify(value)).join(',')}],"sourceRefs":[${request.sourceRefs.map(ref => `{"ref":${JSON.stringify(ref.ref)},"contentHash":${JSON.stringify(ref.contentHash)}}`).join(',')}]}`;
}
function compactionRequest(span) {
    if (span.toolProtocol === null ||
        span.toolProtocol.callIds.length > MAX_CONTEXT_COMPACTION_TOOL_CALLS)
        return null;
    const refs = [Object.freeze({
            ref: span.spanId,
            contentHash: contextSpanHash(span)
        })];
    const seen = new Map(refs.map(ref => [ref.ref, ref.contentHash]));
    for (const ref of span.sourceRefs) {
        const priorHash = seen.get(ref.ref);
        if (priorHash !== undefined) {
            if (priorHash !== ref.contentHash)
                return invalidContextValue();
            continue;
        }
        seen.set(ref.ref, ref.contentHash);
        refs.push(ref);
    }
    if (refs.length > MAX_CONTEXT_ARTIFACT_REFS)
        return null;
    const sourceRefs = Object.freeze(refs);
    const partial = Object.freeze({
        schemaVersion: 1,
        namespaceRef: span.namespaceRef,
        generation: span.originGeneration,
        kind: 'tool_digest',
        sourceSpanIds: Object.freeze([span.spanId]),
        sourceRefs
    });
    return Object.freeze({
        schemaVersion: 1,
        requestId: `request:${domainSeparatedContextHash(CONTEXT_COMPACTION_REQUEST_HASH_DOMAIN, requestJson(partial))}`,
        namespaceRef: partial.namespaceRef,
        generation: partial.generation,
        kind: partial.kind,
        sourceSpanIds: partial.sourceSpanIds,
        sourceRefs: parseContextSourceRefs(partial.sourceRefs)
    });
}
function materializeArtifacts(input, allowNewArtifacts) {
    const rawById = new Map(input.spans.map(span => [span.spanId, span]));
    const seenCovered = new Set();
    const artifactSpans = [];
    const coverage = new Map();
    const inactiveArtifactIds = new Set();
    const previousArtifactIds = new Set(input.previousPlan?.artifactRefs ?? []);
    for (const artifact of input.artifacts) {
        if (artifact.namespaceRef !== input.namespaceRef ||
            artifact.estimatorVersion !== input.estimatorVersion || rawById.has(artifact.artifactId)) {
            return invalidContextValue();
        }
        const sources = artifact.sourceSpanIds.map(spanId => {
            const span = rawById.get(spanId);
            if (span === undefined || span.requirement !== 'optional' ||
                (span.toolProtocol !== null && span.toolProtocol.phase !== 'consumed') ||
                seenCovered.has(span.spanId)) {
                return invalidContextValue();
            }
            seenCovered.add(span.spanId);
            return span;
        });
        if (sources.some((span, index) => {
            const previous = sources[index - 1];
            return previous !== undefined && semanticOrder(previous, span) >= 0;
        }))
            return invalidContextValue();
        const sourcePrefix = sources.map(span => Object.freeze({
            ref: span.spanId,
            contentHash: contextSpanHash(span)
        }));
        if (artifact.sourceRefs.length < sourcePrefix.length || sourcePrefix.some((expected, index) => {
            const actual = artifact.sourceRefs[index];
            return actual === undefined || actual.ref !== expected.ref || actual.contentHash !== expected.contentHash;
        }))
            return invalidContextValue();
        const expectedTail = [];
        const seenRefs = new Map(sourcePrefix.map(ref => [ref.ref, ref.contentHash]));
        for (const source of sources) {
            for (const ref of source.sourceRefs) {
                const priorHash = seenRefs.get(ref.ref);
                if (priorHash !== undefined) {
                    if (priorHash !== ref.contentHash)
                        return invalidContextValue();
                    continue;
                }
                seenRefs.set(ref.ref, ref.contentHash);
                expectedTail.push(ref);
            }
        }
        const actualTail = artifact.sourceRefs.slice(artifact.sourceSpanIds.length);
        if (actualTail.length !== expectedTail.length || actualTail.some((ref, index) => {
            const expected = expectedTail[index];
            return expected === undefined || ref.ref !== expected.ref || ref.contentHash !== expected.contentHash;
        }))
            return invalidContextValue();
        const expectedGeneration = Math.max(...sources.map(span => span.originGeneration));
        const expectedKind = sources.every(span => span.toolProtocol?.phase === 'consumed')
            ? 'tool_digest'
            : 'conversation_summary';
        if (artifact.generation !== expectedGeneration || artifact.kind !== expectedKind) {
            return invalidContextValue();
        }
        const artifactSemanticOrder = Math.min(...sources.map(span => span.semanticOrder));
        const artifactSpan = contextArtifactToSpan(artifact, artifactSemanticOrder);
        artifactSpans.push(artifactSpan);
        if (allowNewArtifacts || previousArtifactIds.has(artifactSpan.spanId)) {
            coverage.set(artifactSpan.spanId, Object.freeze(sources.map(span => span.spanId)));
        }
        else {
            inactiveArtifactIds.add(artifactSpan.spanId);
        }
    }
    return Object.freeze({
        spans: Object.freeze([...input.spans, ...artifactSpans]),
        coverage,
        inactiveArtifactIds
    });
}
function previousWire(previous, byId) {
    const wire = [];
    for (const entry of previous.included) {
        const span = byId.get(entry.spanId);
        if (span === undefined || entry.contentHash !== contextSpanHash(span) ||
            entry.wireCount !== span.messages.length ||
            entry.representation !== (span.source === 'artifact' ? 'artifact' : 'raw'))
            return null;
        wire.push(...span.messages);
    }
    const frozenWire = Object.freeze(wire);
    try {
        if (previous.estimatedInputTokens !== estimateModelMessagesTokens(frozenWire) ||
            previous.serializedMessageBytes !== serializedModelMessagesBytes(frozenWire))
            return null;
    }
    catch {
        return null;
    }
    return frozenWire;
}
function equalWire(left, right) {
    return serializeModelMessages(Object.freeze([...left])) ===
        serializeModelMessages(Object.freeze([...right]));
}
function commonPrefixMessageCount(left, right) {
    const length = Math.min(left.length, right.length);
    let index = 0;
    while (index < length && equalWire([left[index]], [right[index]])) {
        index += 1;
    }
    return index;
}
export function planModelTurn(value) {
    const input = parseContextPlannerInputV1(value);
    if (input.spans.some(span => span.toolProtocol?.phase === 'awaiting' ||
        span.toolProtocol?.phase === 'indeterminate') || !protocolIsGloballyValid(input.spans)) {
        return BLOCKED_PROTOCOL;
    }
    const rawUsage = usageFor(input.spans);
    const crossesCompactionBoundary = input.previousPlan?.mode === 'compacting' ||
        entersCompacting(rawUsage, input.budget);
    const materialized = materializeArtifacts(input, crossesCompactionBoundary);
    const allSpans = materialized.spans;
    const byId = new Map(allSpans.map(span => [span.spanId, span]));
    const priorWire = input.previousPlan === null ? Object.freeze([]) : previousWire(input.previousPlan, byId);
    if (priorWire === null)
        return BLOCKED_BUDGET;
    const applySupersedes = input.previousPlan === null || crossesCompactionBoundary;
    const superseded = new Set(applySupersedes
        ? input.spans
            .filter(span => span.supersedes !== null)
            .map(span => span.supersedes)
        : []);
    const coverage = materialized.coverage;
    const artifactCovered = new Set();
    for (const refs of coverage.values())
        for (const ref of refs)
            artifactCovered.add(ref);
    const candidates = allSpans.filter(span => !superseded.has(span.spanId) &&
        !artifactCovered.has(span.spanId) && !materialized.inactiveArtifactIds.has(span.spanId));
    const initialUsage = usageFor(candidates);
    const previousMode = input.previousPlan?.mode ?? 'normal';
    let mode = previousMode === 'compacting'
        ? (atOrBelowTarget(initialUsage, input.budget) ? 'normal' : 'compacting')
        : (entersCompacting(rawUsage, input.budget) ? 'compacting' : 'normal');
    const mandatory = candidates.filter(span => span.requirement === 'mandatory');
    const mandatoryUsage = usageFor(mandatory);
    if (!fitsHardBudget(mandatoryUsage, input.budget))
        return BLOCKED_BUDGET;
    if (mode === 'compacting' && input.artifactPolicy === 'enabled' &&
        atOrBelowTarget(mandatoryUsage, input.budget)) {
        const consumed = candidates
            .filter(span => span.toolProtocol?.phase === 'consumed')
            .sort((left, right) => left.originGeneration - right.originGeneration || semanticOrder(left, right));
        if (consumed.length > 0) {
            const requests = consumed
                .map(compactionRequest)
                .filter((request) => request !== null);
            if (requests.length === 0) {
                // Fall through to deterministic optional trimming when provenance cannot fit V1.
            }
            else {
                return Object.freeze({
                    status: 'requires_artifacts',
                    compactionRequests: Object.freeze(requests)
                });
            }
        }
    }
    const selected = new Set(candidates.map(span => span.spanId));
    const optionalDiscard = candidates
        .filter(span => span.requirement === 'optional')
        .sort(optionalKeepOrder)
        .reverse();
    let selectedSpans = candidates;
    let selectedUsage = initialUsage;
    const needsTarget = mode === 'compacting';
    while ((!fitsHardBudget(selectedUsage, input.budget) ||
        (needsTarget && !atOrBelowTarget(selectedUsage, input.budget))) && optionalDiscard.length > 0) {
        const discard = optionalDiscard.shift();
        if (discard !== undefined)
            selected.delete(discard.spanId);
        selectedSpans = candidates.filter(span => selected.has(span.spanId));
        selectedUsage = usageFor(selectedSpans);
    }
    if (!fitsHardBudget(selectedUsage, input.budget))
        return BLOCKED_BUDGET;
    if (needsTarget && atOrBelowTarget(selectedUsage, input.budget))
        mode = 'normal';
    const ordered = [...selectedSpans].sort(semanticOrder);
    const wire = Object.freeze(ordered.flatMap(span => span.messages));
    if (!finalWireProtocolIsValid(wire))
        return BLOCKED_PROTOCOL;
    let prefixMessageCount = commonPrefixMessageCount(priorWire, wire);
    const requiresFullPrefix = input.previousPlan?.mode === 'normal' &&
        !entersCompacting(rawUsage, input.budget);
    if (requiresFullPrefix) {
        if (wire.length < priorWire.length || prefixMessageCount !== priorWire.length) {
            return BLOCKED_BUDGET;
        }
    }
    let wireStart = 0;
    const included = Object.freeze(ordered.map(span => {
        const entry = Object.freeze({
            spanId: span.spanId,
            representation: span.source === 'artifact' ? 'artifact' : 'raw',
            wireStart,
            wireCount: span.messages.length,
            contentHash: contextSpanHash(span)
        });
        wireStart += span.messages.length;
        return entry;
    }));
    const omittedReason = new Map();
    for (const ref of superseded)
        omittedReason.set(ref, 'superseded');
    const selectedArtifactCovered = new Set();
    for (const [artifactId, refs] of coverage) {
        if (!selected.has(artifactId))
            continue;
        for (const ref of refs)
            selectedArtifactCovered.add(ref);
    }
    for (const ref of selectedArtifactCovered)
        omittedReason.set(ref, 'artifact');
    for (const span of allSpans) {
        if (!selected.has(span.spanId) && !omittedReason.has(span.spanId))
            omittedReason.set(span.spanId, 'budget');
    }
    const omitted = Object.freeze([...allSpans].sort(semanticOrder)
        .filter(span => omittedReason.has(span.spanId))
        .map(span => Object.freeze({
        spanId: span.spanId,
        reason: omittedReason.get(span.spanId)
    })));
    const estimatedInputTokens = estimateModelMessagesTokens(wire);
    const plan = createContextPlanV1(Object.freeze({
        namespaceRef: input.namespaceRef,
        generation: input.generation,
        previousPlanHash: input.previousPlan?.planHash ?? null,
        estimatorVersion: input.estimatorVersion,
        capabilityHash: input.capabilityHash,
        mode,
        included,
        omitted,
        artifactRefs: Object.freeze(included
            .filter(entry => entry.representation === 'artifact')
            .map(entry => entry.spanId)),
        prefixMessageCount,
        estimatedInputTokens,
        estimatedToolTokens: input.budget.estimatedToolTokens,
        reservedOutputTokens: input.budget.reservedOutputTokens,
        serializedMessageBytes: serializedModelMessagesBytes(wire),
        messageCount: wire.length
    }));
    return Object.freeze({ status: 'ready', plan, messages: wire });
}

const SPAN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RECOVERABLE_KINDS = new Set(['legacy', 'group']);
function isZero(value) {
    return Number.isSafeInteger(value) && value === 0;
}
function selectedSpansAreRecoverable(context, selected) {
    const found = new Set();
    for (const span of context) {
        if (!selected.has(span.spanId))
            continue;
        found.add(span.spanId);
        if (!span.optional || !RECOVERABLE_KINDS.has(span.kind))
            return false;
    }
    return found.size === selected.size;
}
export class OptionalContextRecoveryPolicy {
    tryRecover(input) {
        if (input.hint !== 'drop_optional_context_once' || input.recoveryUsed ||
            input.counters.recoveryAttempts !== 0 || !isZero(input.modelCallIndex) ||
            !isZero(input.successfulTurns) || !isZero(input.capabilityDispatches) ||
            !Array.isArray(input.context) || !Array.isArray(input.optionalSpanIds) ||
            input.optionalSpanIds.length === 0) {
            return undefined;
        }
        const selected = new Set(input.optionalSpanIds);
        if (selected.size !== input.optionalSpanIds.length ||
            [...selected].some(id => typeof id !== 'string' || !SPAN_ID.test(id)) ||
            !selectedSpansAreRecoverable(input.context, selected)) {
            return undefined;
        }
        const context = Object.freeze(input.context
            .filter(span => !selected.has(span.spanId))
            .map(span => Object.freeze({ ...span })));
        const removedSpanIds = Object.freeze([...selected].sort());
        const counters = input.budget.recordRecovery(input.counters);
        return Object.freeze({
            context,
            removedSpanIds,
            recoveryUsed: true,
            counters
        });
    }
}

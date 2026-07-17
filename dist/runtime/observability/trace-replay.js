import { parseStoredTraceRecord } from './trace-record.js';
function schemaVersion(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return null;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
        if (descriptor === undefined || !descriptor.enumerable ||
            !Object.hasOwn(descriptor, 'value') ||
            !Number.isSafeInteger(descriptor.value) || Number(descriptor.value) < 1) {
            return null;
        }
        return Number(descriptor.value);
    }
    catch {
        return null;
    }
}
function unknownOptional(event) {
    return Object.hasOwn(event, 'optional');
}
export function replayTrace(value) {
    const version = schemaVersion(value);
    if (version === null)
        return Object.freeze({ kind: 'invalid_trace' });
    if (version !== 1)
        return Object.freeze({ kind: 'unsupported_version' });
    try {
        const record = parseStoredTraceRecord(value);
        let unsupportedEventCount = 0;
        const phases = Object.freeze(record.events.map(event => {
            if (unknownOptional(event)) {
                unsupportedEventCount += 1;
                return 'unsupported_event';
            }
            return event.type;
        }));
        const presentation = record.presentation.kind === 'unavailable'
            ? Object.freeze({ kind: 'unavailable' })
            : Object.freeze({
                kind: 'reduced',
                selectedMode: record.presentation.value.reducerInput.selectedMode,
                fallbackReason: record.presentation.value.reducerInput.fallbackReason
            });
        return Object.freeze({
            kind: 'replayed',
            report: Object.freeze({
                schemaVersion: 1,
                runRef: record.runRef,
                outcome: record.terminal.status,
                phases,
                omittedEventCount: record.omittedEventCount,
                unsupportedEventCount,
                metricSummary: record.metricSummary,
                presentation
            })
        });
    }
    catch {
        return Object.freeze({ kind: 'invalid_trace' });
    }
}

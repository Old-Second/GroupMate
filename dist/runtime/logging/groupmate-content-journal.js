import { isNetworkPolicyErrorCode } from '../../agent/tools/network-policy.js';
import { projectOutboundJournalEvent } from './content-journal-outbound-projector.js';
import { projectParticipationObservation } from './content-journal-projection.js';
import { projectRequestJournalEvent, projectRunJournalEvent } from './content-journal-request-run-projector.js';
function failureEvent(operation) {
    return Object.freeze({
        type: 'groupmate.content_journal.projection_failure',
        payload: Object.freeze({ operation, code: 'invalid_content' })
    });
}
export function createGroupMateContentJournal(diskLog) {
    const safeRecordEvent = (event) => {
        try {
            diskLog.record(event);
        }
        catch { }
    };
    const recordProjection = (operation, project) => {
        try {
            safeRecordEvent(project());
        }
        catch {
            safeRecordEvent(failureEvent(operation));
        }
    };
    return Object.freeze({
        recordParticipation(event) {
            recordProjection('participation', () => projectParticipationObservation(event));
        },
        recordRequest(request) {
            recordProjection('request', () => projectRequestJournalEvent(request));
        },
        recordRunEvent(event) {
            recordProjection('run_event', () => projectRunJournalEvent(event));
        },
        recordOutbound(event) {
            recordProjection('outbound', () => projectOutboundJournalEvent(event));
        },
        recordNetworkDiagnostic(event) {
            if (!['image_search', 'image_fetch', 'other'].includes(event.tag) ||
                !['dns', 'headers', 'body', 'complete'].includes(event.phase) ||
                !['success', 'failure', 'timeout', 'cancelled'].includes(event.result) ||
                ![event.durationMs, event.timeoutMs, event.redirects].every(value => Number.isSafeInteger(value) && value >= 0))
                return;
            safeRecordEvent(Object.freeze({ type: 'tool.network', payload: Object.freeze({
                    tag: event.tag, phase: event.phase, result: event.result,
                    durationMs: event.durationMs, timeoutMs: event.timeoutMs, redirects: event.redirects,
                    ...(typeof event.httpStatus === 'number' && Number.isSafeInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599
                        ? { httpStatus: event.httpStatus } : {}),
                    ...(isNetworkPolicyErrorCode(event.errorCode) ? { errorCode: event.errorCode } : {})
                }) }));
        },
        async drain() {
            try {
                await diskLog.drain();
            }
            catch { }
        }
    });
}

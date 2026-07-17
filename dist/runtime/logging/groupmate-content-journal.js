import { projectOutboundJournalEvent } from './content-journal-outbound-projector.js';
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
        recordRequest(request) {
            recordProjection('request', () => projectRequestJournalEvent(request));
        },
        recordRunEvent(event) {
            recordProjection('run_event', () => projectRunJournalEvent(event));
        },
        recordOutbound(event) {
            recordProjection('outbound', () => projectOutboundJournalEvent(event));
        },
        async drain() {
            try {
                await diskLog.drain();
            }
            catch { }
        }
    });
}

import { parseJsonValue } from '../model/json-value.js';
import { parseRunCheckpoint } from './run-checkpoint.js';
import { RUN_RESOURCE_LIMITS } from './run-limits.js';
import { parseTerminalCommitReceipt } from './run-store.js';
export function detachedRunContentSnapshot(value, maxBytes) {
    return parseJsonValue(value, {
        maxBytes,
        maxDepth: 32,
        maxNodes: 8_192
    });
}
export function snapshotModelRequestForJournal(request) {
    return detachedRunContentSnapshot(request, RUN_RESOURCE_LIMITS.requestBytes);
}
export function snapshotModelTurnForJournal(turn) {
    return detachedRunContentSnapshot(turn, RUN_RESOURCE_LIMITS.providerResponseBytes);
}
export function snapshotRunCheckpointForJournal(checkpoint) {
    return parseRunCheckpoint(checkpoint);
}
export function snapshotTerminalReceiptForJournal(receipt) {
    return parseTerminalCommitReceipt(receipt);
}

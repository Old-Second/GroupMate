export const RUN_STATUSES = Object.freeze([
    'created',
    'preparing',
    'calling_model',
    'evaluating_tools',
    'waiting_approval',
    'executing_tools',
    'correcting',
    'completed',
    'failed',
    'cancelled'
]);
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const allowedTransitions = Object.freeze({
    created: new Set(['preparing', 'failed', 'cancelled']),
    preparing: new Set(['calling_model', 'failed', 'cancelled']),
    calling_model: new Set([
        'evaluating_tools',
        'correcting',
        'completed',
        'failed',
        'cancelled'
    ]),
    evaluating_tools: new Set([
        'waiting_approval',
        'executing_tools',
        'failed',
        'cancelled'
    ]),
    waiting_approval: new Set([
        'waiting_approval',
        'evaluating_tools',
        'executing_tools',
        'failed',
        'cancelled'
    ]),
    executing_tools: new Set(['preparing', 'calling_model', 'failed', 'cancelled']),
    correcting: new Set(['completed', 'failed', 'cancelled']),
    completed: new Set(),
    failed: new Set(),
    cancelled: new Set()
});
export function parseRunStatus(value) {
    if (typeof value !== 'string' || !RUN_STATUSES.includes(value)) {
        throw new TypeError('run status is invalid');
    }
    return value;
}
export function isTerminalRunStatus(status) {
    return terminalStatuses.has(status);
}
export function assertRunTransition(from, to) {
    if (isTerminalRunStatus(from))
        throw new TypeError(`terminal run state ${from} cannot transition`);
    if (!allowedTransitions[from].has(to)) {
        throw new TypeError(`illegal run transition from ${from} to ${to}`);
    }
}

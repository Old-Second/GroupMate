export function aggregatePresentationResults(children) {
    const deliveries = Object.freeze(children.flatMap(child => [...child.deliveries]));
    const hasSent = deliveries.some(delivery => delivery.kind === 'sent');
    const hasUnknown = children.some(child => child.outcome === 'unknown') ||
        deliveries.some(delivery => delivery.kind === 'outcome_unknown');
    const hasFailure = children.some(child => child.outcome === 'failed' || child.outcome === 'partial') ||
        deliveries.some(delivery => delivery.kind === 'failed_definite');
    if (hasSent) {
        return Object.freeze({
            schemaVersion: 1,
            outcome: hasUnknown || hasFailure ? 'partial' : 'complete',
            deliveries
        });
    }
    if (hasUnknown)
        return Object.freeze({ schemaVersion: 1, outcome: 'unknown', deliveries });
    if (hasFailure)
        return Object.freeze({ schemaVersion: 1, outcome: 'failed', deliveries });
    const attempted = children.some(child => child.outcome !== 'skipped');
    if (attempted)
        return Object.freeze({ schemaVersion: 1, outcome: 'complete', deliveries });
    const reasons = new Set(children.map(child => child.skipReason).filter(reason => reason !== undefined));
    const skipReason = reasons.size === 1 ? [...reasons][0] : undefined;
    return Object.freeze({
        schemaVersion: 1,
        outcome: 'skipped',
        ...(skipReason === undefined ? {} : { skipReason }),
        deliveries
    });
}

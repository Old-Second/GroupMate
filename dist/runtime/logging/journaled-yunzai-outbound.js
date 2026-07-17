function recordSafely(journal, now, event) {
    try {
        journal.recordOutbound(Object.freeze({
            ...event,
            occurredAt: now().toISOString()
        }));
    }
    catch { }
}
function journaledPort(delegate, journal, now) {
    return Object.freeze({
        target: delegate.target,
        async deliver(part, attempt, options) {
            const result = await delegate.deliver(part, attempt, options);
            recordSafely(journal, now, {
                type: 'qq.outbound.deliver',
                target: delegate.target,
                part,
                attempt,
                quoteMessageId: options?.quoteMessageId ?? null,
                result
            });
            return result;
        },
        async recall(receipt, signal) {
            const result = await delegate.recall(receipt, signal);
            recordSafely(journal, now, {
                type: 'qq.outbound.recall',
                target: delegate.target,
                receipt,
                result
            });
            return result;
        }
    });
}
export function createJournaledYunzaiOutboundPortFactory(delegate, journal, now) {
    return Object.freeze({
        async forTarget(target) {
            return journaledPort(await delegate.forTarget(target), journal, now);
        }
    });
}

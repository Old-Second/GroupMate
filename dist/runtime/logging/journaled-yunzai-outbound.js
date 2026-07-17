function recordSafely(journal, now, createEvent) {
    try {
        const event = createEvent();
        journal.recordOutbound(Object.freeze({
            ...event,
            occurredAt: now().toISOString()
        }));
    }
    catch { }
}
function journaledPort(delegate, journal, now) {
    const target = delegate.target;
    return Object.freeze({
        target,
        async deliver(part, attempt, options) {
            const result = await delegate.deliver(part, attempt, options);
            recordSafely(journal, now, () => ({
                type: 'qq.outbound.deliver',
                target,
                part,
                attempt,
                quoteMessageId: options?.quoteMessageId ?? null,
                result
            }));
            return result;
        },
        async recall(receipt, signal) {
            const result = await delegate.recall(receipt, signal);
            recordSafely(journal, now, () => ({
                type: 'qq.outbound.recall',
                target,
                receipt,
                result
            }));
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

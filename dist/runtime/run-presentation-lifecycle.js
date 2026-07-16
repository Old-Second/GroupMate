export function createRunPresentationLifecycle(input) {
    let startedRunId;
    let indicator = null;
    let settlePromise;
    return Object.freeze({
        async onRunStarted(started) {
            if (startedRunId !== undefined)
                return;
            startedRunId = started.runId;
            const outbound = await input.outboundFactory.forTarget(input.route.sessionAddress);
            indicator = await input.pending.show({
                runRef: started.runRef,
                outbound,
                profile: input.profile,
                enabled: input.pendingEnabled
            });
            input.progress.attach(Object.freeze({
                runId: started.runId,
                runRef: started.runRef,
                requestKind: input.route.requestKind === 'legacy_unknown'
                    ? 'recovered_legacy_plain_text'
                    : input.route.requestKind,
                observationPolicy: started.observationPolicy,
                resume: started.progressResume ?? Object.freeze({
                    attempts: 0,
                    seenStages: Object.freeze([])
                }),
                outbound,
                indicator
            }));
        },
        async onRunSettled(settled) {
            if (startedRunId === undefined || settled.runId !== startedRunId)
                return;
            if (settlePromise === undefined) {
                settlePromise = (async () => {
                    try {
                        await indicator?.dismiss(settled.status === 'paused' ? 'paused' : 'terminal');
                    }
                    catch { }
                    try {
                        await input.progress.drain(settled.runId);
                    }
                    catch { }
                    try {
                        input.progress.detach(settled.runId);
                    }
                    catch { }
                })();
            }
            await settlePromise;
        }
    });
}

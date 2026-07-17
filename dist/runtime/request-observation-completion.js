import { projectFinalPresentation } from './agent-service.js';
import { finalizeRequestObservation } from './request-observation.js';
export class RequestObservationAlreadyCompletedError extends Error {
    constructor() {
        super('request observation draft was already completed');
        this.name = 'RequestObservationAlreadyCompletedError';
    }
}
function safeMonotonicNow(clock) {
    try {
        const value = clock();
        return value === 'unavailable' ||
            (Number.isSafeInteger(value) && value >= 0)
            ? value
            : 'unavailable';
    }
    catch {
        return 'unavailable';
    }
}
export function createPresentationCompletionCoordinator(input) {
    const completed = new WeakSet();
    return Object.freeze({
        async complete({ envelope, present }) {
            const draft = envelope.requestObservationDraft;
            if (draft === null || typeof draft !== 'object') {
                throw new TypeError('final request observation draft is invalid');
            }
            if (completed.has(draft)) {
                throw new RequestObservationAlreadyCompletedError();
            }
            completed.add(draft);
            try {
                const projection = projectFinalPresentation(envelope);
                return await present(projection);
            }
            finally {
                const observation = finalizeRequestObservation({
                    draft,
                    finishedAtMonotonicMs: safeMonotonicNow(input.monotonicNow)
                });
                try {
                    await input.publisher.publish(observation);
                }
                catch {
                    try {
                        input.onPublishFailure?.('request_observation_publish_failed');
                    }
                    catch {
                        // Observation reporting is outside the presentation control plane.
                    }
                }
            }
        }
    });
}

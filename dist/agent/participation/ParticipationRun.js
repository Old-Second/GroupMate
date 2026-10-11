import { AgentError } from '../contracts/error.js';
const issued = new WeakSet();
export function isParticipationRun(value) {
    return typeof value === 'object' && value !== null && issued.has(value);
}
/** Live host selection, never reconstructed from a checkpoint or model text. */
export function createParticipationRun(policy, candidate, eligible) {
    const instructions = policy.instructions(candidate);
    if (instructions === null)
        throw new TypeError('participation selection unavailable');
    let admitted = false, finished = false;
    const check = () => {
        if (finished || !policy.current(candidate) || !eligible()) {
            if (!finished) {
                finished = true;
                policy.finish(candidate, false);
            }
            throw new AgentError({
                code: 'authorization_changed', stage: 'participation.current', retryable: false,
                userMessage: '当前参与请求已失效。'
            });
        }
    };
    const run = Object.freeze({
        admission: candidate.source === 'direct' ? 'queue' : 'immediate', instructions,
        admit: () => {
            check();
            if (admitted || !policy.admit(candidate))
                throw new AgentError({
                    code: 'run_budget_exceeded', stage: 'participation.admission', retryable: false,
                    userMessage: '当前参与预算不可用。'
                });
            admitted = true;
        },
        checkBoundary: async (_boundary, signal) => {
            signal.throwIfAborted();
            check();
            if (!admitted)
                throw new TypeError('participation not admitted');
        },
        finish: delivered => {
            if (finished)
                return;
            finished = true;
            policy.finish(candidate, delivered && admitted && eligible());
        }
    });
    issued.add(run);
    return run;
}

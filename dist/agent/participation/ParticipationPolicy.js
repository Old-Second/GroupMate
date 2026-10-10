import { isTrustedParticipationEvent } from './ParticipationContract.js';
// Exact legacy probability semantics, including its -1 sentinel for explicit aliases.
export function legacyParticipationAllowed(input) {
    if (input.explicitlyAddressed)
        return !(-1 >= input.ratePercent);
    if (input.sample === null || !Number.isFinite(input.sample) || input.sample < 0 || input.sample >= 1)
        return false;
    return !(Math.floor(input.sample * 100) >= input.ratePercent);
}
export function decideParticipation(event, input) {
    const decision = (kind, source, reason) => Object.freeze({ kind, source, reason });
    if (!isTrustedParticipationEvent(event))
        return decision('ignore', 'none', 'untrusted');
    if (!event.eligible)
        return decision('ignore', 'none', 'disabled');
    if (event.addressed)
        return decision('candidate', 'direct', 'direct');
    if (event.acknowledgement)
        return decision('ignore', 'none', 'acknowledgement');
    if (input.continuation)
        return decision('candidate', 'continuation', 'continuation');
    if (input.sampled)
        return decision('candidate', 'sampled', 'sampled');
    return decision('ignore', 'none', 'sample_miss');
}

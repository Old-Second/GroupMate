import { PARTICIPATION_POLICY_VERSION } from '../../agent/participation/ParticipationContract.js';
import { decideParticipation } from '../../agent/participation/ParticipationPolicy.js';
import { ParticipationState } from '../../agent/participation/ParticipationState.js';
// No provider/tool/memory/outbound port can be acquired by this diagnostic component.
export class ParticipationShadow {
    record;
    state;
    constructor(now, record) {
        this.record = record;
        this.state = new ParticipationState(now);
    }
    compare(event, legacyAllowed) {
        try {
            const continuation = this.state.observe(event);
            const decision = decideParticipation(event, { sampled: legacyAllowed, continuation });
            const candidate = decision.kind === 'candidate' && decision.source !== 'none'
                ? this.state.offer(event, decision.source) : null;
            const stats = this.state.stats();
            try {
                this.record(Object.freeze({ schemaVersion: 1, policyVersion: PARTICIPATION_POLICY_VERSION,
                    legacyAllowed, proposedAllowed: candidate !== null, reason: decision.reason,
                    disagreement: legacyAllowed !== (candidate !== null), scopes: stats.scopes,
                    candidates: stats.candidates, stateBytes: stats.bytes }));
            }
            catch { }
            return candidate;
        }
        catch {
            return null;
        }
    }
    close() { this.state.close(); }
}

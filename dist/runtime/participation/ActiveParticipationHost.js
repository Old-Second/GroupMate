import { ActiveParticipationPolicy } from '../../agent/participation/ActiveParticipationPolicy.js';
import { createParticipationRun } from '../../agent/participation/ParticipationRun.js';
import { participationMode } from '../../agent/participation/ParticipationContract.js';
import { projectYunzaiParticipation } from './YunzaiParticipationAdapter.js';
/** An empty pilot list enables no new group behavior; non-pilot groups retain legacy routing. */
export class ActiveParticipationHost {
    now;
    config;
    botId;
    eligible;
    #policy = null;
    #closed = false;
    constructor(now, config, botId, eligible) {
        this.now = now;
        this.config = config;
        this.botId = botId;
        this.eligible = eligible;
    }
    #enabled() {
        const enabled = !this.#closed && participationMode(this.config().participationMode) === 'active';
        if (!enabled) {
            this.#policy?.close();
            this.#policy = null;
        }
        return enabled;
    }
    #pilot(groupId) {
        const groups = this.config().participationActiveGroups;
        return Array.isArray(groups) && groups.length <= 64 && new Set(groups).size === groups.length &&
            groups.every(group => typeof group === 'string' && /^[1-9]\d{0,19}$/.test(group)) &&
            groups.includes(groupId);
    }
    select(event, explicitlyAddressed, sampled) {
        if (!this.#enabled())
            return undefined;
        const groupId = String(event.group_id);
        if (!this.#pilot(groupId))
            return undefined;
        const eligible = () => this.#enabled() && this.#pilot(groupId) && this.eligible(groupId);
        this.#policy ??= new ActiveParticipationPolicy(this.now, () => this.#enabled());
        const botId = this.botId(event);
        const projected = projectYunzaiParticipation({ event, botId, now: this.now(), explicitlyAddressed, eligible: eligible() });
        if (projected === null)
            return null;
        // No cold sampled or model gatekeeper is enabled. Only a live same-actor continuation can pass.
        const elsewhere = Array.isArray(event.message) && event.message.some(part => part?.type === 'at' &&
            String(part.qq ?? part.data?.qq) !== String(botId));
        const selected = this.#policy.select(projected, { sampled, gateAllows: !elsewhere });
        // Cold sampled candidates remain disabled until their independent should-reply gate is approved.
        if (selected.kind !== 'candidate')
            return null;
        if (selected.candidate.source === 'sampled') {
            this.#policy.finish(selected.candidate, false);
            return null;
        }
        return createParticipationRun(this.#policy, selected.candidate, eligible);
    }
    close() {
        this.#closed = true;
        this.#policy?.close();
        this.#policy = null;
    }
}

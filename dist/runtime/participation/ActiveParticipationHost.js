import { ActiveParticipationPolicy } from '../../agent/participation/ActiveParticipationPolicy.js';
import { createParticipationRun } from '../../agent/participation/ParticipationRun.js';
import { participationMode } from '../../agent/participation/ParticipationContract.js';
import { projectYunzaiParticipation } from './YunzaiParticipationAdapter.js';
const SEEN_LIMIT = 128;
const SEEN_TTL_MS = 600_000;
/** An empty pilot list enables no new group behavior; non-pilot groups retain legacy routing. */
export class ActiveParticipationHost {
    now;
    config;
    botId;
    eligible;
    #policy = null;
    #closed = false;
    #seen = new Map();
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
            this.#seen.clear();
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
        return this.#select(event, explicitlyAddressed, sampled, false);
    }
    /** Ordinary explicit requests keep their existing queue when qualification is unavailable. */
    selectOrdinary(event) {
        return this.#select(event, true, false, true);
    }
    #remember(messageRef, now) {
        if (this.#seen.size >= SEEN_LIMIT)
            this.#seen.delete(this.#seen.keys().next().value);
        this.#seen.set(messageRef, now);
    }
    #select(event, explicitlyAddressed, sampled, ordinary) {
        if (!this.#enabled())
            return undefined;
        const groupId = String(event.group_id);
        if (!this.#pilot(groupId))
            return undefined;
        const eligible = () => this.#enabled() && this.#pilot(groupId) && this.eligible(groupId);
        this.#policy ??= new ActiveParticipationPolicy(this.now, () => this.#enabled());
        const botId = this.botId(event);
        const now = this.now();
        const projected = projectYunzaiParticipation({ event, botId, now, explicitlyAddressed, eligible: eligible() });
        if (projected === null)
            return ordinary ? undefined : null;
        for (const [key, time] of this.#seen)
            if (now - time >= SEEN_TTL_MS)
                this.#seen.delete(key);
        // Ordinary and BYM host rules may observe the same message. Selection belongs to only one route.
        if (this.#seen.has(projected.messageRef))
            return null;
        if (ordinary)
            this.#remember(projected.messageRef, now);
        // No cold sampled or model gatekeeper is enabled. Only a live same-actor continuation can pass.
        const elsewhere = Array.isArray(event.message) && event.message.some(part => part?.type === 'at' &&
            String(part.qq ?? part.data?.qq) !== String(botId));
        const selected = this.#policy.select(projected, { sampled, gateAllows: !elsewhere });
        // Cold sampled candidates remain disabled until their independent should-reply gate is approved.
        if (selected.kind !== 'candidate')
            return ordinary ? undefined : null;
        if (selected.candidate.source === 'sampled') {
            this.#policy.finish(selected.candidate, false);
            return null;
        }
        if (!ordinary)
            this.#remember(projected.messageRef, now);
        return createParticipationRun(this.#policy, selected.candidate, eligible);
    }
    close() {
        this.#closed = true;
        this.#policy?.close();
        this.#policy = null;
        this.#seen.clear();
    }
}

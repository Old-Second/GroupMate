/** Coordinates the two existing proactive sources without applying new quotas to direct requests. */
export class ProactiveCoordination {
    now;
    #scopes = new Map();
    #closed = false;
    constructor(now = Date.now) {
        this.now = now;
    }
    close() { this.#closed = true; this.#scopes.clear(); }
    begin(botId, groupId, source, direct = false) {
        if (this.#closed)
            return null;
        const key = JSON.stringify([botId, groupId]);
        let scope = this.#scopes.get(key);
        const time = this.now();
        if (!direct && scope !== undefined && (scope.active !== undefined ||
            (scope.source !== source && time - scope.sentAt < 30_000)))
            return null;
        if (scope === undefined) {
            if (this.#scopes.size >= 64)
                this.#scopes.delete(this.#scopes.keys().next().value);
            scope = { source, sentAt: -Infinity };
            this.#scopes.set(key, scope);
        }
        const ticket = {};
        scope.active = ticket;
        let finished = false;
        return Object.freeze({
            current: () => !finished && this.#scopes.get(key) === scope && scope.active === ticket,
            finish: async (sent) => {
                if (finished)
                    return;
                finished = true;
                if (this.#scopes.get(key) !== scope || scope.active !== ticket)
                    return;
                delete scope.active;
                if (sent) {
                    scope.source = source;
                    scope.sentAt = this.now();
                }
            }
        });
    }
}

import { currentGroupMember } from './CurrentGroupMember.js';
import { changedContextError } from './MemoryContextBoundary.js';
// Live notices invalidate outstanding tickets. Eviction also fails closed; no subscriptions or timers.
const tickets = new Map();
const keyFor = (botId, groupId) => JSON.stringify([botId, groupId]);
export function invalidateGroupScene(botId, groupId) {
    const key = keyFor(botId, groupId);
    const ticket = tickets.get(key);
    if (ticket !== undefined)
        ticket.valid = false;
    tickets.delete(key);
}
export function invalidateYunzaiGroupNotice(event) {
    const kind = String(event.notice_type ?? '');
    const subtype = String(event.sub_type ?? '');
    if (!['group_decrease', 'group_increase', 'group_admin'].includes(kind) &&
        !(kind === 'group' && ['decrease', 'increase', 'admin'].includes(subtype)))
        return;
    const botId = String(event.self_id ?? event.bot?.uin ?? '');
    const groupId = String(event.group_id ?? '');
    if (botId && groupId)
        invalidateGroupScene(botId, groupId);
}
export async function captureSceneDependency(bot, botId, groupId, actorId, signal) {
    const [actor, self] = await Promise.all([currentGroupMember(bot, groupId, actorId, signal),
        currentGroupMember(bot, groupId, botId, signal)]);
    if (actor === null || self === null)
        throw changedContextError();
    return Object.freeze({ botId, groupId, actorId, botJoinedAt: self.joinedAt, actorJoinedAt: actor.joinedAt });
}
export function sceneBoundary(bot, scene) {
    const key = keyFor(scene.botId, scene.groupId);
    let ticket = tickets.get(key);
    if (ticket === undefined) {
        if (tickets.size >= 64) {
            const oldest = tickets.keys().next().value;
            tickets.get(oldest).valid = false;
            tickets.delete(oldest);
        }
        ticket = { valid: true };
        tickets.set(key, ticket);
    }
    return async (_boundary, signal) => {
        if (!ticket.valid)
            throw changedContextError();
        const current = await captureSceneDependency(bot, scene.botId, scene.groupId, scene.actorId, signal);
        if (!ticket.valid || current.botJoinedAt !== scene.botJoinedAt || current.actorJoinedAt !== scene.actorJoinedAt)
            throw changedContextError();
    };
}
export function combineBoundaries(...guards) {
    return async (boundary, signal) => { for (const guard of guards)
        await guard?.(boundary, signal); };
}

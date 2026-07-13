export function groupId(facts) {
    return facts.channel.kind === 'group' ? facts.channel.groupId : '';
}
export function memberTarget(input, facts) {
    const selected = String(input.userId ?? '').trim() || facts.actor.userId;
    return Object.freeze({ kind: 'member', groupId: groupId(facts), userId: selected });
}
export function messageTarget(input, facts) {
    return Object.freeze({
        kind: 'message', groupId: groupId(facts), messageId: String(input.messageId ?? '').trim()
    });
}
export function managementSuccess(message) {
    return Object.freeze({
        status: 'success', effect: 'background',
        content: Object.freeze([{ type: 'text', text: message }]), retryable: false
    });
}
export function managementDefinition(input) {
    return Object.freeze({
        name: input.name, version: 1, aliases: Object.freeze([...(input.aliases ?? [])]),
        description: input.description, inputSchema: input.inputSchema,
        effect: 'side_effect', risk: 'high', readOnly: false,
        destructive: input.destructive ?? false, idempotency: 'call', openWorld: false,
        timeoutMs: 10_000, maxOutputBytes: 4 * 1024, network: 'none',
        permission: input.permission, resolveTarget: input.resolveTarget, execute: input.execute
    });
}
export function asMemberTarget(target) {
    return target.kind === 'member' ? target : null;
}
export function asMessageTarget(target) {
    return target.kind === 'message' ? target : null;
}

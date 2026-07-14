import { canonicalSessionKey, parseCanonicalSessionKey } from '../session/conversation-scope.js';
const actorRoles = [
    'bot_master',
    'group_owner',
    'group_admin',
    'member'
];
const policyProfiles = ['compatible', 'safe', 'strict'];
function asRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}
function assertOnlyKeys(value, keys, label) {
    const allowed = new Set(keys);
    if (Object.keys(value).some(key => !allowed.has(key))) {
        throw new TypeError(`${label} contains unknown keys`);
    }
}
function readString(value, label, maxLength = 256) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength ||
        /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value;
}
function readTimestamp(value, label) {
    const timestamp = readString(value, label, 64);
    if (new Date(timestamp).toISOString() !== timestamp)
        throw new TypeError(`${label} is invalid`);
    return timestamp;
}
function parseActor(value) {
    const actor = asRecord(value, 'approval actor');
    assertOnlyKeys(actor, ['userId', 'role'], 'approval actor');
    if (!actorRoles.includes(actor.role)) {
        throw new TypeError('approval actor role is invalid');
    }
    return Object.freeze({
        userId: readString(actor.userId, 'approval actor user ID', 128),
        role: actor.role
    });
}
function parsePolicy(value) {
    const policy = asRecord(value, 'approver policy');
    assertOnlyKeys(policy, [
        'profile', 'allowedRoles', 'eligibleActorIds', 'requireDifferentActor'
    ], 'approver policy');
    if (!policyProfiles.includes(policy.profile)) {
        throw new TypeError('approver policy profile is invalid');
    }
    if (!Array.isArray(policy.allowedRoles) || policy.allowedRoles.length === 0) {
        throw new TypeError('approver policy roles are invalid');
    }
    const allowedRoles = policy.allowedRoles.map(role => {
        if (!actorRoles.includes(role) || role === 'member') {
            throw new TypeError('approver policy role is invalid');
        }
        return role;
    });
    if (new Set(allowedRoles).size !== allowedRoles.length) {
        throw new TypeError('approver policy roles contain duplicates');
    }
    if (!Array.isArray(policy.eligibleActorIds) || policy.eligibleActorIds.length === 0 ||
        policy.eligibleActorIds.length > 32) {
        throw new TypeError('approver policy eligible actors are invalid');
    }
    const eligibleActorIds = policy.eligibleActorIds.map((actorId, index) => (readString(actorId, `approver policy eligible actor ${index}`, 128)));
    if (new Set(eligibleActorIds).size !== eligibleActorIds.length) {
        throw new TypeError('approver policy eligible actors contain duplicates');
    }
    if (typeof policy.requireDifferentActor !== 'boolean') {
        throw new TypeError('approver policy actor requirement is invalid');
    }
    if ((policy.profile === 'strict') !== policy.requireDifferentActor) {
        throw new TypeError('approver policy separation requirement is invalid');
    }
    return Object.freeze({
        profile: policy.profile,
        allowedRoles: Object.freeze(allowedRoles),
        eligibleActorIds: Object.freeze(eligibleActorIds),
        requireDifferentActor: policy.requireDifferentActor
    });
}
function parseAddress(value) {
    const address = asRecord(value, 'approval address');
    let canonical;
    try {
        canonical = canonicalSessionKey(address);
    }
    catch (error) {
        throw new TypeError('approval address is invalid', { cause: error });
    }
    const parsed = parseCanonicalSessionKey(canonical);
    if (parsed === null || canonicalSessionKey(parsed) !== canonical) {
        throw new TypeError('approval address is invalid');
    }
    return Object.freeze({
        botId: parsed.botId,
        scope: Object.freeze({ ...parsed.scope })
    });
}
function parseDecision(value) {
    const decision = asRecord(value, 'approval decision');
    assertOnlyKeys(decision, ['kind', 'decidedAt', 'actor'], 'approval decision');
    if (!['approved', 'rejected', 'expired'].includes(String(decision.kind))) {
        throw new TypeError('approval decision kind is invalid');
    }
    const kind = decision.kind;
    if (kind === 'expired' && decision.actor !== undefined) {
        throw new TypeError('expired approval decision actor is invalid');
    }
    if (kind !== 'expired' && decision.actor === undefined) {
        throw new TypeError('approval decision actor is missing');
    }
    return Object.freeze({
        kind,
        decidedAt: readTimestamp(decision.decidedAt, 'approval decision timestamp'),
        ...(decision.actor === undefined ? {} : { actor: parseActor(decision.actor) })
    });
}
export function parseApprovalReplyText(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.normalize('NFC').trim();
    if (normalized === '确认')
        return 'approved';
    if (normalized === '拒绝')
        return 'rejected';
    return null;
}
export function isApprovalActorEligible(interruption, actor) {
    return isActorEligible(interruption.approverPolicy, interruption.requester, actor);
}
function isActorEligible(policy, requester, actor) {
    return policy.allowedRoles.includes(actor.role) &&
        policy.eligibleActorIds.includes(actor.userId) &&
        (!policy.requireDifferentActor || actor.userId !== requester.userId);
}
export function parseApprovalInterruption(value) {
    const input = asRecord(value, 'approval interruption');
    assertOnlyKeys(input, [
        'schemaVersion', 'approvalId', 'runId', 'step', 'callId', 'toolFingerprint',
        'argumentHash', 'action', 'target', 'keyParameters', 'requester',
        'approverPolicy', 'approvalAddress', 'approvalMessageId', 'createdAt',
        'displayedAt', 'expiresAt', 'decision'
    ], 'approval interruption');
    if (input.schemaVersion !== 1)
        throw new TypeError('approval interruption version is invalid');
    if (!Number.isSafeInteger(input.step) || Number(input.step) < 0) {
        throw new TypeError('approval interruption step is invalid');
    }
    if (!Array.isArray(input.keyParameters) || input.keyParameters.length > 8) {
        throw new TypeError('approval interruption parameters are invalid');
    }
    const keyParameters = input.keyParameters.map((parameter, index) => (readString(parameter, `approval interruption parameter ${index}`, 256)));
    const requester = parseActor(input.requester);
    const approverPolicy = parsePolicy(input.approverPolicy);
    const createdAt = readTimestamp(input.createdAt, 'approval creation timestamp');
    const hasDisplay = input.approvalMessageId !== undefined || input.displayedAt !== undefined ||
        input.expiresAt !== undefined;
    if (hasDisplay && (input.approvalMessageId === undefined || input.displayedAt === undefined ||
        input.expiresAt === undefined)) {
        throw new TypeError('approval display metadata is incomplete');
    }
    const displayedAt = input.displayedAt === undefined
        ? undefined
        : readTimestamp(input.displayedAt, 'approval display timestamp');
    const expiresAt = input.expiresAt === undefined
        ? undefined
        : readTimestamp(input.expiresAt, 'approval expiration timestamp');
    if (displayedAt !== undefined && expiresAt !== undefined) {
        const createdMs = new Date(createdAt).getTime();
        const displayedMs = new Date(displayedAt).getTime();
        const expiresMs = new Date(expiresAt).getTime();
        const ttlMs = expiresMs - displayedMs;
        if (displayedMs < createdMs || ttlMs < 30_000 || ttlMs > 300_000) {
            throw new TypeError('approval display timing is invalid');
        }
    }
    const decision = input.decision === undefined ? undefined : parseDecision(input.decision);
    if (decision !== undefined) {
        if (displayedAt === undefined || expiresAt === undefined) {
            throw new TypeError('approval decision display metadata is missing');
        }
        const decidedMs = new Date(decision.decidedAt).getTime();
        const displayedMs = new Date(displayedAt).getTime();
        const expiresMs = new Date(expiresAt).getTime();
        if (decidedMs < displayedMs ||
            (decision.kind === 'expired' ? decidedMs < expiresMs : decidedMs >= expiresMs) ||
            (decision.actor !== undefined && !isActorEligible(approverPolicy, requester, decision.actor))) {
            throw new TypeError('approval decision is invalid');
        }
    }
    const approvalAddress = parseAddress(input.approvalAddress);
    if (approvalAddress.scope.kind === 'private' &&
        !approverPolicy.eligibleActorIds.includes(approvalAddress.scope.userId)) {
        throw new TypeError('approval private address is not eligible');
    }
    return Object.freeze({
        schemaVersion: 1,
        approvalId: readString(input.approvalId, 'approval ID', 128),
        runId: readString(input.runId, 'approval run ID', 128),
        step: input.step,
        callId: readString(input.callId, 'approval call ID', 128),
        toolFingerprint: readString(input.toolFingerprint, 'approval tool fingerprint', 128),
        argumentHash: readString(input.argumentHash, 'approval argument hash', 128),
        action: readString(input.action, 'approval action'),
        target: readString(input.target, 'approval target'),
        keyParameters: Object.freeze(keyParameters),
        requester,
        approverPolicy,
        approvalAddress,
        ...(input.approvalMessageId === undefined
            ? {}
            : { approvalMessageId: readString(input.approvalMessageId, 'approval message ID', 128) }),
        createdAt,
        ...(displayedAt === undefined ? {} : { displayedAt }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(decision === undefined ? {} : { decision })
    });
}
export function displayApprovalInterruption(interruption, metadata) {
    const current = parseApprovalInterruption(interruption);
    if (current.approvalMessageId !== undefined || current.decision !== undefined ||
        !Number.isSafeInteger(metadata.ttlSeconds) || metadata.ttlSeconds < 30 ||
        metadata.ttlSeconds > 300) {
        throw new TypeError('approval cannot be displayed');
    }
    const displayedAt = readTimestamp(metadata.displayedAt, 'approval display timestamp');
    return parseApprovalInterruption({
        ...current,
        approvalMessageId: readString(metadata.messageId, 'approval message ID', 128),
        displayedAt,
        expiresAt: new Date(new Date(displayedAt).getTime() + metadata.ttlSeconds * 1_000).toISOString()
    });
}
export function decideApprovalInterruption(interruption, decision) {
    const current = parseApprovalInterruption(interruption);
    if (current.decision !== undefined)
        throw new TypeError('approval is already decided');
    return parseApprovalInterruption({ ...current, decision });
}

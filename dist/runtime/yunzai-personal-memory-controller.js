import { createHash } from 'node:crypto';
import { createMemoryAccessCapabilityIssuerV1, issueMemoryAccessCapabilityV1 } from '../agent/memory/memory-access-gate.js';
import { createMemorySourceV1 } from '../agent/memory/memory-domain.js';
import { createMemoryExportCommandV1, memoryExportStableResultHashV1 } from '../agent/memory/memory-export-port.js';
import { createMemoryLifecycleAuthorityRootV1, issueMemoryLifecycleActorCapabilityV1 } from '../agent/memory/memory-lifecycle-authority.js';
import { buildMemoryCorrectionBundleV1, buildMemoryProposalApprovalBundleV1, buildMemoryProposalDraftV2, buildMemoryRenewalBundleV1 } from '../agent/memory/memory-lifecycle-builder.js';
import { createMemoryLifecycleCommandV1 } from '../agent/memory/memory-lifecycle-command.js';
import { memoryNamespaceRefV1 } from '../agent/memory/memory-namespace.js';
import { memoryTextWithinLimits, MEMORY_RESOURCE_LIMITS } from '../agent/memory/memory-resource-limits.js';
import { createPersonalMemoryEnrollmentCommandV1 } from '../agent/memory/personal-memory-enrollment.js';
import { buildPersonalMemoryAccessScopeV1, selectPersonalMemorySubjectsV1 } from '../agent/memory/scene-participant.js';
import { createYunzaiSceneParticipantDirectoryV1 } from './yunzai-scene-participant-directory.js';
const COMMAND_PREFIX = /^#长期记忆(?:\s*|$)/u;
const RECORDS_PER_DISPLAY_PAGE = 8;
const RECORD_LOOKUP_LIMIT = 64;
const COMMAND_TIMEOUT_MS = 8_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RENEW_MAX_DAYS = 1_825;
const ACTOR_ACTIONS = Object.freeze([
    'propose_create', 'approve', 'list_safe', 'inspect_full', 'correct', 'renew',
    'forget', 'export', 'delete_namespace', 'claim_export', 'manage_enrollment'
]);
class PersonalMemoryCommandError extends Error {
}
function currentMode(source) {
    try {
        const value = Reflect.apply(source, undefined, []);
        return value === 'explicit' || value === 'shadow' || value === 'automatic' ? value : 'off';
    }
    catch {
        return 'off';
    }
}
function groupIsAllowed(source, groupId) {
    try {
        const values = Reflect.apply(source, undefined, []);
        return Array.isArray(values) && values.some(value => qqId(value) === groupId);
    }
    catch {
        return false;
    }
}
function sha256(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
function qqId(value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
        return null;
    }
    const normalized = String(value).trim();
    return /^[1-9][0-9]{0,31}$/.test(normalized) ? normalized : null;
}
function messageId(event) {
    const value = event.message_id ?? event.messageId;
    if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') &&
        /^[\x21-\x7e]{1,128}$/.test(String(value)))
        return String(value);
    throw new PersonalMemoryCommandError('无法确认当前 QQ 消息编号，长期记忆操作未执行。');
}
function boundedSourceText(value) {
    let result = '';
    for (const codePoint of value.normalize('NFC').replace(/\r\n?/g, '\n')) {
        if (Buffer.byteLength(result + codePoint, 'utf8') >
            MEMORY_RESOURCE_LIMITS.sourceExcerptUtf8Bytes)
            break;
        result += codePoint;
    }
    return result.trim() || '长期记忆控制请求';
}
function commandRef(source, operation) {
    const sceneRef = source.scene.kind === 'private'
        ? 'private'
        : `${source.scene.groupId}\0${source.scene.groupLifecycleId}`;
    return `command:${sha256(`${source.messageId ?? source.sourceId}\0${sceneRef}\0${operation}`)}`;
}
function actorRef(botInstanceId, accountId, userId) {
    return `actor:${sha256(`${botInstanceId}\0qq\0${accountId}\0${userId}`)}`;
}
function accountId(event) {
    const value = qqId(event.self_id ?? event.bot?.uin ?? event.bot?.self_id);
    if (value === null)
        throw new PersonalMemoryCommandError('无法确认当前机器人账号，长期记忆操作未执行。');
    return value;
}
function commandBody(value) {
    const normalized = value.normalize('NFC').trim();
    if (!COMMAND_PREFIX.test(normalized)) {
        throw new PersonalMemoryCommandError('长期记忆命令格式无效。');
    }
    return normalized.replace(COMMAND_PREFIX, '').trim();
}
function exactInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new PersonalMemoryCommandError('长期记忆状态暂时不可用。');
    }
    return value;
}
function namespaceState(database, namespaceRef) {
    const namespace = database.prepare(`
    SELECT namespace_generation FROM namespaces WHERE namespace_ref = ?
  `).get(namespaceRef);
    if (namespace === undefined)
        return null;
    const policy = database.prepare(`
    SELECT namespace_generation, policy_generation, state
    FROM personal_memory_policies WHERE namespace_ref = ?
  `).get(namespaceRef);
    const generation = exactInteger(namespace.namespace_generation);
    if (policy === undefined) {
        return Object.freeze({ generation, policyGeneration: 0, enrollmentState: null });
    }
    if (exactInteger(policy.namespace_generation) !== generation ||
        (policy.state !== 'opted_in' && policy.state !== 'opted_out')) {
        throw new PersonalMemoryCommandError('长期记忆状态暂时不可用。');
    }
    return Object.freeze({
        generation,
        policyGeneration: exactInteger(policy.policy_generation),
        enrollmentState: policy.state
    });
}
function messageEvidence(text, currentMessageId) {
    return Object.freeze({
        schemaVersion: 1,
        prompt: text,
        imageUrls: Object.freeze([]),
        currentMessageId,
        quotedMessageId: null,
        hasReply: false,
        replyResolved: true,
        currentSegmentCount: 1,
        replySegmentCount: 0,
        ocrTexts: Object.freeze([])
    });
}
function memorySource(participant, currentMessageId, observedAt, normalizedText) {
    const identity = participant.identity;
    const scene = participant.scene;
    return createMemorySourceV1({
        sourceKind: 'current_message',
        messageId: currentMessageId,
        actor: {
            userId: identity.userId,
            nickname: identity.nickname,
            groupCard: identity.groupCard,
            groupTitle: identity.groupTitle,
            groupRole: identity.groupRole,
            displayName: identity.displayName
        },
        scene: scene.kind === 'private'
            ? { kind: 'private', groupId: null, groupLifecycleId: null, groupName: null }
            : {
                kind: 'group',
                groupId: scene.groupId,
                groupLifecycleId: scene.groupLifecycleId,
                groupName: scene.groupName
            },
        observedAt,
        normalizedText: boundedSourceText(normalizedText),
        resourceRefs: []
    });
}
function inferKind(text) {
    if (/^(?:我|本人)?(?:喜欢|偏好|不喜欢|讨厌|常用|更喜欢)/u.test(text))
        return 'preference';
    if (/^(?:我|本人|我的|本人是|我是)/u.test(text))
        return 'profile_fact';
    if (/(?:关系|朋友|同事|家人|亲属)/u.test(text))
        return 'relationship';
    if (/(?:任务|待办|计划|截止|提醒)/u.test(text))
        return 'task_fact';
    return 'other';
}
function validMemoryText(value) {
    const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if (!memoryTextWithinLimits(normalized) || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized)) {
        throw new PersonalMemoryCommandError('记忆内容不能为空，且最多为 2000 个字符或 4 KiB。');
    }
    return normalized;
}
function recordId(value) {
    return value.lifecycleState === 'purge_due' ? value.memoryId : value.record.memoryId;
}
function recordReference(memoryId) {
    return `@${memoryId.slice(-8)}`;
}
function recordText(value) {
    if (value.lifecycleState === 'purge_due')
        return '[已到物理清理期]';
    const text = [...value.record.text].slice(0, 120).join('');
    return text.length === value.record.text.length ? text : `${text}...`;
}
function lifecyclePayload(auth, command) {
    return Object.freeze({
        schemaVersion: 1,
        command,
        access: auth.access,
        authority: Object.freeze({ kind: 'actor', capability: auth.actor })
    });
}
function controlBase(auth, operation) {
    return {
        schemaVersion: 1,
        operation,
        botInstanceId: auth.namespace.botInstanceId,
        accountId: auth.namespace.accountId,
        sceneRef: auth.access.sceneRef,
        namespaceRef: memoryNamespaceRefV1(auth.namespace),
        generation: auth.generation,
        actorRef: auth.actorRef,
        access: auth.access,
        actor: auth.actor
    };
}
function facadeRequest(operation, auth, payload) {
    return Object.freeze({
        schemaVersion: 1,
        operation,
        namespace: auth.namespace,
        payload
    });
}
function mutationSucceeded(result) {
    const status = result.result.status;
    return status === 'stored' || status === 'unchanged' || status === 'deletion_pending' ||
        status === 'deletion_complete';
}
function mutationFailureText(result) {
    const status = result.result.status;
    if (status === 'enrollment_required')
        return '请先发送“#长期记忆 开启”。';
    if (status === 'denied')
        return '当前场景或身份无权执行这个长期记忆操作。';
    if (status === 'conflict')
        return '记忆刚刚发生变化，请重新查看列表后再操作。';
    if (status === 'record_expired')
        return '这条记忆已过期，不能更正；可以续期或遗忘。';
    if (status === 'record_purge_due' || status === 'not_found')
        return '没有找到可操作的记忆。';
    if (status === 'capacity' || status === 'history_limit')
        return '长期记忆已达到当前容量上限。';
    if (status === 'aborted')
        return '长期记忆操作已取消。';
    return '长期记忆操作暂时不可用，请稍后重试。';
}
function helpText() {
    return [
        '长期记忆命令：',
        '#长期记忆 状态',
        '#长期记忆 开启 / 关闭',
        '#长期记忆 记住 <内容>',
        '#长期记忆 列表 [页码]',
        '#长期记忆 更正 <@编号> <新内容>',
        '#长期记忆 续期 <@编号> [天数]',
        '#长期记忆 遗忘 <@编号>',
        '#长期记忆 导出（仅私聊）',
        '#长期记忆 删除全部 确认'
    ].join('\n');
}
export function createYunzaiPersonalMemoryControllerV1(options) {
    const participants = createYunzaiSceneParticipantDirectoryV1();
    const issuer = createMemoryAccessCapabilityIssuerV1(() => true);
    const authorityRoot = createMemoryLifecycleAuthorityRootV1(() => true);
    const authorize = async (request) => {
        const event = request.event;
        const now = options.now();
        const botAccountId = accountId(event);
        const currentMessageId = messageId(event);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('personal_memory_command_timeout'), COMMAND_TIMEOUT_MS);
        let snapshot;
        try {
            snapshot = await participants.resolve(Object.freeze({
                event,
                messageEvidence: messageEvidence(request.text, currentMessageId),
                accountId: botAccountId,
                observedAt: now
            }), controller.signal);
        }
        catch {
            snapshot = null;
        }
        finally {
            clearTimeout(timeout);
        }
        if (snapshot === null) {
            throw new PersonalMemoryCommandError('无法确认当前 QQ 身份或群成员关系，长期记忆操作未执行。');
        }
        if (snapshot.scene.kind === 'group' &&
            !groupIsAllowed(options.groupAllowlist, snapshot.scene.groupId)) {
            throw new PersonalMemoryCommandError('当前群未加入长期记忆试点，操作未执行。');
        }
        const subjects = selectPersonalMemorySubjectsV1(Object.freeze({
            scene: snapshot.scene,
            current: snapshot.current,
            references: Object.freeze([]),
            now
        }));
        const scope = buildPersonalMemoryAccessScopeV1(Object.freeze({
            botInstanceId: options.botInstanceId,
            accountId: botAccountId,
            scene: snapshot.scene,
            subjects,
            now
        }));
        const namespace = scope.namespaces[0];
        if (namespace === undefined || subjects.length !== 1) {
            throw new PersonalMemoryCommandError('无法确认个人长期记忆命名空间。');
        }
        const state = namespaceState(options.database, memoryNamespaceRefV1(namespace));
        const generation = state?.generation ?? 1;
        const access = issueMemoryAccessCapabilityV1(issuer, scope.context, [namespace], now);
        const currentActorRef = actorRef(options.botInstanceId, botAccountId, snapshot.current.identity.userId);
        const actorContext = {
            schemaVersion: 1,
            botInstanceId: options.botInstanceId,
            adapter: 'qq',
            accountId: botAccountId,
            sceneRef: access.sceneRef,
            namespace,
            namespaceRef: memoryNamespaceRefV1(namespace),
            generation,
            actorRef: currentActorRef,
            actorUserId: snapshot.current.identity.userId,
            role: 'personal_subject',
            roleObservedAt: null,
            actions: ACTOR_ACTIONS
        };
        const actor = issueMemoryLifecycleActorCapabilityV1(authorityRoot, actorContext, now);
        const source = memorySource(snapshot.current, currentMessageId, now, request.text);
        return Object.freeze({
            now,
            namespace,
            generation,
            access,
            actor,
            actorRef: currentActorRef,
            participant: snapshot.current,
            source
        });
    };
    const readEnrollment = async (auth) => await options.facade.execute(facadeRequest('enrollment.read', auth, Object.freeze({
        schemaVersion: 1,
        namespace: auth.namespace,
        access: auth.access
    })));
    const listRecords = async (auth) => {
        const listed = await options.facade.execute(facadeRequest('list', auth, Object.freeze({
            ...controlBase(auth, 'record.inspectList'),
            cursor: null,
            limit: RECORD_LOOKUP_LIMIT,
            maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes
        })));
        if (listed.result.status !== 'page' || listed.result.operation !== 'record.inspectList') {
            throw new PersonalMemoryCommandError(mutationFailureText(listed));
        }
        return listed.result.records;
    };
    const resolveRecord = async (auth, selector) => {
        const records = await listRecords(auth);
        if (/^[1-9][0-9]*$/.test(selector)) {
            const record = records[Number(selector) - 1];
            if (record !== undefined)
                return record;
        }
        const normalized = selector.startsWith('@') ? selector.slice(1).toLowerCase() : selector;
        const matches = records.filter(record => {
            const id = recordId(record).toLowerCase();
            return id === normalized || (normalized.length === 8 && id.endsWith(normalized));
        });
        if (matches.length !== 1) {
            throw new PersonalMemoryCommandError('没有找到唯一的记忆编号，请重新查看列表。');
        }
        return matches[0];
    };
    const loadRevision = async (auth, projection) => {
        if (projection.lifecycleState === 'purge_due') {
            throw new PersonalMemoryCommandError('这条记忆已到物理清理期，不能再修改。');
        }
        const result = await options.control.execute(Object.freeze({
            ...controlBase(auth, 'revision.get'),
            memoryId: projection.record.memoryId,
            revision: projection.record.revision
        }));
        if (result.status !== 'found' || result.operation !== 'revision.get') {
            throw new PersonalMemoryCommandError('记忆刚刚发生变化，请重新查看列表后再操作。');
        }
        return result.value;
    };
    const projectAfterMutation = async () => {
        try {
            await options.rebuildLexical();
            return true;
        }
        catch {
            return false;
        }
    };
    const handleEnrollment = async (request, auth, operation) => {
        const namespaceRef = memoryNamespaceRefV1(auth.namespace);
        const state = namespaceState(options.database, namespaceRef);
        if (operation === 'enrollment.optOut' && state?.enrollmentState !== 'opted_in') {
            await request.replyText('个人长期记忆尚未开启。');
            return;
        }
        const mode = currentMode(options.mode);
        const candidateMode = operation === 'enrollment.optOut' || mode === 'explicit'
            ? 'off'
            : mode === 'shadow' ? 'shadow' : 'policy_approved';
        const ref = commandRef(auth.source, operation);
        const result = await options.facade.execute(facadeRequest(operation, auth, Object.freeze({
            schemaVersion: 1,
            namespace: auth.namespace,
            command: createPersonalMemoryEnrollmentCommandV1({
                commandRef: ref,
                operation,
                initiatedByActorRef: auth.actorRef,
                namespaceRef,
                expectedNamespaceGeneration: state?.generation ?? 1,
                expectedPolicyGeneration: state?.policyGeneration ?? 0,
                candidateMode,
                occurredAt: auth.now,
                source: auth.source
            }),
            access: auth.access,
            actor: auth.actor
        })));
        if (result.result.status !== 'stored' && result.result.status !== 'unchanged') {
            await request.replyText(mutationFailureText(result));
            return;
        }
        await request.replyText(operation === 'enrollment.optIn'
            ? '个人长期记忆已开启。之后只有你明确要求记住的内容才会立即保存。'
            : `个人长期记忆已关闭。${result.notices.join('')}`);
    };
    const handleRemember = async (request, auth, value) => {
        const text = validMemoryText(value);
        const namespaceRef = memoryNamespaceRefV1(auth.namespace);
        const ref = commandRef(auth.source, 'proposal.createAndApprove');
        const proposal = buildMemoryProposalDraftV2({
            commandRef: ref,
            operation: 'proposal.createAndApprove',
            namespaceRef,
            namespaceGeneration: auth.generation,
            initiatedByActorRef: auth.actorRef,
            namespace: auth.namespace,
            proposedBy: { kind: 'user', actorRef: auth.actorRef },
            intent: { kind: 'create' },
            kind: inferKind(text),
            text,
            sources: [auth.source],
            observedAt: auth.now,
            proposedAt: auth.now,
            confidence: 1,
            sensitivity: 'personal',
            conflict: { state: 'none', relatedMemoryIds: [], note: null },
            customTtlDays: null,
            consentRequirement: 'explicit',
            consentPolicyRef: null,
            consentPolicyGeneration: null
        });
        const bundle = buildMemoryProposalApprovalBundleV1({
            commandRef: ref,
            operation: 'proposal.createAndApprove',
            namespaceRef,
            namespaceGeneration: auth.generation,
            proposal,
            approvedByActorRef: auth.actorRef,
            freshNow: auth.now,
            evidenceSource: auth.source,
            reason: null
        });
        const command = createMemoryLifecycleCommandV1({
            commandRef: ref,
            operation: 'proposal.createAndApprove',
            initiatedByActorRef: auth.actorRef,
            namespaceRef,
            expectedNamespaceGeneration: auth.generation,
            aggregateRef: null,
            expectedRevision: null,
            expectedAggregateHash: null,
            occurredAt: auth.now,
            newValidUntil: null,
            newPurgeAt: null,
            material: bundle
        });
        const result = await options.facade.execute(facadeRequest('remember', auth, lifecyclePayload(auth, command)));
        if (!mutationSucceeded(result)) {
            await request.replyText(mutationFailureText(result));
            return;
        }
        const projected = await projectAfterMutation();
        await request.replyText(projected
            ? `已记住：${text}`
            : `已保存到长期记忆，但词法索引同步暂时失败；稍后重建索引即可恢复召回。`);
    };
    const handleList = async (request, auth, pageValue) => {
        const page = pageValue === '' ? 1 : Number(pageValue);
        if (!Number.isSafeInteger(page) || page < 1 || page > 8) {
            throw new PersonalMemoryCommandError('列表页码必须是 1 到 8。');
        }
        const records = await listRecords(auth);
        if (records.length === 0) {
            await request.replyText('还没有保存个人长期记忆。');
            return;
        }
        const start = (page - 1) * RECORDS_PER_DISPLAY_PAGE;
        const selected = records.slice(start, start + RECORDS_PER_DISPLAY_PAGE);
        if (selected.length === 0) {
            await request.replyText('这一页没有长期记忆。');
            return;
        }
        const lines = selected.map((record, index) => {
            const state = record.lifecycleState === 'current' ? '' : ` [${record.lifecycleState}]`;
            return `${start + index + 1}. ${recordReference(recordId(record))}${state} ${recordText(record)}`;
        });
        const more = records.length === RECORD_LOOKUP_LIMIT
            ? '\n当前仅载入前 64 条；完整内容请使用私聊导出。'
            : '';
        await request.replyText(`个人长期记忆（第 ${page} 页）：\n${lines.join('\n')}${more}`);
    };
    const handleCorrect = async (request, auth, selector, value) => {
        const text = validMemoryText(value);
        const before = await loadRevision(auth, await resolveRecord(auth, selector));
        const ref = commandRef(auth.source, 'record.correct');
        const bundle = buildMemoryCorrectionBundleV1({
            commandRef: ref,
            operation: 'record.correct',
            namespaceRef: before.record.namespaceRef,
            namespaceGeneration: before.record.namespaceGeneration,
            beforeRevision: before,
            changedByActorRef: auth.actorRef,
            freshNow: auth.now,
            text,
            confidence: 1,
            validity: before.record.validity,
            conflict: before.record.conflict,
            supersedes: before.record.supersedes,
            evidenceKind: 'explicit',
            evidenceSource: auth.source,
            policyRef: null,
            policyGeneration: null,
            reason: '用户通过 QQ 显式更正'
        });
        const command = createMemoryLifecycleCommandV1({
            commandRef: ref,
            operation: 'record.correct',
            initiatedByActorRef: auth.actorRef,
            namespaceRef: before.record.namespaceRef,
            expectedNamespaceGeneration: before.record.namespaceGeneration,
            aggregateRef: before.memoryId,
            expectedRevision: before.revision,
            expectedAggregateHash: before.revisionHash,
            occurredAt: auth.now,
            newValidUntil: null,
            newPurgeAt: null,
            material: bundle
        });
        const result = await options.facade.execute(facadeRequest('correct', auth, lifecyclePayload(auth, command)));
        if (!mutationSucceeded(result)) {
            await request.replyText(mutationFailureText(result));
            return;
        }
        const projected = await projectAfterMutation();
        await request.replyText(projected ? '长期记忆已更正。' : '长期记忆已更正，但词法索引同步暂时失败。');
    };
    const handleRenew = async (request, auth, selector, daysValue) => {
        const days = daysValue === '' ? 365 : Number(daysValue);
        if (!Number.isSafeInteger(days) || days < 1 || days > RENEW_MAX_DAYS) {
            throw new PersonalMemoryCommandError(`续期天数必须是 1 到 ${RENEW_MAX_DAYS}。`);
        }
        const before = await loadRevision(auth, await resolveRecord(auth, selector));
        const oldUntil = Date.parse(before.record.retention.validUntil);
        const maximum = Date.parse(auth.now) + RENEW_MAX_DAYS * DAY_MS;
        const proposed = Math.min(Math.max(oldUntil + days * DAY_MS, Date.parse(auth.now) + DAY_MS), maximum);
        if (proposed <= oldUntil) {
            throw new PersonalMemoryCommandError('这条记忆当前已接近最长有效期，暂时无法继续续期。');
        }
        const newValidUntil = new Date(proposed).toISOString();
        const ref = commandRef(auth.source, 'record.renew');
        const bundle = buildMemoryRenewalBundleV1({
            commandRef: ref,
            operation: 'record.renew',
            namespaceRef: before.record.namespaceRef,
            namespaceGeneration: before.record.namespaceGeneration,
            beforeRevision: before,
            changedByActorRef: auth.actorRef,
            freshNow: auth.now,
            newValidUntil,
            evidenceKind: 'explicit',
            evidenceSource: auth.source,
            policyRef: null,
            policyGeneration: null,
            reason: '用户通过 QQ 显式续期'
        });
        const command = createMemoryLifecycleCommandV1({
            commandRef: ref,
            operation: 'record.renew',
            initiatedByActorRef: auth.actorRef,
            namespaceRef: before.record.namespaceRef,
            expectedNamespaceGeneration: before.record.namespaceGeneration,
            aggregateRef: before.memoryId,
            expectedRevision: before.revision,
            expectedAggregateHash: before.revisionHash,
            occurredAt: auth.now,
            newValidUntil: bundle.revision.record.retention.validUntil,
            newPurgeAt: bundle.revision.record.retention.purgeAt,
            material: bundle
        });
        const result = await options.facade.execute(facadeRequest('renew', auth, lifecyclePayload(auth, command)));
        if (!mutationSucceeded(result)) {
            await request.replyText(mutationFailureText(result));
            return;
        }
        const projected = await projectAfterMutation();
        await request.replyText(projected
            ? `长期记忆已续期至 ${newValidUntil.slice(0, 10)}。`
            : '长期记忆已续期，但词法索引同步暂时失败。');
    };
    const handleForget = async (request, auth, selector) => {
        const before = await loadRevision(auth, await resolveRecord(auth, selector));
        const ref = commandRef(auth.source, 'record.forget');
        const command = createMemoryLifecycleCommandV1({
            commandRef: ref,
            operation: 'record.forget',
            initiatedByActorRef: auth.actorRef,
            namespaceRef: before.record.namespaceRef,
            expectedNamespaceGeneration: before.record.namespaceGeneration,
            aggregateRef: before.memoryId,
            expectedRevision: before.revision,
            expectedAggregateHash: before.revisionHash,
            occurredAt: auth.now,
            newValidUntil: null,
            newPurgeAt: null,
            material: null
        });
        const result = await options.facade.execute(facadeRequest('forget', auth, lifecyclePayload(auth, command)));
        if (!mutationSucceeded(result)) {
            await request.replyText(mutationFailureText(result));
            return;
        }
        const projected = await projectAfterMutation();
        await request.replyText(`${projected ? '已遗忘这条长期记忆。' : '已遗忘这条长期记忆，但索引清理暂时失败。'}${result.notices.join('')}`);
    };
    const exportEnvelope = (auth, command) => Object.freeze({
        schemaVersion: 1,
        command,
        access: auth.access,
        actor: auth.actor
    });
    const executeExport = async (auth, operation, values) => {
        const command = createMemoryExportCommandV1({
            commandRef: commandRef(auth.source, operation),
            operation,
            initiatedByActorRef: auth.actorRef,
            namespaceRef: memoryNamespaceRefV1(auth.namespace),
            expectedNamespaceGeneration: auth.generation,
            exportId: values.exportId,
            expectedManifestHash: values.expectedManifestHash,
            retryOfExportId: null,
            expectedSnapshotSha256: null,
            occurredAt: auth.now
        });
        return await options.facade.execute(facadeRequest('export', auth, exportEnvelope(auth, command)));
    };
    const handleExport = async (request, auth) => {
        const event = request.event;
        if (event.isGroup !== false) {
            await request.replyText('为避免在群内公开个人记忆，请私聊发送“#长期记忆 导出”。');
            return;
        }
        const prepared = await executeExport(auth, 'export.prepare', {
            exportId: null,
            expectedManifestHash: null
        });
        if (prepared.result.status !== 'prepared') {
            await request.replyText(mutationFailureText(prepared));
            return;
        }
        const generated = await executeExport(auth, 'export.generate', {
            exportId: prepared.result.exportId,
            expectedManifestHash: memoryExportStableResultHashV1(prepared.result)
        });
        if (generated.result.status !== 'deliverable') {
            await request.replyText(mutationFailureText(generated));
            return;
        }
        const claimed = await executeExport(auth, 'export.claimDelivery', {
            exportId: generated.result.exportId,
            expectedManifestHash: memoryExportStableResultHashV1(generated.result)
        });
        if (claimed.result.status !== 'delivery_claimed') {
            await request.replyText(mutationFailureText(claimed));
            return;
        }
        const delivery = await options.exportDelivery.redeemAndSend(claimed.result.handle, request.sendPrivateFile);
        await request.replyText(delivery === 'delivered'
            ? `长期记忆已导出。${claimed.notices.join('')}`
            : delivery === 'already_consumed'
                ? '这份长期记忆导出已经发送过。'
                : '长期记忆导出文件发送失败，请重新发起导出。');
    };
    const handleDelete = async (request, auth) => {
        const ref = commandRef(auth.source, 'namespace.delete');
        const command = createMemoryLifecycleCommandV1({
            commandRef: ref,
            operation: 'namespace.delete',
            initiatedByActorRef: auth.actorRef,
            namespaceRef: memoryNamespaceRefV1(auth.namespace),
            expectedNamespaceGeneration: auth.generation,
            aggregateRef: null,
            expectedRevision: null,
            expectedAggregateHash: null,
            occurredAt: auth.now,
            newValidUntil: null,
            newPurgeAt: null,
            material: null
        });
        const result = await options.facade.execute(facadeRequest('delete', auth, lifecyclePayload(auth, command)));
        if (!mutationSucceeded(result)) {
            await request.replyText(mutationFailureText(result));
            return;
        }
        const projected = await projectAfterMutation();
        await request.replyText(`${projected ? '个人长期记忆已全部删除并清理检索索引。' : '个人长期记忆已删除，但索引清理暂时失败。'}${result.notices.join('')}`);
    };
    return Object.freeze({
        async handle(request) {
            try {
                const body = commandBody(request.text);
                const mode = currentMode(options.mode);
                if (mode === 'off') {
                    await request.replyText('个人长期记忆当前未启用。请先由机器人主人在锅巴中开启试点模式并重启。');
                    return true;
                }
                const auth = await authorize(request);
                if (body === '' || body === '状态') {
                    const enrollment = await readEnrollment(auth);
                    const state = enrollment.result.status === 'found' && 'policy' in enrollment.result
                        ? enrollment.result.policy.state === 'opted_in' ? '已开启' : '已关闭'
                        : enrollment.result.status === 'not_enrolled' ? '未开启' : '状态暂不可用';
                    await request.replyText(`个人长期记忆：${state}；部署模式：${mode}。\n发送“#长期记忆 帮助”查看命令。`);
                    return true;
                }
                if (body === '帮助') {
                    await request.replyText(helpText());
                    return true;
                }
                if (body === '开启') {
                    await handleEnrollment(request, auth, 'enrollment.optIn');
                    return true;
                }
                if (body === '关闭') {
                    await handleEnrollment(request, auth, 'enrollment.optOut');
                    return true;
                }
                let match = /^记住\s+([\s\S]+)$/u.exec(body);
                if (match !== null) {
                    await handleRemember(request, auth, match[1] ?? '');
                    return true;
                }
                match = /^列表(?:\s+([1-8]))?$/u.exec(body);
                if (match !== null) {
                    await handleList(request, auth, match[1] ?? '');
                    return true;
                }
                match = /^更正\s+(\S+)\s+([\s\S]+)$/u.exec(body);
                if (match !== null) {
                    await handleCorrect(request, auth, match[1] ?? '', match[2] ?? '');
                    return true;
                }
                match = /^续期\s+(\S+)(?:\s+([0-9]+))?$/u.exec(body);
                if (match !== null) {
                    await handleRenew(request, auth, match[1] ?? '', match[2] ?? '');
                    return true;
                }
                match = /^遗忘\s+(\S+)$/u.exec(body);
                if (match !== null) {
                    await handleForget(request, auth, match[1] ?? '');
                    return true;
                }
                if (body === '导出') {
                    await handleExport(request, auth);
                    return true;
                }
                if (body === '删除全部') {
                    await request.replyText('这是不可逆操作。确认删除时请发送“#长期记忆 删除全部 确认”。');
                    return true;
                }
                if (body === '删除全部 确认') {
                    await handleDelete(request, auth);
                    return true;
                }
                await request.replyText(helpText());
                return true;
            }
            catch (error) {
                await request.replyText(error instanceof PersonalMemoryCommandError
                    ? error.message
                    : '长期记忆操作暂时不可用，请稍后重试。');
                return true;
            }
        }
    });
}

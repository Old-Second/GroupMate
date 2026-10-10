import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createOpenAiMemoryCandidateExtractorV1 } from '../agent/memory/OpenAiMemoryCandidateExtractor.js';
import { createMemoryAccessCapabilityIssuerV1, issueMemoryAccessCapabilityV1 } from '../agent/memory/memory-access-gate.js';
import { createMemoryLifecycleAuthorityRootV1, issueMemoryLifecycleActorCapabilityV1, issueMemoryPolicyCapabilityV1 } from '../agent/memory/memory-lifecycle-authority.js';
import { createMemoryCandidateLifecycleSinkV1 } from '../agent/memory/memory-candidate-lifecycle-sink.js';
import { createMemoryCandidateWorkerV1, memoryCandidateSubmissionAllowsPolicyApprovalV1 } from '../agent/memory/memory-candidate-worker.js';
import { createMemoryExtractionJobV1, memoryCredentialRejectionReasonV1 } from '../agent/memory/memory-candidate-pipeline.js';
import { createMemorySourceV1 } from '../agent/memory/memory-domain.js';
import { decodeCanonicalMemoryRevisionV1 } from '../agent/memory/memory-canonical-wire.js';
import { decodeMemoryProposalV2 } from '../agent/memory/memory-lifecycle-codec.js';
import { memoryNamespaceRefV1 } from '../agent/memory/memory-namespace.js';
import { createPersonalMemoryEnrollmentCommandV1, personalMemoryEnrollmentActorRefHashV1 } from '../agent/memory/personal-memory-enrollment.js';
import { MEMORY_RETENTION_POLICY_REF_V1 } from '../agent/memory/memory-lifecycle-domain.js';
import { decidePersonalMemoryPilotV1 } from '../agent/memory/personal-memory-pilot-policy.js';
import { buildPersonalMemoryAccessScopeV1, selectPersonalMemorySubjectsV1 } from '../agent/memory/scene-participant.js';
import { createSqliteMemoryExtractionQueueV1 } from '../agent/memory/sqlite-memory-extraction-queue.js';
import { createYunzaiSceneParticipantDirectoryV1 } from './yunzai-scene-participant-directory.js';
import { RUN_REF_PATTERN } from '../agent/run/run-reference.js';
async function abortable(pending, signal) {
    let onAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([pending, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function aborted(signal) { return signal?.aborted === true; }
/** Event driven single worker; automatic defaults remain subordinate to a durable personal opt-out. */
export function createProductionShadowMemoryV1(options) {
    const issuer = createMemoryAccessCapabilityIssuerV1(() => true);
    const root = createMemoryLifecycleAuthorityRootV1(() => true);
    const participants = createYunzaiSceneParticipantDirectoryV1();
    let queueDatabase = null;
    let queue = null;
    let worker = null;
    let active = null;
    let activeSignal = null;
    let closed = false;
    let rerun = false;
    // Reject overload before retaining event/host objects or doing member lookups.
    const enqueues = new Set();
    const enabled = () => options.mode() === 'shadow' || options.mode() === 'automatic';
    const report = (stage, outcome) => {
        try {
            options.onAdmission?.(Object.freeze({ stage, outcome }));
        }
        catch { }
    };
    const contextFor = async (job, signal) => {
        if (job.source.scene.kind === 'group') {
            // Durable jobs cannot turn the original event into a fresh membership proof.
            // Refresh both subject and bot lifecycle through the trusted host on each authorization.
            const bot = await options.bot?.(job.namespace.accountId);
            if (typeof bot?.sendApi !== 'function' || signal === undefined)
                return null;
            const raw = await abortable(bot.sendApi('get_group_member_info', {
                group_id: job.source.scene.groupId, user_id: job.subject.userId, no_cache: true
            }), signal);
            const member = raw?.data ?? raw;
            if (signal.aborted || String(member?.user_id) !== job.subject.userId)
                return null;
            const snapshot = await abortable(participants.resolve({
                event: { isGroup: true, group_id: job.source.scene.groupId, user_id: job.subject.userId,
                    self_id: job.namespace.accountId, sender: member, bot },
                accountId: job.namespace.accountId, observedAt: options.now(),
                messageEvidence: { schemaVersion: 1, prompt: job.source.normalizedText, imageUrls: [],
                    currentMessageId: job.source.messageId, quotedMessageId: null, hasReply: false,
                    replyResolved: true, currentSegmentCount: 1, replySegmentCount: 0, ocrTexts: [] }
            }, signal), signal);
            if (snapshot?.scene.kind !== 'group' ||
                snapshot.scene.groupLifecycleId !== job.source.scene.groupLifecycleId)
                return null;
        }
        return {
            schemaVersion: 1, botInstanceId: options.botInstanceId, adapter: 'qq',
            accountId: job.namespace.accountId,
            scene: job.source.scene.kind === 'private'
                ? { kind: 'private', peerUserId: job.subject.userId }
                : { kind: 'group', groupId: job.source.scene.groupId,
                    groupLifecycleId: job.source.scene.groupLifecycleId,
                    trustedMemberUserIds: [job.subject.userId], observedAt: options.now() }
        };
    };
    const recordsFor = (job) => {
        const rows = options.database.prepare(`
      SELECT p.revision_wire FROM heads h JOIN revision_payloads p
        ON p.namespace_ref = h.namespace_ref AND p.namespace_generation = h.namespace_generation
        AND p.memory_id = h.memory_id AND p.revision = h.current_revision
      WHERE h.namespace_ref = ? AND h.namespace_generation = ? ORDER BY h.memory_id LIMIT 33
    `).all(job.namespaceRef, job.namespaceGeneration);
        if (rows.length > 32)
            throw new TypeError('candidate comparison capacity');
        return rows.map(row => decodeCanonicalMemoryRevisionV1(row.revision_wire).record)
            .filter(record => record.deletionState === 'active' && record.validity.state === 'current' &&
            Date.parse(record.retention.validUntil) > Date.parse(options.now()));
    };
    const authorize = async (job, signal, issuedAt, submission) => {
        if (closed || !enabled() || signal?.aborted === true ||
            job.namespace.botInstanceId !== options.botInstanceId || job.source.actor.userId !== job.subject.userId)
            return null;
        const instant = options.now();
        const context = await contextFor(job, signal);
        if (context === null || closed || aborted(signal))
            return null;
        const instantForCapability = issuedAt ?? options.now();
        const access = issueMemoryAccessCapabilityV1(issuer, context, [job.namespace], instantForCapability);
        if (access.sceneRef !== job.sceneRef)
            return null;
        const state = await options.enrollment.read({ schemaVersion: 1, namespace: job.namespace, access }, signal);
        if (state.status !== 'found' || state.policy.namespaceGeneration !== job.namespaceGeneration ||
            state.policy.policyGeneration !== job.enrollmentPolicyGeneration)
            return null;
        const decision = decidePersonalMemoryPilotV1({
            deploymentMode: options.mode(),
            enrollment: { status: state.policy.state, candidateMode: state.policy.candidateMode },
            scene: job.source.scene.kind === 'private' ? { kind: 'private' }
                : { kind: 'group', groupId: job.source.scene.groupId },
            groupAllowlist: options.groupAllowlist()
        });
        if ((!decision.shadowCandidate && !decision.automaticCandidate) || closed || aborted(signal))
            return null;
        const actorRef = `actor:${createHash('sha256').update(`${options.botInstanceId}\0qq\0${job.namespace.accountId}\0${job.subject.userId}`).digest('hex')}`;
        const actor = issueMemoryLifecycleActorCapabilityV1(root, {
            schemaVersion: 1, botInstanceId: options.botInstanceId, adapter: 'qq',
            accountId: job.namespace.accountId, sceneRef: access.sceneRef,
            namespace: job.namespace, namespaceRef: job.namespaceRef, generation: job.namespaceGeneration,
            actorRef, actorUserId: job.subject.userId, role: 'personal_subject',
            roleObservedAt: null, actions: ['propose_create']
        }, instantForCapability);
        const automatic = submission?.approvalMode === 'policy_approved';
        if (automatic && (!decision.automaticCandidate || !memoryCandidateSubmissionAllowsPolicyApprovalV1(submission) ||
            state.policy.decidedByActorRefHash !== personalMemoryEnrollmentActorRefHashV1(actorRef) ||
            recordsFor(job).some(record => record.kind === submission.candidate.kind)))
            return null;
        const policy = !automatic ? null : issueMemoryPolicyCapabilityV1(root, {
            schemaVersion: 1, botInstanceId: options.botInstanceId, adapter: 'qq', accountId: job.namespace.accountId,
            sceneRef: access.sceneRef, namespace: job.namespace, namespaceRef: job.namespaceRef,
            generation: job.namespaceGeneration, policyRef: `policy:${state.policy.policyHash}`,
            policyGeneration: state.policy.policyGeneration, createdByActorRef: actorRef,
            createdByUserId: job.subject.userId, consent: 'owner_policy',
            allowedKinds: ['profile_fact', 'preference', 'task_fact'], allowedSensitivities: ['public', 'personal'],
            allowedSourceKinds: ['current_message'], allowedRetentionPolicyRefs: [MEMORY_RETENTION_POLICY_REF_V1]
        }, instantForCapability);
        return { status: 'authorized', access, actor, policy,
            candidateMode: decision.automaticCandidate ? 'automatic' : 'shadow' };
    };
    const openQueue = (forCleanup = false) => {
        if (queue !== null || closed || (!enabled() && !forCleanup))
            return;
        const database = new DatabaseSync(options.queueLocation);
        try {
            chmodSync(options.queueLocation, 0o600);
            database.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 50; PRAGMA cache_size = -256; PRAGMA max_page_count = 8192');
            queue = createSqliteMemoryExtractionQueueV1({ database, now: options.now });
            queueDatabase = database;
            const sink = createMemoryCandidateLifecycleSinkV1({ lifecycle: options.lifecycle,
                authorize: async (input, signal) => {
                    const result = await authorize(input.job, signal, input.submittedAt, input);
                    return result === null ? { status: 'denied', reason: 'policy' }
                        : { status: result.status, access: result.access, actor: result.actor, policy: result.policy };
                } });
            worker = createMemoryCandidateWorkerV1({
                queue, workerId: 'groupmate-production-shadow', now: options.now,
                rssBytes: () => process.memoryUsage().rss,
                policy: { decide: async (job, signal) => {
                        const authorization = await authorize(job, signal);
                        return authorization === null ? { status: 'disabled', reason: 'stale_policy' }
                            : { status: 'enabled', mode: authorization.candidateMode };
                    } },
                extractor: createOpenAiMemoryCandidateExtractorV1(options.model),
                classifier: { classify: async ({ job, candidate }) => {
                        const records = recordsFor(job);
                        const duplicate = records.find(record => record.text === candidate.text);
                        if (duplicate !== undefined)
                            return { status: 'duplicate', relatedMemoryIds: [duplicate.memoryId] };
                        const conflicts = records.filter(record => record.kind === candidate.kind).slice(0, 4);
                        return conflicts.length === 0 ? { status: 'distinct' }
                            : { status: 'conflict', relatedMemoryIds: conflicts.map(record => record.memoryId),
                                note: '与已有同类事实不同，需本人确认；不会自动覆盖。' };
                    } },
                sink: { submit: async (input, signal) => {
                        if (await authorize(input.job, signal, input.submittedAt) === null)
                            return { status: 'denied', reason: 'policy' };
                        const rows = options.database.prepare(`
            SELECT proposal_wire FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
              AND state = 'pending' ORDER BY proposal_id LIMIT 33
          `).all(input.job.namespaceRef, input.job.namespaceGeneration);
                        if (rows.length > 32)
                            return { status: 'capacity' };
                        const duplicate = rows.map(row => decodeMemoryProposalV2(row.proposal_wire)).find(proposal => proposal.text === input.candidate.text && proposal.kind === input.candidate.kind &&
                            Date.parse(proposal.suggestedRetention.validUntil) > Date.parse(options.now()));
                        if (duplicate !== undefined)
                            return input.approvalMode === 'policy_approved'
                                ? { status: 'denied', reason: 'policy' }
                                : { status: 'unchanged', outcome: 'shadow', proposalId: duplicate.proposalId };
                        const result = await sink.submit(input, signal);
                        if ((result.status === 'stored' || result.status === 'unchanged') && result.outcome === 'approved') {
                            // Canonical approval remains authoritative if a rebuildable projection is unavailable.
                            try {
                                await options.onApproved?.();
                            }
                            catch { }
                        }
                        return result;
                    } }
            });
        }
        catch (error) {
            queue = null;
            queueDatabase = null;
            database.close();
            throw error;
        }
    };
    const kick = () => {
        if (closed || !enabled() || worker === null)
            return;
        if (active !== null) {
            rerun = true;
            return;
        }
        const controller = new AbortController();
        activeSignal = controller;
        active = (async () => {
            for (let batch = 0; batch < 2; batch += 1) {
                rerun = false;
                await worker.runBatch(controller.signal);
                if (!rerun || closed || controller.signal.aborted || !enabled())
                    break;
            }
        })().catch(() => undefined)
            .finally(() => { active = null; activeSignal = null; });
    };
    const enqueue = async (input) => {
        if (closed || !enabled() || input.envelope.kind !== 'completed' ||
            input.envelope.completion.kind !== 'reply_text' ||
            !input.presentation.deliveries.some(delivery => delivery.kind === 'sent'))
            return;
        const evidence = input.prepared.evidence;
        const prompt = evidence.prompt.normalize('NFC').replace(/\r\n?/g, '\n').trim();
        // Never persist truncated evidence, credentials, image/OCR/quoted assertions or command messages.
        if (evidence.currentMessageId === null || evidence.hasReply || evidence.imageUrls.length !== 0 ||
            evidence.ocrTexts.length !== 0 || prompt.startsWith('#') || prompt === '' ||
            Buffer.byteLength(prompt, 'utf8') > 1_024 || [...prompt].length > 500 ||
            memoryCredentialRejectionReasonV1(prompt) !== null) {
            report('evidence', 'rejected');
            return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_000);
        let stage = 'participant';
        try {
            const instant = options.now();
            const accountId = input.prepared.route.sessionAddress.botId;
            const snapshot = await abortable(participants.resolve({ event: input.event, messageEvidence: evidence,
                accountId, observedAt: instant }, controller.signal), controller.signal);
            if (snapshot === null || closed || controller.signal.aborted) {
                report(stage, 'rejected');
                return;
            }
            stage = 'scope';
            const address = input.prepared.route.sessionAddress.scope;
            if (input.prepared.route.actorId !== snapshot.current.identity.userId ||
                (snapshot.scene.kind === 'private'
                    ? address.kind !== 'private' || address.userId !== snapshot.current.identity.userId
                    : address.kind === 'private' || address.groupId !== snapshot.scene.groupId ||
                        (address.kind === 'group_user' && address.userId !== snapshot.current.identity.userId))) {
                report(stage, 'rejected');
                return;
            }
            const subjects = selectPersonalMemorySubjectsV1({ scene: snapshot.scene,
                current: snapshot.current, references: [], now: instant });
            const scope = buildPersonalMemoryAccessScopeV1({ botInstanceId: options.botInstanceId,
                accountId, scene: snapshot.scene, subjects, now: instant });
            const namespace = scope.namespaces[0];
            if (namespace === undefined || subjects.length !== 1) {
                report(stage, 'rejected');
                return;
            }
            const access = issueMemoryAccessCapabilityV1(issuer, scope.context, [namespace], instant);
            stage = 'enrollment';
            const identity = snapshot.current.identity;
            const { userId, nickname, groupCard, groupTitle, groupRole, displayName } = identity;
            const actor = { userId, nickname, groupCard, groupTitle, groupRole, displayName };
            const scene = snapshot.scene;
            const source = createMemorySourceV1({ sourceKind: 'current_message', messageId: evidence.currentMessageId,
                actor, scene: scene.kind === 'private'
                    ? { kind: 'private', groupId: null, groupLifecycleId: null, groupName: null }
                    : { kind: 'group', groupId: scene.groupId, groupLifecycleId: scene.groupLifecycleId, groupName: scene.groupName },
                observedAt: instant, normalizedText: prompt, resourceRefs: [] });
            let enrollment = await options.enrollment.read({ schemaVersion: 1, namespace, access }, controller.signal);
            const eligibleScene = scene.kind === 'private' || options.groupAllowlist().includes(scene.groupId);
            if (options.mode() === 'automatic' && eligibleScene && (enrollment.status === 'not_enrolled' ||
                (enrollment.status === 'found' && enrollment.policy.state === 'opted_in' &&
                    enrollment.policy.candidateMode !== 'policy_approved'))) {
                // This is the deployment's default policy, evidenced by the triggering message, not a user approval.
                // An explicit opt-out is never upgraded, including across restarts and deployment changes.
                const namespaceRef = memoryNamespaceRefV1(namespace);
                const generation = enrollment.status === 'found' ? enrollment.policy.namespaceGeneration
                    : Number(options.database.prepare('SELECT namespace_generation FROM namespaces WHERE namespace_ref = ?')
                        .get(namespaceRef)?.namespace_generation ?? 1);
                const policyGeneration = enrollment.status === 'found' ? enrollment.policy.policyGeneration : 0;
                const actorRef = `actor:${createHash('sha256').update(`${options.botInstanceId}\0qq\0${accountId}\0${identity.userId}`).digest('hex')}`;
                const actor = issueMemoryLifecycleActorCapabilityV1(root, {
                    schemaVersion: 1, botInstanceId: options.botInstanceId, adapter: 'qq', accountId,
                    sceneRef: access.sceneRef, namespace, namespaceRef, generation, actorRef,
                    actorUserId: identity.userId, role: 'personal_subject', roleObservedAt: null,
                    actions: ['manage_enrollment']
                }, instant);
                await options.enrollment.decide({ schemaVersion: 1, namespace, access, actor,
                    command: createPersonalMemoryEnrollmentCommandV1({
                        commandRef: `command:${createHash('sha256').update(`groupmate.memory.automatic-default.v1\0${namespaceRef}\0${generation}\0${policyGeneration}\0${source.sourceId}`).digest('hex')}`,
                        operation: 'enrollment.optIn', initiatedByActorRef: actorRef, namespaceRef,
                        expectedNamespaceGeneration: generation, expectedPolicyGeneration: policyGeneration,
                        candidateMode: 'policy_approved', occurredAt: instant, source
                    }) }, controller.signal);
                enrollment = await options.enrollment.read({ schemaVersion: 1, namespace, access }, controller.signal);
            }
            if (enrollment.status !== 'found') {
                report(stage, 'rejected');
                return;
            }
            stage = 'job';
            const reply = [...input.envelope.completion.text.normalize('NFC')].slice(0, 500).join('').trim();
            if (!RUN_REF_PATTERN.test(input.envelope.runRef)) {
                report(stage, 'rejected');
                return;
            }
            const job = createMemoryExtractionJobV1({ namespace, namespaceGeneration: enrollment.policy.namespaceGeneration,
                enrollmentPolicyGeneration: enrollment.policy.policyGeneration,
                // Kernel refs are bare 32-digit hex; memory provenance uses domain-prefixed opaque ids.
                subject: actor, source, sceneRef: access.sceneRef, sourceRunRef: `run:${input.envelope.runRef}`,
                sourceModelProfile: options.model.model(), requestedMode: options.mode() === 'automatic' &&
                    enrollment.policy.candidateMode === 'policy_approved' ? 'automatic' : 'shadow', priority: 'asserted',
                enqueuedAt: instant, assistantReply: reply });
            stage = 'authorization';
            if (await abortable(authorize(job, controller.signal), controller.signal) === null) {
                report(stage, 'rejected');
                return;
            }
            stage = 'queue';
            openQueue();
            if (queue !== null && !closed && !controller.signal.aborted) {
                const result = await queue.enqueue(job, controller.signal);
                report(stage, result.status === 'stored' || result.status === 'unchanged' ? 'accepted' : 'rejected');
                kick();
            }
        }
        catch {
            report(stage, controller.signal.aborted ? 'timeout' : 'failed');
        }
        finally {
            clearTimeout(timeout);
        }
    };
    const postReplyCandidate = Object.freeze({
        async enqueue(input) {
            if (closed || !enabled() || enqueues.size >= 2)
                return;
            const pending = enqueue(input).catch(() => undefined);
            enqueues.add(pending);
            try {
                await pending;
            }
            finally {
                enqueues.delete(pending);
            }
        }
    });
    return Object.freeze({
        postReplyCandidate,
        async resume() { if (enabled() && existsSync(options.queueLocation)) {
            openQueue();
            kick();
        } },
        async clearNamespace(namespace) {
            if (queueDatabase === null && existsSync(options.queueLocation))
                openQueue(true);
            // Abort in-flight extraction first; sink also rechecks generation/opt-in before writing.
            activeSignal?.abort();
            if (queueDatabase !== null) {
                queueDatabase.prepare('DELETE FROM memory_extraction_jobs WHERE namespace_ref = ?')
                    .run(memoryNamespaceRefV1(namespace));
                queueDatabase.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            }
        },
        async inspect() {
            const usage = queue === null ? null : await queue.usage();
            return { status: queue !== null && usage?.status !== 'usage' ? 'unavailable'
                    : active === null ? 'idle' : 'running',
                pendingRecords: usage?.status === 'usage' ? usage.pendingRecords : 0,
                deadLetterRecords: queueDatabase === null ? 0 : Number(queueDatabase.prepare("SELECT count(*) AS n FROM memory_candidate_audits WHERE outcome = 'dead_letter'").get()?.n), logicalBytes: usage?.status === 'usage' ? usage.logicalBytes : 0 };
        },
        async waitForIdle() { await Promise.all([...enqueues]); if (active !== null)
            await active; },
        async close() {
            closed = true;
            activeSignal?.abort();
            await Promise.all([...enqueues]);
            if (active !== null)
                await active;
            queueDatabase?.close();
            queueDatabase = null;
            queue = null;
            worker = null;
        }
    });
}

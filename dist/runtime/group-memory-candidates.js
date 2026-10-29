import { cultureKindV1 } from '../agent/contracts/CultureRecord.js';
import { issueMemoryPolicyCapabilityV1 } from '../agent/memory/memory-lifecycle-authority.js';
import { MEMORY_PROPOSAL_DEADLINE_DAYS_V2 } from '../agent/memory/memory-lifecycle-domain.js';
/**
 * One numbered view of a group's pending candidates, shared by the review
 * commands and by the proactive notice.
 *
 * Administrators used to copy an eight hex digit proposal id out of the list on
 * a phone keyboard, one command per candidate. The short ordinal below is what
 * both surfaces print, so a notice and a later `#群记忆 候选` agree on which
 * number means which candidate, and `通过 1 3` or `通过 全部` stays typable.
 * Ordinals are positions in this exact ordering, not stored identifiers: a
 * review or an expiry renumbers the rest, which is why every reviewed
 * candidate is echoed back by its text.
 */
/**
 * Ordinals cover every pending candidate of a group, so a culture candidate is
 * never hidden behind a page of rule candidates. The per-group caps are eight
 * automatic candidates plus the classified-culture pending cap, so this bound
 * holds the whole set.
 */
export const GROUP_MEMORY_CANDIDATE_LIST_LIMIT_V1 = 48;
/** Lines per reply, so one group message stays readable. */
export const GROUP_MEMORY_CANDIDATE_PAGE_V1 = 16;
/** Veto window for candidates the bot may approve on the owner's standing policy. */
export const GROUP_MEMORY_IMPLICIT_APPROVAL_HOURS_V1 = 24;
const SELECT = `SELECT proposal_id, proposed_at_ms,
    json_extract(proposal_wire, '$.text') AS text,
    json_extract(proposal_wire, '$.proposedBy.kind') AS proposer,
    json_extract(proposal_wire, '$.conflict.state') AS conflict,
    json_extract(proposal_wire, '$.consentRequirement') AS consent
  FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
  AND state = 'pending' AND proposed_at_ms > ?
  ORDER BY proposed_at_ms, proposal_id LIMIT ?`;
/**
 * Pending, not yet expired candidates in a stable order. The predicate matches
 * the lifecycle projection's `pending` effective state, so a row here is one the
 * control port will also accept for review.
 */
export function listGroupMemoryCandidateRowsV1(database, namespaceRef, generation, nowMs) {
    const rows = database.prepare(SELECT).all(namespaceRef, generation, nowMs - MEMORY_PROPOSAL_DEADLINE_DAYS_V2 * 86_400_000, GROUP_MEMORY_CANDIDATE_LIST_LIMIT_V1);
    return Object.freeze(rows.map((row, index) => {
        const text = String(row.text);
        return Object.freeze({
            ordinal: index + 1, proposalId: String(row.proposal_id), text,
            culture: cultureKindV1(text) !== null, automatic: row.proposer === 'model',
            conflicting: row.conflict !== 'none', implicitApprovable: row.consent === 'group_policy',
            proposedAtMs: Number(row.proposed_at_ms)
        });
    }));
}
/** Fixed labels only; the candidate text is already bounded by the group memory text rules. */
export function groupMemoryCandidateLineV1(row, implicitApprovalHours) {
    const deadline = new Date(row.proposedAtMs + MEMORY_PROPOSAL_DEADLINE_DAYS_V2 * 86_400_000)
        .toISOString().slice(0, 10);
    const note = row.conflicting
        ? '（与已有记录相近，需管理员确认）'
        : implicitApprovalHours !== null && row.automatic && row.implicitApprovable
            ? `（公示后 ${implicitApprovalHours} 小时内无人处理将自动保存）`
            : `（${deadline} 前审核）`;
    return `${row.ordinal}. ${row.culture ? '[文化] ' : ''}${[...row.text].slice(0, 120).join('')}` +
        `${row.automatic ? ' [自动]' : ' [成员提议]'}${note}`;
}
/**
 * Issues the authority for approving a candidate whose consent is the group's
 * own policy rather than a single message.
 *
 * Candidates created while the public-notice window is on record
 * `group_policy` consent, which the lifecycle port only accepts from a policy
 * capability. Both approval paths go through here: an administrator applying
 * the policy early inside the window, and the bot applying it after the window
 * elapsed. Who acted stays visible in the approving actor ref and the revision
 * reason; the administrator gate itself lives in the calling command, which
 * verifies the live group role before it gets here.
 */
export function issueGroupMemoryPolicyApprovalCapabilityV1(root, input) {
    const { proposal } = input;
    return issueMemoryPolicyCapabilityV1(root, {
        schemaVersion: 1, botInstanceId: input.botInstanceId, adapter: 'qq', accountId: input.accountId,
        sceneRef: input.sceneRef, namespace: input.namespace, namespaceRef: input.namespaceRef,
        generation: input.generation, policyRef: proposal.consentPolicyRef,
        policyGeneration: proposal.consentPolicyGeneration,
        createdByActorRef: input.actorRef, createdByUserId: input.actorUserId,
        consent: 'group_policy',
        // Scoped to exactly this candidate, so the capability cannot cover anything else.
        allowedKinds: [proposal.kind], allowedSensitivities: [proposal.sensitivity],
        allowedSourceKinds: [...new Set(proposal.sources.map(source => source.sourceKind))],
        allowedRetentionPolicyRefs: [proposal.retentionPolicyRef]
    }, input.now);
}

import { CULTURE_LABELS, CULTURE_TTL_DAYS, cultureKindV1, type CultureKindV1 } from '../agent/contracts/CultureRecord.js'
import { validateCanonicalMemoryDependencies } from './CanonicalMemoryBoundary.js'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createMemoryAccessCapabilityIssuerV1, issueMemoryAccessCapabilityV1 } from '../agent/memory/memory-access-gate.js'
import { memoryCredentialRejectionReasonV1 } from '../agent/memory/memory-candidate-pipeline.js'
import type { MemoryControlRepositoryPortV1 } from '../agent/memory/memory-control-repository.js'
import { createMemorySourceV1, type MemoryKindV1 } from '../agent/memory/memory-domain.js'
import { createMemoryExportCommandV1, memoryExportStableResultHashV1, type MemoryExportPortV1 } from '../agent/memory/memory-export-port.js'
import { createMemoryLifecycleAuthorityRootV1, issueMemoryLifecycleActorCapabilityV1, type MemoryLifecycleActorActionV1 } from '../agent/memory/memory-lifecycle-authority.js'
import { buildMemoryCorrectionBundleV1, buildMemoryProposalApprovalBundleV1, buildMemoryProposalDraftV2, buildMemoryRenewalBundleV1 } from '../agent/memory/memory-lifecycle-builder.js'
import { createMemoryLifecycleCommandV1, type MemoryLifecycleCommandOperationV1, type MemoryLifecycleCommandMaterialV1 } from '../agent/memory/memory-lifecycle-command.js'
import type { MemoryRevisionV2, MemoryProposalV2 } from '../agent/memory/memory-lifecycle-domain.js'
import type { MemoryLifecycleEnvelopeAuthorityV1, MemoryLifecyclePortV1 } from '../agent/memory/memory-lifecycle-port.js'
import { memoryNamespaceRefV1, parseMemoryNamespaceV1, type MemoryNamespaceV1 } from '../agent/memory/memory-namespace.js'
import { MEMORY_RESOURCE_LIMITS, memoryTextWithinLimits } from '../agent/memory/memory-resource-limits.js'
import { parseMemoryRetrievalRequestV2, retrieveMemoryV2, type MemoryRetrievalAdapterV2, type MemoryRetrievalResultV2 } from '../agent/memory/memory-retrieval.js'
import type { PersonalMemoryCommandPortV1, PersonalMemoryCommandRequestV1 } from './personal-memory-command.js'
import type { PersonalMemoryExportDeliveryV1 } from './yunzai-personal-memory-controller.js'
import { createYunzaiSceneParticipantDirectoryV1, type YunzaiPersonalMemoryRecallInputV1 } from './yunzai-scene-participant-directory.js'
import { groupMemoryCandidateLineV1, issueGroupMemoryPolicyApprovalCapabilityV1, listGroupMemoryCandidateRowsV1, type GroupMemoryCandidateRowV1 } from './group-memory-candidates.js'
import type { GroupMemoryFeatureV1, GroupMemoryPolicyStoreV1, GroupMemoryPolicyV1 } from './GroupMemoryPolicy.js'

interface GroupMemoryOptions {
  readonly botInstanceId: string
  readonly database: DatabaseSync
  readonly enabled: () => boolean
  readonly policy: GroupMemoryPolicyStoreV1
  readonly now: () => string
  readonly lifecycle: MemoryLifecyclePortV1
  readonly control: MemoryControlRepositoryPortV1
  readonly export: MemoryExportPortV1
  readonly exportDelivery: PersonalMemoryExportDeliveryV1
  readonly retriever: MemoryRetrievalAdapterV2
  readonly rebuildLexical: () => Promise<number>
  /**
   * Reports that a canonical write committed but its derived lexical projection did not. Recall
   * degrades silently without this signal, so the failure must leave a durable trace.
   */
  readonly onDerivedIndexFailure?: (operation: string) => void
  readonly completeNamespaceDeletion: (namespace: MemoryNamespaceV1) => Promise<boolean>
  readonly recallLimits: () => { readonly maxCandidates: number; readonly maxTokens: number; readonly maxBytes: number }
  readonly recallTimeoutMs: () => number
  /** Drops observed-but-unprocessed group messages after a close or a delete-all. */
  readonly discardObservedMessages?: (accountId: string, groupId: string) => void
  /** Owner switch; only changes how a pending candidate's deadline is described. */
  readonly implicitApprovalEnabled?: () => boolean
}


const ADMIN_ACTIONS: readonly MemoryLifecycleActorActionV1[] = [
  'propose_create', 'list_safe', 'inspect_full', 'approve', 'reject', 'correct', 'renew', 'forget'
]
const HELP = ['群记忆命令：',
  '#群记忆 状态', '#群记忆 开启 / 关闭（群管理员；默认开启）',
  '#群记忆 列表 [页码]', '#群记忆 记住 <规则|共同偏好|文化|群体事实> <以本群或我们群开头的内容>',
  '#群记忆 候选（群管理员；一个列表列出全部待审候选，含从群聊自动发现的）',
  '#群记忆 通过 / 拒绝 <编号…|全部>（群管理员；编号用候选列表里的 1、2、3）',
  '#群记忆 更正 <@编号> <新内容>', '#群记忆 续期 <@编号> [天数]',
  '#群记忆 遗忘 <@编号>', '#群记忆 导出（群主，私发文件）',
  '#群记忆 删除全部 确认（群主）',
  '群管理员可以保存和修改；普通成员可以查看。第三方个人信息不会写入群记忆。'].join('\n')
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
class GroupMemoryError extends Error {}
const FEATURE_LABELS: Readonly<Record<GroupMemoryFeatureV1, string>> = Object.freeze({
  group_memory: '群记忆', group_culture: '群文化'
})

function boundedExcerpt (value: string): string {
  let result = ''
  for (const point of value) {
    if (Buffer.byteLength(result + point) > MEMORY_RESOURCE_LIMITS.sourceExcerptUtf8Bytes) break
    result += point
  }
  return result
}

async function abortable<T> (pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  try { return await Promise.race([pending, aborted]) }
  finally { signal.removeEventListener('abort', stop) }
}

/** Only collective assertions, never individual identities or private facts, enter this pilot. */
export function groupMemoryTextV1 (value: string): string {
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (!memoryTextWithinLimits(text) || Buffer.byteLength(text) > 800 ||
    !/^(?:本群|我们群|群内|全群)(?:禁止|不允许|允许|要求|约定|共同|习惯|主题偏好|语言约定|梗说明|每|成立于|偏好|喜欢|使用|活动|默认|鼓励|讨论|以|是一个|成员(?:都|共同|统一))/u.test(text) ||
    memoryCredentialRejectionReasonV1(text) !== null ||
    /(?:["“”「」『』]|\b\d{5,}\b|https?:|@|CQ:|手机号|电话|住址|身份证|病史|糖尿病|癌症|抑郁症|诊断|收入|工资|债务|银行卡|性取向|性生活|私聊|小明|某人|个人信息|我(?!们群)|你|他|她|转述|模型(?:输出|回答)|姓名|邮箱|微信|\b(?:salary|income|diagnosed|password|token)\b)/iu.test(text)) {
    throw new GroupMemoryError('群记忆只保存明确的群规则、共同偏好、稳定群文化和群体事实；请勿包含个人身份、转述或私密信息。')
  }
  return text
}

/** Uses existing canonical/FTS ports; no extra database, polling worker or vector service. */
export function createGroupMemoryV1 (options: GroupMemoryOptions) {
  const participants = createYunzaiSceneParticipantDirectoryV1()
  const issuer = createMemoryAccessCapabilityIssuerV1(() => true)
  const root = createMemoryLifecycleAuthorityRootV1(() => true)
  const policyScope = (event: any) => ({ botInstanceId: options.botInstanceId,
    accountId: String(event?.self_id ?? event?.bot?.uin ?? ''), groupId: String(event?.group_id ?? '') })
  // Absent or unreadable policy state never widens access: an unreadable store fails closed.
  const groupPolicy = (event: any): GroupMemoryPolicyV1 | null => {
    try { return options.policy.read(policyScope(event)) } catch { return null }
  }
  const memoryEnabled = (event: any): boolean => groupPolicy(event)?.group_memory.enabled === true
  // Recall and dependency checks require the group switch; management commands opt out of that check.
  const authorize = async (event: any, text: string, messageId: string, signal: AbortSignal,
    refreshCurrentRole = true, freshAuthority = false, requireEnabled = true) => {
    if (!options.enabled() || event?.isGroup !== true) throw new GroupMemoryError('当前场景未启用群记忆。')
    const policy = groupPolicy(event)
    if (policy === null) throw new GroupMemoryError('无法核实当前群记忆开关状态，操作未执行。')
    if (requireEnabled && !policy.group_memory.enabled) {
      throw new GroupMemoryError('当前群记忆已由管理员关闭；群管理员可发送“#群记忆 开启”恢复。')
    }
    const accountId = String(event.self_id ?? event.bot?.uin ?? '')
    const now = options.now()
    const snapshot = await abortable(participants.resolve({ event, accountId, observedAt: now,
      refreshCurrentRole, freshAuthority,
      messageEvidence: { schemaVersion: 1, prompt: text, speakerText: text, imageUrls: [], currentMessageId: messageId,
        quotedMessageId: null, hasReply: false, replyResolved: true,
        currentSegmentCount: 1, replySegmentCount: 0, ocrTexts: [] } }, signal), signal)
    if (signal.aborted || snapshot?.scene.kind !== 'group' ||
      (refreshCurrentRole && snapshot.current.identity.roleStatus !== 'verified')) throw new GroupMemoryError('无法核实当前群生命周期或成员权限，群记忆操作未执行。')
    const scene = snapshot.scene
    const namespace = parseMemoryNamespaceV1({ schemaVersion: 1, botInstanceId: options.botInstanceId,
      adapter: 'qq', accountId, scope: { kind: 'group', groupId: scene.groupId,
        groupLifecycleId: scene.groupLifecycleId } })
    const namespaceRef = memoryNamespaceRefV1(namespace)
    const generation = Number(options.database.prepare('SELECT namespace_generation FROM namespaces WHERE namespace_ref = ?')
      .get(namespaceRef)?.namespace_generation ?? 1)
    const userId = snapshot.current.identity.userId
    const actorRef = `actor:${digest(`${options.botInstanceId}\0qq\0${accountId}\0${userId}`)}`
    const context = { schemaVersion: 1, botInstanceId: options.botInstanceId, adapter: 'qq', accountId,
      scene: { kind: 'group', groupId: scene.groupId, groupLifecycleId: scene.groupLifecycleId,
        trustedMemberUserIds: [userId], observedAt: now } }
    const access = issueMemoryAccessCapabilityV1(issuer, context, [namespace], now)
    // An ordinary message proves current membership, never administrative authority.
    const role = refreshCurrentRole ? snapshot.current.identity.groupRole : 'member'
    if (role === 'unknown') throw new GroupMemoryError('无法核实当前群成员角色。')
    const actions: readonly MemoryLifecycleActorActionV1[] = role === 'member' ? ['list_safe', 'propose_create']
      : role === 'owner' ? [...ADMIN_ACTIONS, 'delete_namespace', 'export', 'claim_export'] : ADMIN_ACTIONS
    const actor = issueMemoryLifecycleActorCapabilityV1(root, { schemaVersion: 1,
      botInstanceId: options.botInstanceId, adapter: 'qq', accountId, namespace, namespaceRef,
      sceneRef: access.sceneRef, generation, actorRef, actorUserId: userId,
      role: role === 'owner' ? 'group_owner' : role === 'admin' ? 'group_admin' : 'group_member',
      roleObservedAt: now, actions }, now)
    const identity = snapshot.current.identity
    const source = createMemorySourceV1({ sourceKind: 'current_message', messageId,
      actor: { userId, nickname: identity.nickname, groupCard: identity.groupCard,
        groupTitle: identity.groupTitle, groupRole: role, displayName: identity.displayName },
      scene: { kind: 'group', groupId: scene.groupId, groupLifecycleId: scene.groupLifecycleId, groupName: scene.groupName },
      normalizedText: boundedExcerpt(text), observedAt: now, resourceRefs: [] })
    return { namespace, namespaceRef, generation, accountId, now, actorRef, access, actor, source, role }
  }
  type Auth = Awaited<ReturnType<typeof authorize>>
  // One command may review several candidates, so the aggregate discriminates the command ref.
  const ref = (auth: Auth, op: string, aggregate = ''): string =>
    `command:${digest(`${auth.source.sourceId}\0${auth.access.sceneRef}\0${op}\0${aggregate}`)}`
  const controlBase = (auth: Auth) => ({ schemaVersion: 1, botInstanceId: options.botInstanceId,
    accountId: auth.accountId, sceneRef: auth.access.sceneRef, namespaceRef: auth.namespaceRef,
    generation: auth.generation, actorRef: auth.actorRef, access: auth.access, actor: auth.actor })
  const discard = (auth: Auth): void => {
    // Dropping buffered observations is best effort: a failure here must not change the command's outcome.
    try { options.discardObservedMessages?.(auth.accountId, auth.namespace.scope.kind === 'group' ? auth.namespace.scope.groupId : '') } catch { /* buffered messages stay until the next write rechecks policy */ }
  }
  const requireAdmin = (auth: Auth): void => {
    if (auth.role === 'member') throw new GroupMemoryError('只有当前群管理员或群主可以修改群记忆。')
  }
  const mutate = async (auth: Auth, operation: MemoryLifecycleCommandOperationV1,
    material: MemoryLifecycleCommandMaterialV1, before?: MemoryRevisionV2 | MemoryProposalV2,
    authority?: MemoryLifecycleEnvelopeAuthorityV1, aggregate = '') => {
    const command = createMemoryLifecycleCommandV1({ commandRef: ref(auth, operation, aggregate), operation,
      initiatedByActorRef: auth.actorRef, namespaceRef: auth.namespaceRef,
      expectedNamespaceGeneration: auth.generation,
      aggregateRef: before === undefined ? null : 'proposalId' in before ? before.proposalId : before.memoryId,
      expectedRevision: before?.revision ?? null,
      expectedAggregateHash: before === undefined ? null : 'consentTargetHash' in before ? before.consentTargetHash : before.revisionHash,
      occurredAt: auth.now,
      newValidUntil: operation === 'record.renew' && material !== null && 'kind' in material && material.kind === 'revision_change_v1'
        ? material.revision.record.retention.validUntil : null,
      newPurgeAt: operation === 'record.renew' && material !== null && 'kind' in material && material.kind === 'revision_change_v1'
        ? material.revision.record.retention.purgeAt : null, material })
    const result = await options.lifecycle.execute({ schemaVersion: 1, command, access: auth.access,
      authority: authority ?? { kind: 'actor', capability: auth.actor } })
    if (!['stored', 'unchanged', 'deletion_pending', 'deletion_complete'].includes(result.status)) {
      throw new GroupMemoryError(result.status === 'conflict' ? '群记忆已发生变化，请重新查看后再操作。' : '群记忆操作未完成，请核实权限、容量和有效期。')
    }
    // Canonical receipts remain truthful even if the derived index is temporarily unavailable.
    // Pending/rejected proposals do not change recallable heads; avoid rebuilding the full FTS graph.
    if (operation !== 'proposal.create' && operation !== 'proposal.reject') {
      try { await options.rebuildLexical() } catch {
        // The reply must still report the committed canonical write, but the drift is observable.
        try { options.onDerivedIndexFailure?.(operation) } catch {}
      }
    }
  }
  const records = async (auth: Auth, page: number) => {
    let cursor: string | null = null
    const chunk = Math.floor((page - 1) / 8)
    for (let index = 0; index <= chunk; index += 1) {
      const result = await options.control.execute({ ...controlBase(auth), operation: 'record.listSafe',
        cursor, limit: 64, maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes })
      if (result.status !== 'page' || result.operation !== 'record.listSafe') {
        throw new GroupMemoryError('群记忆列表暂时不可用。')
      }
      if (index === chunk) return result.records.slice(((page - 1) % 8) * 8, ((page - 1) % 8 + 1) * 8)
      if (result.nextCursor === null) return []
      cursor = result.nextCursor
    }
    return []
  }
  const revision = async (auth: Auth, selector: string): Promise<MemoryRevisionV2> => {
    if (!/^(?:memory:[0-9a-f]{64}|@[0-9a-f]{8})$/u.test(selector)) {
      throw new GroupMemoryError('请先查看列表并使用唯一的 @编号。')
    }
    const matches = options.database.prepare(`SELECT memory_id FROM heads
      WHERE namespace_ref = ? AND namespace_generation = ?
      AND (memory_id = ? OR substr(memory_id, -8) = ?) LIMIT 2`).all(
      auth.namespaceRef, auth.generation, selector, selector.startsWith('@') ? selector.slice(1) : '')
    if (matches.length !== 1) throw new GroupMemoryError('请先查看列表并使用唯一的 @编号。')
    const inspected = await options.control.execute({ ...controlBase(auth), operation: 'record.inspectGet',
      memoryId: String(matches[0]!.memory_id) })
    if (inspected.status !== 'found' || inspected.operation !== 'record.inspectGet' ||
      inspected.value.lifecycleState === 'purge_due') throw new GroupMemoryError('这条群记忆暂时不可修改。')
    const result = await options.control.execute({ ...controlBase(auth), operation: 'revision.get',
      memoryId: inspected.value.record.memoryId, revision: inspected.value.record.revision })
    if (result.status !== 'found' || result.operation !== 'revision.get') throw new GroupMemoryError('这条群记忆暂时不可修改。')
    return result.value
  }
  const cultureEnabled = (event: any): boolean => {
    const policy = groupPolicy(event)
    return policy?.group_memory.enabled === true && policy.group_culture.enabled
  }
  const statusText = (event: any): string => {
    const policy = groupPolicy(event)
    if (policy === null) return '当前群记忆状态暂时不可用。'
    const state = (feature: GroupMemoryFeatureV1) => policy[feature].enabled ? '已开启' : '已关闭'
    return `当前群记忆：${state('group_memory')}；群文化：${state('group_culture')}。\n` +
      '默认开启，群管理员可发送“#群记忆 关闭”或“#群文化 关闭”停止注入和新记录，关闭状态跨重启保留。'
  }
  const toggle = async (auth: Auth, feature: GroupMemoryFeatureV1, enabled: boolean, event: any): Promise<string> => {
    requireAdmin(auth)
    const result = options.policy.decide(policyScope(event), feature, enabled, auth.actorRef, auth.now)
    if (result.status === 'capacity') throw new GroupMemoryError('群记忆开关容量已满，操作未执行。')
    if (!enabled) discard(auth)
    const label = FEATURE_LABELS[feature]
    if (!enabled) {
      return `当前群的${label}已关闭，不再注入对话或记录新内容；已有内容保留，可用“#${label} 开启”恢复。`
    }
    return feature === 'group_culture' && !result.policy.group_memory.enabled
      ? '当前群的群文化已开启；群记忆仍处于关闭状态，需先发送“#群记忆 开启”才会生效。'
      : `当前群的${label}已开启。`
  }
  const requireWritable = (event: any): void => {
    if (!memoryEnabled(event)) {
      throw new GroupMemoryError('当前群记忆已由管理员关闭；群管理员可发送“#群记忆 开启”恢复。')
    }
  }
  const implicitApproval = (): boolean => {
    try { return options.implicitApprovalEnabled?.() ?? false } catch { return false }
  }
  const candidateRows = (auth: Auth, culture: boolean): readonly GroupMemoryCandidateRowV1[] =>
    listGroupMemoryCandidateRowsV1(options.database, auth.namespaceRef, auth.generation, Date.parse(auth.now))
      .filter(row => !culture || row.culture)
  /** Resolves `1`, a legacy `@3f9a1b2c` or `全部` against one ordered snapshot of the pending list. */
  const selectCandidates = (auth: Auth, body: string, culture: boolean): readonly GroupMemoryCandidateRowV1[] => {
    const rows = candidateRows(auth, culture)
    if (rows.length === 0) throw new GroupMemoryError('当前群没有待审核的候选。')
    const selectors = body.split(/\s+/u).filter(value => value !== '')
    if (selectors.length === 1 && (selectors[0] === '全部' || selectors[0] === '所有')) return rows
    if (selectors.length > rows.length) throw new GroupMemoryError('编号数量超出候选列表。')
    const picked = new Map<string, GroupMemoryCandidateRowV1>()
    for (const selector of selectors) {
      const legacy = /^@[0-9a-f]{8}$/u.exec(selector) === null ? []
        : rows.filter(row => row.proposalId.slice(-8) === selector.slice(1))
      const row = /^[1-9][0-9]?$/u.test(selector) ? rows.find(item => item.ordinal === Number(selector))
        : legacy.length === 1 ? legacy[0] : undefined
      if (row === undefined) throw new GroupMemoryError('请使用候选列表里的编号（1、2、3），或“全部”。')
      picked.set(row.proposalId, row)
    }
    return [...picked.values()]
  }
  const pendingProposal = async (auth: Auth, proposalId: string): Promise<MemoryProposalV2> => {
    const result = await options.control.execute({ ...controlBase(auth), operation: 'proposal.inspect', proposalId })
    if (result.status !== 'found' || result.operation !== 'proposal.inspect' ||
      result.effectiveState !== 'pending') throw new GroupMemoryError('候选不存在或已过期。')
    return result.value
  }
  const approveProposal = async (auth: Auth, proposal: MemoryProposalV2): Promise<void> => {
    // A member proposal still needs someone other than its proposer and its quoted speakers.
    // A model candidate has no self-nomination problem: its evidence is ordinary group chat and an
    // administrator may save the same sentence directly, so any current administrator can approve it.
    if (proposal.proposedBy.kind === 'user' &&
      (proposal.initiatedByActorRef === auth.actorRef ||
      proposal.sources.some(source => source.actor.userId === auth.source.actor.userId))) {
      throw new GroupMemoryError('该候选需要另一位当前管理员审核，不能自行通过。')
    }
    // One current description per subtype. Conflicting proposals stay pending until explicit correction/forget.
    if (cultureKindV1(proposal.text) !== null) {
      const rows = options.database.prepare(`SELECT p.revision_wire FROM heads h JOIN revision_payloads p
        ON p.namespace_ref = h.namespace_ref AND p.namespace_generation = h.namespace_generation
        AND p.memory_id = h.memory_id AND p.revision = h.current_revision
        WHERE h.namespace_ref = ? AND h.namespace_generation = ? AND h.valid_until_ms > ?
        AND json_extract(p.revision_wire, '$.record.kind') = 'group_culture' LIMIT 64`).all(
        auth.namespaceRef, auth.generation, Date.parse(auth.now))
      if (rows.some(row => cultureKindV1(JSON.parse(String(row.revision_wire)).record.text) === cultureKindV1(proposal.text))) {
        throw new GroupMemoryError('该类别已有文化描述，候选保持待审核。请明确更正或遗忘旧描述后再审核，不能覆盖。')
      }
    }
    const policyConsent = proposal.consentRequirement !== 'explicit'
    const approval = buildMemoryProposalApprovalBundleV1({ commandRef: ref(auth, 'proposal.approve', proposal.proposalId), operation: 'proposal.approve',
      namespaceRef: auth.namespaceRef, namespaceGeneration: auth.generation, proposal,
      approvedByActorRef: auth.actorRef, freshNow: auth.now,
      // Candidates created while the notice window is on carry `group_policy` consent, which admits
      // no message source; the administrator applies that policy early rather than granting consent.
      evidenceSource: policyConsent ? null : auth.source,
      reason: policyConsent ? '群管理员在公示期内确认自动候选' : null })
    await mutate(auth, 'proposal.approve', approval.consentEvidence, proposal, policyConsent
      ? { kind: 'policy', capability: issueGroupMemoryPolicyApprovalCapabilityV1(root, {
          proposal, namespace: auth.namespace, namespaceRef: auth.namespaceRef, generation: auth.generation,
          botInstanceId: options.botInstanceId, accountId: auth.accountId, sceneRef: auth.access.sceneRef,
          actorRef: auth.actorRef, actorUserId: auth.source.actor.userId, now: auth.now }) }
      : undefined, proposal.proposalId)
  }
  /** One command reviews several candidates; each outcome is echoed by text, never by ordinal alone. */
  const reviewCandidates = async (auth: Auth, body: string, approve: boolean, culture: boolean,
    event: any, reply: (text: string) => Promise<void>): Promise<void> => {
    requireAdmin(auth)
    const rows = selectCandidates(auth, body, culture)
    const done: string[] = []
    const failed: string[] = []
    let savedCulture = false
    for (const row of rows) {
      try {
        const proposal = await pendingProposal(auth, row.proposalId)
        if (!approve) {
          await mutate(auth, 'proposal.reject', null, proposal, undefined, proposal.proposalId)
        } else {
          requireWritable(event)
          if (row.culture && !cultureEnabled(event)) {
            throw new GroupMemoryError('当前群文化已由管理员关闭；群管理员可发送“#群文化 开启”后再审核文化候选。')
          }
          await approveProposal(auth, proposal)
          savedCulture = savedCulture || row.culture
        }
        done.push(`${row.culture ? '[文化] ' : ''}${proposal.text}`)
      } catch (error) {
        failed.push(`${row.ordinal}. ${error instanceof GroupMemoryError ? error.message : '操作未完成。'}`)
      }
    }
    const verb = approve ? '已保存' : '已拒绝'
    const lines = done.length === 0 ? [] : [`${verb} ${done.length} 条：`, ...done]
    if (savedCulture) lines.push('文化描述仅作参考，不代表全群共识或群规则。')
    if (failed.length > 0) lines.push(`${done.length === 0 ? '' : '\n'}未处理 ${failed.length} 条：`, ...failed)
    await reply(lines.join('\n'))
  }

  const cultureCommand = async (auth: Auth, body: string, event: any,
    reply: (text: string) => Promise<void>): Promise<boolean> => {
    let match = /^提议\s+(主题偏好|语言约定|梗说明)\s+([\s\S]+)$/u.exec(body)
    if (match !== null) {
      const kind = (Object.keys(CULTURE_LABELS) as CultureKindV1[]).find(k => CULTURE_LABELS[k] === match![1])!
      const text = groupMemoryTextV1(`本群${CULTURE_LABELS[kind]}：${groupMemoryTextV1(match[2]!)}`)
      if (/^(?:本群|我们群|群内|全群)(?:禁止|不允许|要求)/u.test(match[2]!)) throw new GroupMemoryError('文化提案保存描述，群规则请使用群记忆命令。')
      // Descriptions enter pending, never automatic approval or a claim of consensus.
      const proposal = buildMemoryProposalDraftV2({ commandRef: ref(auth, 'proposal.create'), operation: 'proposal.create',
        namespaceRef: auth.namespaceRef, namespaceGeneration: auth.generation, initiatedByActorRef: auth.actorRef,
        namespace: auth.namespace, proposedBy: { kind: 'user', actorRef: auth.actorRef }, intent: { kind: 'create' },
        kind: 'group_culture', text, sources: [auth.source], observedAt: auth.now, proposedAt: auth.now,
        confidence: 0.5, sensitivity: 'group', conflict: { state: 'none', relatedMemoryIds: [], note: null },
        customTtlDays: CULTURE_TTL_DAYS[kind], consentRequirement: 'explicit', consentPolicyRef: null, consentPolicyGeneration: null })
      await mutate(auth, 'proposal.create', proposal)
      await reply('已提交文化候选，待另一位管理员审核；发送“#群文化 候选”查看编号。尚未保存为可召回记忆，也不代表群共识。')
      return true
    }
    if (body === '候选') {
      requireAdmin(auth)
      const items = candidateRows(auth, true).map(row => groupMemoryCandidateLineV1(row, implicitApproval()))
      await reply(items.length === 0 ? '当前群没有文化候选。'
        : `当前群文化候选（编号与“#群记忆 候选”一致；[自动] 来自群聊，仅供审核）：\n${items.join('\n')}\n` +
          '审核：#群文化 通过 1 3 / #群文化 拒绝 全部')
      return true
    }
    match = /^(通过|拒绝)\s+([\s\S]+)$/u.exec(body)
    if (match !== null) {
      await reviewCandidates(auth, match[2]!, match[1] === '通过', true, event, reply)
      return true
    }
    return false
  }
  const commands: PersonalMemoryCommandPortV1 = Object.freeze({
    async handle (request: PersonalMemoryCommandRequestV1): Promise<boolean> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      try {
        if (!/^#群(?:记忆|文化)(?:\s|$)/u.test(request.text)) return false
        const isCulture = /^#群文化(?:\s|$)/u.test(request.text)
        if (isCulture && ((request.event as any)?.source || (request.event as any)?.message?.some?.((segment: any) =>
          ['reply', 'forward', 'image', 'json', 'xml', 'record', 'video'].includes(segment.type)))) {
          throw new GroupMemoryError('文化提案仅接受当前发言的纯文字，不接受引用、转发或媒体。')
        }
        const event = request.event as any
        const messageId = String(event?.message_id ?? '')
        if (!/^[\x21-\x7e]{1,128}$/u.test(messageId)) throw new GroupMemoryError('无法核实当前消息编号。')
        const body = request.text.replace(/^#群(?:记忆|文化)\s*/u, '').trim()
        if (body === '状态') {
          if (!options.enabled() || event?.isGroup !== true) throw new GroupMemoryError('当前场景未启用群记忆。')
          await request.replyText(statusText(event))
          return true
        }
        if (body === '开启' || body === '关闭') {
          const auth = await authorize(event, request.text, messageId, controller.signal, true, false, false)
          await request.replyText(await toggle(auth, isCulture ? 'group_culture' : 'group_memory', body === '开启', event))
          return true
        }
        const auth = await authorize(event, request.text, messageId, controller.signal, true, false, false)
        if (isCulture && !cultureEnabled(event)) {
          throw new GroupMemoryError('当前群文化或群记忆已由管理员关闭；群管理员可发送“#群文化 开启”或“#群记忆 开启”恢复。')
        }
        if (isCulture && await cultureCommand(auth, body, event, request.replyText)) return true
        if (isCulture && !/^(?:列表|更正|续期|遗忘|帮助|状态|$)/u.test(body)) {
          await request.replyText('群文化命令：提议 <主题偏好|语言约定|梗说明> <本群…>；候选；通过/拒绝 <编号…|全部>；列表；更正/续期/遗忘 @编号；状态；开启/关闭（群管理员）。仅文字描述，不代表群共识。')
          return true
        }
        if (body === '帮助' || body === '') {
          await request.replyText(isCulture ? '群文化：提议 <主题偏好|语言约定|梗说明> <本群…>；候选；通过/拒绝 <编号…|全部>。已保存的描述可用列表、更正、续期、遗忘管理；群管理员可开启/关闭，默认开启；不代表群共识。' : HELP)
        } else if (/^列表(?:\s+[1-9][0-9]{0,2})?$/u.test(body)) {
          const page = Number(body.split(/\s+/u)[1] ?? 1)
          if (page > MEMORY_RESOURCE_LIMITS.namespaceActiveRecords / 8) throw new GroupMemoryError('群记忆页码超出范围。')
          let items = await records(auth, page)
          if (isCulture) {
            const culture = []
            let cursor: string | null = null
            for (let index = 0; index < Math.ceil(MEMORY_RESOURCE_LIMITS.namespaceActiveRecords / 64); index += 1) {
              const result = await options.control.execute({ ...controlBase(auth), operation: 'record.listSafe',
                cursor, limit: 64, maxWireBytes: MEMORY_RESOURCE_LIMITS.listPageWireBytes })
              if (result.status !== 'page' || result.operation !== 'record.listSafe') throw new GroupMemoryError('文化列表暂时不可用。')
              culture.push(...result.records.filter(record => record.kind === 'group_culture'))
              if (result.nextCursor === null) break
              cursor = result.nextCursor
            }
            items = culture.slice((page - 1) * 8, page * 8)
          }
          await request.replyText(items.length === 0 ? (page === 1 ? '当前群还没有群记忆。' : '这一页没有群记忆。') :
            `当前群记忆（第 ${page} 页）：\n${items.map(r => `@${r.memoryId.slice(-8)} [${r.kind}] ${[...r.text].slice(0, 120).join('')}`).join('\n')}`)
        } else if (body === '导出') {
          if (auth.role !== 'owner') throw new GroupMemoryError('只有当前群主可以导出群记忆。')
          const execute = async (operation: 'export.prepare' | 'export.generate' | 'export.claimDelivery',
            exportId: string | null, expectedManifestHash: string | null) => await options.export.execute({
            schemaVersion: 1, access: auth.access, actor: auth.actor,
            command: createMemoryExportCommandV1({ commandRef: ref(auth, operation), operation,
              initiatedByActorRef: auth.actorRef, namespaceRef: auth.namespaceRef,
              expectedNamespaceGeneration: auth.generation, exportId, expectedManifestHash,
              retryOfExportId: null, expectedSnapshotSha256: null, occurredAt: auth.now }) })
          const prepared = await execute('export.prepare', null, null)
          if (prepared.status !== 'prepared') throw new GroupMemoryError('群记忆导出暂时不可用。')
          const generated = await execute('export.generate', prepared.exportId, memoryExportStableResultHashV1(prepared))
          if (generated.status !== 'deliverable') throw new GroupMemoryError('群记忆导出暂时不可用。')
          const claimed = await execute('export.claimDelivery', generated.exportId, memoryExportStableResultHashV1(generated))
          if (claimed.status !== 'delivery_claimed') throw new GroupMemoryError('群记忆导出暂时不可用。')
          const sent = await options.exportDelivery.redeemAndSend(claimed.handle, request.sendPrivateFile)
          await request.replyText(sent === 'delivered' ? '群记忆已私发导出。导出不包含聊天日志。' : '群记忆文件未送达，请稍后重试。')
        } else if (body === '删除全部 确认') {
          if (auth.role !== 'owner') throw new GroupMemoryError('只有当前群主可以删除全部群记忆。')
          await mutate(auth, 'namespace.delete', null)
          discard(auth)
          const complete = await options.completeNamespaceDeletion(auth.namespace)
          await request.replyText(complete ? '当前群记忆已全部删除，正文与检索索引已清理。' : '当前群记忆已停止召回，正文清理尚未完成。')
        } else if (body === '删除全部') {
          await request.replyText('群主确认删除时请发送“#群记忆 删除全部 确认”。')
        } else {
          requireAdmin(auth)
          let match = /^记住\s+(规则|共同偏好|文化|群体事实)\s+([\s\S]+)$/u.exec(body)
          const review = /^(通过|拒绝)\s+([\s\S]+)$/u.exec(body)
          if (body === '候选') {
            // One list for both kinds: administrators no longer have to check 群记忆 and 群文化 separately.
            const items = candidateRows(auth, false).map(row => groupMemoryCandidateLineV1(row, implicitApproval()))
            await request.replyText(items.length === 0 ? '当前群没有待审核的候选。'
              : `当前群待审候选（[自动] 来自群聊，模型生成不代表群共识；通过后才会召回）：\n${items.join('\n')}\n` +
                '审核：#群记忆 通过 1 3 / #群记忆 通过 全部 / #群记忆 拒绝 全部')
          } else if (review !== null) {
            await reviewCandidates(auth, review[2]!, review[1] === '通过', false, event, request.replyText)
          } else if (match !== null) {
            requireWritable(event)
            const text = groupMemoryTextV1(match[2]!)
            if (cultureKindV1(text) !== null) throw new GroupMemoryError('分类文化描述请使用群文化提议并由另一位管理员审核。')
            const kind: MemoryKindV1 = match[1] === '规则' ? 'group_rule' :
              match[1] === '文化' || match[1] === '共同偏好' ? 'group_culture' : 'other'
            const commandRef = ref(auth, 'proposal.create')
            const proposal = buildMemoryProposalDraftV2({ commandRef, operation: 'proposal.create',
              namespaceRef: auth.namespaceRef, namespaceGeneration: auth.generation, initiatedByActorRef: auth.actorRef,
              namespace: auth.namespace, proposedBy: { kind: 'user', actorRef: auth.actorRef }, intent: { kind: 'create' },
              kind, text, sources: [auth.source], observedAt: auth.now, proposedAt: auth.now, confidence: 1,
              sensitivity: 'group', conflict: { state: 'none', relatedMemoryIds: [], note: null }, customTtlDays: null,
              consentRequirement: 'explicit', consentPolicyRef: null, consentPolicyGeneration: null })
            await mutate(auth, 'proposal.create', proposal)
            const approval = buildMemoryProposalApprovalBundleV1({ commandRef: ref(auth, 'proposal.approve'),
              operation: 'proposal.approve', namespaceRef: auth.namespaceRef, namespaceGeneration: auth.generation,
              proposal, approvedByActorRef: auth.actorRef, freshNow: auth.now, evidenceSource: auth.source, reason: null })
            await mutate(auth, 'proposal.approve', approval.consentEvidence, proposal)
            await request.replyText(`已保存当前群记忆：${text}`)
          } else if ((match = /^更正\s+(\S+)\s+([\s\S]+)$/u.exec(body)) !== null) {
            requireWritable(event)
            const text = groupMemoryTextV1(match[2]!)
            const before = await revision(auth, match[1]!)
            if (isCulture && before.record.kind !== 'group_culture') throw new GroupMemoryError('群文化命令只能修改文化描述。')
            if (cultureKindV1(before.record.text) !== null && cultureKindV1(text) !== cultureKindV1(before.record.text)) throw new GroupMemoryError('更正分类文化描述时请保留原类别前缀。')
            await mutate(auth, 'record.correct', buildMemoryCorrectionBundleV1({ commandRef: ref(auth, 'record.correct'),
              operation: 'record.correct', namespaceRef: auth.namespaceRef, namespaceGeneration: auth.generation,
              beforeRevision: before, changedByActorRef: auth.actorRef, freshNow: auth.now, text, confidence: 1,
              validity: before.record.validity, conflict: before.record.conflict, supersedes: before.record.supersedes,
              evidenceKind: 'explicit', evidenceSource: auth.source, policyRef: null, policyGeneration: null,
              reason: '群管理员更正群记忆' }), before)
            await request.replyText('当前群记忆已更正。')
          } else if ((match = /^续期\s+(\S+)(?:\s+([0-9]+))?$/u.exec(body)) !== null) {
            requireWritable(event)
            const days = Number(match[2] ?? 30)
            if (!Number.isSafeInteger(days) || days < 1 || days > 1825) throw new GroupMemoryError('续期天数必须为 1 到 1825。')
            const before = await revision(auth, match[1]!)
            if (isCulture && before.record.kind !== 'group_culture') throw new GroupMemoryError('群文化命令只能修改文化描述。')
            await mutate(auth, 'record.renew', buildMemoryRenewalBundleV1({ commandRef: ref(auth, 'record.renew'),
              operation: 'record.renew', namespaceRef: auth.namespaceRef, namespaceGeneration: auth.generation,
              beforeRevision: before, changedByActorRef: auth.actorRef, freshNow: auth.now,
              newValidUntil: new Date(Math.min(Date.parse(before.record.retention.validUntil) + days * 86400000,
                Date.parse(auth.now) + 1825 * 86400000)).toISOString(),
              evidenceKind: 'explicit', evidenceSource: auth.source, policyRef: null, policyGeneration: null,
              reason: '群管理员续期群记忆' }), before)
            await request.replyText('当前群记忆已续期。')
          } else if ((match = /^遗忘\s+(\S+)$/u.exec(body)) !== null) {
            const before = await revision(auth, match[1]!)
            if (isCulture && before.record.kind !== 'group_culture') throw new GroupMemoryError('群文化命令只能遗忘文化描述。')
            await mutate(auth, 'record.forget', null, before)
            await request.replyText('已遗忘当前群的这条记忆。')
          } else await request.replyText(HELP)
        }
        return true
      } catch (error) {
        await request.replyText(error instanceof GroupMemoryError ? error.message : '群记忆操作暂时不可用。')
        return true
      } finally { clearTimeout(timer) }
    }
  })
  return Object.freeze({ commands,
    /** Live policy view for authority stamps; null when the policy store is unreadable. */
    policy: groupPolicy,
    async recall (input: YunzaiPersonalMemoryRecallInputV1, callerSignal?: AbortSignal): Promise<MemoryRetrievalResultV2> {
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(callerSignal?.reason)
      callerSignal?.addEventListener('abort', onAbort, { once: true })
      if (callerSignal?.aborted) onAbort()
      const requestedAt = options.now()
      const timeoutMs = input.freshAuthority === true ? 2_000 : options.recallTimeoutMs()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const auth = await authorize(input.event, input.queryText,
          input.messageEvidence.currentMessageId ?? 'group-memory-recall', controller.signal, false, input.freshAuthority === true)
        // The issued capability must not appear to come from the future when authorization crosses a clock tick.
        const retrievalAt = auth.now
        const retrievalMs = Math.min(500, options.recallTimeoutMs())
        const deadlineAt = new Date(Date.parse(input.freshAuthority === true ? retrievalAt : requestedAt) + retrievalMs).toISOString()
        if (Date.parse(deadlineAt) <= Date.parse(retrievalAt)) return { schemaVersion: 2, status: 'unavailable', reason: 'deadline_exceeded' }
        const request = parseMemoryRetrievalRequestV2({ schemaVersion: 2, capability: auth.access,
          subjects: [{ namespaceRef: auth.namespaceRef, reason: 'current_actor' }],
          query: { text: input.queryText, languageHint: null },
          limits: options.recallLimits(), requestedAt: retrievalAt,
          deadlineAt })
        if (input.dependencyCheck !== undefined) {
          if (!cultureEnabled(input.event)) {
            for (const dependency of input.dependencyCheck) {
              const row = options.database.prepare(`SELECT revision_wire FROM revision_payloads WHERE namespace_ref = ? AND namespace_generation = ? AND memory_id = ? AND revision = ?`).get(
                auth.namespaceRef, auth.generation, dependency.memoryId, dependency.revision)
              if (row !== undefined) {
                const record = JSON.parse(String(row.revision_wire)).record
                if (record.kind === 'group_culture' && cultureKindV1(record.text) !== null) return { schemaVersion: 2, status: 'unavailable', reason: 'policy_unavailable' }
              }
            }
          }
          if (!await validateCanonicalMemoryDependencies(options.database, request, input.dependencyCheck, controller.signal)) return { schemaVersion: 2, status: 'unavailable', reason: 'canonical_unavailable' }
          return { schemaVersion: 2, status: 'completed', mode: 'none', candidates: [], index: { lexical: 'disabled', vector: 'disabled', watermark: null } }
        }
        const result = await retrieveMemoryV2(options.retriever, request, { signal: controller.signal })
        if (result.status !== 'completed' || cultureEnabled(input.event)) return result
        return { ...result, candidates: result.candidates.filter(c => c.kind !== 'group_culture' || cultureKindV1(c.text) === null) }
      } catch {
        return { schemaVersion: 2, status: 'unavailable', reason: 'policy_unavailable' }
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', onAbort)
      }
    }
  })
}

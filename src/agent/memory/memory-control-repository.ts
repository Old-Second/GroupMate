import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  memoryAccessCapabilityAllowsV1,
  type MemoryAccessCapabilityV1
} from './memory-access-gate.js'
import {
  memoryLifecycleActorCapabilityAllowsV1,
  memoryLifecycleActorCapabilityRoleV1,
  type MemoryLifecycleActorActionV1,
  type MemoryLifecycleActorAuthorityRequirementV1,
  type MemoryLifecycleActorCapabilityV1
} from './memory-lifecycle-authority.js'
import {
  projectMemoryProposalLifecycleV2,
  projectMemoryRecordLifecycleV2
} from './memory-lifecycle-builder.js'
import { memoryLifecycleCommandRefHashV1 } from './memory-lifecycle-command.js'
import {
  parseDeletionMutationReceiptV1,
  parseDeletionStatusV1,
  parseMemoryLifecycleAuditV1,
  parseMemoryLifecycleHashV1,
  parseMemoryLifecycleHashedRefV1,
  parseMemoryLifecycleInstantV1,
  parseMemoryProposalV2,
  parseMemoryRecordV2,
  parseMemoryRevisionV2,
  type DeletionMutationReceiptV1,
  type DeletionStatusV1,
  type MemoryLifecycleAuditV1,
  type MemoryProposalV2,
  type MemoryRecordV2,
  type MemoryRevisionV2
} from './memory-lifecycle-domain.js'
import {
  parseMemoryTombstoneV1,
  type MemoryKindV1,
  type MemorySensitivityV1,
  type MemoryValidityV1
} from './memory-domain.js'
import {
  inspectMemoryArray,
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryBotInstanceIdV1,
  parseMemoryNamespaceRefV1,
  parseMemoryQqIdV1,
  type MemoryNamespaceRefV1
} from './memory-namespace.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import {
  MEMORY_RESOURCE_LIMITS,
  memoryTextWithinLimits
} from './memory-resource-limits.js'

type MemoryProposalStateV2 = MemoryProposalV2['state']

export type MemoryProposalEffectiveStateV1 = MemoryProposalStateV2 | 'expired_due'

export interface MemoryProposalSafeProjectionV1 {
  readonly schemaVersion: 1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly proposalId: string
  readonly revision: number
  readonly state: MemoryProposalStateV2
  readonly effectiveState: MemoryProposalEffectiveStateV1
  readonly intentKind: 'create' | 'correction'
  readonly plannedMemoryId: string
  readonly kind: MemoryKindV1
  readonly sensitivity: MemorySensitivityV1
  readonly proposedAt: string
  readonly deadlineAt: string
  readonly validUntil: string
  readonly approvalCutoff: string
}

export interface MemoryRecordSafeProjectionV1 {
  readonly schemaVersion: 1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly revision: number
  readonly lifecycleState: 'current'
  readonly kind: MemoryKindV1
  readonly text: string
  readonly validity: MemoryValidityV1
  readonly confidence: number
  readonly sensitivity: MemorySensitivityV1
  readonly updatedAt: string
  readonly sourceCount: number
  readonly validUntil: string
  readonly purgeAt: string
}

export interface MemoryTombstoneControlProjectionV1 {
  readonly schemaVersion: 1
  readonly tombstoneId: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string | null
  readonly deletedRevision: number | null
  readonly deletionKind: 'memory_forgotten' | 'namespace_deleted'
  readonly deletedAt: string
  readonly receiptHash: string
  readonly expiresAt: string
}

export interface MemoryRevisionHistoryCursorAnchorV1 {
  readonly schemaVersion: 1
  readonly revision: number
  readonly revisionHash: string
}

export interface MemoryRevisionHistoryCursorInputV1 {
  readonly schemaVersion: 1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly anchor: MemoryRevisionHistoryCursorAnchorV1
}

interface MemoryRevisionHeadProofBaseV1 {
  readonly schemaVersion: 1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly namespaceGeneration: number
  readonly memoryId: string
  readonly headRevision: number
  readonly validUntil: string
  readonly purgeAt: string
}

export type MemoryRevisionHeadProofV1 =
  | MemoryRevisionHeadProofBaseV1 & {
      readonly lifecycleState: 'current' | 'expired'
      readonly headRevisionHash: string
    }
  | MemoryRevisionHeadProofBaseV1 & {
      readonly lifecycleState: 'purge_due'
    }

export type MemoryRecordControlProjectionV1 =
  | {
      readonly schemaVersion: 1
      readonly lifecycleState: 'current' | 'expired'
      readonly record: MemoryRecordV2
    }
  | {
      readonly schemaVersion: 1
      readonly lifecycleState: 'purge_due'
      readonly namespaceRef: MemoryNamespaceRefV1
      readonly namespaceGeneration: number
      readonly memoryId: string
      readonly revision: number
      readonly validUntil: string
      readonly purgeAt: string
    }

export interface MemoryControlGlobalUsageV1 {
  readonly schemaVersion: 1
  readonly namespaceRecords: number
  readonly pendingProposalRecords: number
  readonly activeMemoryRecords: number
  readonly retainedRevisionRecords: number
  readonly tombstoneRecords: number
  readonly lifecycleAuditRecords: number
  readonly lifecycleAuditReservedRecords: number
  readonly lifecycleCommandRecords: number
  readonly deletionCheckpointRecords: number
  readonly exportJobRecords: number
  readonly canonicalLogicalBytes: number
  readonly pendingOutboxRecords: number
  readonly outboxLogicalBytes: number
  readonly lifecycleAuditLogicalBytes: number
  readonly lifecycleAuditReservedBytes: number
  readonly lifecycleCommandLogicalBytes: number
  readonly deletionCheckpointLogicalBytes: number
  readonly exportJobLogicalBytes: number
}

export interface MemoryControlRepositoryAuthorizationV1 {
  readonly botInstanceId: string
  readonly accountId: string
  readonly sceneRef: string
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
  readonly actorRef: string
  readonly access: MemoryAccessCapabilityV1
  readonly actor: MemoryLifecycleActorCapabilityV1
}

interface MemoryControlRequestBaseV1 extends MemoryControlRepositoryAuthorizationV1 {
  readonly schemaVersion: 1
}

interface MemoryControlPageRequestV1 {
  readonly cursor: string | null
  readonly limit: number
  readonly maxWireBytes: number
}

export type MemoryControlRepositoryRequestV1 =
  | MemoryControlRequestBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'proposal.list'
      readonly states?: readonly MemoryProposalStateV2[]
    }
  | MemoryControlRequestBaseV1 & {
      readonly operation: 'proposal.inspect'
      readonly proposalId: string
    }
  | MemoryControlRequestBaseV1 & {
      readonly operation: 'record.inspectGet'
      readonly memoryId: string
    }
  | MemoryControlRequestBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'record.inspectList'
    }
  | MemoryControlRequestBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'record.listSafe'
    }
  | MemoryControlRequestBaseV1 & {
      readonly operation: 'revision.get'
      readonly memoryId: string
      readonly revision: number
    }
  | MemoryControlRequestBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'revision.list'
      readonly memoryId: string
      readonly cursorAnchor: MemoryRevisionHistoryCursorAnchorV1 | null
    }
  | MemoryControlRequestBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'tombstone.list'
      readonly targetGeneration?: number
    }
  | MemoryControlRequestBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'audit.list'
      readonly targetGeneration?: number
    }
  | MemoryControlRequestBaseV1 & {
      readonly operation: 'deletion.getStatus'
      readonly deletionRef: string
    }
  | MemoryControlRequestBaseV1 & {
      readonly operation: 'deletion.resolve'
      readonly deletionRef: string
      readonly commandRef: string
    }
  | MemoryControlRequestBaseV1 & {
      readonly operation: 'usage.getGlobal'
    }

interface MemoryControlAdapterBaseV1 {
  readonly schemaVersion: 1
  readonly namespaceRef: MemoryNamespaceRefV1
  readonly generation: number
}

export type MemoryControlRepositoryAdapterRequestV1 =
  | MemoryControlAdapterBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'proposal.list'
      readonly states: readonly MemoryProposalStateV2[]
    }
  | MemoryControlAdapterBaseV1 & {
      readonly operation: 'proposal.inspect'
      readonly proposalId: string
    }
  | MemoryControlAdapterBaseV1 & {
      readonly operation: 'record.inspectGet'
      readonly memoryId: string
    }
  | MemoryControlAdapterBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'record.inspectList'
    }
  | MemoryControlAdapterBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'record.listSafe'
    }
  | MemoryControlAdapterBaseV1 & {
      readonly operation: 'revision.get'
      readonly memoryId: string
      readonly revision: number
    }
  | MemoryControlAdapterBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'revision.list'
      readonly memoryId: string
      readonly cursorAnchor: MemoryRevisionHistoryCursorAnchorV1 | null
    }
  | MemoryControlAdapterBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'tombstone.list'
      readonly targetGeneration: number
    }
  | MemoryControlAdapterBaseV1 & MemoryControlPageRequestV1 & {
      readonly operation: 'audit.list'
      readonly targetGeneration: number
    }
  | MemoryControlAdapterBaseV1 & {
      readonly operation: 'deletion.getStatus'
      readonly deletionRef: string
    }
  | MemoryControlAdapterBaseV1 & {
      readonly operation: 'deletion.resolve'
      readonly deletionRef: string
      readonly commandRef: string
    }
  | MemoryControlAdapterBaseV1 & {
      readonly operation: 'usage.getGlobal'
    }

/**
 * Process-local only. Task 5 adapters must revalidate this exact authorization after acquiring
 * BEGIN IMMEDIATE and freezing the transaction's trusted high-water. It has no codec or log form.
 */
export interface MemoryControlRepositoryAdapterEnvelopeV1 {
  readonly schemaVersion: 1
  readonly request: MemoryControlRepositoryAdapterRequestV1
  readonly authorization: MemoryControlRepositoryAuthorizationV1
}

interface MemoryControlPageResultBaseV1<
  Operation extends MemoryControlRepositoryAdapterRequestV1['operation'],
  RecordValue
> {
  readonly status: 'page'
  readonly operation: Operation
  readonly snapshotAt: string
  readonly records: readonly RecordValue[]
  readonly nextCursor: string | null
  readonly wireBytes: number
  readonly corruptRecords: number
  readonly corruptRefs: readonly string[]
}

type MemoryControlExactOperationV1 =
  | 'proposal.inspect'
  | 'record.inspectGet'
  | 'revision.get'
  | 'deletion.getStatus'
  | 'deletion.resolve'

type MemoryControlListOperationV1 =
  | 'proposal.list'
  | 'record.listSafe'
  | 'record.inspectList'
  | 'revision.list'
  | 'tombstone.list'
  | 'audit.list'

export type MemoryControlRepositoryResultV1 =
  | MemoryControlPageResultBaseV1<'proposal.list', MemoryProposalSafeProjectionV1>
  | MemoryControlPageResultBaseV1<'record.listSafe', MemoryRecordSafeProjectionV1>
  | MemoryControlPageResultBaseV1<'record.inspectList', MemoryRecordControlProjectionV1>
  | MemoryControlPageResultBaseV1<'revision.list', MemoryRevisionV2> & {
      readonly head: Extract<MemoryRevisionHeadProofV1, { lifecycleState: 'current' | 'expired' }>
      readonly nextCursorAnchor: MemoryRevisionHistoryCursorAnchorV1 | null
    }
  | MemoryControlPageResultBaseV1<'tombstone.list', MemoryTombstoneControlProjectionV1>
  | MemoryControlPageResultBaseV1<'audit.list', MemoryLifecycleAuditV1>
  | {
      readonly status: 'found'
      readonly operation: 'proposal.inspect'
      readonly snapshotAt: string
      readonly value: MemoryProposalV2
      readonly effectiveState: MemoryProposalEffectiveStateV1
    }
  | {
      readonly status: 'found'
      readonly operation: 'record.inspectGet'
      readonly snapshotAt: string
      readonly value: MemoryRecordControlProjectionV1
    }
  | {
      readonly status: 'found'
      readonly operation: 'revision.get'
      readonly snapshotAt: string
      readonly value: MemoryRevisionV2
      readonly head: Extract<MemoryRevisionHeadProofV1, { lifecycleState: 'current' | 'expired' }>
    }
  | {
      readonly status: 'found'
      readonly operation: 'deletion.getStatus'
      readonly snapshotAt: string
      readonly value: DeletionStatusV1
    }
  | {
      readonly status: 'resolved'
      readonly operation: 'deletion.resolve'
      readonly snapshotAt: string
      readonly receipt: DeletionMutationReceiptV1
      readonly deletionStatus: DeletionStatusV1
    }
  | {
      readonly status: 'usage'
      readonly operation: 'usage.getGlobal'
      readonly snapshotAt: string
      readonly value: MemoryControlGlobalUsageV1
    }
  | {
      readonly status: 'not_found'
      readonly operation: MemoryControlExactOperationV1
      readonly snapshotAt: string
    }
  | {
      readonly status: 'record_purge_due'
      readonly operation: 'revision.get' | 'revision.list'
      readonly snapshotAt: string
      readonly head: Extract<MemoryRevisionHeadProofV1, { lifecycleState: 'purge_due' }>
    }
  | { readonly status: 'invalid_cursor'; readonly operation: MemoryControlListOperationV1 }
  | { readonly status: 'denied'; readonly category: 'access' | 'authority' }
  | { readonly status: 'corrupt'; readonly category: 'canonical_data' | 'adapter_contract' }
  | {
      readonly status: 'unavailable'
      readonly category: 'busy' | 'storage' | 'io'
      readonly retryable: boolean
    }
  | { readonly status: 'aborted' }

export interface MemoryControlRepositoryPortV1 {
  readonly execute: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryControlRepositoryResultV1>
}

export interface MemoryControlRepositoryAdapterV1 {
  /**
   * Canonical SQLite only. Time-sensitive reads must acquire BEGIN IMMEDIATE,
   * freeze a trusted high-water, and complete projection/query in that same transaction.
   */
  readonly execute: (
    envelope: MemoryControlRepositoryAdapterEnvelopeV1,
    signal?: AbortSignal
  ) => Promise<unknown>
}

export interface CreateMemoryControlRepositoryPortOptionsV1 {
  readonly now: () => string
  readonly execute: MemoryControlRepositoryAdapterV1['execute']
}

const OPERATIONS = Object.freeze([
  'proposal.list', 'proposal.inspect', 'record.listSafe', 'record.inspectGet', 'record.inspectList',
  'revision.get', 'revision.list', 'tombstone.list', 'audit.list',
  'deletion.getStatus', 'deletion.resolve', 'usage.getGlobal'
] as const)
const LIST_OPERATIONS = new Set<MemoryControlListOperationV1>([
  'proposal.list', 'record.listSafe', 'record.inspectList', 'revision.list', 'tombstone.list',
  'audit.list'
])
const PROPOSAL_STATES = Object.freeze([
  'pending', 'approved', 'rejected', 'withdrawn', 'expired'
] as const satisfies readonly MemoryProposalStateV2[])
const MEMORY_KINDS = Object.freeze([
  'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
  'task_fact', 'other'
] as const satisfies readonly MemoryKindV1[])
const MEMORY_SENSITIVITIES = Object.freeze([
  'public', 'group', 'personal', 'sensitive'
] as const satisfies readonly MemorySensitivityV1[])
const GROUP_SAFE_MEMORY_KINDS = new Set<MemoryKindV1>([
  'group_rule', 'group_culture', 'task_fact', 'other'
])
const REQUEST_AUTH_FIELDS = Object.freeze([
  'botInstanceId', 'accountId', 'sceneRef', 'namespaceRef', 'generation', 'actorRef',
  'access', 'actor'
])
const REQUEST_OPERATION_FIELDS = Object.freeze([
  'states', 'proposalId', 'memoryId', 'revision', 'cursor', 'limit', 'maxWireBytes',
  'deletionRef', 'commandRef', 'targetGeneration', 'cursorAnchor'
])
const RESULT_FIELDS = Object.freeze([
  'operation', 'snapshotAt', 'records', 'nextCursor', 'wireBytes', 'corruptRecords',
  'corruptRefs', 'value', 'effectiveState', 'receipt', 'deletionStatus', 'category',
  'retryable', 'head', 'nextCursorAnchor'
])
const CURSOR_PATTERN = /^memory-control-cursor:v1:[0-9a-f]{64}$/
const SCENE_REF_PATTERN = /^[0-9a-f]{64}$/
const REVISION_CURSOR_HASH_DOMAIN_V1 = 'groupmate.memory.control-revision-cursor.v1'
const ABORTED_RESULT = Object.freeze({ status: 'aborted' as const })
const DENIED_ACCESS_RESULT = Object.freeze({ status: 'denied' as const, category: 'access' as const })
const DENIED_AUTHORITY_RESULT = Object.freeze({
  status: 'denied' as const,
  category: 'authority' as const
})
const ADAPTER_CONTRACT_RESULT = Object.freeze({
  status: 'corrupt' as const,
  category: 'adapter_contract' as const
})
const ADAPTER_IO_RESULT = Object.freeze({
  status: 'unavailable' as const,
  category: 'io' as const,
  retryable: true
})

function enumValue<T extends string> (value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalidMemoryValue()
  return value as T
}

function positiveInteger (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum || Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function nonnegativeInteger (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function sceneRef (value: unknown): string {
  if (typeof value !== 'string' || !SCENE_REF_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function cursor (value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) return invalidMemoryValue()
  return value
}

function actorRef (value: unknown): string {
  return parseMemoryLifecycleHashedRefV1(value, 'actor:')
}

function proposalRef (value: unknown): string {
  return parseMemoryLifecycleHashedRefV1(value, 'proposal:')
}

function memoryRef (value: unknown): string {
  return parseMemoryLifecycleHashedRefV1(value, 'memory:')
}

function deletionRef (value: unknown): string {
  return parseMemoryLifecycleHashedRefV1(value, 'deletion:')
}

function commandRef (value: unknown): string {
  return parseMemoryLifecycleHashedRefV1(value, 'command:')
}

function parseRevisionCursorAnchor (value: unknown): MemoryRevisionHistoryCursorAnchorV1 {
  const input = inspectMemoryRecord(value, ['schemaVersion', 'revision', 'revisionHash'])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions),
    revisionHash: parseMemoryLifecycleHashV1(input.revisionHash)
  })
}

export function memoryRevisionHistoryCursorV1 (
  value: unknown
): string {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'anchor'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const canonical = Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    namespaceGeneration: positiveInteger(input.namespaceGeneration),
    memoryId: memoryRef(input.memoryId),
    anchor: parseRevisionCursorAnchor(input.anchor)
  })
  const digest = createHash('sha256')
    .update(REVISION_CURSOR_HASH_DOMAIN_V1, 'utf8')
    .update('\0')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
  return `memory-control-cursor:v1:${digest}`
}

function parseRevisionCursorBinding (
  cursorValue: string | null,
  anchorValue: unknown,
  namespaceRef: MemoryNamespaceRefV1,
  namespaceGeneration: number,
  memoryId: string
): MemoryRevisionHistoryCursorAnchorV1 | null {
  if (cursorValue === null) {
    if (anchorValue !== null) return invalidMemoryValue()
    return null
  }
  if (anchorValue === null) return invalidMemoryValue()
  const anchor = parseRevisionCursorAnchor(anchorValue)
  if (memoryRevisionHistoryCursorV1({
    schemaVersion: 1,
    namespaceRef,
    namespaceGeneration,
    memoryId,
    anchor
  }) !== cursorValue) return invalidMemoryValue()
  return anchor
}

function parsePageFields (
  input: Readonly<Record<string, unknown>>,
  maximumRecords: number = MEMORY_RESOURCE_LIMITS.listPageRecords
): MemoryControlPageRequestV1 {
  return Object.freeze({
    cursor: cursor(input.cursor),
    limit: positiveInteger(input.limit, maximumRecords),
    maxWireBytes: positiveInteger(input.maxWireBytes, MEMORY_RESOURCE_LIMITS.listPageWireBytes)
  })
}

function parseAuthorization (
  input: Readonly<Record<string, unknown>>
): MemoryControlRepositoryAuthorizationV1 {
  if (input.access === null || typeof input.access !== 'object' ||
    utilTypes.isProxy(input.access) || input.actor === null || typeof input.actor !== 'object' ||
    utilTypes.isProxy(input.actor)) return invalidMemoryValue()
  return Object.freeze({
    botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
    accountId: parseMemoryQqIdV1(input.accountId),
    sceneRef: sceneRef(input.sceneRef),
    namespaceRef: parseMemoryNamespaceRefV1(input.namespaceRef),
    generation: positiveInteger(input.generation),
    actorRef: actorRef(input.actorRef),
    access: input.access as MemoryAccessCapabilityV1,
    actor: input.actor as MemoryLifecycleActorCapabilityV1
  })
}

function parseProposalStates (value: unknown): readonly MemoryProposalStateV2[] {
  if (value === undefined) return Object.freeze(['pending'] as const)
  const parsed = inspectMemoryArray(value, PROPOSAL_STATES.length)
    .map(item => enumValue(item, PROPOSAL_STATES))
  if (parsed.length === 0 || new Set(parsed).size !== parsed.length) return invalidMemoryValue()
  parsed.sort((left, right) => PROPOSAL_STATES.indexOf(left) - PROPOSAL_STATES.indexOf(right))
  return Object.freeze(parsed)
}

interface ParsedControlRequestV1 {
  readonly authorization: MemoryControlRepositoryAuthorizationV1
  readonly adapterRequest: MemoryControlRepositoryAdapterRequestV1
}

function parseRequest (value: unknown): ParsedControlRequestV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['schemaVersion', 'operation', ...REQUEST_AUTH_FIELDS],
    REQUEST_OPERATION_FIELDS
  )
  if (discriminator.schemaVersion !== 1) return invalidMemoryValue()
  const operation = enumValue(discriminator.operation, OPERATIONS)
  const common = ['schemaVersion', 'operation', ...REQUEST_AUTH_FIELDS]
  let input: Readonly<Record<string, unknown>>
  let operationFields: Readonly<Record<string, unknown>>
  if (operation === 'proposal.list') {
    input = inspectMemoryRecord(
      value,
      [...common, 'cursor', 'limit', 'maxWireBytes'],
      ['states']
    )
    operationFields = { ...parsePageFields(input), states: parseProposalStates(input.states) }
  } else if (operation === 'proposal.inspect') {
    input = inspectMemoryRecord(value, [...common, 'proposalId'])
    operationFields = { proposalId: proposalRef(input.proposalId) }
  } else if (operation === 'record.inspectGet') {
    input = inspectMemoryRecord(value, [...common, 'memoryId'])
    operationFields = { memoryId: memoryRef(input.memoryId) }
  } else if (operation === 'record.inspectList' || operation === 'record.listSafe') {
    input = inspectMemoryRecord(value, [...common, 'cursor', 'limit', 'maxWireBytes'])
    operationFields = { ...parsePageFields(input) }
  } else if (operation === 'tombstone.list' || operation === 'audit.list') {
    input = inspectMemoryRecord(
      value,
      [...common, 'cursor', 'limit', 'maxWireBytes'],
      ['targetGeneration']
    )
    const authorization = parseAuthorization(input)
    const targetGeneration = input.targetGeneration === undefined
      ? authorization.generation
      : positiveInteger(input.targetGeneration, authorization.generation)
    operationFields = { ...parsePageFields(input), targetGeneration }
  } else if (operation === 'revision.get') {
    input = inspectMemoryRecord(value, [...common, 'memoryId', 'revision'])
    operationFields = {
      memoryId: memoryRef(input.memoryId),
      revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions)
    }
  } else if (operation === 'revision.list') {
    input = inspectMemoryRecord(value, [
      ...common, 'memoryId', 'cursor', 'cursorAnchor', 'limit', 'maxWireBytes'
    ])
    const authorization = parseAuthorization(input)
    const memoryId = memoryRef(input.memoryId)
    const page = parsePageFields(input, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions)
    operationFields = {
      memoryId,
      ...page,
      cursorAnchor: parseRevisionCursorBinding(
        page.cursor,
        input.cursorAnchor,
        authorization.namespaceRef,
        authorization.generation,
        memoryId
      )
    }
  } else if (operation === 'deletion.getStatus') {
    input = inspectMemoryRecord(value, [...common, 'deletionRef'])
    operationFields = { deletionRef: deletionRef(input.deletionRef) }
  } else if (operation === 'deletion.resolve') {
    input = inspectMemoryRecord(value, [...common, 'deletionRef', 'commandRef'])
    operationFields = {
      deletionRef: deletionRef(input.deletionRef),
      commandRef: commandRef(input.commandRef)
    }
  } else {
    input = inspectMemoryRecord(value, common)
    operationFields = {}
  }
  const authorization = parseAuthorization(input)
  const adapterRequest = Object.freeze({
    schemaVersion: 1 as const,
    operation,
    namespaceRef: authorization.namespaceRef,
    generation: authorization.generation,
    ...operationFields
  }) as MemoryControlRepositoryAdapterRequestV1
  return Object.freeze({ authorization, adapterRequest })
}

function actionForRequest (
  request: MemoryControlRepositoryAdapterRequestV1
): MemoryLifecycleActorActionV1 {
  if (request.operation === 'record.listSafe') return 'list_safe'
  if (request.operation === 'deletion.getStatus' || request.operation === 'deletion.resolve' ||
    ((request.operation === 'tombstone.list' || request.operation === 'audit.list') &&
      request.targetGeneration < request.generation)) {
    return 'resolve_deletion'
  }
  return 'inspect_full'
}

function requiredAuthority (
  action: MemoryLifecycleActorActionV1,
  role: ReturnType<typeof memoryLifecycleActorCapabilityRoleV1>
): MemoryLifecycleActorAuthorityRequirementV1 {
  if (action === 'list_safe') return 'safe'
  if (action === 'resolve_deletion') {
    return role === 'personal_bot_master' ? 'delete_only' : 'elevated'
  }
  return 'ordinary'
}

function authorizationDenial (
  parsed: ParsedControlRequestV1,
  now: string
): MemoryControlRepositoryResultV1 | null {
  const { authorization, adapterRequest } = parsed
  if (!memoryAccessCapabilityAllowsV1(
    authorization.access,
    authorization.namespaceRef,
    now
  )) return DENIED_ACCESS_RESULT
  const access = authorization.access
  if (access.botInstanceId !== authorization.botInstanceId ||
    access.accountId !== authorization.accountId || access.sceneRef !== authorization.sceneRef) {
    return DENIED_ACCESS_RESULT
  }
  const role = memoryLifecycleActorCapabilityRoleV1(authorization.actor)
  if (role === null) return DENIED_AUTHORITY_RESULT
  const action = actionForRequest(adapterRequest)
  if (!memoryLifecycleActorCapabilityAllowsV1(authorization.actor, {
    botInstanceId: authorization.botInstanceId,
    accountId: authorization.accountId,
    sceneRef: authorization.sceneRef,
    namespaceRef: authorization.namespaceRef,
    generation: authorization.generation,
    actorRef: authorization.actorRef,
    action,
    requiredAuthority: requiredAuthority(action, role)
  }, now)) return DENIED_AUTHORITY_RESULT
  if (adapterRequest.operation === 'usage.getGlobal' && role !== 'group_bot_master') {
    return DENIED_AUTHORITY_RESULT
  }
  return null
}

function canonicalPageBytes (
  records: readonly unknown[],
  corruptRefs: readonly string[],
  metadata: Readonly<Record<string, unknown>> = {}
): number {
  return Buffer.byteLength(JSON.stringify({ records, corruptRefs, ...metadata }), 'utf8')
}

function parseSnapshotAt (value: unknown): string {
  return parseMemoryLifecycleInstantV1(value)
}

function parseProposalSafeProjection (
  value: unknown,
  snapshotAt: string,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, { operation: 'proposal.list' }>
): MemoryProposalSafeProjectionV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'proposalId', 'revision', 'state',
    'effectiveState', 'intentKind', 'plannedMemoryId', 'kind', 'sensitivity', 'proposedAt',
    'deadlineAt', 'validUntil', 'approvalCutoff'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  const namespaceGeneration = positiveInteger(input.namespaceGeneration)
  if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation) {
    return invalidMemoryValue()
  }
  const state = enumValue(input.state, PROPOSAL_STATES)
  if (!request.states.includes(state)) return invalidMemoryValue()
  const revision = positiveInteger(input.revision, 2)
  if ((state === 'pending' && revision !== 1) || (state !== 'pending' && revision !== 2)) {
    return invalidMemoryValue()
  }
  const proposedAt = parseMemoryLifecycleInstantV1(input.proposedAt)
  const deadlineAt = parseMemoryLifecycleInstantV1(input.deadlineAt)
  const validUntil = parseMemoryLifecycleInstantV1(input.validUntil)
  const approvalCutoff = parseMemoryLifecycleInstantV1(input.approvalCutoff)
  const expectedDeadlineMs = Date.parse(proposedAt) + 7 * 24 * 60 * 60 * 1_000
  if (!Number.isSafeInteger(expectedDeadlineMs) ||
    new Date(expectedDeadlineMs).toISOString() !== deadlineAt) return invalidMemoryValue()
  const expectedApprovalCutoff = Date.parse(deadlineAt) <= Date.parse(validUntil)
    ? deadlineAt
    : validUntil
  if (Date.parse(validUntil) <= Date.parse(proposedAt) ||
    approvalCutoff !== expectedApprovalCutoff) return invalidMemoryValue()
  const effectiveState = enumValue(input.effectiveState, [
    ...PROPOSAL_STATES, 'expired_due'
  ] as const)
  const expectedEffective = state === 'pending' &&
    Date.parse(snapshotAt) >= Date.parse(approvalCutoff)
    ? 'expired_due'
    : state
  if (effectiveState !== expectedEffective) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef,
    namespaceGeneration,
    proposalId: proposalRef(input.proposalId),
    revision,
    state,
    effectiveState,
    intentKind: enumValue(input.intentKind, ['create', 'correction'] as const),
    plannedMemoryId: memoryRef(input.plannedMemoryId),
    kind: enumValue(input.kind, MEMORY_KINDS),
    sensitivity: enumValue(input.sensitivity, MEMORY_SENSITIVITIES),
    proposedAt,
    deadlineAt,
    validUntil,
    approvalCutoff
  })
}

function assertProposalOldestFirst (records: readonly MemoryProposalSafeProjectionV1[]): void {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!
    const current = records[index]!
    if (previous.proposedAt > current.proposedAt ||
      (previous.proposedAt === current.proposedAt && previous.proposalId >= current.proposalId)) {
      return invalidMemoryValue()
    }
  }
}

function parseRecordProjection (
  value: unknown,
  snapshotAt: string,
  request: MemoryControlRepositoryAdapterRequestV1
): MemoryRecordControlProjectionV1 {
  const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'lifecycleState'], [
    'record', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'revision', 'validUntil',
    'purgeAt'
  ])
  if (discriminator.schemaVersion !== 1) return invalidMemoryValue()
  const lifecycleState = enumValue(
    discriminator.lifecycleState,
    ['current', 'expired', 'purge_due'] as const
  )
  if (lifecycleState !== 'purge_due') {
    const input = inspectMemoryRecord(value, ['schemaVersion', 'lifecycleState', 'record'])
    const record = parseMemoryRecordV2(input.record)
    if (record.namespaceRef !== request.namespaceRef ||
      record.namespaceGeneration !== request.generation ||
      (request.operation === 'record.inspectGet' && record.memoryId !== request.memoryId) ||
      projectMemoryRecordLifecycleV2(record, snapshotAt).state !== lifecycleState) {
      return invalidMemoryValue()
    }
    return Object.freeze({ schemaVersion: 1 as const, lifecycleState, record })
  }
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'lifecycleState', 'namespaceRef', 'namespaceGeneration', 'memoryId',
    'revision', 'validUntil', 'purgeAt'
  ])
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  const namespaceGeneration = positiveInteger(input.namespaceGeneration)
  const memoryId = memoryRef(input.memoryId)
  const validUntil = parseMemoryLifecycleInstantV1(input.validUntil)
  const purgeAt = parseMemoryLifecycleInstantV1(input.purgeAt)
  if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation ||
    (request.operation === 'record.inspectGet' && memoryId !== request.memoryId) ||
    Date.parse(purgeAt) - Date.parse(validUntil) !==
      MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs ||
    Date.parse(snapshotAt) < Date.parse(purgeAt)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    lifecycleState,
    namespaceRef,
    namespaceGeneration,
    memoryId,
    revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions),
    validUntil,
    purgeAt
  })
}

function parseSafeValidity (value: unknown, updatedAt: string): MemoryValidityV1 {
  const input = inspectMemoryRecord(value, ['state', 'validFrom'])
  const state = enumValue(input.state, ['current', 'uncertain', 'superseded'] as const)
  const validFrom = input.validFrom === null
    ? null
    : parseMemoryLifecycleInstantV1(input.validFrom)
  if ((state === 'uncertain' && validFrom !== null) ||
    (state !== 'uncertain' && validFrom === null) ||
    (validFrom !== null && Date.parse(validFrom) > Date.parse(updatedAt))) {
    return invalidMemoryValue()
  }
  return Object.freeze({ state, validFrom })
}

function parseSafeText (value: unknown): string {
  if (typeof value !== 'string' || value.includes('\r') || !memoryTextWithinLimits(value) ||
    !/[\p{L}\p{N}\p{P}\p{S}]/u.test(value)) return invalidMemoryValue()
  return value
}

function parseSafeConfidence (value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) ||
    value < 0 || value > 1) return invalidMemoryValue()
  return value
}

function parseRecordSafeProjection (
  value: unknown,
  snapshotAt: string,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, { operation: 'record.listSafe' }>
): MemoryRecordSafeProjectionV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'revision',
    'lifecycleState', 'kind', 'text', 'validity', 'confidence', 'sensitivity', 'updatedAt',
    'sourceCount', 'validUntil', 'purgeAt'
  ])
  if (input.schemaVersion !== 1 || input.lifecycleState !== 'current') {
    return invalidMemoryValue()
  }
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  const namespaceGeneration = positiveInteger(input.namespaceGeneration)
  const validUntil = parseMemoryLifecycleInstantV1(input.validUntil)
  const purgeAt = parseMemoryLifecycleInstantV1(input.purgeAt)
  const updatedAt = parseMemoryLifecycleInstantV1(input.updatedAt)
  if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation ||
    Date.parse(snapshotAt) >= Date.parse(validUntil) ||
    Date.parse(purgeAt) - Date.parse(validUntil) !== MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs ||
    Date.parse(updatedAt) > Date.parse(snapshotAt)) return invalidMemoryValue()
  const kind = enumValue(input.kind, MEMORY_KINDS)
  const sensitivity = enumValue(input.sensitivity, MEMORY_SENSITIVITIES)
  if (!GROUP_SAFE_MEMORY_KINDS.has(kind) || !['public', 'group'].includes(sensitivity)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    namespaceRef,
    namespaceGeneration,
    memoryId: memoryRef(input.memoryId),
    revision: positiveInteger(input.revision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions),
    lifecycleState: 'current' as const,
    kind,
    text: parseSafeText(input.text),
    validity: parseSafeValidity(input.validity, updatedAt),
    confidence: parseSafeConfidence(input.confidence),
    sensitivity,
    updatedAt,
    sourceCount: positiveInteger(input.sourceCount, MEMORY_RESOURCE_LIMITS.sources),
    validUntil,
    purgeAt
  })
}

function parseTombstoneControlProjection (
  value: unknown,
  snapshotAt: string,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, { operation: 'tombstone.list' }>
): MemoryTombstoneControlProjectionV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'tombstoneId', 'namespaceRef', 'namespaceGeneration', 'memoryId',
    'deletedRevision', 'deletionKind', 'deletedAt', 'deletedByActorRef', 'reasonCode',
    'receiptHash', 'expiresAt'
  ])
  const tombstone = parseMemoryTombstoneV1(input)
  const memoryId = tombstone.memoryId === null ? null : memoryRef(tombstone.memoryId)
  const deletedRevision = tombstone.deletedRevision === null
    ? null
    : positiveInteger(tombstone.deletedRevision, MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions)
  const namespaceRef = parseMemoryNamespaceRefV1(tombstone.namespaceRef)
  const namespaceGeneration = positiveInteger(tombstone.namespaceGeneration)
  const deletedAt = parseMemoryLifecycleInstantV1(tombstone.deletedAt)
  const expiresAt = parseMemoryLifecycleInstantV1(tombstone.expiresAt)
  if (namespaceRef !== request.namespaceRef ||
    namespaceGeneration !== request.targetGeneration ||
    Date.parse(deletedAt) > Date.parse(snapshotAt)) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    tombstoneId: parseMemoryLifecycleHashedRefV1(tombstone.tombstoneId, 'tombstone:'),
    namespaceRef,
    namespaceGeneration,
    memoryId,
    deletedRevision,
    deletionKind: tombstone.deletionKind,
    deletedAt,
    receiptHash: parseMemoryLifecycleHashV1(tombstone.receiptHash),
    expiresAt
  })
}

function parseRevisionHeadProof (
  value: unknown,
  snapshotAt: string,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, {
    operation: 'revision.get' | 'revision.list'
  }>
): MemoryRevisionHeadProofV1 {
  const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'lifecycleState'], [
    'namespaceRef', 'namespaceGeneration', 'memoryId', 'headRevision', 'headRevisionHash',
    'validUntil', 'purgeAt'
  ])
  if (discriminator.schemaVersion !== 1) return invalidMemoryValue()
  const lifecycleState = enumValue(
    discriminator.lifecycleState,
    ['current', 'expired', 'purge_due'] as const
  )
  const fields = [
    'schemaVersion', 'namespaceRef', 'namespaceGeneration', 'memoryId', 'headRevision',
    'lifecycleState', 'validUntil', 'purgeAt'
  ]
  const input = lifecycleState === 'purge_due'
    ? inspectMemoryRecord(value, fields)
    : inspectMemoryRecord(value, [...fields, 'headRevisionHash'])
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  const namespaceGeneration = positiveInteger(input.namespaceGeneration)
  const memoryId = memoryRef(input.memoryId)
  const headRevision = positiveInteger(
    input.headRevision,
    MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions
  )
  const validUntil = parseMemoryLifecycleInstantV1(input.validUntil)
  const purgeAt = parseMemoryLifecycleInstantV1(input.purgeAt)
  const expectedState = Date.parse(snapshotAt) < Date.parse(validUntil)
    ? 'current' as const
    : Date.parse(snapshotAt) < Date.parse(purgeAt)
      ? 'expired' as const
      : 'purge_due' as const
  if (namespaceRef !== request.namespaceRef || namespaceGeneration !== request.generation ||
    memoryId !== request.memoryId || lifecycleState !== expectedState ||
    Date.parse(purgeAt) - Date.parse(validUntil) !==
      MEMORY_RESOURCE_LIMITS.tombstoneRetentionMs) return invalidMemoryValue()
  const common = {
    schemaVersion: 1 as const,
    namespaceRef,
    namespaceGeneration,
    memoryId,
    headRevision,
    validUntil,
    purgeAt
  }
  if (lifecycleState === 'purge_due') {
    return Object.freeze({ ...common, lifecycleState: 'purge_due' as const })
  }
  return Object.freeze({
    ...common,
    lifecycleState,
    headRevisionHash: parseMemoryLifecycleHashV1(input.headRevisionHash)
  })
}

function parseOpaqueCorruptRef (
  value: unknown,
  operation: MemoryControlListOperationV1
): string {
  if (operation === 'proposal.list') return proposalRef(value)
  if (operation === 'record.inspectList' || operation === 'record.listSafe') {
    return memoryRef(value)
  }
  if (operation === 'tombstone.list') {
    return parseMemoryLifecycleHashedRefV1(value, 'tombstone:')
  }
  if (operation === 'audit.list') return parseMemoryLifecycleHashedRefV1(value, 'audit:')
  return invalidMemoryValue()
}

function parseCommonPage (
  value: unknown,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, { cursor: string | null }>
): {
    readonly input: Readonly<Record<string, unknown>>
    readonly snapshotAt: string
    readonly nextCursor: string | null
    readonly corruptRecords: number
    readonly corruptRefs: readonly string[]
  } {
  const fields = [
    'status', 'operation', 'snapshotAt', 'records', 'nextCursor', 'wireBytes',
    'corruptRecords', 'corruptRefs'
  ]
  const input = request.operation === 'revision.list'
    ? inspectMemoryRecord(value, [...fields, 'head', 'nextCursorAnchor'])
    : inspectMemoryRecord(value, fields)
  if (input.status !== 'page' || input.operation !== request.operation) {
    return invalidMemoryValue()
  }
  const snapshotAt = parseSnapshotAt(input.snapshotAt)
  const nextCursor = cursor(input.nextCursor)
  if (nextCursor !== null && nextCursor === request.cursor) return invalidMemoryValue()
  const corruptRecords = nonnegativeInteger(input.corruptRecords)
  const corruptRefs = request.operation === 'revision.list'
    ? inspectMemoryArray(input.corruptRefs, 0).map(() => invalidMemoryValue())
    : inspectMemoryArray(input.corruptRefs, request.limit)
      .map(item => parseOpaqueCorruptRef(item, request.operation))
  if (corruptRefs.length !== corruptRecords) return invalidMemoryValue()
  if (new Set(corruptRefs).size !== corruptRefs.length) return invalidMemoryValue()
  return Object.freeze({
    input,
    snapshotAt,
    nextCursor,
    corruptRecords,
    corruptRefs: Object.freeze(corruptRefs)
  })
}

function parsePageResult (
  value: unknown,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, { cursor: string | null }>
): MemoryControlRepositoryResultV1 {
  const common = parseCommonPage(value, request)
  let records: readonly unknown[]
  let revisionHead: Extract<MemoryRevisionHeadProofV1, {
    lifecycleState: 'current' | 'expired'
  }> | undefined
  let nextCursorAnchor: MemoryRevisionHistoryCursorAnchorV1 | null | undefined
  if (request.operation === 'proposal.list') {
    const parsed = inspectMemoryArray(common.input.records, request.limit)
      .map(item => parseProposalSafeProjection(item, common.snapshotAt, request))
    assertProposalOldestFirst(parsed)
    records = Object.freeze(parsed)
  } else if (request.operation === 'record.listSafe') {
    const parsed = inspectMemoryArray(common.input.records, request.limit)
      .map(item => parseRecordSafeProjection(item, common.snapshotAt, request))
    for (let index = 1; index < parsed.length; index += 1) {
      if (parsed[index - 1]!.memoryId >= parsed[index]!.memoryId) return invalidMemoryValue()
    }
    records = Object.freeze(parsed)
  } else if (request.operation === 'record.inspectList') {
    const parsed = inspectMemoryArray(common.input.records, request.limit)
      .map(item => parseRecordProjection(item, common.snapshotAt, request))
    for (let index = 1; index < parsed.length; index += 1) {
      const previous = parsed[index - 1]!
      const current = parsed[index]!
      const previousId = previous.lifecycleState === 'purge_due'
        ? previous.memoryId
        : previous.record.memoryId
      const currentId = current.lifecycleState === 'purge_due'
        ? current.memoryId
        : current.record.memoryId
      if (previousId >= currentId) return invalidMemoryValue()
    }
    records = Object.freeze(parsed)
  } else if (request.operation === 'revision.list') {
    const parsedHead = parseRevisionHeadProof(common.input.head, common.snapshotAt, request)
    if (parsedHead.lifecycleState === 'purge_due') return invalidMemoryValue()
    revisionHead = parsedHead
    nextCursorAnchor = common.input.nextCursorAnchor === null
      ? null
      : parseRevisionCursorAnchor(common.input.nextCursorAnchor)
    const parsed = inspectMemoryArray(common.input.records, request.limit)
      .map(parseMemoryRevisionV2)
    let priorRevision = request.cursorAnchor?.revision ?? 0
    let priorRevisionHash: string | null = request.cursorAnchor?.revisionHash ?? null
    if (priorRevision > revisionHead.headRevision ||
      (priorRevision === revisionHead.headRevision &&
        priorRevisionHash !== revisionHead.headRevisionHash)) return invalidMemoryValue()
    for (let index = 0; index < parsed.length; index += 1) {
      const revision = parsed[index]!
      if (revision.record.namespaceRef !== request.namespaceRef ||
        revision.record.namespaceGeneration !== request.generation ||
        revision.memoryId !== request.memoryId ||
        revision.revision !== priorRevision + 1 ||
        revision.previousRevisionHash !== priorRevisionHash) {
        return invalidMemoryValue()
      }
      priorRevision = revision.revision
      priorRevisionHash = revision.revisionHash
    }
    if (common.nextCursor === null) {
      if (nextCursorAnchor !== null || priorRevision !== revisionHead.headRevision ||
        priorRevisionHash !== revisionHead.headRevisionHash) return invalidMemoryValue()
    } else {
      const last = parsed.at(-1)
      if (last === undefined || nextCursorAnchor === null ||
        nextCursorAnchor.revision !== last.revision ||
        nextCursorAnchor.revisionHash !== last.revisionHash ||
        last.revision >= revisionHead.headRevision ||
        common.nextCursor !== memoryRevisionHistoryCursorV1({
          schemaVersion: 1,
          namespaceRef: request.namespaceRef,
          namespaceGeneration: request.generation,
          memoryId: request.memoryId,
          anchor: nextCursorAnchor
        })) return invalidMemoryValue()
    }
    const finalRevision = parsed.at(-1)
    if (finalRevision?.revision === revisionHead.headRevision && (
      finalRevision.revisionHash !== revisionHead.headRevisionHash ||
      finalRevision.record.retention.validUntil !== revisionHead.validUntil ||
      finalRevision.record.retention.purgeAt !== revisionHead.purgeAt
    )) {
      return invalidMemoryValue()
    }
    records = Object.freeze(parsed)
  } else if (request.operation === 'tombstone.list') {
    const parsed = inspectMemoryArray(common.input.records, request.limit)
      .map(item => parseTombstoneControlProjection(item, common.snapshotAt, request))
    for (let index = 1; index < parsed.length; index += 1) {
      const previous = parsed[index - 1]!
      const current = parsed[index]!
      if (previous.deletedAt > current.deletedAt ||
        (previous.deletedAt === current.deletedAt && previous.tombstoneId >= current.tombstoneId)) {
        return invalidMemoryValue()
      }
    }
    records = Object.freeze(parsed)
  } else {
    const parsed = inspectMemoryArray(common.input.records, request.limit)
      .map(parseMemoryLifecycleAuditV1)
    if (parsed.some(item => item.namespaceRef !== request.namespaceRef ||
      item.namespaceGeneration !== request.targetGeneration)) return invalidMemoryValue()
    for (let index = 1; index < parsed.length; index += 1) {
      const previous = parsed[index - 1]!
      const current = parsed[index]!
      if (previous.recordedAt > current.recordedAt ||
        (previous.recordedAt === current.recordedAt && previous.auditId >= current.auditId)) {
        return invalidMemoryValue()
      }
    }
    records = Object.freeze(parsed)
  }
  if (records.length + common.corruptRecords > request.limit) return invalidMemoryValue()
  const aggregateRefs = records.map(record => {
    if (request.operation === 'proposal.list') {
      return (record as MemoryProposalSafeProjectionV1).proposalId
    }
    if (request.operation === 'record.listSafe') {
      return (record as MemoryRecordSafeProjectionV1).memoryId
    }
    if (request.operation === 'record.inspectList') {
      const projection = record as MemoryRecordControlProjectionV1
      return projection.lifecycleState === 'purge_due'
        ? projection.memoryId
        : projection.record.memoryId
    }
    if (request.operation === 'revision.list') {
      return `${(record as MemoryRevisionV2).memoryId}:${(record as MemoryRevisionV2).revision}`
    }
    if (request.operation === 'tombstone.list') {
      return (record as MemoryTombstoneControlProjectionV1).tombstoneId
    }
    return (record as MemoryLifecycleAuditV1).auditId
  })
  if (new Set(aggregateRefs).size !== aggregateRefs.length ||
    common.corruptRefs.some(ref => aggregateRefs.includes(ref)) ||
    (records.length + common.corruptRecords === 0 && common.nextCursor !== null)) {
    return invalidMemoryValue()
  }
  const wireBytes = positiveInteger(common.input.wireBytes)
  const revisionMetadata = revisionHead === undefined
    ? {}
    : { head: revisionHead, nextCursorAnchor }
  const actualBytes = canonicalPageBytes(records, common.corruptRefs, revisionMetadata)
  if (wireBytes !== actualBytes || wireBytes > request.maxWireBytes ||
    wireBytes > MEMORY_RESOURCE_LIMITS.listPageWireBytes) return invalidMemoryValue()
  return deepFreeze({
    status: 'page' as const,
    operation: request.operation,
    snapshotAt: common.snapshotAt,
    records,
    nextCursor: common.nextCursor,
    wireBytes,
    corruptRecords: common.corruptRecords,
    corruptRefs: common.corruptRefs,
    ...revisionMetadata
  }) as MemoryControlRepositoryResultV1
}

function parseGlobalUsage (value: unknown): MemoryControlGlobalUsageV1 {
  const fields = [
    'namespaceRecords', 'pendingProposalRecords', 'activeMemoryRecords',
    'retainedRevisionRecords', 'tombstoneRecords', 'lifecycleAuditRecords',
    'lifecycleAuditReservedRecords', 'lifecycleCommandRecords', 'deletionCheckpointRecords',
    'exportJobRecords', 'canonicalLogicalBytes', 'pendingOutboxRecords',
    'outboxLogicalBytes', 'lifecycleAuditLogicalBytes', 'lifecycleAuditReservedBytes',
    'lifecycleCommandLogicalBytes', 'deletionCheckpointLogicalBytes', 'exportJobLogicalBytes'
  ] as const
  const input = inspectMemoryRecord(value, ['schemaVersion', ...fields])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    namespaceRecords: nonnegativeInteger(input.namespaceRecords),
    pendingProposalRecords: nonnegativeInteger(input.pendingProposalRecords),
    activeMemoryRecords: nonnegativeInteger(input.activeMemoryRecords),
    retainedRevisionRecords: nonnegativeInteger(input.retainedRevisionRecords),
    tombstoneRecords: nonnegativeInteger(input.tombstoneRecords),
    lifecycleAuditRecords: nonnegativeInteger(input.lifecycleAuditRecords),
    lifecycleAuditReservedRecords: nonnegativeInteger(input.lifecycleAuditReservedRecords),
    lifecycleCommandRecords: nonnegativeInteger(input.lifecycleCommandRecords),
    deletionCheckpointRecords: nonnegativeInteger(input.deletionCheckpointRecords),
    exportJobRecords: nonnegativeInteger(input.exportJobRecords),
    canonicalLogicalBytes: nonnegativeInteger(input.canonicalLogicalBytes),
    pendingOutboxRecords: nonnegativeInteger(input.pendingOutboxRecords),
    outboxLogicalBytes: nonnegativeInteger(input.outboxLogicalBytes),
    lifecycleAuditLogicalBytes: nonnegativeInteger(input.lifecycleAuditLogicalBytes),
    lifecycleAuditReservedBytes: nonnegativeInteger(input.lifecycleAuditReservedBytes),
    lifecycleCommandLogicalBytes: nonnegativeInteger(input.lifecycleCommandLogicalBytes),
    deletionCheckpointLogicalBytes: nonnegativeInteger(input.deletionCheckpointLogicalBytes),
    exportJobLogicalBytes: nonnegativeInteger(input.exportJobLogicalBytes)
  })
}

function parseFoundResult (
  value: unknown,
  request: Exclude<MemoryControlRepositoryAdapterRequestV1, { cursor: string | null }>
): MemoryControlRepositoryResultV1 {
  if (request.operation === 'proposal.inspect') {
    const input = inspectMemoryRecord(value, [
      'status', 'operation', 'snapshotAt', 'value', 'effectiveState'
    ])
    if (input.status !== 'found' || input.operation !== request.operation) {
      return invalidMemoryValue()
    }
    const snapshotAt = parseSnapshotAt(input.snapshotAt)
    const proposal = parseMemoryProposalV2(input.value)
    const projection = projectMemoryProposalLifecycleV2(proposal, snapshotAt)
    if (proposal.namespaceRef !== request.namespaceRef ||
      proposal.namespaceGeneration !== request.generation ||
      proposal.proposalId !== request.proposalId ||
      input.effectiveState !== projection.logicalState || !projection.fullWireReadable) {
      return invalidMemoryValue()
    }
    return deepFreeze({
      status: 'found' as const,
      operation: request.operation,
      snapshotAt,
      value: proposal,
      effectiveState: projection.logicalState
    })
  }
  if (request.operation === 'record.inspectGet') {
    const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value'])
    if (input.status !== 'found' || input.operation !== request.operation) {
      return invalidMemoryValue()
    }
    const snapshotAt = parseSnapshotAt(input.snapshotAt)
    return deepFreeze({
      status: 'found' as const,
      operation: request.operation,
      snapshotAt,
      value: parseRecordProjection(input.value, snapshotAt, request)
    })
  }
  if (request.operation === 'revision.get') {
    const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value', 'head'])
    if (input.status !== 'found' || input.operation !== request.operation) {
      return invalidMemoryValue()
    }
    const snapshotAt = parseSnapshotAt(input.snapshotAt)
    const head = parseRevisionHeadProof(input.head, snapshotAt, request)
    if (head.lifecycleState === 'purge_due') return invalidMemoryValue()
    const revision = parseMemoryRevisionV2(input.value)
    if (revision.record.namespaceRef !== request.namespaceRef ||
      revision.record.namespaceGeneration !== request.generation ||
      revision.memoryId !== request.memoryId || revision.revision !== request.revision ||
      revision.revision > head.headRevision ||
      (revision.revision === head.headRevision && (
        revision.revisionHash !== head.headRevisionHash ||
        revision.record.retention.validUntil !== head.validUntil ||
        revision.record.retention.purgeAt !== head.purgeAt
      ))) {
      return invalidMemoryValue()
    }
    return deepFreeze({
      status: 'found' as const,
      operation: request.operation,
      snapshotAt,
      value: revision,
      head
    })
  }
  if (request.operation === 'deletion.getStatus') {
    const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value'])
    if (input.status !== 'found' || input.operation !== request.operation) {
      return invalidMemoryValue()
    }
    const status = parseDeletionStatusV1(input.value)
    const snapshotAt = parseSnapshotAt(input.snapshotAt)
    if (status.deletionRef !== request.deletionRef ||
      status.namespaceRef !== request.namespaceRef ||
      status.observedCurrentGeneration !== request.generation ||
      status.observedAt !== snapshotAt) return invalidMemoryValue()
    return deepFreeze({
      status: 'found' as const,
      operation: request.operation,
      snapshotAt,
      value: status
    })
  }
  if (request.operation === 'deletion.resolve') {
    const input = inspectMemoryRecord(value, [
      'status', 'operation', 'snapshotAt', 'receipt', 'deletionStatus'
    ])
    if (input.status !== 'resolved' || input.operation !== request.operation) {
      return invalidMemoryValue()
    }
    const receipt = parseDeletionMutationReceiptV1(input.receipt)
    const status = parseDeletionStatusV1(input.deletionStatus)
    const snapshotAt = parseSnapshotAt(input.snapshotAt)
    if (receipt.deletionRef !== request.deletionRef || status.deletionRef !== request.deletionRef ||
      receipt.commandRefHash !== memoryLifecycleCommandRefHashV1(request.commandRef) ||
      receipt.namespaceRef !== request.namespaceRef || status.namespaceRef !== request.namespaceRef ||
      receipt.generationAfter > request.generation ||
      status.observedCurrentGeneration !== request.generation ||
      receipt.deletingGeneration !== status.deletingGeneration ||
      status.observedAt !== snapshotAt) return invalidMemoryValue()
    return deepFreeze({
      status: 'resolved' as const,
      operation: request.operation,
      snapshotAt,
      receipt,
      deletionStatus: status
    })
  }
  const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'value'])
  if (input.status !== 'usage' || input.operation !== request.operation) {
    return invalidMemoryValue()
  }
  return deepFreeze({
    status: 'usage' as const,
    operation: request.operation,
    snapshotAt: parseSnapshotAt(input.snapshotAt),
    value: parseGlobalUsage(input.value)
  })
}

function parseRecordPurgeDueResult (
  value: unknown,
  request: Extract<MemoryControlRepositoryAdapterRequestV1, {
    operation: 'revision.get' | 'revision.list'
  }>
): MemoryControlRepositoryResultV1 {
  const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt', 'head'])
  if (input.status !== 'record_purge_due' || input.operation !== request.operation) {
    return invalidMemoryValue()
  }
  const snapshotAt = parseSnapshotAt(input.snapshotAt)
  const head = parseRevisionHeadProof(input.head, snapshotAt, request)
  if (head.lifecycleState !== 'purge_due') return invalidMemoryValue()
  return deepFreeze({
    status: 'record_purge_due' as const,
    operation: request.operation,
    snapshotAt,
    head
  })
}

function retryableForCategory (
  category: 'busy' | 'storage' | 'io',
  value: unknown
): boolean {
  const expected = category !== 'storage'
  if (typeof value !== 'boolean' || value !== expected) return invalidMemoryValue()
  return value
}

function parseAdapterResult (
  value: unknown,
  request: MemoryControlRepositoryAdapterRequestV1
): MemoryControlRepositoryResultV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], RESULT_FIELDS)
  if (discriminator.status === 'denied') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    return Object.freeze({
      status: 'denied' as const,
      category: enumValue(input.category, ['access', 'authority'] as const)
    })
  }
  if (discriminator.status === 'corrupt') {
    const input = inspectMemoryRecord(value, ['status', 'category'])
    if (input.category !== 'canonical_data') return invalidMemoryValue()
    return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
  }
  if (discriminator.status === 'unavailable') {
    const input = inspectMemoryRecord(value, ['status', 'category', 'retryable'])
    const category = enumValue(input.category, ['busy', 'storage', 'io'] as const)
    return Object.freeze({
      status: 'unavailable' as const,
      category,
      retryable: retryableForCategory(category, input.retryable)
    })
  }
  if (discriminator.status === 'invalid_cursor') {
    const input = inspectMemoryRecord(value, ['status', 'operation'])
    if (!LIST_OPERATIONS.has(request.operation as MemoryControlListOperationV1) ||
      input.operation !== request.operation) return invalidMemoryValue()
    return Object.freeze({
      status: 'invalid_cursor' as const,
      operation: request.operation as MemoryControlListOperationV1
    })
  }
  if (discriminator.status === 'record_purge_due') {
    if (request.operation !== 'revision.get' && request.operation !== 'revision.list') {
      return invalidMemoryValue()
    }
    return parseRecordPurgeDueResult(value, request)
  }
  if (discriminator.status === 'not_found') {
    const input = inspectMemoryRecord(value, ['status', 'operation', 'snapshotAt'])
    if (LIST_OPERATIONS.has(request.operation as MemoryControlListOperationV1) ||
      input.operation !== request.operation || request.operation === 'usage.getGlobal') {
      return invalidMemoryValue()
    }
    return Object.freeze({
      status: 'not_found' as const,
      operation: request.operation as MemoryControlExactOperationV1,
      snapshotAt: parseSnapshotAt(input.snapshotAt)
    })
  }
  if (discriminator.status === 'page') {
    if (!LIST_OPERATIONS.has(request.operation as MemoryControlListOperationV1)) {
      return invalidMemoryValue()
    }
    return parsePageResult(
      value,
      request as Extract<MemoryControlRepositoryAdapterRequestV1, { cursor: string | null }>
    )
  }
  if (discriminator.status === 'found' || discriminator.status === 'resolved' ||
    discriminator.status === 'usage') {
    if (LIST_OPERATIONS.has(request.operation as MemoryControlListOperationV1)) {
      return invalidMemoryValue()
    }
    return parseFoundResult(
      value,
      request as Exclude<MemoryControlRepositoryAdapterRequestV1, { cursor: string | null }>
    )
  }
  return invalidMemoryValue()
}

function deepFreeze<T> (value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value, seen)
    }
  }
  return Object.freeze(value)
}

function parseOptions (
  value: CreateMemoryControlRepositoryPortOptionsV1
): CreateMemoryControlRepositoryPortOptionsV1 {
  const input = inspectMemoryRecord(value, ['now', 'execute'])
  if (typeof input.now !== 'function' || utilTypes.isProxy(input.now) ||
    typeof input.execute !== 'function' || utilTypes.isProxy(input.execute)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    now: input.now as () => string,
    execute: input.execute as MemoryControlRepositoryAdapterV1['execute']
  })
}

export function createMemoryControlRepositoryPortV1 (
  optionsValue: CreateMemoryControlRepositoryPortOptionsV1
): MemoryControlRepositoryPortV1 {
  const options = parseOptions(optionsValue)
  return Object.freeze({
    execute: async (
      requestValue: unknown,
      signalValue?: AbortSignal
    ): Promise<MemoryControlRepositoryResultV1> => {
      const signal = createMemoryPortSignalScopeV1(signalValue)
      let parsed: ParsedControlRequestV1
      try {
        parsed = parseRequest(requestValue)
      } catch (error) {
        signal.close()
        throw error
      }
      if (signal.isAborted()) {
        signal.close()
        return ABORTED_RESULT
      }
      let now: string
      try {
        now = parseMemoryLifecycleInstantV1(Reflect.apply(options.now, undefined, []))
      } catch {
        signal.close()
        return ADAPTER_IO_RESULT
      }
      const denial = authorizationDenial(parsed, now)
      if (denial !== null) {
        signal.close()
        return denial
      }

      // Task 5 adapters must freeze their own trusted high-water under BEGIN IMMEDIATE.
      // This outer authorization clock is deliberately not presented as read linearization.
      // The process-local envelope has no codec and exists only for the locked authoritative check.
      const adapterEnvelope: MemoryControlRepositoryAdapterEnvelopeV1 = Object.freeze({
        schemaVersion: 1 as const,
        request: parsed.adapterRequest,
        authorization: parsed.authorization
      })
      let raw: unknown
      try {
        raw = await Reflect.apply(options.execute, undefined, [
          adapterEnvelope,
          signal.signal
        ])
      } catch {
        const aborted = signal.isAborted()
        signal.close()
        return aborted ? ABORTED_RESULT : ADAPTER_IO_RESULT
      }
      if (signal.isAborted()) {
        signal.close()
        return ABORTED_RESULT
      }
      try {
        const result = parseAdapterResult(raw, parsed.adapterRequest)
        signal.close()
        return result
      } catch {
        const aborted = signal.isAborted()
        signal.close()
        return aborted ? ABORTED_RESULT : ADAPTER_CONTRACT_RESULT
      }
    }
  })
}

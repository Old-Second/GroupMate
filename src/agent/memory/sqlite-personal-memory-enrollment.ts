import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  memoryAccessCapabilityAllowsV1
} from './memory-access-gate.js'
import {
  memoryLifecycleActorCapabilityAllowsV1
} from './memory-lifecycle-authority.js'
import {
  parseMemoryLifecycleInstantV1
} from './memory-lifecycle-domain.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  memoryNamespaceWireV1,
  parseMemoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceRefV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import {
  createPersonalMemoryEnrollmentPolicyV1,
  decodePersonalMemoryEnrollmentCommandWireV1,
  decodePersonalMemoryEnrollmentPolicyV1,
  encodePersonalMemoryEnrollmentPolicyV1,
  parsePersonalMemoryEnrollmentDecisionEnvelopeV1,
  personalMemoryEnrollmentActorRefHashV1,
  personalMemoryEnrollmentCommandHashV1,
  personalMemoryEnrollmentCommandRefHashV1,
  personalMemoryEnrollmentSourceRefHashV1,
  personalMemoryEnrollmentSourceSceneRefV1,
  type PersonalMemoryEnrollmentAdapterReadRequestV1,
  type PersonalMemoryEnrollmentAdapterV1,
  type PersonalMemoryEnrollmentDecisionEnvelopeV1,
  type PersonalMemoryEnrollmentDecisionResultV1,
  type PersonalMemoryEnrollmentPolicyV1,
  type PersonalMemoryEnrollmentReadResultV1
} from './personal-memory-enrollment.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'
import {
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'

interface CreateSqlitePersonalMemoryEnrollmentAdapterOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

type Row = Readonly<Record<string, SQLOutputValue>>

class CanonicalPersonalMemoryEnrollmentDataErrorV1 extends Error {}

function rowValue (row: Row | undefined, key: string): SQLOutputValue | undefined {
  if (row === undefined) return undefined
  return Object.getOwnPropertyDescriptor(row, key)?.value as SQLOutputValue | undefined
}

function exactString (value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  return value
}

function positiveInteger (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    Object.is(value, -0)) throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  return value
}

function nonnegativeInteger (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  return value
}

function methodIsDataFunction (value: object, name: string): boolean {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function' &&
        !utilTypes.isProxy(descriptor.value)
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
}

function parseOptions (
  value: CreateSqlitePersonalMemoryEnrollmentAdapterOptionsV1
): CreateSqlitePersonalMemoryEnrollmentAdapterOptionsV1 {
  const input = inspectMemoryRecord(value, ['database', 'now'])
  if (input.database === null || typeof input.database !== 'object' ||
    utilTypes.isProxy(input.database) || !methodIsDataFunction(input.database, 'prepare') ||
    !methodIsDataFunction(input.database, 'exec') || typeof input.now !== 'function' ||
    utilTypes.isProxy(input.now)) return invalidMemoryValue()
  return Object.freeze({
    database: input.database as DatabaseSync,
    now: input.now as () => string
  })
}

function parseReadRequest (value: unknown): PersonalMemoryEnrollmentAdapterReadRequestV1 {
  const input = inspectMemoryRecord(value, ['schemaVersion', 'namespace', 'namespaceRef'])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const namespace = parseMemoryNamespaceV1(input.namespace)
  const namespaceRef = parseMemoryNamespaceRefV1(input.namespaceRef)
  if (namespace.scope.kind !== 'personal' || memoryNamespaceRefV1(namespace) !== namespaceRef) {
    return invalidMemoryValue()
  }
  return Object.freeze({ schemaVersion: 1 as const, namespace, namespaceRef })
}

function sqliteErrorNumber (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : null
}

function sqliteFailure (
  error: unknown
): Extract<
  PersonalMemoryEnrollmentReadResultV1 | PersonalMemoryEnrollmentDecisionResultV1,
  { readonly status: 'unavailable' | 'corrupt' }
> {
  if (error instanceof CanonicalPersonalMemoryEnrollmentDataErrorV1) {
    return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
  }
  const errcode = sqliteErrorNumber(error)
  const primary = errcode !== null && errcode >= 0 && errcode <= 0x7fffffff
    ? errcode & 0xff
    : null
  if (primary === 5 || primary === 6) {
    return Object.freeze({
      status: 'unavailable' as const,
      category: 'busy' as const,
      retryable: true
    })
  }
  if (primary === 10) {
    return Object.freeze({
      status: 'unavailable' as const,
      category: 'io' as const,
      retryable: true
    })
  }
  if (primary === 11 || primary === 26) {
    return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
  }
  return Object.freeze({
    status: 'unavailable' as const,
    category: 'storage' as const,
    retryable: false
  })
}

interface NamespaceStateV1 {
  readonly namespace: MemoryNamespaceV1
  readonly generation: number
  readonly wireBytes: number
}

function loadNamespace (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1
): NamespaceStateV1 | null {
  const row = database.prepare(`
    SELECT n.namespace_wire, n.namespace_wire_bytes, n.namespace_generation,
      u.namespace_ref AS usage_ref, l.namespace_ref AS lifecycle_ref
    FROM namespaces AS n
    LEFT JOIN usage AS u
      ON u.namespace_ref = n.namespace_ref
     AND u.namespace_generation = n.namespace_generation
    LEFT JOIN lifecycle_namespace_usage AS l
      ON l.namespace_ref = n.namespace_ref
    WHERE n.namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (row === undefined) return null
  const wire = exactString(rowValue(row, 'namespace_wire'))
  const wireBytes = positiveInteger(rowValue(row, 'namespace_wire_bytes'))
  if (Buffer.byteLength(wire, 'utf8') !== wireBytes ||
    exactString(rowValue(row, 'usage_ref')) !== namespaceRef ||
    exactString(rowValue(row, 'lifecycle_ref')) !== namespaceRef) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  let namespace: MemoryNamespaceV1
  try {
    namespace = parseMemoryNamespaceV1(JSON.parse(wire) as unknown)
  } catch {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  if (memoryNamespaceRefV1(namespace) !== namespaceRef ||
    memoryNamespaceWireV1(namespace) !== wire) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  return Object.freeze({
    namespace,
    generation: positiveInteger(rowValue(row, 'namespace_generation')),
    wireBytes
  })
}

function requireRequestedNamespace (
  stored: NamespaceStateV1,
  requested: MemoryNamespaceV1
): void {
  if (memoryNamespaceWireV1(stored.namespace) !== memoryNamespaceWireV1(requested)) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
}

function loadPolicy (
  database: DatabaseSync,
  namespaceRef: MemoryNamespaceRefV1
): PersonalMemoryEnrollmentPolicyV1 | null {
  const row = database.prepare(`
    SELECT namespace_ref, namespace_generation, state, candidate_mode,
      policy_generation, decided_by_actor_ref_hash, decision_source_ref_hash,
      policy_hash, policy_wire, policy_wire_bytes, updated_at_ms
    FROM personal_memory_policies WHERE namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (row === undefined) return null
  const wire = exactString(rowValue(row, 'policy_wire'))
  const wireBytes = positiveInteger(rowValue(row, 'policy_wire_bytes'))
  if (Buffer.byteLength(wire, 'utf8') !== wireBytes) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  let policy: PersonalMemoryEnrollmentPolicyV1
  try {
    policy = decodePersonalMemoryEnrollmentPolicyV1(wire)
  } catch {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  if (policy.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    policy.namespaceGeneration !== positiveInteger(rowValue(row, 'namespace_generation')) ||
    policy.state !== exactString(rowValue(row, 'state')) ||
    policy.candidateMode !== exactString(rowValue(row, 'candidate_mode')) ||
    policy.policyGeneration !== positiveInteger(rowValue(row, 'policy_generation')) ||
    policy.decidedByActorRefHash !== exactString(rowValue(row, 'decided_by_actor_ref_hash')) ||
    policy.decisionSourceRefHash !== exactString(rowValue(row, 'decision_source_ref_hash')) ||
    policy.policyHash !== exactString(rowValue(row, 'policy_hash')) ||
    Date.parse(policy.updatedAt) !== nonnegativeInteger(rowValue(row, 'updated_at_ms')) ||
    encodePersonalMemoryEnrollmentPolicyV1(policy) !== wire) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  return policy
}

function loadGlobalUsage (database: DatabaseSync): {
  readonly namespaceRecords: number
  readonly canonicalLogicalBytes: number
} {
  const row = database.prepare(`
    SELECT namespace_records, canonical_logical_bytes
    FROM global_usage WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  const namespaceRecords = nonnegativeInteger(rowValue(row, 'namespace_records'))
  const canonicalLogicalBytes = nonnegativeInteger(rowValue(row, 'canonical_logical_bytes'))
  if (namespaceRecords > MEMORY_RESOURCE_LIMITS.deploymentNamespaces ||
    canonicalLogicalBytes > MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  return Object.freeze({ namespaceRecords, canonicalLogicalBytes })
}

function requireConservativeGlobalUsage (
  database: DatabaseSync,
  stored: ReturnType<typeof loadGlobalUsage>
): void {
  const row = database.prepare(`
    SELECT
      (SELECT count(*) FROM namespaces) AS namespace_records,
      (SELECT coalesce(sum(namespace_wire_bytes), 0) FROM namespaces) +
        (SELECT coalesce(sum(proposal_wire_bytes), 0) FROM proposals) +
        (SELECT coalesce(sum(revision_wire_bytes), 0) FROM revisions) +
        (SELECT coalesce(sum(tombstone_wire_bytes), 0) FROM tombstones) +
        (SELECT coalesce(sum(manifest_wire_bytes), 0) FROM memory_v1_to_v2_manifests) +
        (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM consent_evidence) +
        (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM revision_evidence) +
        (SELECT coalesce(sum(audit_wire_bytes), 0) FROM lifecycle_audits) +
        (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands) +
        (SELECT coalesce(sum(checkpoint_wire_bytes), 0)
          FROM namespace_deletion_checkpoints) +
        (SELECT coalesce(sum(job_wire_bytes), 0) FROM export_jobs) +
        (SELECT coalesce(sum(reservation_wire_bytes), 0)
          FROM export_audit_reservations) AS canonical_logical_bytes
  `).get() as Row | undefined
  if (row === undefined ||
    stored.namespaceRecords < nonnegativeInteger(rowValue(row, 'namespace_records')) ||
    stored.canonicalLogicalBytes <
      nonnegativeInteger(rowValue(row, 'canonical_logical_bytes'))) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
}

function requireOneChange (changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
}

function freezeTrustedNow (database: DatabaseSync, now: () => string): string {
  let wall: string
  try {
    wall = parseMemoryLifecycleInstantV1(Reflect.apply(now, undefined, []))
  } catch {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  const row = database.prepare(`
    SELECT trusted_time_high_water_ms
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  const persisted = nonnegativeInteger(rowValue(row, 'trusted_time_high_water_ms'))
  const trustedMs = Math.max(Date.parse(wall), persisted)
  if (trustedMs > persisted) {
    requireOneChange(database.prepare(`
      UPDATE lifecycle_deployment_state SET trusted_time_high_water_ms = ?
      WHERE singleton = 1 AND trusted_time_high_water_ms = ?
    `).run(trustedMs, persisted).changes)
  }
  return new Date(trustedMs).toISOString()
}

function insertEmptyNamespace (
  database: DatabaseSync,
  namespace: MemoryNamespaceV1,
  generation: number,
  nowMs: number
): PersonalMemoryEnrollmentDecisionResultV1 | null {
  const global = loadGlobalUsage(database)
  requireConservativeGlobalUsage(database, global)
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const wire = memoryNamespaceWireV1(namespace)
  const wireBytes = Buffer.byteLength(wire, 'utf8')
  if (global.namespaceRecords + 1 > MEMORY_RESOURCE_LIMITS.deploymentNamespaces) {
    return Object.freeze({ status: 'capacity' as const, category: 'namespaces' as const })
  }
  if (wireBytes > MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes ||
    global.canonicalLogicalBytes + wireBytes >
      MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes) {
    return Object.freeze({ status: 'capacity' as const, category: 'canonical_bytes' as const })
  }
  requireOneChange(database.prepare(`
    INSERT INTO namespaces(
      namespace_ref, namespace_wire, namespace_wire_bytes, namespace_generation,
      created_at_ms, updated_at_ms, content_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(namespaceRef, wire, wireBytes, generation, nowMs, nowMs).changes)
  requireOneChange(database.prepare(`
    INSERT INTO usage(
      namespace_ref, namespace_generation, pending_proposal_records,
      active_memory_records, retained_revision_records, tombstone_records,
      canonical_logical_bytes, pending_outbox_records, outbox_logical_bytes,
      updated_at_ms, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes
    ) VALUES (?, ?, 0, 0, 0, 0, ?, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  `).run(namespaceRef, generation, wireBytes, nowMs).changes)
  requireOneChange(database.prepare(`
    INSERT INTO lifecycle_namespace_usage(
      namespace_ref, lifecycle_audit_records, lifecycle_audit_reserved_records,
      lifecycle_command_records, deletion_checkpoint_records, export_job_records,
      lifecycle_audit_logical_bytes, lifecycle_audit_reserved_bytes,
      lifecycle_command_logical_bytes, deletion_checkpoint_logical_bytes,
      export_job_logical_bytes, updated_at_ms
    ) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
  `).run(namespaceRef, nowMs).changes)
  requireOneChange(database.prepare(`
    UPDATE global_usage
    SET namespace_records = namespace_records + 1,
      canonical_logical_bytes = canonical_logical_bytes + ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(wireBytes, nowMs).changes)
  return null
}

function commandExpectedPolicy (
  envelope: PersonalMemoryEnrollmentDecisionEnvelopeV1,
  policyGeneration: number,
  updatedAt: string
): PersonalMemoryEnrollmentPolicyV1 {
  const wire = decodePersonalMemoryEnrollmentCommandWireV1(envelope.command.wire)
  return createPersonalMemoryEnrollmentPolicyV1({
    schemaVersion: 1,
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    state: wire.operation === 'enrollment.optIn' ? 'opted_in' : 'opted_out',
    candidateMode: wire.candidateMode,
    policyGeneration,
    commandRefHash: personalMemoryEnrollmentCommandRefHashV1(wire.commandRef),
    commandHash: personalMemoryEnrollmentCommandHashV1(envelope.command.wire),
    decidedByActorRefHash: personalMemoryEnrollmentActorRefHashV1(
      wire.initiatedByActorRef
    ),
    decisionSourceRefHash: personalMemoryEnrollmentSourceRefHashV1(wire.sourceId),
    updatedAt
  })
}

function storePolicy (
  database: DatabaseSync,
  policy: PersonalMemoryEnrollmentPolicyV1,
  previousGeneration: number | null
): void {
  const wire = encodePersonalMemoryEnrollmentPolicyV1(policy)
  const bytes = Buffer.byteLength(wire, 'utf8')
  const updatedAtMs = Date.parse(policy.updatedAt)
  if (previousGeneration === null) {
    requireOneChange(database.prepare(`
      INSERT INTO personal_memory_policies(
        namespace_ref, namespace_generation, state, candidate_mode,
        policy_generation, decided_by_actor_ref_hash, decision_source_ref_hash,
        policy_hash, policy_wire, policy_wire_bytes, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      policy.namespaceRef,
      policy.namespaceGeneration,
      policy.state,
      policy.candidateMode,
      policy.policyGeneration,
      policy.decidedByActorRefHash,
      policy.decisionSourceRefHash,
      policy.policyHash,
      wire,
      bytes,
      updatedAtMs
    ).changes)
    return
  }
  requireOneChange(database.prepare(`
    UPDATE personal_memory_policies
    SET state = ?, candidate_mode = ?, policy_generation = ?,
      decided_by_actor_ref_hash = ?, decision_source_ref_hash = ?,
      policy_hash = ?, policy_wire = ?, policy_wire_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ? AND namespace_generation = ? AND policy_generation = ?
  `).run(
    policy.state,
    policy.candidateMode,
    policy.policyGeneration,
    policy.decidedByActorRefHash,
    policy.decisionSourceRefHash,
    policy.policyHash,
    wire,
    bytes,
    updatedAtMs,
    policy.namespaceRef,
    policy.namespaceGeneration,
    previousGeneration
  ).changes)
}

function revalidateAuthority (
  envelope: PersonalMemoryEnrollmentDecisionEnvelopeV1,
  freshNow: string
): boolean {
  const wire = decodePersonalMemoryEnrollmentCommandWireV1(envelope.command.wire)
  return envelope.access.botInstanceId === envelope.namespace.botInstanceId &&
    envelope.access.accountId === envelope.namespace.accountId &&
    envelope.actor.botInstanceId === envelope.namespace.botInstanceId &&
    envelope.actor.accountId === envelope.namespace.accountId &&
    envelope.actor.sceneRef === envelope.access.sceneRef &&
    envelope.access.sceneRef === personalMemoryEnrollmentSourceSceneRefV1(
      envelope.command.source
    ) &&
    envelope.actor.actorRef === wire.initiatedByActorRef &&
    memoryAccessCapabilityAllowsV1(envelope.access, wire.namespaceRef, freshNow) &&
    memoryLifecycleActorCapabilityAllowsV1(envelope.actor, {
      botInstanceId: envelope.namespace.botInstanceId,
      accountId: envelope.namespace.accountId,
      sceneRef: envelope.access.sceneRef,
      namespaceRef: wire.namespaceRef,
      generation: wire.expectedNamespaceGeneration,
      actorRef: wire.initiatedByActorRef,
      action: 'manage_enrollment',
      requiredAuthority: 'elevated'
    }, freshNow)
}

function readEnrollment (
  database: DatabaseSync,
  request: PersonalMemoryEnrollmentAdapterReadRequestV1
): PersonalMemoryEnrollmentReadResultV1 {
  const namespace = loadNamespace(database, request.namespaceRef)
  if (namespace === null) return Object.freeze({ status: 'not_enrolled' as const })
  requireRequestedNamespace(namespace, request.namespace)
  const policy = loadPolicy(database, request.namespaceRef)
  if (policy === null) return Object.freeze({ status: 'not_enrolled' as const })
  if (policy.namespaceGeneration !== namespace.generation) {
    throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  return Object.freeze({ status: 'found' as const, policy })
}

function decideEnrollment (
  database: DatabaseSync,
  envelope: PersonalMemoryEnrollmentDecisionEnvelopeV1,
  freshNow: string,
  aborted: () => boolean
): PersonalMemoryEnrollmentDecisionResultV1 {
  const wire = decodePersonalMemoryEnrollmentCommandWireV1(envelope.command.wire)
  if (!revalidateAuthority(envelope, freshNow)) {
    return Object.freeze({ status: 'denied' as const, category: 'authority' as const })
  }
  let namespace = loadNamespace(database, wire.namespaceRef)
  if (namespace === null) {
    if (wire.operation !== 'enrollment.optIn') {
      return Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
    }
    if (wire.expectedNamespaceGeneration !== 1 || wire.expectedPolicyGeneration !== 0) {
      return Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
    }
    const capacity = insertEmptyNamespace(
      database,
      envelope.namespace,
      wire.expectedNamespaceGeneration,
      Date.parse(freshNow)
    )
    if (capacity !== null) return capacity
    namespace = loadNamespace(database, wire.namespaceRef)
    if (namespace === null) throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
  }
  requireRequestedNamespace(namespace, envelope.namespace)
  if (namespace.generation !== wire.expectedNamespaceGeneration) {
    return Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
  }

  const current = loadPolicy(database, wire.namespaceRef)
  const expected = commandExpectedPolicy(
    envelope,
    wire.expectedPolicyGeneration + 1,
    current?.updatedAt ?? freshNow
  )
  if (current !== null && current.commandHash === expected.commandHash) {
    if (current.policyHash !== expected.policyHash) {
      throw new CanonicalPersonalMemoryEnrollmentDataErrorV1()
    }
    return Object.freeze({ status: 'unchanged' as const, policy: current })
  }
  if (current !== null && current.commandRefHash === expected.commandRefHash) {
    return Object.freeze({ status: 'conflict' as const, category: 'idempotency' as const })
  }
  if ((current?.policyGeneration ?? 0) !== wire.expectedPolicyGeneration) {
    return Object.freeze({ status: 'conflict' as const, category: 'generation' as const })
  }
  const policy = commandExpectedPolicy(
    envelope,
    wire.expectedPolicyGeneration + 1,
    freshNow
  )
  if (aborted()) return Object.freeze({ status: 'aborted' as const })
  storePolicy(database, policy, current?.policyGeneration ?? null)
  if (aborted()) return Object.freeze({ status: 'aborted' as const })
  return Object.freeze({ status: 'stored' as const, policy })
}

export function createSqlitePersonalMemoryEnrollmentAdapterV1 (
  optionsValue: CreateSqlitePersonalMemoryEnrollmentAdapterOptionsV1
): PersonalMemoryEnrollmentAdapterV1 {
  const options = parseOptions(optionsValue)

  const read = async (
    requestValue: PersonalMemoryEnrollmentAdapterReadRequestV1,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      if (signalScope.isAborted()) return Object.freeze({ status: 'aborted' as const })
      const request = parseReadRequest(requestValue)
      return readEnrollment(options.database, request)
    } catch (error) {
      return sqliteFailure(error)
    } finally {
      signalScope.close()
    }
  }

  const decide = async (
    envelopeValue: PersonalMemoryEnrollmentDecisionEnvelopeV1,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    let transaction = false
    try {
      const envelope = parsePersonalMemoryEnrollmentDecisionEnvelopeV1(envelopeValue)
      if (signalScope.isAborted()) return Object.freeze({ status: 'aborted' as const })
      options.database.exec('BEGIN IMMEDIATE')
      transaction = true
      const freshNow = freezeTrustedNow(options.database, options.now)
      const result = decideEnrollment(
        options.database,
        envelope,
        freshNow,
        signalScope.isAborted
      )
      if (result.status === 'stored') {
        options.database.exec('COMMIT')
      } else {
        options.database.exec('ROLLBACK')
      }
      transaction = false
      return result
    } catch (error) {
      if (transaction) {
        try {
          options.database.exec('ROLLBACK')
        } catch {
          // The original failure remains authoritative.
        }
      }
      return sqliteFailure(error)
    } finally {
      signalScope.close()
    }
  }

  return Object.freeze({ read, decide })
}

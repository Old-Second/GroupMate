import { createHash, randomUUID } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  decodeMemoryExtractionJobV1,
  encodeMemoryExtractionJobV1,
  memoryCredentialRejectionReasonV1,
  parseMemoryExtractionJobV1,
  type MemoryExtractionJobV1
} from './memory-candidate-pipeline.js'
import { parseMemoryLifecycleInstantV1 } from './memory-lifecycle-domain.js'
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'
import {
  MEMORY_DERIVATIVE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit
} from './memory-resource-limits.js'

export const MEMORY_EXTRACTION_SQLITE_APPLICATION_ID_V1 = 0x474d4558
export const MEMORY_EXTRACTION_SQLITE_SCHEMA_VERSION_V1 = 1
export const MEMORY_EXTRACTION_SQLITE_SCHEMA_FINGERPRINT_V1 =
  '1206a4f06ab9a6503795ce478c676ec86cd8ba24a4d621ae65a92df76b87a575'

export type MemoryExtractionQueueEnqueueResultV1 =
  | { readonly status: 'stored'; readonly shedInferredJobs?: number }
  | { readonly status: 'unchanged' }
  | { readonly status: 'rejected'; readonly reason: 'credential' | 'expired' | 'queue_pressure' }
  | { readonly status: 'aborted' }
  | { readonly status: 'unavailable'; readonly retryable: boolean }

export type MemoryExtractionQueueClaimResultV1 =
  | {
      readonly status: 'claimed'
      readonly ownerId: string
      readonly leaseToken: string
      readonly leasedUntil: string
      readonly jobs: readonly MemoryExtractionJobV1[]
      readonly attemptCounts: readonly number[]
    }
  | { readonly status: 'empty' }
  | { readonly status: 'aborted' }
  | { readonly status: 'unavailable'; readonly retryable: boolean }

export type MemoryExtractionQueueMutationResultV1 =
  | { readonly status: 'acked' }
  | { readonly status: 'retried'; readonly attemptCount: number }
  | { readonly status: 'dead_lettered' }
  | { readonly status: 'attempts_exhausted' }
  | { readonly status: 'lease_conflict' }
  | { readonly status: 'aborted' }
  | { readonly status: 'unavailable'; readonly retryable: boolean }

export type MemoryExtractionQueueUsageResultV1 =
  | {
      readonly status: 'usage'
      readonly pendingRecords: number
      readonly leasedRecords: number
      readonly logicalBytes: number
    }
  | { readonly status: 'aborted' }
  | { readonly status: 'unavailable'; readonly retryable: boolean }

export type MemoryCandidateAuditOutcomeV1 =
  | 'no_op'
  | 'rejected'
  | 'duplicate'
  | 'shadow_stored'
  | 'approved'
  | 'dead_letter'

export interface MemoryCandidateAuditInputV1 {
  readonly auditId: string
  readonly jobId: string
  readonly candidateHash: string | null
  readonly provenanceHash: string | null
  readonly outcome: MemoryCandidateAuditOutcomeV1
  readonly reasonCode: string
  readonly proposalId: string | null
  readonly recordedAt: string
}

export type MemoryCandidateAuditResultV1 =
  | { readonly status: 'stored' | 'unchanged' }
  | { readonly status: 'aborted' }
  | { readonly status: 'unavailable'; readonly retryable: boolean }

export interface MemoryExtractionLeaseMutationV1 {
  readonly ownerId: string
  readonly leaseToken: string
  readonly jobId: string
}

export interface MemoryExtractionRetryV1 extends MemoryExtractionLeaseMutationV1 {
  readonly retryAt: string
  readonly reasonCode: string
}

export interface SqliteMemoryExtractionQueueV1 {
  readonly enqueue: (
    job: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryExtractionQueueEnqueueResultV1>
  readonly claim: (
    ownerId: unknown,
    limit: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryExtractionQueueClaimResultV1>
  readonly ack: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryExtractionQueueMutationResultV1>
  readonly retry: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryExtractionQueueMutationResultV1>
  readonly deadLetter: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryExtractionQueueMutationResultV1>
  readonly usage: (signal?: AbortSignal) => Promise<MemoryExtractionQueueUsageResultV1>
  readonly recordAudit: (
    input: unknown,
    signal?: AbortSignal
  ) => Promise<MemoryCandidateAuditResultV1>
}

export interface CreateSqliteMemoryExtractionQueueOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
  readonly leaseToken?: () => string
}

interface QueueUsageV1 {
  readonly records: number
  readonly logicalBytes: number
}

class MemoryExtractionQueueDataErrorV1 extends Error {}

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const JOB_ID = /^extraction:[0-9a-f]{64}$/
const LEASE_TOKEN = /^candidate-lease:v1:[0-9a-f]{64}$/
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/
const MAXIMUM_FUTURE_SKEW_MS = 5_000
const MAXIMUM_SCHEMA_OBJECTS = 7
const MAXIMUM_SCHEMA_OBJECT_SQL_BYTES = 16 * 1_024
const MAXIMUM_SCHEMA_SQL_BYTES = 64 * 1_024
const SCHEMA_FINGERPRINT_DOMAIN = 'groupmate.memory.sqlite-schema.v1'

const SCHEMA_SQL = `
CREATE TABLE memory_extraction_usage(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  pending_records INTEGER NOT NULL CHECK(
    pending_records BETWEEN 0 AND ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueRecords}
  ),
  logical_bytes INTEGER NOT NULL CHECK(
    logical_bytes BETWEEN 0 AND ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueLogicalBytes}
  ),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT, WITHOUT ROWID;
CREATE TABLE memory_extraction_jobs(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE CHECK(length(job_id) = 75),
  namespace_ref TEXT NOT NULL CHECK(length(namespace_ref) = 64),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation > 0),
  priority TEXT NOT NULL CHECK(priority IN ('asserted', 'inferred')),
  enqueued_at_ms INTEGER NOT NULL CHECK(enqueued_at_ms >= 0),
  available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= enqueued_at_ms),
  job_wire TEXT NOT NULL CHECK(length(job_wire) > 0),
  logical_bytes INTEGER NOT NULL CHECK(
    logical_bytes BETWEEN 1 AND ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionJobWireBytes}
  ),
  lease_owner_id TEXT,
  lease_token TEXT,
  leased_until_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(
    attempt_count BETWEEN 0 AND ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionWorkerMaximumAttempts}
  ),
  last_reason_code TEXT,
  CHECK(logical_bytes = length(CAST(job_wire AS BLOB))),
  CHECK(
    (lease_owner_id IS NULL AND lease_token IS NULL AND leased_until_ms IS NULL) OR
    (lease_owner_id IS NOT NULL AND lease_token IS NOT NULL AND leased_until_ms IS NOT NULL)
  )
) STRICT;
CREATE INDEX memory_extraction_jobs_available_v1
ON memory_extraction_jobs(priority ASC, available_at_ms ASC, sequence ASC);
CREATE TABLE memory_candidate_audits(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL UNIQUE CHECK(length(audit_id) = 64),
  job_id TEXT NOT NULL CHECK(length(job_id) = 75),
  candidate_hash TEXT CHECK(candidate_hash IS NULL OR length(candidate_hash) = 64),
  provenance_hash TEXT CHECK(provenance_hash IS NULL OR length(provenance_hash) = 64),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'no_op', 'rejected', 'duplicate', 'shadow_stored', 'approved', 'dead_letter'
  )),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  proposal_id TEXT CHECK(proposal_id IS NULL OR length(proposal_id) = 73),
  recorded_at_ms INTEGER NOT NULL CHECK(recorded_at_ms >= 0),
  CHECK((candidate_hash IS NULL) = (provenance_hash IS NULL))
) STRICT;
CREATE TRIGGER memory_extraction_jobs_ai_v1
AFTER INSERT ON memory_extraction_jobs BEGIN
  UPDATE memory_extraction_usage
  SET pending_records = pending_records + 1,
      logical_bytes = logical_bytes + new.logical_bytes,
      updated_at_ms = max(updated_at_ms, new.enqueued_at_ms)
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN raise(ABORT, 'memory extraction usage unavailable') END;
END;
CREATE TRIGGER memory_extraction_jobs_ad_v1
AFTER DELETE ON memory_extraction_jobs BEGIN
  UPDATE memory_extraction_usage
  SET pending_records = pending_records - 1,
      logical_bytes = logical_bytes - old.logical_bytes
  WHERE singleton = 1;
  SELECT CASE WHEN changes() != 1
    THEN raise(ABORT, 'memory extraction usage unavailable') END;
END;
INSERT INTO memory_extraction_usage(singleton, pending_records, logical_bytes, updated_at_ms)
VALUES (1, 0, 0, 0);
`

function rowValue (
  row: Readonly<Record<string, SQLOutputValue>> | undefined,
  key: string
): SQLOutputValue | undefined {
  return row === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(row, key)?.value as SQLOutputValue | undefined
}

function exactInteger (value: SQLOutputValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new MemoryExtractionQueueDataErrorV1()
  return value
}

function exactString (value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string') throw new MemoryExtractionQueueDataErrorV1()
  return value
}

function scalarPragma (database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get()
  const value = row === undefined ? undefined : Object.values(row)[0]
  return exactInteger(value as SQLOutputValue | undefined)
}

function extractionSchemaFingerprint (database: DatabaseSync): string {
  const rows = database.prepare(`
    WITH bounded_schema AS (
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY type ASC, name ASC
      LIMIT ${MAXIMUM_SCHEMA_OBJECTS + 1}
    ), measured_schema AS (
      SELECT
        type,
        name,
        tbl_name,
        sql,
        length(CAST(sql AS BLOB)) AS sql_bytes,
        count(*) OVER () AS object_count,
        sum(length(CAST(sql AS BLOB))) OVER () AS total_sql_bytes
      FROM bounded_schema
    )
    SELECT
      type,
      name,
      tbl_name,
      sql_bytes,
      object_count,
      total_sql_bytes,
      CASE
        WHEN object_count <= ${MAXIMUM_SCHEMA_OBJECTS}
          AND sql_bytes <= ${MAXIMUM_SCHEMA_OBJECT_SQL_BYTES}
          AND total_sql_bytes <= ${MAXIMUM_SCHEMA_SQL_BYTES}
        THEN sql
        ELSE NULL
      END AS sql
    FROM measured_schema
    ORDER BY type ASC, name ASC
  `).all()
  if (rows.length > MAXIMUM_SCHEMA_OBJECTS) return invalidMemoryValue()
  const canonical = rows.map(row => {
    const type = exactString(rowValue(row, 'type'))
    const name = exactString(rowValue(row, 'name'))
    const tableName = exactString(rowValue(row, 'tbl_name'))
    const sql = exactString(rowValue(row, 'sql'))
    const sqlBytes = exactInteger(rowValue(row, 'sql_bytes'))
    const objectCount = exactInteger(rowValue(row, 'object_count'))
    const totalSqlBytes = exactInteger(rowValue(row, 'total_sql_bytes'))
    if (objectCount !== rows.length || sqlBytes !== Buffer.byteLength(sql, 'utf8') ||
      sqlBytes > MAXIMUM_SCHEMA_OBJECT_SQL_BYTES || totalSqlBytes > MAXIMUM_SCHEMA_SQL_BYTES) {
      return invalidMemoryValue()
    }
    return Object.freeze({ type, name, tableName, sql })
  })
  return createHash('sha256')
    .update(SCHEMA_FINGERPRINT_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
}

function initializeSchema (database: DatabaseSync): void {
  const applicationId = scalarPragma(database, 'application_id')
  const version = scalarPragma(database, 'user_version')
  if (applicationId === 0 && version === 0) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(SCHEMA_SQL)
      database.exec(`PRAGMA application_id = ${MEMORY_EXTRACTION_SQLITE_APPLICATION_ID_V1}`)
      database.exec(`PRAGMA user_version = ${MEMORY_EXTRACTION_SQLITE_SCHEMA_VERSION_V1}`)
      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch {}
      throw error
    }
  } else if (applicationId !== MEMORY_EXTRACTION_SQLITE_APPLICATION_ID_V1 ||
    version !== MEMORY_EXTRACTION_SQLITE_SCHEMA_VERSION_V1) {
    throw new MemoryExtractionQueueDataErrorV1()
  }
  if (extractionSchemaFingerprint(database) !==
    MEMORY_EXTRACTION_SQLITE_SCHEMA_FINGERPRINT_V1) {
    throw new MemoryExtractionQueueDataErrorV1()
  }
}

function parseOptions (
  value: CreateSqliteMemoryExtractionQueueOptionsV1
): Required<CreateSqliteMemoryExtractionQueueOptionsV1> {
  const input = inspectMemoryRecord(value, ['database', 'now'], ['leaseToken'])
  if (input.database === null || typeof input.database !== 'object' ||
    utilTypes.isProxy(input.database) ||
    typeof (input.database as DatabaseSync).prepare !== 'function' ||
    typeof (input.database as DatabaseSync).exec !== 'function' ||
    typeof input.now !== 'function' ||
    (input.leaseToken !== undefined && typeof input.leaseToken !== 'function')) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    database: input.database as DatabaseSync,
    now: input.now as () => string,
    leaseToken: (input.leaseToken ?? (() => randomUUID().replaceAll('-', '') +
      randomUUID().replaceAll('-', ''))) as () => string
  })
}

function readNow (now: () => string): { readonly instant: string; readonly milliseconds: number } {
  let value: unknown
  try {
    value = Reflect.apply(now, undefined, [])
  } catch {
    return invalidMemoryValue()
  }
  const instant = parseMemoryLifecycleInstantV1(value)
  return Object.freeze({ instant, milliseconds: Date.parse(instant) })
}

function workerId (value: unknown): string {
  if (!memoryAsciiWithinLimit(value, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !WORKER_ID.test(value)) return invalidMemoryValue()
  return value
}

function positiveLimit (value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
    value > MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionWorkerBatchRecords ||
    Object.is(value, -0)) return invalidMemoryValue()
  return value
}

function parseLeaseMutation (value: unknown): MemoryExtractionLeaseMutationV1 {
  const input = inspectMemoryRecord(value, ['ownerId', 'leaseToken', 'jobId'])
  if (typeof input.leaseToken !== 'string' || !LEASE_TOKEN.test(input.leaseToken) ||
    typeof input.jobId !== 'string' || !JOB_ID.test(input.jobId)) return invalidMemoryValue()
  return Object.freeze({
    ownerId: workerId(input.ownerId),
    leaseToken: input.leaseToken,
    jobId: input.jobId
  })
}

function parseRetry (value: unknown): MemoryExtractionRetryV1 {
  const input = inspectMemoryRecord(value, [
    'ownerId', 'leaseToken', 'jobId', 'retryAt', 'reasonCode'
  ])
  const base = parseLeaseMutation({
    ownerId: input.ownerId,
    leaseToken: input.leaseToken,
    jobId: input.jobId
  })
  if (typeof input.reasonCode !== 'string' || !REASON_CODE.test(input.reasonCode)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    ...base,
    retryAt: parseMemoryLifecycleInstantV1(input.retryAt),
    reasonCode: input.reasonCode
  })
}

function nullableHash (value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return invalidMemoryValue()
  return value
}

function parseAuditInput (value: unknown): MemoryCandidateAuditInputV1 {
  const input = inspectMemoryRecord(value, [
    'auditId', 'jobId', 'candidateHash', 'provenanceHash', 'outcome', 'reasonCode',
    'proposalId', 'recordedAt'
  ])
  if (typeof input.auditId !== 'string' || !/^[0-9a-f]{64}$/.test(input.auditId) ||
    typeof input.jobId !== 'string' || !JOB_ID.test(input.jobId) ||
    typeof input.reasonCode !== 'string' || !REASON_CODE.test(input.reasonCode) ||
    (input.proposalId !== null && (
      typeof input.proposalId !== 'string' || !/^proposal:[0-9a-f]{64}$/.test(input.proposalId)
    ))) return invalidMemoryValue()
  const candidateHash = nullableHash(input.candidateHash)
  const provenanceHash = nullableHash(input.provenanceHash)
  if ((candidateHash === null) !== (provenanceHash === null)) return invalidMemoryValue()
  return Object.freeze({
    auditId: input.auditId,
    jobId: input.jobId,
    candidateHash,
    provenanceHash,
    outcome: enumAuditOutcome(input.outcome),
    reasonCode: input.reasonCode,
    proposalId: input.proposalId as string | null,
    recordedAt: parseMemoryLifecycleInstantV1(input.recordedAt)
  })
}

function enumAuditOutcome (value: unknown): MemoryCandidateAuditOutcomeV1 {
  const values: readonly MemoryCandidateAuditOutcomeV1[] = [
    'no_op', 'rejected', 'duplicate', 'shadow_stored', 'approved', 'dead_letter'
  ]
  if (typeof value !== 'string' || !values.includes(value as MemoryCandidateAuditOutcomeV1)) {
    return invalidMemoryValue()
  }
  return value as MemoryCandidateAuditOutcomeV1
}

function queueUsage (database: DatabaseSync): QueueUsageV1 {
  const row = database.prepare(`
    SELECT pending_records, logical_bytes FROM memory_extraction_usage WHERE singleton = 1
  `).get()
  const usage = Object.freeze({
    records: exactInteger(rowValue(row, 'pending_records')),
    logicalBytes: exactInteger(rowValue(row, 'logical_bytes'))
  })
  const actual = database.prepare(`
    SELECT count(*) AS records, coalesce(sum(logical_bytes), 0) AS logical_bytes
    FROM memory_extraction_jobs
  `).get()
  if (usage.records !== exactInteger(rowValue(actual, 'records')) ||
    usage.logicalBytes !== exactInteger(rowValue(actual, 'logical_bytes'))) {
    throw new MemoryExtractionQueueDataErrorV1()
  }
  return usage
}

function sqlitePrimaryCode (error: unknown): number | null {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error)) return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'errcode')
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value)) return null
  return descriptor.value & 0xff
}

function unavailable (error: unknown): { readonly status: 'unavailable'; readonly retryable: boolean } {
  const code = sqlitePrimaryCode(error)
  return Object.freeze({ status: 'unavailable' as const, retryable: code === 5 || code === 6 || code === 10 })
}

function transact<T> (database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    throw error
  }
}

function shedInferred (
  database: DatabaseSync,
  requiredBytes: number
): number {
  let usage = queueUsage(database)
  let shed = 0
  const rows = database.prepare(`
    SELECT sequence FROM memory_extraction_jobs
    WHERE priority = 'inferred' AND lease_owner_id IS NULL
    ORDER BY sequence ASC
    LIMIT ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueRecords}
  `).all()
  for (const row of rows) {
    if (usage.records < MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueRecords &&
      usage.logicalBytes + requiredBytes <=
        MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueLogicalBytes) break
    const sequence = exactInteger(rowValue(row, 'sequence'))
    const deleted = database.prepare(`
      DELETE FROM memory_extraction_jobs WHERE sequence = ? AND lease_owner_id IS NULL
    `).run(sequence)
    if (deleted.changes !== 1) throw new MemoryExtractionQueueDataErrorV1()
    shed += 1
    usage = queueUsage(database)
  }
  return shed
}

function enqueueJob (
  database: DatabaseSync,
  job: MemoryExtractionJobV1,
  nowMs: number
): MemoryExtractionQueueEnqueueResultV1 {
  const wire = encodeMemoryExtractionJobV1(job)
  const logicalBytes = Buffer.byteLength(wire, 'utf8')
  if (logicalBytes > MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionJobWireBytes) {
    return Object.freeze({ status: 'rejected' as const, reason: 'queue_pressure' as const })
  }
  const existing = database.prepare(`
    SELECT job_wire FROM memory_extraction_jobs WHERE job_id = ?
  `).get(job.jobId)
  if (existing !== undefined) {
    if (exactString(rowValue(existing, 'job_wire')) !== wire) {
      throw new MemoryExtractionQueueDataErrorV1()
    }
    return Object.freeze({ status: 'unchanged' as const })
  }
  const enqueuedAtMs = Date.parse(job.enqueuedAt)
  if (nowMs - enqueuedAtMs > MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionJobMaximumAgeMs ||
    enqueuedAtMs - nowMs > MAXIMUM_FUTURE_SKEW_MS) {
    return Object.freeze({ status: 'rejected' as const, reason: 'expired' as const })
  }
  let usage = queueUsage(database)
  const overCapacity = (): boolean =>
    usage.records + 1 > MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueRecords ||
    usage.logicalBytes + logicalBytes >
      MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionQueueLogicalBytes
  let shed = 0
  if (overCapacity() && job.priority === 'asserted') {
    shed = shedInferred(database, logicalBytes)
    usage = queueUsage(database)
  }
  if (overCapacity()) {
    return Object.freeze({ status: 'rejected' as const, reason: 'queue_pressure' as const })
  }
  const inserted = database.prepare(`
    INSERT INTO memory_extraction_jobs(
      job_id, namespace_ref, namespace_generation, priority, enqueued_at_ms,
      available_at_ms, job_wire, logical_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.jobId,
    job.namespaceRef,
    job.namespaceGeneration,
    job.priority,
    enqueuedAtMs,
    enqueuedAtMs,
    wire,
    logicalBytes
  )
  if (inserted.changes !== 1) throw new MemoryExtractionQueueDataErrorV1()
  return Object.freeze({
    status: 'stored' as const,
    ...(shed === 0 ? {} : { shedInferredJobs: shed })
  })
}

function claimedJob (row: Readonly<Record<string, SQLOutValue>>): MemoryExtractionJobV1 {
  const job = decodeMemoryExtractionJobV1(exactString(rowValue(row, 'job_wire')))
  const logicalBytes = exactInteger(rowValue(row, 'logical_bytes'))
  if (job.jobId !== exactString(rowValue(row, 'job_id')) ||
    job.namespaceRef !== exactString(rowValue(row, 'namespace_ref')) ||
    job.namespaceGeneration !== exactInteger(rowValue(row, 'namespace_generation')) ||
    job.priority !== exactString(rowValue(row, 'priority')) ||
    Date.parse(job.enqueuedAt) !== exactInteger(rowValue(row, 'enqueued_at_ms')) ||
    Buffer.byteLength(encodeMemoryExtractionJobV1(job), 'utf8') !== logicalBytes) {
    throw new MemoryExtractionQueueDataErrorV1()
  }
  return job
}

type SQLOutValue = SQLOutputValue

function claimJobs (
  database: DatabaseSync,
  owner: string,
  limit: number,
  nowMs: number,
  tokenSource: () => string
): MemoryExtractionQueueClaimResultV1 {
  const rows = database.prepare(`
    SELECT job_id, namespace_ref, namespace_generation, priority, enqueued_at_ms,
      job_wire, logical_bytes, attempt_count
    FROM memory_extraction_jobs
    WHERE available_at_ms <= ? AND attempt_count < ?
      AND (lease_owner_id IS NULL OR leased_until_ms <= ?)
    ORDER BY CASE priority WHEN 'asserted' THEN 0 ELSE 1 END ASC, sequence ASC
    LIMIT ?
  `).all(
    nowMs,
    MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionWorkerMaximumAttempts,
    nowMs,
    limit
  )
  if (rows.length === 0) return Object.freeze({ status: 'empty' as const })
  const jobs = Object.freeze(rows.map(claimedJob))
  const attemptCounts = Object.freeze(rows.map(row => exactInteger(rowValue(row, 'attempt_count'))))
  let rawToken: unknown
  try { rawToken = Reflect.apply(tokenSource, undefined, []) } catch { return invalidMemoryValue() }
  if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/.test(rawToken)) {
    return invalidMemoryValue()
  }
  const leaseToken = `candidate-lease:v1:${rawToken}`
  const leasedUntilMs = nowMs + MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionLeaseDurationMs
  if (!Number.isSafeInteger(leasedUntilMs)) throw new MemoryExtractionQueueDataErrorV1()
  for (const job of jobs) {
    const updated = database.prepare(`
      UPDATE memory_extraction_jobs
      SET lease_owner_id = ?, lease_token = ?, leased_until_ms = ?
      WHERE job_id = ? AND available_at_ms <= ? AND attempt_count < ?
        AND (lease_owner_id IS NULL OR leased_until_ms <= ?)
    `).run(
      owner,
      leaseToken,
      leasedUntilMs,
      job.jobId,
      nowMs,
      MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionWorkerMaximumAttempts,
      nowMs
    )
    if (updated.changes !== 1) throw new MemoryExtractionQueueDataErrorV1()
  }
  return Object.freeze({
    status: 'claimed' as const,
    ownerId: owner,
    leaseToken,
    leasedUntil: new Date(leasedUntilMs).toISOString(),
    jobs,
    attemptCounts
  })
}

function activeLease (
  database: DatabaseSync,
  request: MemoryExtractionLeaseMutationV1,
  nowMs: number
): Readonly<Record<string, SQLOutputValue>> | null {
  const row = database.prepare(`
    SELECT attempt_count FROM memory_extraction_jobs
    WHERE job_id = ? AND lease_owner_id = ? AND lease_token = ? AND leased_until_ms > ?
  `).get(request.jobId, request.ownerId, request.leaseToken, nowMs)
  return row ?? null
}

function deleteLeased (
  database: DatabaseSync,
  request: MemoryExtractionLeaseMutationV1,
  nowMs: number,
  status: 'acked' | 'dead_lettered'
): MemoryExtractionQueueMutationResultV1 {
  if (activeLease(database, request, nowMs) === null) {
    return Object.freeze({ status: 'lease_conflict' as const })
  }
  const deleted = database.prepare(`
    DELETE FROM memory_extraction_jobs
    WHERE job_id = ? AND lease_owner_id = ? AND lease_token = ? AND leased_until_ms > ?
  `).run(request.jobId, request.ownerId, request.leaseToken, nowMs)
  if (deleted.changes !== 1) throw new MemoryExtractionQueueDataErrorV1()
  return Object.freeze({ status })
}

function retryLeased (
  database: DatabaseSync,
  request: MemoryExtractionRetryV1,
  nowMs: number
): MemoryExtractionQueueMutationResultV1 {
  const row = activeLease(database, request, nowMs)
  if (row === null) return Object.freeze({ status: 'lease_conflict' as const })
  const attemptCount = exactInteger(rowValue(row, 'attempt_count'))
  const nextAttempt = attemptCount + 1
  if (nextAttempt >= MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionWorkerMaximumAttempts) {
    return Object.freeze({ status: 'attempts_exhausted' as const })
  }
  const retryAtMs = Date.parse(request.retryAt)
  const retryDelays = [5_000, 30_000, 120_000, 600_000] as const
  if (retryAtMs !== nowMs + (retryDelays[attemptCount] ?? 600_000) ||
    !Number.isSafeInteger(retryAtMs)) return invalidMemoryValue()
  const updated = database.prepare(`
    UPDATE memory_extraction_jobs
    SET available_at_ms = ?, lease_owner_id = NULL, lease_token = NULL,
      leased_until_ms = NULL, attempt_count = ?, last_reason_code = ?
    WHERE job_id = ? AND lease_owner_id = ? AND lease_token = ?
      AND leased_until_ms > ? AND attempt_count = ?
  `).run(
    retryAtMs,
    nextAttempt,
    request.reasonCode,
    request.jobId,
    request.ownerId,
    request.leaseToken,
    nowMs,
    attemptCount
  )
  if (updated.changes !== 1) throw new MemoryExtractionQueueDataErrorV1()
  return Object.freeze({ status: 'retried' as const, attemptCount: nextAttempt })
}

function recordAudit (
  database: DatabaseSync,
  audit: MemoryCandidateAuditInputV1
): MemoryCandidateAuditResultV1 {
  const existing = database.prepare(`
    SELECT job_id, candidate_hash, provenance_hash, outcome, reason_code,
      proposal_id, recorded_at_ms
    FROM memory_candidate_audits WHERE audit_id = ?
  `).get(audit.auditId)
  if (existing !== undefined) {
    if (exactString(rowValue(existing, 'job_id')) !== audit.jobId ||
      rowValue(existing, 'candidate_hash') !== audit.candidateHash ||
      rowValue(existing, 'provenance_hash') !== audit.provenanceHash ||
      exactString(rowValue(existing, 'outcome')) !== audit.outcome ||
      exactString(rowValue(existing, 'reason_code')) !== audit.reasonCode ||
      rowValue(existing, 'proposal_id') !== audit.proposalId ||
      exactInteger(rowValue(existing, 'recorded_at_ms')) !== Date.parse(audit.recordedAt)) {
      throw new MemoryExtractionQueueDataErrorV1()
    }
    return Object.freeze({ status: 'unchanged' as const })
  }
  const inserted = database.prepare(`
    INSERT INTO memory_candidate_audits(
      audit_id, job_id, candidate_hash, provenance_hash, outcome, reason_code,
      proposal_id, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audit.auditId,
    audit.jobId,
    audit.candidateHash,
    audit.provenanceHash,
    audit.outcome,
    audit.reasonCode,
    audit.proposalId,
    Date.parse(audit.recordedAt)
  )
  if (inserted.changes !== 1) throw new MemoryExtractionQueueDataErrorV1()
  database.prepare(`
    DELETE FROM memory_candidate_audits
    WHERE sequence IN (
      SELECT sequence FROM memory_candidate_audits
      ORDER BY sequence DESC
      LIMIT -1 OFFSET ${MEMORY_DERIVATIVE_RESOURCE_LIMITS.candidateAuditRecords}
    )
  `).run()
  return Object.freeze({ status: 'stored' as const })
}

export function createSqliteMemoryExtractionQueueV1 (
  optionsValue: CreateSqliteMemoryExtractionQueueOptionsV1
): SqliteMemoryExtractionQueueV1 {
  const options = parseOptions(optionsValue)
  initializeSchema(options.database)

  return Object.freeze({
    async enqueue (jobValue: unknown, signal?: AbortSignal) {
      const job = parseMemoryExtractionJobV1(jobValue)
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      if (memoryCredentialRejectionReasonV1(job.source.normalizedText) !== null ||
        memoryCredentialRejectionReasonV1(job.assistantReply) !== null) {
        return Object.freeze({ status: 'rejected' as const, reason: 'credential' as const })
      }
      const now = readNow(options.now)
      try {
        return transact(options.database, () => enqueueJob(options.database, job, now.milliseconds))
      } catch (error) {
        return unavailable(error)
      }
    },

    async claim (ownerValue: unknown, limitValue: unknown, signal?: AbortSignal) {
      const owner = workerId(ownerValue)
      const limit = positiveLimit(limitValue)
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      const now = readNow(options.now)
      try {
        return transact(options.database, () => claimJobs(
          options.database, owner, limit, now.milliseconds, options.leaseToken
        ))
      } catch (error) {
        return unavailable(error)
      }
    },

    async ack (requestValue: unknown, signal?: AbortSignal) {
      const request = parseLeaseMutation(requestValue)
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      const now = readNow(options.now)
      try {
        return transact(options.database, () => deleteLeased(
          options.database, request, now.milliseconds, 'acked'
        ))
      } catch (error) {
        return unavailable(error)
      }
    },

    async retry (requestValue: unknown, signal?: AbortSignal) {
      const request = parseRetry(requestValue)
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      const now = readNow(options.now)
      try {
        return transact(options.database, () => retryLeased(
          options.database, request, now.milliseconds
        ))
      } catch (error) {
        return unavailable(error)
      }
    },

    async deadLetter (requestValue: unknown, signal?: AbortSignal) {
      const request = parseLeaseMutation(requestValue)
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      const now = readNow(options.now)
      try {
        return transact(options.database, () => deleteLeased(
          options.database, request, now.milliseconds, 'dead_lettered'
        ))
      } catch (error) {
        return unavailable(error)
      }
    },

    async usage (signal?: AbortSignal) {
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      const now = readNow(options.now)
      try {
        const usage = queueUsage(options.database)
        const leased = options.database.prepare(`
          SELECT count(*) AS count FROM memory_extraction_jobs
          WHERE lease_owner_id IS NOT NULL AND leased_until_ms > ?
        `).get(now.milliseconds)
        return Object.freeze({
          status: 'usage' as const,
          pendingRecords: usage.records,
          leasedRecords: exactInteger(rowValue(leased, 'count')),
          logicalBytes: usage.logicalBytes
        })
      } catch (error) {
        return unavailable(error)
      }
    },

    async recordAudit (auditValue: unknown, signal?: AbortSignal) {
      const audit = parseAuditInput(auditValue)
      if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
      try {
        return transact(options.database, () => recordAudit(options.database, audit))
      } catch (error) {
        return unavailable(error)
      }
    }
  })
}

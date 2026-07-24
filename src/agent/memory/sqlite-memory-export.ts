import { createHash, randomBytes } from 'node:crypto'
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync
} from 'node:fs'
import {
  link,
  lstat,
  open,
  rename,
  unlink
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types as utilTypes } from 'node:util'
import {
  memoryAccessCapabilityAllowsV1
} from './memory-access-gate.js'
import {
  memoryLifecycleActorCapabilityAllowsV1
} from './memory-lifecycle-authority.js'
import {
  decodeMemoryProposalV2,
  decodeMemoryRevisionV2,
  decodeMemoryLifecycleAuditV1,
  encodeMemoryLifecycleAuditV1
} from './memory-lifecycle-codec.js'
import {
  createMemoryLifecycleAuditV1,
  memoryLifecycleDomainHashV1,
  parseMemoryLifecycleInstantV1,
  type MemoryLifecycleAuditV1
} from './memory-lifecycle-domain.js'
import {
  decodeMemoryTombstoneV1
} from './memory-codec.js'
import {
  acquireMemoryExportGenerateAttemptV1,
  createMemoryExportStableResultV1,
  decodeMemoryExportCommandWireV1,
  decodeMemoryExportStableResultWireV1,
  deriveMemoryExportIdV1,
  encodeMemoryExportStableResultWireV1,
  memoryExportClaimReceiptHashV1,
  memoryExportCommandHashV1,
  memoryExportCommandRefHashV1,
  memoryExportDeliveryRefHashV1,
  memoryExportStableResultHashV1,
  MEMORY_EXPORT_EXCLUSIONS_HASH_V1,
  MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
  MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
  type MemoryExportAuthorizationEnvelopeV1,
  type MemoryExportBoundedSinkV1,
  type MemoryExportConsumedDeliveryV1,
  type MemoryExportDeliverableManifestV1,
  type MemoryExportFailedManifestV1,
  type MemoryExportGenerateAttemptV1,
  type MemoryExportGenerateFinalizeOutcomeV1,
  type MemoryExportGenerateFinalizeResultV1,
  type MemoryExportPersistentDeliveryAdapterV1,
  type MemoryExportPortOptionsV1,
  type MemoryExportPreparedManifestV1,
  type MemoryExportSnapshotSourceV1,
  type MemoryExportStableResultV1
} from './memory-export-port.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  parseMemoryNamespaceRefV1
} from './memory-namespace.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS
} from './memory-resource-limits.js'

export const MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1 = 256 * 1_024 * 1_024
export const MEMORY_EXPORT_LEASE_TTL_MS_V1 = 5 * 60 * 1_000
export const MEMORY_EXPORT_CLEANUP_BATCH_V1 = 32

const EXPORT_REF_HASH_DOMAIN_V1 = 'groupmate.memory.export-ref.v1'
const EXPORT_ACTOR_REF_HASH_DOMAIN_V1 = 'groupmate.memory.export-actor-ref.v1'
const EXPORT_DELIVERY_REF_DOMAIN_V1 = 'groupmate.memory.export-delivery.v1'
const HASH_PATTERN = /^[0-9a-f]{64}$/
const EXPORT_ID_PATTERN = /^export:[0-9a-f]{64}$/
const DELIVERY_REF_PATTERN = /^delivery:[0-9a-f]{64}$/
const LEASE_OWNER_PATTERN = /^[\x21-\x7e]{1,128}$/
const LEASE_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const ARTIFACT_TOKEN_PATTERN =
  /^memory-export-v1-([0-9a-f]{64})-([1-9][0-9]*)-([0-9a-f]{64})\.jsonl$/
const MAX_ARTIFACT_DIRECTORY_ENTRIES = 2_048
const LIFECYCLE_AUDIT_RECORDS_PER_NAMESPACE = 8_192
const LIFECYCLE_AUDIT_BYTES_PER_NAMESPACE = 8 * 1_024 * 1_024
const LIFECYCLE_AUDIT_RECORDS_PER_DEPLOYMENT = 65_536
const LIFECYCLE_AUDIT_BYTES_PER_DEPLOYMENT = 64 * 1_024 * 1_024

type Row = Readonly<Record<string, SQLOutputValue>>

export interface CreateSqliteMemoryExportAdapterOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
  readonly artifactDirectory: string
  readonly leaseOwnerId: string
  readonly artifactCapacityBytes?: number
  readonly consumeArtifact: (
    source: MemoryExportSnapshotSourceV1,
    manifest: MemoryExportDeliverableManifestV1
  ) => Promise<void>
}

export interface SqliteMemoryExportCleanupResultV1 {
  readonly deletedJobs: number
  readonly deletedArtifacts: number
  readonly hasMore: boolean
}

export interface SqliteMemoryExportAdapterV1 {
  readonly execute: MemoryExportPortOptionsV1['execute']
  readonly cleanupPartial: MemoryExportPortOptionsV1['cleanupPartial']
  readonly finalizeGenerate: MemoryExportPortOptionsV1['finalizeGenerate']
  readonly persistentDelivery: MemoryExportPersistentDeliveryAdapterV1
  readonly cleanupExpired: (limit?: number) => Promise<SqliteMemoryExportCleanupResultV1>
}

interface ParsedOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
  readonly artifactDirectory: string
  readonly leaseOwnerId: string
  readonly artifactCapacityBytes: number
  readonly consumeArtifact: CreateSqliteMemoryExportAdapterOptionsV1['consumeArtifact']
}

interface JobFieldsV1 {
  readonly exportId: string
  readonly namespaceRef: string
  readonly namespaceGeneration: number
  readonly contentEpoch: number
  readonly state: 'prepared' | 'writing' | 'deliverable' | 'delivered' | 'failed'
  readonly preparedCommandHash: string
  readonly terminalCommandHash: string | null
  readonly leaseOwnerId: string | null
  readonly leaseToken: string | null
  readonly fencingToken: number
  readonly leasedUntilMs: number | null
  readonly manifestWire: string | null
  readonly artifactToken: string | null
  readonly claimCommandHash: string | null
  readonly deliveryRefHash: string | null
  readonly claimReceiptHash: string | null
  readonly preparedAtMs: number
  readonly terminalAtMs: number | null
  readonly deliveredAtMs: number | null
  readonly expiresAtMs: number
}

interface AttemptStateV1 {
  readonly envelope: MemoryExportAuthorizationEnvelopeV1
  readonly commandHash: string
  readonly commandRefHash: string
  readonly initiatedByActorRef: string
  readonly namespaceRef: string
  readonly namespaceGeneration: number
  readonly exportId: string
  readonly contentEpoch: number
  readonly snapshotAt: string
  readonly artifactExpiresAt: string
  readonly expectedSnapshotSha256: string | null
  readonly leaseOwnerId: string
  readonly leaseToken: string
  readonly fencingToken: number
  artifactToken: string
  terminal: Exclude<MemoryExportStableResultV1, MemoryExportPreparedManifestV1> | null
}

class CanonicalExportDataErrorV1 extends Error {}
class ExportArtifactCapacityErrorV1 extends Error {}
class ExportAbortedErrorV1 extends Error {}
class ExportArtifactErrorV1 extends Error {}
class ExportCanonicalCapacityErrorV1 extends Error {}

const require = createRequire(import.meta.url)
let sqliteDatabaseConstructor: typeof import('node:sqlite').DatabaseSync | undefined

function databaseConstructor (): typeof import('node:sqlite').DatabaseSync {
  if (sqliteDatabaseConstructor !== undefined) return sqliteDatabaseConstructor
  const sqlite = require('node:sqlite') as typeof import('node:sqlite')
  sqliteDatabaseConstructor = sqlite.DatabaseSync
  return sqliteDatabaseConstructor
}

function rowValue (row: Row, name: string): SQLOutputValue {
  if (!Object.hasOwn(row, name)) throw new CanonicalExportDataErrorV1()
  return row[name]
}

function exactString (value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new CanonicalExportDataErrorV1()
  return value
}

function nullableString (value: SQLOutputValue): string | null {
  if (value === null) return null
  return exactString(value)
}

function exactInteger (value: SQLOutputValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new CanonicalExportDataErrorV1()
  return value
}

function positiveInteger (value: SQLOutputValue): number {
  const result = exactInteger(value)
  if (result === 0) throw new CanonicalExportDataErrorV1()
  return result
}

function nullableInteger (value: SQLOutputValue): number | null {
  return value === null ? null : exactInteger(value)
}

function exactHash (value: SQLOutputValue): string {
  const result = exactString(value)
  if (!HASH_PATTERN.test(result)) throw new CanonicalExportDataErrorV1()
  return result
}

function nullableHash (value: SQLOutputValue): string | null {
  return value === null ? null : exactHash(value)
}

function requireOneChange (changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new CanonicalExportDataErrorV1()
}

function byteLength (value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function canonicalTime (value: unknown): string {
  try {
    return parseMemoryLifecycleInstantV1(value)
  } catch {
    throw new CanonicalExportDataErrorV1()
  }
}

function addMilliseconds (instant: string, durationMs: number): string {
  const result = new Date(Date.parse(instant) + durationMs)
  if (!Number.isFinite(result.getTime())) throw new CanonicalExportDataErrorV1()
  return result.toISOString()
}

function parseOptions (value: CreateSqliteMemoryExportAdapterOptionsV1): ParsedOptionsV1 {
  const input = inspectMemoryRecord(value, [
    'database', 'now', 'artifactDirectory', 'leaseOwnerId', 'consumeArtifact'
  ], ['artifactCapacityBytes'])
  const database = input.database
  const capacity = input.artifactCapacityBytes ?? MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1
  if (database === null || typeof database !== 'object' || utilTypes.isProxy(database) ||
    typeof (database as DatabaseSync).prepare !== 'function' ||
    typeof (database as DatabaseSync).exec !== 'function' ||
    typeof input.now !== 'function' || utilTypes.isProxy(input.now) ||
    typeof input.consumeArtifact !== 'function' || utilTypes.isProxy(input.consumeArtifact) ||
    typeof input.artifactDirectory !== 'string' || input.artifactDirectory.length === 0 ||
    input.artifactDirectory.length > 4_096 || input.artifactDirectory.includes('\0') ||
    typeof input.leaseOwnerId !== 'string' || !LEASE_OWNER_PATTERN.test(input.leaseOwnerId) ||
    typeof capacity !== 'number' || !Number.isSafeInteger(capacity) ||
    capacity < MEMORY_EXPORT_MAX_WIRE_BYTES_V1 ||
    capacity > 1_024 * 1_024 * 1_024) return invalidMemoryValue()
  return Object.freeze({
    database: database as DatabaseSync,
    now: input.now as () => string,
    artifactDirectory: input.artifactDirectory,
    leaseOwnerId: input.leaseOwnerId,
    artifactCapacityBytes: capacity,
    consumeArtifact: input.consumeArtifact as ParsedOptionsV1['consumeArtifact']
  })
}

function ensureArtifactDirectory (directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ExportArtifactErrorV1()
  if ((info.mode & 0o777) !== 0o700) {
    const descriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.fchmodSync(descriptor, 0o700)
    } finally {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.closeSync(descriptor)
    }
  }
}

function artifactToken (
  exportId: string,
  fencingToken: number,
  artifactSha256 = '0'.repeat(64)
): string {
  if (!EXPORT_ID_PATTERN.test(exportId) || !Number.isSafeInteger(fencingToken) ||
    fencingToken <= 0 || !HASH_PATTERN.test(artifactSha256)) {
    throw new CanonicalExportDataErrorV1()
  }
  return `memory-export-v1-${exportId.slice('export:'.length)}-${fencingToken}-${artifactSha256}.jsonl`
}

function artifactPaths (directory: string, token: string) {
  if (!ARTIFACT_TOKEN_PATTERN.test(token)) throw new CanonicalExportDataErrorV1()
  return Object.freeze({
    final: join(directory, token),
    partial: join(directory, `${token}.partial`),
    redeeming: join(directory, `${token}.redeeming`),
    lock: join(directory, `${token}.lock`)
  })
}

function artifactDirectoryBytes (directory: string): number {
  const names = readdirSync(directory)
  if (names.length > MAX_ARTIFACT_DIRECTORY_ENTRIES) throw new ExportArtifactCapacityErrorV1()
  let total = 0
  for (const name of names) {
    const base = name.replace(/\.(partial|redeeming|lock)$/, '')
    if (!ARTIFACT_TOKEN_PATTERN.test(base)) throw new ExportArtifactErrorV1()
    const info = lstatSync(join(directory, name))
    if (!info.isFile() || info.isSymbolicLink()) throw new ExportArtifactErrorV1()
    if (!name.endsWith('.lock')) total += info.size
    if (!Number.isSafeInteger(total)) throw new ExportArtifactCapacityErrorV1()
  }
  return total
}

class SecureArtifactSinkV1 implements MemoryExportBoundedSinkV1 {
  readonly maximumWireBytes = MEMORY_EXPORT_MAX_WIRE_BYTES_V1
  readonly maximumChunkBytes = MEMORY_EXPORT_MAX_CHUNK_BYTES_V1
  readonly #partialPath: string
  readonly #finalPath: string
  readonly #directory: string
  readonly #capacityRemaining: number
  readonly #hash = createHash('sha256')
  #file: Awaited<ReturnType<typeof open>> | null
  #wireBytes = 0
  #committed = false

  private constructor (
    directory: string,
    partialPath: string,
    finalPath: string,
    capacityRemaining: number,
    file: Awaited<ReturnType<typeof open>>
  ) {
    this.#directory = directory
    this.#partialPath = partialPath
    this.#finalPath = finalPath
    this.#capacityRemaining = capacityRemaining
    this.#file = file
  }

  static async create (
    directory: string,
    token: string,
    capacityRemaining: number
  ): Promise<SecureArtifactSinkV1> {
    const paths = artifactPaths(directory, token)
    const file = await open(
      paths.partial,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    )
    await file.chmod(0o600)
    return new SecureArtifactSinkV1(
      directory,
      paths.partial,
      paths.final,
      capacityRemaining,
      file
    )
  }

  get wireBytes (): number {
    return this.#wireBytes
  }

  digest (): string {
    if (!this.#committed) throw new ExportArtifactErrorV1()
    return this.#hash.digest('hex')
  }

  async write (chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.#file === null || this.#committed || signal?.aborted === true ||
      !(chunk instanceof Uint8Array) || chunk.byteLength === 0 ||
      chunk.byteLength > this.maximumChunkBytes) {
      if (signal?.aborted === true) throw new ExportAbortedErrorV1()
      throw new ExportArtifactErrorV1()
    }
    const next = this.#wireBytes + chunk.byteLength
    if (next > this.maximumWireBytes || next > this.#capacityRemaining) {
      throw new ExportArtifactCapacityErrorV1()
    }
    let offset = 0
    while (offset < chunk.byteLength) {
      const written = await this.#file.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        this.#wireBytes + offset
      )
      if (written.bytesWritten <= 0) throw new ExportArtifactErrorV1()
      offset += written.bytesWritten
    }
    this.#hash.update(chunk)
    this.#wireBytes = next
  }

  async commit (): Promise<void> {
    if (this.#file === null || this.#committed || this.#wireBytes === 0) {
      throw new ExportArtifactErrorV1()
    }
    await this.#file.sync()
    await this.#file.chmod(0o600)
    await this.#file.close()
    this.#file = null
    await link(this.#partialPath, this.#finalPath)
    await unlink(this.#partialPath)
    const directory = await open(
      this.#directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY
    )
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    this.#committed = true
  }

  async abort (): Promise<void> {
    const file = this.#file
    this.#file = null
    if (file !== null) {
      try {
        await file.close()
      } catch {
      }
    }
    try {
      await unlink(this.#partialPath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

class FileArtifactSourceV1 implements MemoryExportSnapshotSourceV1 {
  #file: Awaited<ReturnType<typeof open>> | null
  #streamed = false

  constructor (file: Awaited<ReturnType<typeof open>>) {
    this.#file = file
  }

  async streamInto (sink: MemoryExportBoundedSinkV1, signal?: AbortSignal): Promise<void> {
    const file = this.#file
    if (file === null || this.#streamed) throw new ExportArtifactErrorV1()
    this.#streamed = true
    const stream = file.createReadStream({
      autoClose: false,
      start: 0,
      highWaterMark: MEMORY_EXPORT_MAX_CHUNK_BYTES_V1
    })
    try {
      for await (const value of stream) {
        if (signal?.aborted === true) throw new ExportAbortedErrorV1()
        await sink.write(value as Buffer, signal)
      }
    } catch (error) {
      stream.destroy()
      throw error
    }
  }

  async close (): Promise<void> {
    const file = this.#file
    this.#file = null
    if (file !== null) await file.close()
  }
}

function isMissing (error: unknown): boolean {
  return error !== null && typeof error === 'object' &&
    Object.hasOwn(error, 'code') && (error as { code?: unknown }).code === 'ENOENT'
}

function isBusy (error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !Object.hasOwn(error, 'code')) return false
  const code = (error as { code?: unknown }).code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
}

function removeIfPresent (path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function cleanArtifactPaths (directory: string, token: string): number {
  const paths = artifactPaths(directory, token)
  let deleted = 0
  for (const path of [paths.partial, paths.final, paths.redeeming, paths.lock]) {
    if (removeIfPresent(path)) deleted += 1
  }
  return deleted
}

function cleanArtifactFence (directory: string, exportId: string, fencingToken: number): number {
  const prefix = `memory-export-v1-${exportId.slice('export:'.length)}-${fencingToken}-`
  const tokens = new Set<string>()
  for (const name of readdirSync(directory)) {
    const base = name.replace(/\.(partial|redeeming|lock)$/, '')
    if (base.startsWith(prefix) && ARTIFACT_TOKEN_PATTERN.test(base)) tokens.add(base)
  }
  let deleted = 0
  for (const token of tokens) deleted += cleanArtifactPaths(directory, token)
  return deleted
}

async function syncArtifactDirectory (directoryPath: string): Promise<void> {
  const directory = await open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY
  )
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function freezeTrustedNow (database: DatabaseSync, now: () => string): string {
  const wall = canonicalTime(Reflect.apply(now, undefined, []))
  const row = database.prepare(`
    SELECT trusted_time_high_water_ms
    FROM lifecycle_deployment_state WHERE singleton = 1
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalExportDataErrorV1()
  const persisted = exactInteger(rowValue(row, 'trusted_time_high_water_ms'))
  const trustedMs = Math.max(Date.parse(wall), persisted)
  const trusted = new Date(trustedMs)
  if (!Number.isFinite(trusted.getTime())) throw new CanonicalExportDataErrorV1()
  if (trustedMs > persisted) {
    requireOneChange(database.prepare(`
      UPDATE lifecycle_deployment_state SET trusted_time_high_water_ms = ?
      WHERE singleton = 1 AND trusted_time_high_water_ms = ?
    `).run(trustedMs, persisted).changes)
  }
  return trusted.toISOString()
}

const USAGE_FIELDS = Object.freeze([
  'pending_proposal_records', 'active_memory_records', 'retained_revision_records',
  'tombstone_records', 'canonical_logical_bytes', 'pending_outbox_records',
  'outbox_logical_bytes', 'lifecycle_audit_records',
  'lifecycle_audit_reserved_records', 'lifecycle_command_records',
  'deletion_checkpoint_records', 'export_job_records', 'lifecycle_audit_logical_bytes',
  'lifecycle_audit_reserved_bytes', 'lifecycle_command_logical_bytes',
  'deletion_checkpoint_logical_bytes', 'export_job_logical_bytes'
])

const GLOBAL_USAGE_FIELDS = Object.freeze([
  'namespace_records', ...USAGE_FIELDS
])

function generationUsageActual (
  database: DatabaseSync,
  namespaceRef: string,
  generation: number
): Row {
  const row = database.prepare(`
    WITH target(namespace_ref, namespace_generation) AS (VALUES (?, ?))
    SELECT
      (SELECT count(*) FROM proposals p, target t WHERE p.namespace_ref = t.namespace_ref
        AND p.namespace_generation = t.namespace_generation AND p.state = 'pending')
        AS pending_proposal_records,
      (SELECT count(*) FROM heads h, target t WHERE h.namespace_ref = t.namespace_ref
        AND h.namespace_generation = t.namespace_generation) AS active_memory_records,
      (SELECT count(*) FROM revisions r, target t WHERE r.namespace_ref = t.namespace_ref
        AND r.namespace_generation = t.namespace_generation) AS retained_revision_records,
      (SELECT count(*) FROM tombstones x, target t WHERE x.namespace_ref = t.namespace_ref
        AND x.namespace_generation = t.namespace_generation) AS tombstone_records,
      coalesce((SELECT namespace_wire_bytes FROM namespaces n, target t
        WHERE n.namespace_ref = t.namespace_ref
          AND n.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(proposal_wire_bytes) FROM proposals p, target t
        WHERE p.namespace_ref = t.namespace_ref
          AND p.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(revision_wire_bytes) FROM revisions r, target t
        WHERE r.namespace_ref = t.namespace_ref
          AND r.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(tombstone_wire_bytes) FROM tombstones x, target t
        WHERE x.namespace_ref = t.namespace_ref
          AND x.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(manifest_wire_bytes) FROM memory_v1_to_v2_manifests m, target t
        WHERE m.namespace_ref = t.namespace_ref
          AND m.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(evidence_wire_bytes) FROM consent_evidence e, target t
        WHERE e.namespace_ref = t.namespace_ref
          AND e.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(evidence_wire_bytes) FROM revision_evidence e, target t
        WHERE e.namespace_ref = t.namespace_ref
          AND e.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(audit_wire_bytes) FROM lifecycle_audits a, target t
        WHERE a.namespace_ref = t.namespace_ref
          AND a.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands c, target t
        WHERE c.namespace_ref = t.namespace_ref
          AND c.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(checkpoint_wire_bytes) FROM namespace_deletion_checkpoints d, target t
        WHERE d.namespace_ref = t.namespace_ref
          AND d.deleting_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(job_wire_bytes) FROM export_jobs j, target t
        WHERE j.namespace_ref = t.namespace_ref
          AND j.namespace_generation = t.namespace_generation), 0) +
      coalesce((SELECT sum(reservation_wire_bytes) FROM export_audit_reservations e, target t
        WHERE e.namespace_ref = t.namespace_ref
          AND e.namespace_generation = t.namespace_generation), 0) AS canonical_logical_bytes,
      (SELECT count(*) FROM outbox o, target t WHERE o.namespace_ref = t.namespace_ref
        AND o.namespace_generation = t.namespace_generation) AS pending_outbox_records,
      coalesce((SELECT sum(logical_bytes) FROM outbox o, target t
        WHERE o.namespace_ref = t.namespace_ref
          AND o.namespace_generation = t.namespace_generation), 0) AS outbox_logical_bytes,
      (SELECT count(*) FROM lifecycle_audits a, target t WHERE a.namespace_ref = t.namespace_ref
        AND a.namespace_generation = t.namespace_generation) AS lifecycle_audit_records,
      coalesce((SELECT sum(reserved_records) FROM export_audit_reservations e, target t
        WHERE e.namespace_ref = t.namespace_ref
          AND e.namespace_generation = t.namespace_generation), 0)
        AS lifecycle_audit_reserved_records,
      (SELECT count(*) FROM lifecycle_commands c, target t WHERE c.namespace_ref = t.namespace_ref
        AND c.namespace_generation = t.namespace_generation) AS lifecycle_command_records,
      (SELECT count(*) FROM namespace_deletion_checkpoints d, target t
        WHERE d.namespace_ref = t.namespace_ref
          AND d.deleting_generation = t.namespace_generation) AS deletion_checkpoint_records,
      (SELECT count(*) FROM export_jobs j, target t WHERE j.namespace_ref = t.namespace_ref
        AND j.namespace_generation = t.namespace_generation) AS export_job_records,
      coalesce((SELECT sum(audit_wire_bytes) FROM lifecycle_audits a, target t
        WHERE a.namespace_ref = t.namespace_ref
          AND a.namespace_generation = t.namespace_generation), 0)
        AS lifecycle_audit_logical_bytes,
      coalesce((SELECT sum(reserved_bytes) FROM export_audit_reservations e, target t
        WHERE e.namespace_ref = t.namespace_ref
          AND e.namespace_generation = t.namespace_generation), 0)
        AS lifecycle_audit_reserved_bytes,
      coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands c, target t
        WHERE c.namespace_ref = t.namespace_ref
          AND c.namespace_generation = t.namespace_generation), 0)
        AS lifecycle_command_logical_bytes,
      coalesce((SELECT sum(checkpoint_wire_bytes) FROM namespace_deletion_checkpoints d, target t
        WHERE d.namespace_ref = t.namespace_ref
          AND d.deleting_generation = t.namespace_generation), 0)
        AS deletion_checkpoint_logical_bytes,
      coalesce((SELECT sum(job_wire_bytes) FROM export_jobs j, target t
        WHERE j.namespace_ref = t.namespace_ref
          AND j.namespace_generation = t.namespace_generation), 0)
        AS export_job_logical_bytes
  `).get(namespaceRef, generation) as Row | undefined
  if (row === undefined) throw new CanonicalExportDataErrorV1()
  return row
}

function namespaceLifecycleActual (database: DatabaseSync, namespaceRef: string): Row {
  const row = database.prepare(`
    WITH target(namespace_ref) AS (VALUES (?))
    SELECT
      (SELECT count(*) FROM lifecycle_audits a, target t
        WHERE a.namespace_ref = t.namespace_ref) AS lifecycle_audit_records,
      coalesce((SELECT sum(reserved_records) FROM export_audit_reservations e, target t
        WHERE e.namespace_ref = t.namespace_ref), 0) AS lifecycle_audit_reserved_records,
      (SELECT count(*) FROM lifecycle_commands c, target t
        WHERE c.namespace_ref = t.namespace_ref) AS lifecycle_command_records,
      (SELECT count(*) FROM namespace_deletion_checkpoints d, target t
        WHERE d.namespace_ref = t.namespace_ref) AS deletion_checkpoint_records,
      (SELECT count(*) FROM export_jobs j, target t
        WHERE j.namespace_ref = t.namespace_ref) AS export_job_records,
      coalesce((SELECT sum(audit_wire_bytes) FROM lifecycle_audits a, target t
        WHERE a.namespace_ref = t.namespace_ref), 0) AS lifecycle_audit_logical_bytes,
      coalesce((SELECT sum(reserved_bytes) FROM export_audit_reservations e, target t
        WHERE e.namespace_ref = t.namespace_ref), 0) AS lifecycle_audit_reserved_bytes,
      coalesce((SELECT sum(result_wire_bytes) FROM lifecycle_commands c, target t
        WHERE c.namespace_ref = t.namespace_ref), 0) AS lifecycle_command_logical_bytes,
      coalesce((SELECT sum(checkpoint_wire_bytes) FROM namespace_deletion_checkpoints d, target t
        WHERE d.namespace_ref = t.namespace_ref), 0) AS deletion_checkpoint_logical_bytes,
      coalesce((SELECT sum(job_wire_bytes) FROM export_jobs j, target t
        WHERE j.namespace_ref = t.namespace_ref), 0) AS export_job_logical_bytes
  `).get(namespaceRef) as Row | undefined
  if (row === undefined) throw new CanonicalExportDataErrorV1()
  return row
}

function globalUsageActual (database: DatabaseSync): Row {
  const row = database.prepare(`
    SELECT
      (SELECT count(*) FROM namespaces) AS namespace_records,
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending_proposal_records,
      (SELECT count(*) FROM heads) AS active_memory_records,
      (SELECT count(*) FROM revisions) AS retained_revision_records,
      (SELECT count(*) FROM tombstones) AS tombstone_records,
      (SELECT coalesce(sum(namespace_wire_bytes), 0) FROM namespaces) +
      (SELECT coalesce(sum(proposal_wire_bytes), 0) FROM proposals) +
      (SELECT coalesce(sum(revision_wire_bytes), 0) FROM revisions) +
      (SELECT coalesce(sum(tombstone_wire_bytes), 0) FROM tombstones) +
      (SELECT coalesce(sum(manifest_wire_bytes), 0) FROM memory_v1_to_v2_manifests) +
      (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM consent_evidence) +
      (SELECT coalesce(sum(evidence_wire_bytes), 0) FROM revision_evidence) +
      (SELECT coalesce(sum(audit_wire_bytes), 0) FROM lifecycle_audits) +
      (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands) +
      (SELECT coalesce(sum(checkpoint_wire_bytes), 0) FROM namespace_deletion_checkpoints) +
      (SELECT coalesce(sum(job_wire_bytes), 0) FROM export_jobs) +
      (SELECT coalesce(sum(reservation_wire_bytes), 0) FROM export_audit_reservations)
        AS canonical_logical_bytes,
      (SELECT count(*) FROM outbox) AS pending_outbox_records,
      (SELECT coalesce(sum(logical_bytes), 0) FROM outbox) AS outbox_logical_bytes,
      (SELECT count(*) FROM lifecycle_audits) AS lifecycle_audit_records,
      coalesce((SELECT sum(reserved_records) FROM export_audit_reservations), 0)
        AS lifecycle_audit_reserved_records,
      (SELECT count(*) FROM lifecycle_commands) AS lifecycle_command_records,
      (SELECT count(*) FROM namespace_deletion_checkpoints) AS deletion_checkpoint_records,
      (SELECT count(*) FROM export_jobs) AS export_job_records,
      (SELECT coalesce(sum(audit_wire_bytes), 0) FROM lifecycle_audits)
        AS lifecycle_audit_logical_bytes,
      (SELECT coalesce(sum(reserved_bytes), 0) FROM export_audit_reservations)
        AS lifecycle_audit_reserved_bytes,
      (SELECT coalesce(sum(result_wire_bytes), 0) FROM lifecycle_commands)
        AS lifecycle_command_logical_bytes,
      (SELECT coalesce(sum(checkpoint_wire_bytes), 0) FROM namespace_deletion_checkpoints)
        AS deletion_checkpoint_logical_bytes,
      (SELECT coalesce(sum(job_wire_bytes), 0) FROM export_jobs) AS export_job_logical_bytes
  `).get() as Row | undefined
  if (row === undefined) throw new CanonicalExportDataErrorV1()
  return row
}

function assertSameFields (stored: Row, actual: Row, fields: readonly string[]): void {
  for (const field of fields) {
    if (exactInteger(rowValue(stored, field)) !== exactInteger(rowValue(actual, field))) {
      throw new CanonicalExportDataErrorV1()
    }
  }
}

function assertUsageExact (database: DatabaseSync, namespaceRef: string): void {
  const payloads = database.prepare(`
    SELECT (SELECT count(*) FROM revisions) AS revisions,
      (SELECT count(*) FROM revision_payloads) AS payloads,
      (SELECT count(*) FROM revisions r JOIN revision_payloads p
        ON p.namespace_ref = r.namespace_ref
        AND p.namespace_generation = r.namespace_generation
        AND p.memory_id = r.memory_id AND p.revision = r.revision
        WHERE r.revision_wire_bytes = length(CAST(p.revision_wire AS BLOB))) AS valid_payloads
  `).get() as Row | undefined
  if (payloads === undefined ||
    exactInteger(rowValue(payloads, 'revisions')) !== exactInteger(rowValue(payloads, 'payloads')) ||
    exactInteger(rowValue(payloads, 'revisions')) !==
      exactInteger(rowValue(payloads, 'valid_payloads'))) throw new CanonicalExportDataErrorV1()
  const rows = database.prepare(`
    SELECT * FROM usage WHERE namespace_ref = ? ORDER BY namespace_generation ASC
  `).all(namespaceRef) as Row[]
  if (rows.length === 0) throw new CanonicalExportDataErrorV1()
  for (const row of rows) {
    assertSameFields(
      row,
      generationUsageActual(database, namespaceRef, positiveInteger(rowValue(row, 'namespace_generation'))),
      USAGE_FIELDS
    )
  }
  const lifecycle = database.prepare(`
    SELECT * FROM lifecycle_namespace_usage WHERE namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (lifecycle === undefined) throw new CanonicalExportDataErrorV1()
  assertSameFields(lifecycle, namespaceLifecycleActual(database, namespaceRef), USAGE_FIELDS.slice(7))
  const global = database.prepare('SELECT * FROM global_usage WHERE singleton = 1').get() as
    Row | undefined
  if (global === undefined) throw new CanonicalExportDataErrorV1()
  assertSameFields(global, globalUsageActual(database), GLOBAL_USAGE_FIELDS)
}

function synchronizeUsage (database: DatabaseSync, namespaceRef: string, nowMs: number): void {
  const rows = database.prepare(`
    SELECT namespace_generation FROM usage WHERE namespace_ref = ?
    ORDER BY namespace_generation ASC
  `).all(namespaceRef) as Row[]
  for (const row of rows) {
    const generation = positiveInteger(rowValue(row, 'namespace_generation'))
    const actual = generationUsageActual(database, namespaceRef, generation)
    const values = USAGE_FIELDS.map(field => exactInteger(rowValue(actual, field)))
    requireOneChange(database.prepare(`
      UPDATE usage SET pending_proposal_records = ?, active_memory_records = ?,
        retained_revision_records = ?, tombstone_records = ?, canonical_logical_bytes = ?,
        pending_outbox_records = ?, outbox_logical_bytes = ?, lifecycle_audit_records = ?,
        lifecycle_audit_reserved_records = ?, lifecycle_command_records = ?,
        deletion_checkpoint_records = ?, export_job_records = ?,
        lifecycle_audit_logical_bytes = ?, lifecycle_audit_reserved_bytes = ?,
        lifecycle_command_logical_bytes = ?, deletion_checkpoint_logical_bytes = ?,
        export_job_logical_bytes = ?, updated_at_ms = ?
      WHERE namespace_ref = ? AND namespace_generation = ?
    `).run(...values, nowMs, namespaceRef, generation).changes)
  }
  const lifecycle = namespaceLifecycleActual(database, namespaceRef)
  const lifecycleValues = USAGE_FIELDS.slice(7).map(
    field => exactInteger(rowValue(lifecycle, field))
  )
  requireOneChange(database.prepare(`
    UPDATE lifecycle_namespace_usage SET lifecycle_audit_records = ?,
      lifecycle_audit_reserved_records = ?, lifecycle_command_records = ?,
      deletion_checkpoint_records = ?, export_job_records = ?, lifecycle_audit_logical_bytes = ?,
      lifecycle_audit_reserved_bytes = ?, lifecycle_command_logical_bytes = ?,
      deletion_checkpoint_logical_bytes = ?, export_job_logical_bytes = ?, updated_at_ms = ?
    WHERE namespace_ref = ?
  `).run(...lifecycleValues, nowMs, namespaceRef).changes)
  const global = globalUsageActual(database)
  const globalValues = GLOBAL_USAGE_FIELDS.map(field => exactInteger(rowValue(global, field)))
  requireOneChange(database.prepare(`
    UPDATE global_usage SET namespace_records = ?, pending_proposal_records = ?,
      active_memory_records = ?, retained_revision_records = ?, tombstone_records = ?,
      canonical_logical_bytes = ?, pending_outbox_records = ?, outbox_logical_bytes = ?,
      lifecycle_audit_records = ?, lifecycle_audit_reserved_records = ?,
      lifecycle_command_records = ?, deletion_checkpoint_records = ?, export_job_records = ?,
      lifecycle_audit_logical_bytes = ?, lifecycle_audit_reserved_bytes = ?,
      lifecycle_command_logical_bytes = ?, deletion_checkpoint_logical_bytes = ?,
      export_job_logical_bytes = ?, updated_at_ms = ? WHERE singleton = 1
  `).run(...globalValues, nowMs).changes)
}

function capacityAllowed (database: DatabaseSync, namespaceRef: string): boolean {
  const global = globalUsageActual(database)
  if (exactInteger(rowValue(global, 'namespace_records')) > MEMORY_RESOURCE_LIMITS.deploymentNamespaces ||
    exactInteger(rowValue(global, 'active_memory_records')) >
      MEMORY_RESOURCE_LIMITS.deploymentActiveRecords ||
    exactInteger(rowValue(global, 'canonical_logical_bytes')) >
      MEMORY_RESOURCE_LIMITS.deploymentCanonicalLogicalBytes ||
    exactInteger(rowValue(global, 'pending_outbox_records')) >
      MEMORY_RESOURCE_LIMITS.unackedOutboxRecords ||
    exactInteger(rowValue(global, 'outbox_logical_bytes')) >
      MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes ||
    exactInteger(rowValue(global, 'lifecycle_command_records')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerDeployment ||
    exactInteger(rowValue(global, 'lifecycle_command_logical_bytes')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerDeployment ||
    exactInteger(rowValue(global, 'deletion_checkpoint_records')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerDeployment ||
    exactInteger(rowValue(global, 'deletion_checkpoint_logical_bytes')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointBytesPerDeployment ||
    exactInteger(rowValue(global, 'export_job_records')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerDeployment ||
    exactInteger(rowValue(global, 'export_job_logical_bytes')) >
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobBytesPerDeployment ||
    exactInteger(rowValue(global, 'lifecycle_audit_records')) +
      exactInteger(rowValue(global, 'lifecycle_audit_reserved_records')) >
      LIFECYCLE_AUDIT_RECORDS_PER_DEPLOYMENT ||
    exactInteger(rowValue(global, 'lifecycle_audit_logical_bytes')) +
      exactInteger(rowValue(global, 'lifecycle_audit_reserved_bytes')) >
      LIFECYCLE_AUDIT_BYTES_PER_DEPLOYMENT) return false
  const generations = database.prepare(`
    SELECT namespace_generation FROM usage WHERE namespace_ref = ?
  `).all(namespaceRef) as Row[]
  for (const row of generations) {
    const actual = generationUsageActual(
      database,
      namespaceRef,
      positiveInteger(rowValue(row, 'namespace_generation'))
    )
    if (exactInteger(rowValue(actual, 'pending_proposal_records')) >
        MEMORY_RESOURCE_LIMITS.namespacePendingProposals ||
      exactInteger(rowValue(actual, 'active_memory_records')) >
        MEMORY_RESOURCE_LIMITS.namespaceActiveRecords ||
      exactInteger(rowValue(actual, 'canonical_logical_bytes')) >
        MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes) return false
  }
  const lifecycle = namespaceLifecycleActual(database, namespaceRef)
  return exactInteger(rowValue(lifecycle, 'lifecycle_command_records')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerRecordsPerNamespace &&
    exactInteger(rowValue(lifecycle, 'lifecycle_command_logical_bytes')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleCommandLedgerBytesPerNamespace &&
    exactInteger(rowValue(lifecycle, 'deletion_checkpoint_records')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleDeletionCheckpointsPerNamespace &&
    exactInteger(rowValue(lifecycle, 'export_job_records')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobsPerNamespace &&
    exactInteger(rowValue(lifecycle, 'export_job_logical_bytes')) <=
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobBytesPerNamespace &&
    exactInteger(rowValue(lifecycle, 'lifecycle_audit_records')) +
      exactInteger(rowValue(lifecycle, 'lifecycle_audit_reserved_records')) <=
      LIFECYCLE_AUDIT_RECORDS_PER_NAMESPACE &&
    exactInteger(rowValue(lifecycle, 'lifecycle_audit_logical_bytes')) +
    exactInteger(rowValue(lifecycle, 'lifecycle_audit_reserved_bytes')) <=
      LIFECYCLE_AUDIT_BYTES_PER_NAMESPACE
}

function jobProjection (fields: JobFieldsV1): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    exportId: fields.exportId,
    namespaceRef: fields.namespaceRef,
    namespaceGeneration: fields.namespaceGeneration,
    contentEpoch: fields.contentEpoch,
    state: fields.state,
    preparedCommandHash: fields.preparedCommandHash,
    terminalCommandHash: fields.terminalCommandHash,
    leaseOwnerId: fields.leaseOwnerId,
    leaseToken: fields.leaseToken,
    fencingToken: fields.fencingToken,
    leasedUntilMs: fields.leasedUntilMs,
    manifestWire: fields.manifestWire,
    artifactToken: fields.artifactToken,
    claimCommandHash: fields.claimCommandHash,
    deliveryRefHash: fields.deliveryRefHash,
    claimReceiptHash: fields.claimReceiptHash,
    preparedAtMs: fields.preparedAtMs,
    terminalAtMs: fields.terminalAtMs,
    deliveredAtMs: fields.deliveredAtMs,
    expiresAtMs: fields.expiresAtMs
  })
}

function jobWireBytes (fields: JobFieldsV1): number {
  const bytes = byteLength(JSON.stringify(jobProjection(fields)))
  if (bytes <= 0 || bytes > MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportJobWireBytes) {
    throw new CanonicalExportDataErrorV1()
  }
  return bytes
}

function parseJobRow (row: Row): JobFieldsV1 {
  const state = exactString(rowValue(row, 'state'))
  if (!['prepared', 'writing', 'deliverable', 'delivered', 'failed'].includes(state)) {
    throw new CanonicalExportDataErrorV1()
  }
  const fields: JobFieldsV1 = Object.freeze({
    exportId: (() => {
      const value = exactString(rowValue(row, 'export_id'))
      if (!EXPORT_ID_PATTERN.test(value)) throw new CanonicalExportDataErrorV1()
      return value
    })(),
    namespaceRef: parseMemoryNamespaceRefV1(exactString(rowValue(row, 'namespace_ref'))),
    namespaceGeneration: positiveInteger(rowValue(row, 'namespace_generation')),
    contentEpoch: positiveInteger(rowValue(row, 'content_epoch')),
    state: state as JobFieldsV1['state'],
    preparedCommandHash: exactHash(rowValue(row, 'prepared_command_hash')),
    terminalCommandHash: nullableHash(rowValue(row, 'terminal_command_hash')),
    leaseOwnerId: nullableString(rowValue(row, 'lease_owner_id')),
    leaseToken: nullableString(rowValue(row, 'lease_token')),
    fencingToken: positiveInteger(rowValue(row, 'fencing_token')),
    leasedUntilMs: nullableInteger(rowValue(row, 'leased_until_ms')),
    manifestWire: nullableString(rowValue(row, 'manifest_wire')),
    artifactToken: nullableString(rowValue(row, 'artifact_token')),
    claimCommandHash: nullableHash(rowValue(row, 'claim_command_hash')),
    deliveryRefHash: nullableHash(rowValue(row, 'delivery_ref_hash')),
    claimReceiptHash: nullableHash(rowValue(row, 'claim_receipt_hash')),
    preparedAtMs: exactInteger(rowValue(row, 'prepared_at_ms')),
    terminalAtMs: nullableInteger(rowValue(row, 'terminal_at_ms')),
    deliveredAtMs: nullableInteger(rowValue(row, 'delivered_at_ms')),
    expiresAtMs: exactInteger(rowValue(row, 'expires_at_ms'))
  })
  const tokenMatch = fields.artifactToken === null
    ? null
    : ARTIFACT_TOKEN_PATTERN.exec(fields.artifactToken)
  if (fields.expiresAtMs !== fields.preparedAtMs +
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportTerminalTtlMs ||
    (fields.artifactToken !== null && (tokenMatch === null ||
      `export:${tokenMatch[1]}` !== fields.exportId || Number(tokenMatch[2]) !== fields.fencingToken)) ||
    (fields.manifestWire === null) !== (rowValue(row, 'manifest_wire_bytes') === null) ||
    (fields.manifestWire !== null && (
      byteLength(fields.manifestWire) !== positiveInteger(rowValue(row, 'manifest_wire_bytes')) ||
      encodeMemoryExportStableResultWireV1(
        decodeMemoryExportStableResultWireV1(fields.manifestWire)
      ) !== fields.manifestWire
    )) || jobWireBytes(fields) !== positiveInteger(rowValue(row, 'job_wire_bytes'))) {
    throw new CanonicalExportDataErrorV1()
  }
  const noLease = fields.leaseOwnerId === null && fields.leaseToken === null &&
    fields.leasedUntilMs === null
  if ((fields.state === 'writing') === noLease ||
    (!noLease && (fields.leaseOwnerId === null || fields.leaseToken === null ||
      fields.leasedUntilMs === null)) ||
    (fields.leaseOwnerId !== null && !LEASE_OWNER_PATTERN.test(fields.leaseOwnerId)) ||
    (fields.leaseToken !== null && !LEASE_TOKEN_PATTERN.test(fields.leaseToken))) {
    throw new CanonicalExportDataErrorV1()
  }
  if (fields.state === 'prepared' && (fields.terminalCommandHash !== null ||
    fields.manifestWire !== null || fields.artifactToken !== null)) {
    throw new CanonicalExportDataErrorV1()
  }
  if (fields.state === 'writing' && (fields.terminalCommandHash !== null ||
    fields.manifestWire !== null || fields.artifactToken !== null ||
    fields.leasedUntilMs === null || fields.leasedUntilMs > fields.expiresAtMs)) {
    throw new CanonicalExportDataErrorV1()
  }
  if (fields.state === 'deliverable' || fields.state === 'delivered' || fields.state === 'failed') {
    if (fields.terminalCommandHash === null || fields.terminalAtMs === null ||
      fields.manifestWire === null || fields.terminalAtMs < fields.preparedAtMs) {
      throw new CanonicalExportDataErrorV1()
    }
    const manifest = decodeMemoryExportStableResultWireV1(fields.manifestWire)
    if (manifest.exportId !== fields.exportId || manifest.namespaceRef !== fields.namespaceRef ||
      manifest.namespaceGeneration !== fields.namespaceGeneration ||
      manifest.contentEpoch !== fields.contentEpoch ||
      manifest.commandHash !== fields.terminalCommandHash) throw new CanonicalExportDataErrorV1()
    if (manifest.status === 'prepared' ||
      (fields.state === 'deliverable' || fields.state === 'delivered') !==
      (manifest.status === 'deliverable') ||
      (fields.state === 'failed' && manifest.status === 'deliverable') ||
      ((fields.state === 'deliverable' || fields.state === 'delivered') !==
        (fields.artifactToken !== null))) throw new CanonicalExportDataErrorV1()
  }
  const claimed = fields.claimCommandHash !== null || fields.deliveryRefHash !== null ||
    fields.claimReceiptHash !== null || fields.deliveredAtMs !== null
  if ((fields.state === 'delivered') !== claimed || (claimed && (
    fields.claimCommandHash === null || fields.deliveryRefHash === null ||
    fields.claimReceiptHash === null || fields.deliveredAtMs === null ||
    fields.terminalAtMs === null || fields.deliveredAtMs < fields.terminalAtMs ||
    fields.deliveredAtMs >= fields.expiresAtMs
  ))) throw new CanonicalExportDataErrorV1()
  return fields
}

const JOB_SELECT = `
  SELECT export_id, namespace_ref, namespace_generation, content_epoch, state,
    prepared_command_hash, terminal_command_hash, lease_owner_id, lease_token,
    fencing_token, leased_until_ms, manifest_wire, manifest_wire_bytes, artifact_token,
    claim_command_hash, delivery_ref_hash, claim_receipt_hash, prepared_at_ms,
    terminal_at_ms, delivered_at_ms, expires_at_ms, job_wire_bytes
  FROM export_jobs WHERE export_id = ?
`

function loadJob (database: DatabaseSync, exportId: string): JobFieldsV1 | null {
  const row = database.prepare(JOB_SELECT).get(exportId) as Row | undefined
  return row === undefined ? null : parseJobRow(row)
}

function preparedManifest (
  envelope: MemoryExportAuthorizationEnvelopeV1,
  contentEpoch: number,
  preparedAt: string,
  artifactExpiresAt: string
): MemoryExportPreparedManifestV1 {
  const wire = decodeMemoryExportCommandWireV1(envelope.command.wire)
  if (wire.operation !== 'export.prepare') throw new CanonicalExportDataErrorV1()
  return createMemoryExportStableResultV1({
    schemaVersion: 1,
    status: 'prepared',
    commandRefHash: memoryExportCommandRefHashV1(wire.commandRef),
    commandHash: memoryExportCommandHashV1(envelope.command),
    operation: 'export.prepare',
    exportId: deriveMemoryExportIdV1({
      commandRef: wire.commandRef,
      namespaceRef: wire.namespaceRef,
      namespaceGeneration: wire.expectedNamespaceGeneration
    }),
    namespaceRef: wire.namespaceRef,
    namespaceGeneration: wire.expectedNamespaceGeneration,
    contentEpoch,
    retryOfExportId: wire.retryOfExportId,
    expectedSnapshotSha256: wire.expectedSnapshotSha256,
    preparedAt,
    artifactExpiresAt,
    exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1
  }) as MemoryExportPreparedManifestV1
}

function reservationWire (
  manifest: MemoryExportPreparedManifestV1,
  commandHash: string
): string {
  const wire = JSON.stringify({
    schemaVersion: 1,
    exportId: manifest.exportId,
    namespaceRef: manifest.namespaceRef,
    namespaceGeneration: manifest.namespaceGeneration,
    commandHash,
    preparedManifest: manifest,
    reservedRecords: 1,
    reservedBytes: MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes,
    expiresAt: manifest.artifactExpiresAt
  })
  if (byteLength(wire) <= 0 || byteLength(wire) >
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditReservationWireBytes) {
    throw new CanonicalExportDataErrorV1()
  }
  return wire
}

function decodeReservationWire (raw: string): MemoryExportPreparedManifestV1 {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new CanonicalExportDataErrorV1()
  }
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'exportId', 'namespaceRef', 'namespaceGeneration', 'commandHash',
    'preparedManifest', 'reservedRecords', 'reservedBytes', 'expiresAt'
  ])
  if (input.schemaVersion !== 1 || input.reservedRecords !== 1 ||
    input.reservedBytes !== MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes) {
    throw new CanonicalExportDataErrorV1()
  }
  const manifest = decodeMemoryExportStableResultWireV1(
    encodeMemoryExportStableResultWireV1(input.preparedManifest)
  )
  if (manifest.status !== 'prepared' || input.exportId !== manifest.exportId ||
    input.namespaceRef !== manifest.namespaceRef ||
    input.namespaceGeneration !== manifest.namespaceGeneration ||
    input.commandHash !== manifest.commandHash || input.expiresAt !== manifest.artifactExpiresAt ||
    JSON.stringify(value) !== raw) throw new CanonicalExportDataErrorV1()
  return manifest
}

function loadReservation (database: DatabaseSync, exportId: string) {
  const row = database.prepare(`
    SELECT export_id, namespace_ref, namespace_generation, command_hash,
      reserved_records, reserved_bytes, reservation_wire, reservation_wire_bytes, expires_at_ms
    FROM export_audit_reservations WHERE export_id = ?
  `).get(exportId) as Row | undefined
  if (row === undefined) return null
  const raw = exactString(rowValue(row, 'reservation_wire'))
  const manifest = decodeReservationWire(raw)
  if (exactString(rowValue(row, 'export_id')) !== manifest.exportId ||
    exactString(rowValue(row, 'namespace_ref')) !== manifest.namespaceRef ||
    positiveInteger(rowValue(row, 'namespace_generation')) !== manifest.namespaceGeneration ||
    exactHash(rowValue(row, 'command_hash')) !== manifest.commandHash ||
    positiveInteger(rowValue(row, 'reserved_records')) !== 1 ||
    positiveInteger(rowValue(row, 'reserved_bytes')) !==
      MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes ||
    positiveInteger(rowValue(row, 'reservation_wire_bytes')) !== byteLength(raw) ||
    exactInteger(rowValue(row, 'expires_at_ms')) !== Date.parse(manifest.artifactExpiresAt)) {
    throw new CanonicalExportDataErrorV1()
  }
  return Object.freeze({ manifest, wire: raw })
}

function exportRefHash (exportId: string): string {
  if (!EXPORT_ID_PATTERN.test(exportId)) throw new CanonicalExportDataErrorV1()
  return memoryLifecycleDomainHashV1(EXPORT_REF_HASH_DOMAIN_V1, exportId)
}

function actorRefHash (actorRef: string): string {
  if (!/^actor:[0-9a-f]{64}$/.test(actorRef)) throw new CanonicalExportDataErrorV1()
  return memoryLifecycleDomainHashV1(EXPORT_ACTOR_REF_HASH_DOMAIN_V1, actorRef)
}

function createExportAudit (
  operation: 'export_prepared' | 'export_completed' | 'export_failed',
  envelope: MemoryExportAuthorizationEnvelopeV1,
  exportId: string,
  occurredAt: string,
  outcome: MemoryLifecycleAuditV1['outcome'],
  receiptHash: string
): MemoryLifecycleAuditV1 {
  const command = decodeMemoryExportCommandWireV1(envelope.command.wire)
  const actorHash = actorRefHash(command.initiatedByActorRef)
  return createMemoryLifecycleAuditV1({
    namespaceRef: command.namespaceRef,
    namespaceGeneration: command.expectedNamespaceGeneration,
    operation,
    commandRefHash: memoryExportCommandRefHashV1(command.commandRef),
    aggregateKind: 'export',
    aggregateRefHash: exportRefHash(exportId),
    authorizedByActorRefHash: actorHash,
    executedByActorRefHash: actorHash,
    sourceCommittedAt: occurredAt,
    recordedAt: occurredAt,
    outcome,
    repositoryReceiptHash: receiptHash,
    priorRevision: null,
    nextRevision: null,
    exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1
  })
}

function insertAudit (database: DatabaseSync, audit: MemoryLifecycleAuditV1): void {
  const wire = encodeMemoryLifecycleAuditV1(audit)
  requireOneChange(database.prepare(`
    INSERT INTO lifecycle_audits(
      namespace_ref, namespace_generation, audit_id, operation, command_ref_hash,
      aggregate_ref_hash, authorized_actor_ref_hash, executed_actor_ref_hash,
      source_committed_at_ms, recorded_at_ms, expires_at_ms, audit_wire, audit_wire_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audit.namespaceRef,
    audit.namespaceGeneration,
    audit.auditId,
    audit.operation,
    audit.commandRefHash,
    audit.aggregateRefHash,
    audit.authorizedByActorRefHash,
    audit.executedByActorRefHash,
    Date.parse(audit.sourceCommittedAt),
    Date.parse(audit.recordedAt),
    Date.parse(audit.expiresAt),
    wire,
    byteLength(wire)
  ).changes)
}

function authorityDenial (
  envelope: MemoryExportAuthorizationEnvelopeV1,
  freshNow: string,
  operation: 'export.prepare' | 'export.generate' | 'export.claimDelivery'
): 'access' | 'authority' | null {
  const command = decodeMemoryExportCommandWireV1(envelope.command.wire)
  if (!memoryAccessCapabilityAllowsV1(envelope.access, command.namespaceRef, freshNow)) {
    return 'access'
  }
  return memoryLifecycleActorCapabilityAllowsV1(envelope.actor, Object.freeze({
    botInstanceId: envelope.access.botInstanceId,
    accountId: envelope.access.accountId,
    sceneRef: envelope.access.sceneRef,
    namespaceRef: command.namespaceRef,
    generation: command.expectedNamespaceGeneration,
    actorRef: command.initiatedByActorRef,
    action: operation === 'export.claimDelivery' ? 'claim_export' : 'export',
    requiredAuthority: 'elevated'
  }), freshNow)
    ? null
    : 'authority'
}

function namespaceState (
  database: DatabaseSync,
  namespaceRef: string
): { readonly generation: number; readonly contentEpoch: number } | null {
  const row = database.prepare(`
    SELECT namespace_generation, content_epoch FROM namespaces WHERE namespace_ref = ?
  `).get(namespaceRef) as Row | undefined
  if (row === undefined) return null
  return Object.freeze({
    generation: positiveInteger(rowValue(row, 'namespace_generation')),
    contentEpoch: positiveInteger(rowValue(row, 'content_epoch'))
  })
}

function databaseLocation (database: DatabaseSync): string {
  const rows = database.prepare('PRAGMA database_list').all() as Row[]
  const main = rows.find(row => rowValue(row, 'name') === 'main')
  if (main === undefined) throw new CanonicalExportDataErrorV1()
  const location = exactString(rowValue(main, 'file'))
  if (location.length === 0 || location.length > 4_096 || location.includes('\0')) {
    throw new CanonicalExportDataErrorV1()
  }
  return location
}

function openSnapshotDatabase (database: DatabaseSync): DatabaseSync {
  const Constructor = databaseConstructor()
  const snapshot = new Constructor(databaseLocation(database), {
    readOnly: true,
    enableForeignKeyConstraints: true,
    allowExtension: false
  })
  snapshot.exec('PRAGMA query_only = ON')
  snapshot.exec('PRAGMA busy_timeout = 1000')
  snapshot.exec('BEGIN')
  return snapshot
}

function parseCanonicalJson (wire: string): unknown {
  try {
    return JSON.parse(wire) as unknown
  } catch {
    throw new CanonicalExportDataErrorV1()
  }
}

interface SnapshotCountsMutableV1 {
  proposal: number
  proposalStatus: number
  recordHead: number
  recordRevision: number
  tombstone: number
  lifecycleAudit: number
}

class SnapshotJsonlWriterV1 {
  readonly #sink: SecureArtifactSinkV1
  readonly #snapshotHash = createHash('sha256')
  #snapshotDigest: string | null = null
  readonly counts: SnapshotCountsMutableV1 = {
    proposal: 0,
    proposalStatus: 0,
    recordHead: 0,
    recordRevision: 0,
    tombstone: 0,
    lifecycleAudit: 0
  }
  contentBytes = 0

  constructor (sink: SecureArtifactSinkV1) {
    this.#sink = sink
  }

  async line (
    type: string,
    value: unknown,
    contentKind: keyof SnapshotCountsMutableV1 | null,
    comparisonContent: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted === true) throw new ExportAbortedErrorV1()
    const valueWire = JSON.stringify(value)
    const wire = `${JSON.stringify({ schemaVersion: 1, type, value })}\n`
    const chunk = Buffer.from(wire, 'utf8')
    if (chunk.byteLength > MEMORY_EXPORT_MAX_CHUNK_BYTES_V1) {
      throw new CanonicalExportDataErrorV1()
    }
    await this.#sink.write(chunk, signal)
    if (contentKind !== null) {
      this.counts[contentKind] += 1
      this.contentBytes += byteLength(valueWire)
      if (!Number.isSafeInteger(this.contentBytes)) throw new ExportArtifactCapacityErrorV1()
    }
    if (comparisonContent) {
      if (this.#snapshotDigest !== null) throw new CanonicalExportDataErrorV1()
      this.#snapshotHash.update(type, 'utf8').update('\0', 'utf8')
        .update(valueWire, 'utf8').update('\0', 'utf8')
    }
  }

  snapshotDigest (): string {
    if (this.#snapshotDigest === null) this.#snapshotDigest = this.#snapshotHash.digest('hex')
    return this.#snapshotDigest
  }
}

function assertMillis (instant: string, milliseconds: number): void {
  if (Date.parse(instant) !== milliseconds) throw new CanonicalExportDataErrorV1()
}

async function writeProposals (
  database: DatabaseSync,
  writer: SnapshotJsonlWriterV1,
  namespaceRef: string,
  generation: number,
  signal?: AbortSignal
): Promise<void> {
  const statement = database.prepare(`
    SELECT namespace_ref, namespace_generation, proposal_id, revision, state,
      proposed_at_ms, decided_at_ms, resulting_memory_id, resulting_revision,
      resulting_revision_hash, proposal_wire, proposal_wire_bytes
    FROM proposals WHERE namespace_ref = ? AND namespace_generation = ?
    ORDER BY proposal_id ASC
  `)
  const readProposal = (row: Row) => {
    const wire = exactString(rowValue(row, 'proposal_wire'))
    const proposal = decodeMemoryProposalV2(wire)
    if (proposal.namespaceRef !== namespaceRef || proposal.namespaceGeneration !== generation ||
      proposal.proposalId !== exactString(rowValue(row, 'proposal_id')) ||
      proposal.revision !== positiveInteger(rowValue(row, 'revision')) ||
      proposal.state !== exactString(rowValue(row, 'state')) ||
      byteLength(wire) !== positiveInteger(rowValue(row, 'proposal_wire_bytes'))) {
      throw new CanonicalExportDataErrorV1()
    }
    assertMillis(proposal.proposedAt, exactInteger(rowValue(row, 'proposed_at_ms')))
    const decidedAt = nullableInteger(rowValue(row, 'decided_at_ms'))
    if ((proposal.decision === null) !== (decidedAt === null) ||
      (proposal.decision !== null && decidedAt !== null &&
        Date.parse(proposal.decision.decidedAt) !== decidedAt)) {
      throw new CanonicalExportDataErrorV1()
    }
    const resultingMemoryId = nullableString(rowValue(row, 'resulting_memory_id'))
    const resultingRevision = nullableInteger(rowValue(row, 'resulting_revision'))
    const resultingRevisionHash = nullableHash(rowValue(row, 'resulting_revision_hash'))
    if ((proposal.state === 'approved') !== (resultingMemoryId !== null) ||
      (proposal.state === 'approved' && proposal.decision !== null && (
        proposal.decision.resultingMemoryId !== resultingMemoryId ||
        proposal.decision.resultingMemoryRevision !== resultingRevision ||
        proposal.decision.resultingRevisionHash !== resultingRevisionHash
      ))) throw new CanonicalExportDataErrorV1()
    return Object.freeze({ proposal, wire })
  }
  for (const row of statement.iterate(namespaceRef, generation) as Iterable<Row>) {
    const value = readProposal(row)
    await writer.line('proposal', parseCanonicalJson(value.wire), 'proposal', true, signal)
  }
  for (const row of statement.iterate(namespaceRef, generation) as Iterable<Row>) {
    const { proposal } = readProposal(row)
    await writer.line('proposal_status', {
      proposalId: proposal.proposalId,
      revision: proposal.revision,
      state: proposal.state,
      decision: proposal.decision
    }, 'proposalStatus', true, signal)
  }
}

async function writeHeads (
  database: DatabaseSync,
  writer: SnapshotJsonlWriterV1,
  namespaceRef: string,
  generation: number,
  signal?: AbortSignal
): Promise<void> {
  const rows = database.prepare(`
    SELECT h.memory_id, h.current_revision, h.current_revision_hash, h.content_hash,
      h.cursor_ref, h.updated_at_ms, h.valid_until_ms, h.purge_at_ms,
      r.revision_hash AS joined_revision_hash, p.revision_wire
    FROM heads h
    JOIN revisions r ON r.namespace_ref = h.namespace_ref
      AND r.namespace_generation = h.namespace_generation
      AND r.memory_id = h.memory_id AND r.revision = h.current_revision
    JOIN revision_payloads p ON p.namespace_ref = r.namespace_ref
      AND p.namespace_generation = r.namespace_generation
      AND p.memory_id = r.memory_id AND p.revision = r.revision
    WHERE h.namespace_ref = ? AND h.namespace_generation = ?
    ORDER BY h.memory_id ASC
  `).iterate(namespaceRef, generation) as Iterable<Row>
  for (const row of rows) {
    const revision = decodeMemoryRevisionV2(exactString(rowValue(row, 'revision_wire')))
    const memoryId = exactString(rowValue(row, 'memory_id'))
    const currentRevision = positiveInteger(rowValue(row, 'current_revision'))
    const revisionHash = exactHash(rowValue(row, 'current_revision_hash'))
    const contentHash = exactHash(rowValue(row, 'content_hash'))
    if (revision.record.namespaceRef !== namespaceRef ||
      revision.record.namespaceGeneration !== generation ||
      revision.memoryId !== memoryId || revision.revision !== currentRevision ||
      revision.revisionHash !== revisionHash ||
      exactHash(rowValue(row, 'joined_revision_hash')) !== revisionHash ||
      revision.record.contentHash !== contentHash) throw new CanonicalExportDataErrorV1()
    const value = {
      memoryId,
      currentRevision,
      currentRevisionHash: revisionHash,
      contentHash,
      cursorRef: exactHash(rowValue(row, 'cursor_ref')),
      updatedAt: new Date(exactInteger(rowValue(row, 'updated_at_ms'))).toISOString(),
      validUntil: new Date(exactInteger(rowValue(row, 'valid_until_ms'))).toISOString(),
      purgeAt: new Date(exactInteger(rowValue(row, 'purge_at_ms'))).toISOString()
    }
    if (value.updatedAt !== revision.changedAt ||
      value.validUntil !== revision.record.retention.validUntil ||
      value.purgeAt !== revision.record.retention.purgeAt) {
      throw new CanonicalExportDataErrorV1()
    }
    await writer.line('record_head', value, 'recordHead', true, signal)
  }
}

async function writeRevisions (
  database: DatabaseSync,
  writer: SnapshotJsonlWriterV1,
  namespaceRef: string,
  generation: number,
  signal?: AbortSignal
): Promise<void> {
  const rows = database.prepare(`
    SELECT r.memory_id, r.revision, r.operation, r.revision_hash,
      r.previous_revision_hash, r.changed_at_ms, r.revision_wire_bytes, p.revision_wire
    FROM revisions r JOIN revision_payloads p
      ON p.namespace_ref = r.namespace_ref
      AND p.namespace_generation = r.namespace_generation
      AND p.memory_id = r.memory_id AND p.revision = r.revision
    WHERE r.namespace_ref = ? AND r.namespace_generation = ?
    ORDER BY r.memory_id ASC, r.revision ASC
  `).iterate(namespaceRef, generation) as Iterable<Row>
  for (const row of rows) {
    const wire = exactString(rowValue(row, 'revision_wire'))
    const revision = decodeMemoryRevisionV2(wire)
    if (revision.record.namespaceRef !== namespaceRef ||
      revision.record.namespaceGeneration !== generation ||
      revision.memoryId !== exactString(rowValue(row, 'memory_id')) ||
      revision.revision !== positiveInteger(rowValue(row, 'revision')) ||
      revision.operation !== exactString(rowValue(row, 'operation')) ||
      revision.revisionHash !== exactHash(rowValue(row, 'revision_hash')) ||
      revision.previousRevisionHash !== nullableHash(rowValue(row, 'previous_revision_hash')) ||
      Date.parse(revision.changedAt) !== exactInteger(rowValue(row, 'changed_at_ms')) ||
      byteLength(wire) !== positiveInteger(rowValue(row, 'revision_wire_bytes'))) {
      throw new CanonicalExportDataErrorV1()
    }
    await writer.line('record_revision', parseCanonicalJson(wire), 'recordRevision', true, signal)
  }
}

async function writeTombstones (
  database: DatabaseSync,
  writer: SnapshotJsonlWriterV1,
  namespaceRef: string,
  generation: number,
  signal?: AbortSignal
): Promise<void> {
  const rows = database.prepare(`
    SELECT tombstone_id, memory_id, deleted_revision, deletion_kind, deleted_at_ms,
      expires_at_ms, receipt_hash, tombstone_wire, tombstone_wire_bytes
    FROM tombstones WHERE namespace_ref = ? AND namespace_generation = ?
    ORDER BY tombstone_id ASC
  `).iterate(namespaceRef, generation) as Iterable<Row>
  for (const row of rows) {
    const wire = exactString(rowValue(row, 'tombstone_wire'))
    const tombstone = decodeMemoryTombstoneV1(wire)
    if (tombstone.namespaceRef !== namespaceRef || tombstone.namespaceGeneration !== generation ||
      tombstone.tombstoneId !== exactString(rowValue(row, 'tombstone_id')) ||
      tombstone.memoryId !== nullableString(rowValue(row, 'memory_id')) ||
      tombstone.deletedRevision !== nullableInteger(rowValue(row, 'deleted_revision')) ||
      tombstone.deletionKind !== exactString(rowValue(row, 'deletion_kind')) ||
      Date.parse(tombstone.deletedAt) !== exactInteger(rowValue(row, 'deleted_at_ms')) ||
      Date.parse(tombstone.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms')) ||
      tombstone.receiptHash !== exactHash(rowValue(row, 'receipt_hash')) ||
      byteLength(wire) !== positiveInteger(rowValue(row, 'tombstone_wire_bytes'))) {
      throw new CanonicalExportDataErrorV1()
    }
    await writer.line('tombstone', parseCanonicalJson(wire), 'tombstone', true, signal)
  }
}

async function writeAudits (
  database: DatabaseSync,
  writer: SnapshotJsonlWriterV1,
  namespaceRef: string,
  generation: number,
  signal?: AbortSignal
): Promise<void> {
  const rows = database.prepare(`
    SELECT audit_id, operation, command_ref_hash, aggregate_ref_hash,
      authorized_actor_ref_hash, executed_actor_ref_hash, source_committed_at_ms,
      recorded_at_ms, expires_at_ms, audit_wire, audit_wire_bytes
    FROM lifecycle_audits WHERE namespace_ref = ? AND namespace_generation = ?
    ORDER BY recorded_at_ms ASC, audit_id ASC
  `).iterate(namespaceRef, generation) as Iterable<Row>
  for (const row of rows) {
    const wire = exactString(rowValue(row, 'audit_wire'))
    const audit = decodeMemoryLifecycleAuditV1(wire)
    if (audit.namespaceRef !== namespaceRef || audit.namespaceGeneration !== generation ||
      audit.auditId !== exactString(rowValue(row, 'audit_id')) ||
      audit.operation !== exactString(rowValue(row, 'operation')) ||
      audit.commandRefHash !== exactHash(rowValue(row, 'command_ref_hash')) ||
      audit.aggregateRefHash !== exactHash(rowValue(row, 'aggregate_ref_hash')) ||
      audit.authorizedByActorRefHash !== exactHash(rowValue(row, 'authorized_actor_ref_hash')) ||
      audit.executedByActorRefHash !== exactHash(rowValue(row, 'executed_actor_ref_hash')) ||
      Date.parse(audit.sourceCommittedAt) !==
        exactInteger(rowValue(row, 'source_committed_at_ms')) ||
      Date.parse(audit.recordedAt) !== exactInteger(rowValue(row, 'recorded_at_ms')) ||
      Date.parse(audit.expiresAt) !== exactInteger(rowValue(row, 'expires_at_ms')) ||
      byteLength(wire) !== positiveInteger(rowValue(row, 'audit_wire_bytes'))) {
      throw new CanonicalExportDataErrorV1()
    }
    await writer.line(
      'lifecycle_audit',
      parseCanonicalJson(wire),
      'lifecycleAudit',
      !audit.operation.startsWith('export_'),
      signal
    )
  }
}

async function generateSnapshot (
  sourceDatabase: DatabaseSync,
  directory: string,
  capacityBytes: number,
  state: AttemptStateV1,
  signal?: AbortSignal
): Promise<Exclude<MemoryExportStableResultV1, MemoryExportPreparedManifestV1>> {
  const currentBytes = artifactDirectoryBytes(directory)
  const remaining = capacityBytes - currentBytes
  if (remaining <= 0) throw new ExportArtifactCapacityErrorV1()
  const sink = await SecureArtifactSinkV1.create(directory, state.artifactToken, remaining)
  const snapshot = openSnapshotDatabase(sourceDatabase)
  let transactionOpen = true
  try {
    const namespaceRow = snapshot.prepare(`
      SELECT namespace_wire, namespace_wire_bytes, namespace_generation, content_epoch
      FROM namespaces WHERE namespace_ref = ?
    `).get(state.namespaceRef) as Row | undefined
    if (namespaceRow === undefined ||
      positiveInteger(rowValue(namespaceRow, 'namespace_generation')) !==
        state.namespaceGeneration ||
      positiveInteger(rowValue(namespaceRow, 'content_epoch')) !== state.contentEpoch) {
      throw new CanonicalExportDataErrorV1()
    }
    const namespaceWire = exactString(rowValue(namespaceRow, 'namespace_wire'))
    if (byteLength(namespaceWire) !== positiveInteger(rowValue(namespaceRow, 'namespace_wire_bytes')) ||
      JSON.stringify(parseCanonicalJson(namespaceWire)) !== namespaceWire) {
      throw new CanonicalExportDataErrorV1()
    }
    const writer = new SnapshotJsonlWriterV1(sink)
    await writer.line('header', {
      exportId: state.exportId,
      namespaceRef: state.namespaceRef,
      namespaceGeneration: state.namespaceGeneration,
      contentEpoch: state.contentEpoch,
      snapshotAt: state.snapshotAt,
      namespace: parseCanonicalJson(namespaceWire),
      exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1
    }, null, false, signal)
    await writeProposals(snapshot, writer, state.namespaceRef, state.namespaceGeneration, signal)
    await writeHeads(snapshot, writer, state.namespaceRef, state.namespaceGeneration, signal)
    await writeRevisions(snapshot, writer, state.namespaceRef, state.namespaceGeneration, signal)
    await writeTombstones(snapshot, writer, state.namespaceRef, state.namespaceGeneration, signal)
    await writeAudits(snapshot, writer, state.namespaceRef, state.namespaceGeneration, signal)
    const snapshotSha256 = writer.snapshotDigest()
    await writer.line('footer', {
      exportId: state.exportId,
      counts: writer.counts,
      snapshotSha256,
      completeness: 'complete'
    }, null, false, signal)
    snapshot.exec('COMMIT')
    transactionOpen = false
    snapshot.close()
    await sink.commit()
    const artifactSha256 = sink.digest()
    const committedToken = artifactToken(state.exportId, state.fencingToken, artifactSha256)
    const provisionalPaths = artifactPaths(directory, state.artifactToken)
    const committedPaths = artifactPaths(directory, committedToken)
    await link(provisionalPaths.final, committedPaths.final)
    await unlink(provisionalPaths.final)
    await syncArtifactDirectory(directory)
    state.artifactToken = committedToken
    const sha256 = snapshotSha256
    const changed = state.expectedSnapshotSha256 !== null &&
      state.expectedSnapshotSha256 !== sha256
    return createMemoryExportStableResultV1({
      schemaVersion: 1,
      status: changed ? 'snapshot_changed' : 'deliverable',
      commandRefHash: state.commandRefHash,
      commandHash: state.commandHash,
      operation: 'export.generate',
      exportId: state.exportId,
      namespaceRef: state.namespaceRef,
      namespaceGeneration: state.namespaceGeneration,
      contentEpoch: state.contentEpoch,
      snapshotAt: state.snapshotAt,
      counts: writer.counts,
      contentBytes: writer.contentBytes,
      wireBytes: sink.wireBytes,
      sha256,
      artifactExpiresAt: state.artifactExpiresAt,
      completeness: 'complete',
      snapshotChanged: changed
        ? 'changed'
        : state.expectedSnapshotSha256 === null ? 'not_comparable' : 'matched',
      exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1
    }) as Exclude<MemoryExportStableResultV1, MemoryExportPreparedManifestV1>
  } catch (error) {
    if (transactionOpen) {
      try {
        snapshot.exec('ROLLBACK')
      } catch {
      }
      try {
        snapshot.close()
      } catch {
      }
    }
    try {
      await sink.abort()
    } catch {
    }
    throw error
  }
}

async function verifyArtifactFile (
  file: Awaited<ReturnType<typeof open>>,
  token: string,
  manifest: MemoryExportDeliverableManifestV1
): Promise<void> {
  const tokenMatch = ARTIFACT_TOKEN_PATTERN.exec(token)
  if (tokenMatch === null || `export:${tokenMatch[1]}` !== manifest.exportId) {
    throw new ExportArtifactErrorV1()
  }
  const info = await file.stat()
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 ||
    info.size !== manifest.wireBytes || info.size > MEMORY_EXPORT_MAX_WIRE_BYTES_V1) {
    throw new ExportArtifactErrorV1()
  }
  const artifactHash = createHash('sha256')
  const snapshotHash = createHash('sha256')
  const counts: SnapshotCountsMutableV1 = {
    proposal: 0,
    proposalStatus: 0,
    recordHead: 0,
    recordRevision: 0,
    tombstone: 0,
    lifecycleAudit: 0
  }
  const typeToCount: Readonly<Record<string, keyof SnapshotCountsMutableV1>> = Object.freeze({
    proposal: 'proposal',
    proposal_status: 'proposalStatus',
    record_head: 'recordHead',
    record_revision: 'recordRevision',
    tombstone: 'tombstone',
    lifecycle_audit: 'lifecycleAudit'
  })
  let bytes = 0
  let contentBytes = 0
  let lineIndex = 0
  let sawFooter = false
  let pending = Buffer.alloc(0)
  const processLine = (lineBuffer: Buffer): void => {
    if (lineBuffer.byteLength === 0 || lineBuffer.byteLength + 1 >
      MEMORY_EXPORT_MAX_CHUNK_BYTES_V1 || sawFooter) throw new ExportArtifactErrorV1()
    const line = lineBuffer.toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      throw new ExportArtifactErrorV1()
    }
    if (JSON.stringify(parsed) !== line || parsed === null || typeof parsed !== 'object' ||
      Array.isArray(parsed) || utilTypes.isProxy(parsed)) throw new ExportArtifactErrorV1()
    const record = parsed as Readonly<Record<string, unknown>>
    if (Object.keys(record).length !== 3 || record.schemaVersion !== 1 ||
      typeof record.type !== 'string' || !Object.hasOwn(record, 'value')) {
      throw new ExportArtifactErrorV1()
    }
    const type = record.type
    const valueWire = JSON.stringify(record.value)
    if (lineIndex === 0) {
      if (type !== 'header' || record.value === null || typeof record.value !== 'object') {
        throw new ExportArtifactErrorV1()
      }
      const header = record.value as Readonly<Record<string, unknown>>
      if (header.exportId !== manifest.exportId ||
        header.namespaceRef !== manifest.namespaceRef ||
        header.namespaceGeneration !== manifest.namespaceGeneration ||
        header.contentEpoch !== manifest.contentEpoch ||
        header.snapshotAt !== manifest.snapshotAt ||
        header.exclusionsHash !== MEMORY_EXPORT_EXCLUSIONS_HASH_V1) {
        throw new ExportArtifactErrorV1()
      }
    } else if (type === 'footer') {
      if (record.value === null || typeof record.value !== 'object') {
        throw new ExportArtifactErrorV1()
      }
      const footer = record.value as Readonly<Record<string, unknown>>
      if (footer.exportId !== manifest.exportId || footer.completeness !== 'complete' ||
        footer.snapshotSha256 !== manifest.sha256 ||
        JSON.stringify(footer.counts) !== JSON.stringify(manifest.counts)) {
        throw new ExportArtifactErrorV1()
      }
      sawFooter = true
    } else {
      const countField = typeToCount[type]
      if (countField === undefined) throw new ExportArtifactErrorV1()
      counts[countField] += 1
      contentBytes += byteLength(valueWire)
      const comparisonContent = type !== 'lifecycle_audit' ||
        record.value === null || typeof record.value !== 'object' ||
        typeof (record.value as Readonly<Record<string, unknown>>).operation !== 'string' ||
        !(record.value as Readonly<Record<string, string>>).operation.startsWith('export_')
      if (comparisonContent) {
        snapshotHash.update(type, 'utf8').update('\0', 'utf8')
          .update(valueWire, 'utf8').update('\0', 'utf8')
      }
    }
    lineIndex += 1
  }
  const stream = file.createReadStream({
    autoClose: false,
    start: 0,
    highWaterMark: MEMORY_EXPORT_MAX_CHUNK_BYTES_V1
  })
  for await (const value of stream) {
    const chunk = value as Buffer
    if (chunk.byteLength > MEMORY_EXPORT_MAX_CHUNK_BYTES_V1) {
      throw new ExportArtifactErrorV1()
    }
    bytes += chunk.byteLength
    if (bytes > MEMORY_EXPORT_MAX_WIRE_BYTES_V1) throw new ExportArtifactErrorV1()
    artifactHash.update(chunk)
    const combined = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk])
    let start = 0
    for (let index = 0; index < combined.byteLength; index += 1) {
      if (combined[index] !== 0x0a) continue
      processLine(combined.subarray(start, index))
      start = index + 1
    }
    pending = Buffer.from(combined.subarray(start))
    if (pending.byteLength >= MEMORY_EXPORT_MAX_CHUNK_BYTES_V1) {
      throw new ExportArtifactErrorV1()
    }
  }
  if (pending.byteLength !== 0 || !sawFooter || lineIndex < 2 ||
    bytes !== manifest.wireBytes || artifactHash.digest('hex') !== tokenMatch[3] ||
    snapshotHash.digest('hex') !== manifest.sha256 ||
    contentBytes !== manifest.contentBytes ||
    JSON.stringify(counts) !== JSON.stringify(manifest.counts)) {
    throw new ExportArtifactErrorV1()
  }
}

async function verifyArtifact (
  path: string,
  token: string,
  manifest: MemoryExportDeliverableManifestV1
): Promise<void> {
  const file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    await verifyArtifactFile(file, token, manifest)
  } finally {
    await file.close()
  }
}

function failedManifest (
  state: AttemptStateV1,
  category: MemoryExportFailedManifestV1['category'],
  failedAt = state.snapshotAt
): MemoryExportFailedManifestV1 {
  return createMemoryExportStableResultV1({
    schemaVersion: 1,
    status: 'failed',
    commandRefHash: state.commandRefHash,
    commandHash: state.commandHash,
    operation: 'export.generate',
    exportId: state.exportId,
    namespaceRef: state.namespaceRef,
    namespaceGeneration: state.namespaceGeneration,
    contentEpoch: state.contentEpoch,
    failedAt,
    category,
    exclusionsHash: MEMORY_EXPORT_EXCLUSIONS_HASH_V1
  }) as MemoryExportFailedManifestV1
}

function terminalAuditOutcome (
  terminal: Exclude<MemoryExportStableResultV1, MemoryExportPreparedManifestV1>
): {
    readonly operation: 'export_completed' | 'export_failed'
    readonly outcome: MemoryLifecycleAuditV1['outcome']
  } {
  if (terminal.status === 'deliverable') {
    return Object.freeze({ operation: 'export_completed', outcome: 'completed' })
  }
  if (terminal.status === 'snapshot_changed') {
    return Object.freeze({ operation: 'export_failed', outcome: 'snapshot_changed' })
  }
  return Object.freeze({
    operation: 'export_failed',
    outcome: `failed_${terminal.category}` as MemoryLifecycleAuditV1['outcome']
  })
}

function beginImmediate (database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
}

function rollbackQuietly (database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
  }
}

function mapAdapterError (error: unknown): unknown {
  if (error instanceof ExportCanonicalCapacityErrorV1) {
    return Object.freeze({ status: 'capacity' as const, category: 'canonical_bytes' as const })
  }
  if (error instanceof ExportArtifactCapacityErrorV1) {
    return Object.freeze({ status: 'capacity' as const, category: 'artifact_bytes' as const })
  }
  if (error instanceof CanonicalExportDataErrorV1) {
    return Object.freeze({ status: 'corrupt' as const, category: 'canonical_data' as const })
  }
  if (error instanceof ExportArtifactErrorV1) {
    return Object.freeze({
      status: 'unavailable' as const,
      category: 'artifact' as const,
      retryable: false
    })
  }
  if (isBusy(error)) {
    return Object.freeze({ status: 'unavailable' as const, category: 'busy' as const, retryable: true })
  }
  return Object.freeze({ status: 'unavailable' as const, category: 'io' as const, retryable: true })
}

function insertPreparedState (
  database: DatabaseSync,
  envelope: MemoryExportAuthorizationEnvelopeV1,
  freshNow: string
): MemoryExportPreparedManifestV1 | { readonly status: string; readonly category: string } {
  const command = decodeMemoryExportCommandWireV1(envelope.command.wire)
  const commandHash = memoryExportCommandHashV1(envelope.command)
  const exportId = deriveMemoryExportIdV1({
    commandRef: command.commandRef,
    namespaceRef: command.namespaceRef,
    namespaceGeneration: command.expectedNamespaceGeneration
  })
  const existing = loadJob(database, exportId)
  if (existing !== null) {
    if (existing.preparedCommandHash !== commandHash) {
      return Object.freeze({ status: 'conflict', category: 'idempotency' })
    }
    const replay = preparedManifest(
      envelope,
      existing.contentEpoch,
      new Date(existing.preparedAtMs).toISOString(),
      new Date(existing.expiresAtMs).toISOString()
    )
    const reservation = loadReservation(database, exportId)
    if (existing.state === 'prepared' || existing.state === 'writing') {
      if ((reservation === null && Date.parse(freshNow) < existing.expiresAtMs) ||
        (reservation !== null && memoryExportStableResultHashV1(reservation.manifest) !==
          memoryExportStableResultHashV1(replay))) {
        throw new CanonicalExportDataErrorV1()
      }
    } else if (reservation !== null) {
      throw new CanonicalExportDataErrorV1()
    }
    return replay
  }
  const namespace = namespaceState(database, command.namespaceRef)
  if (namespace === null || namespace.generation !== command.expectedNamespaceGeneration) {
    return Object.freeze({ status: 'conflict', category: 'generation' })
  }
  if (command.retryOfExportId !== null) {
    const prior = loadJob(database, command.retryOfExportId)
    if (prior === null || prior.manifestWire === null) {
      return Object.freeze({ status: 'conflict', category: 'idempotency' })
    }
    const priorManifest = decodeMemoryExportStableResultWireV1(prior.manifestWire)
    if (!('sha256' in priorManifest) || priorManifest.sha256 !== command.expectedSnapshotSha256) {
      return Object.freeze({ status: 'conflict', category: 'idempotency' })
    }
  }
  const expiresAt = addMilliseconds(
    freshNow,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleExportTerminalTtlMs
  )
  const manifest = preparedManifest(envelope, namespace.contentEpoch, freshNow, expiresAt)
  const reservation = reservationWire(manifest, commandHash)
  const fields: JobFieldsV1 = Object.freeze({
    exportId,
    namespaceRef: command.namespaceRef,
    namespaceGeneration: command.expectedNamespaceGeneration,
    contentEpoch: namespace.contentEpoch,
    state: 'prepared',
    preparedCommandHash: commandHash,
    terminalCommandHash: null,
    leaseOwnerId: null,
    leaseToken: null,
    fencingToken: 1,
    leasedUntilMs: null,
    manifestWire: null,
    artifactToken: null,
    claimCommandHash: null,
    deliveryRefHash: null,
    claimReceiptHash: null,
    preparedAtMs: Date.parse(freshNow),
    terminalAtMs: null,
    deliveredAtMs: null,
    expiresAtMs: Date.parse(expiresAt)
  })
  requireOneChange(database.prepare(`
    INSERT INTO export_jobs(
      export_id, namespace_ref, namespace_generation, content_epoch, state,
      prepared_command_hash, terminal_command_hash, lease_owner_id, lease_token,
      fencing_token, leased_until_ms, manifest_wire, manifest_wire_bytes, artifact_token,
      claim_command_hash, delivery_ref_hash, claim_receipt_hash, prepared_at_ms,
      terminal_at_ms, delivered_at_ms, expires_at_ms, job_wire_bytes
    ) VALUES (?, ?, ?, ?, 'prepared', ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, ?, NULL, NULL, ?, ?)
  `).run(
    fields.exportId,
    fields.namespaceRef,
    fields.namespaceGeneration,
    fields.contentEpoch,
    fields.preparedCommandHash,
    fields.fencingToken,
    fields.preparedAtMs,
    fields.expiresAtMs,
    jobWireBytes(fields)
  ).changes)
  requireOneChange(database.prepare(`
    INSERT INTO export_audit_reservations(
      export_id, namespace_ref, namespace_generation, command_hash, reserved_records,
      reserved_bytes, reservation_wire, reservation_wire_bytes, expires_at_ms
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    exportId,
    command.namespaceRef,
    command.expectedNamespaceGeneration,
    commandHash,
    MEMORY_LIFECYCLE_RESOURCE_LIMITS.lifecycleAuditWireBytes,
    reservation,
    byteLength(reservation),
    Date.parse(expiresAt)
  ).changes)
  insertAudit(database, createExportAudit(
    'export_prepared',
    envelope,
    exportId,
    freshNow,
    'prepared',
    manifest.receiptHash
  ))
  synchronizeUsage(database, command.namespaceRef, Date.parse(freshNow))
  if (!capacityAllowed(database, command.namespaceRef)) {
    throw new ExportCanonicalCapacityErrorV1()
  }
  return manifest
}

function acquireGenerateLease (
  options: ParsedOptionsV1,
  envelope: MemoryExportAuthorizationEnvelopeV1,
  attempt: MemoryExportGenerateAttemptV1,
  attemptStates: WeakMap<MemoryExportGenerateAttemptV1, AttemptStateV1>
): {
    readonly result: unknown | null
    readonly state: AttemptStateV1 | null
    readonly staleToken: string | null
  } {
  const database = options.database
  const command = decodeMemoryExportCommandWireV1(envelope.command.wire)
  if (command.operation !== 'export.generate' || command.exportId === null ||
    command.expectedManifestHash === null) throw new CanonicalExportDataErrorV1()
  const commandHash = memoryExportCommandHashV1(envelope.command)
  beginImmediate(database)
  try {
    const freshNow = freezeTrustedNow(database, options.now)
    assertUsageExact(database, command.namespaceRef)
    const denial = authorityDenial(envelope, freshNow, command.operation)
    if (denial !== null) {
      database.exec('ROLLBACK')
      return { result: { status: 'denied', category: denial }, state: null, staleToken: null }
    }
    const namespace = namespaceState(database, command.namespaceRef)
    if (namespace === null || namespace.generation !== command.expectedNamespaceGeneration) {
      database.exec('ROLLBACK')
      return {
        result: { status: 'conflict', category: 'generation' },
        state: null,
        staleToken: null
      }
    }
    const job = loadJob(database, command.exportId)
    if (job === null || job.namespaceRef !== command.namespaceRef ||
      job.namespaceGeneration !== command.expectedNamespaceGeneration) {
      database.exec('ROLLBACK')
      return { result: { status: 'conflict', category: 'state' }, state: null, staleToken: null }
    }
    if (job.terminalCommandHash !== null) {
      if (job.terminalCommandHash !== commandHash || job.manifestWire === null) {
        database.exec('ROLLBACK')
        return {
          result: { status: 'conflict', category: 'idempotency' },
          state: null,
          staleToken: null
        }
      }
      const terminal = decodeMemoryExportStableResultWireV1(job.manifestWire)
      database.exec('COMMIT')
      return { result: terminal, state: null, staleToken: null }
    }
    const reservation = loadReservation(database, command.exportId)
    if (reservation === null ||
      memoryExportStableResultHashV1(reservation.manifest) !== command.expectedManifestHash ||
      reservation.manifest.contentEpoch !== job.contentEpoch ||
      namespace.contentEpoch !== job.contentEpoch ||
      reservation.manifest.retryOfExportId !== command.retryOfExportId ||
      reservation.manifest.expectedSnapshotSha256 !== command.expectedSnapshotSha256) {
      database.exec('ROLLBACK')
      return { result: { status: 'conflict', category: 'state' }, state: null, staleToken: null }
    }
    const nowMs = Date.parse(freshNow)
    if (nowMs >= job.expiresAtMs) {
      database.exec('ROLLBACK')
      return { result: { status: 'conflict', category: 'state' }, state: null, staleToken: null }
    }
    if (job.state === 'writing' && job.leasedUntilMs !== null && job.leasedUntilMs > nowMs) {
      database.exec('ROLLBACK')
      return {
        result: { status: 'unavailable', category: 'busy', retryable: true },
        state: null,
        staleToken: null
      }
    }
    if (job.state !== 'prepared' && job.state !== 'writing') {
      throw new CanonicalExportDataErrorV1()
    }
    const deployment = database.prepare(`
      SELECT export_fencing_counter, export_lease_owner_id, export_lease_token,
        export_leased_until_ms FROM lifecycle_deployment_state WHERE singleton = 1
    `).get() as Row | undefined
    if (deployment === undefined) throw new CanonicalExportDataErrorV1()
    const counter = exactInteger(rowValue(deployment, 'export_fencing_counter'))
    const globalOwner = nullableString(rowValue(deployment, 'export_lease_owner_id'))
    const globalToken = nullableString(rowValue(deployment, 'export_lease_token'))
    const globalUntil = nullableInteger(rowValue(deployment, 'export_leased_until_ms'))
    if ((globalOwner === null) !== (globalToken === null) ||
      (globalOwner === null) !== (globalUntil === null) ||
      (globalOwner !== null && !LEASE_OWNER_PATTERN.test(globalOwner)) ||
      (globalToken !== null && !LEASE_TOKEN_PATTERN.test(globalToken))) {
      throw new CanonicalExportDataErrorV1()
    }
    if (globalUntil !== null && globalUntil > nowMs) {
      database.exec('ROLLBACK')
      return {
        result: { status: 'unavailable', category: 'busy', retryable: true },
        state: null,
        staleToken: null
      }
    }
    const fencingToken = counter + 1
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
      throw new CanonicalExportDataErrorV1()
    }
    const leaseToken = randomBytes(32).toString('hex')
    const leasedUntilMs = Math.min(nowMs + MEMORY_EXPORT_LEASE_TTL_MS_V1, job.expiresAtMs)
    if (leasedUntilMs <= job.preparedAtMs || leasedUntilMs <= nowMs) {
      throw new CanonicalExportDataErrorV1()
    }
    requireOneChange(database.prepare(`
      UPDATE lifecycle_deployment_state SET export_fencing_counter = ?,
        export_lease_owner_id = ?, export_lease_token = ?, export_leased_until_ms = ?
      WHERE singleton = 1 AND export_fencing_counter = ?
    `).run(
      fencingToken,
      options.leaseOwnerId,
      leaseToken,
      leasedUntilMs,
      counter
    ).changes)
    const writing: JobFieldsV1 = Object.freeze({
      ...job,
      state: 'writing',
      leaseOwnerId: options.leaseOwnerId,
      leaseToken,
      fencingToken,
      leasedUntilMs
    })
    requireOneChange(database.prepare(`
      UPDATE export_jobs SET state = 'writing', lease_owner_id = ?, lease_token = ?,
        fencing_token = ?, leased_until_ms = ?, job_wire_bytes = ?
      WHERE export_id = ? AND prepared_command_hash = ? AND terminal_command_hash IS NULL
    `).run(
      options.leaseOwnerId,
      leaseToken,
      fencingToken,
      leasedUntilMs,
      jobWireBytes(writing),
      job.exportId,
      job.preparedCommandHash
    ).changes)
    synchronizeUsage(database, command.namespaceRef, nowMs)
    if (!capacityAllowed(database, command.namespaceRef)) {
      throw new ExportCanonicalCapacityErrorV1()
    }
    database.exec('COMMIT')
    acquireMemoryExportGenerateAttemptV1(attempt)
    const state: AttemptStateV1 = {
      envelope,
      commandHash,
      commandRefHash: memoryExportCommandRefHashV1(command.commandRef),
      initiatedByActorRef: command.initiatedByActorRef,
      namespaceRef: command.namespaceRef,
      namespaceGeneration: command.expectedNamespaceGeneration,
      exportId: job.exportId,
      contentEpoch: job.contentEpoch,
      snapshotAt: freshNow,
      artifactExpiresAt: new Date(job.expiresAtMs).toISOString(),
      expectedSnapshotSha256: command.expectedSnapshotSha256,
      leaseOwnerId: options.leaseOwnerId,
      leaseToken,
      fencingToken,
      artifactToken: artifactToken(job.exportId, fencingToken),
      terminal: null
    }
    attemptStates.set(attempt, state)
    return {
      result: null,
      state,
      staleToken: job.state === 'writing' ? artifactToken(job.exportId, job.fencingToken) : null
    }
  } catch (error) {
    rollbackQuietly(database)
    throw error
  }
}

async function claimDelivery (
  options: ParsedOptionsV1,
  envelope: MemoryExportAuthorizationEnvelopeV1
): Promise<unknown> {
  const command = decodeMemoryExportCommandWireV1(envelope.command.wire)
  if (command.operation !== 'export.claimDelivery' || command.exportId === null ||
    command.expectedManifestHash === null) throw new CanonicalExportDataErrorV1()
  const commandHash = memoryExportCommandHashV1(envelope.command)
  const initial = loadJob(options.database, command.exportId)
  if (initial === null || initial.manifestWire === null || initial.artifactToken === null) {
    return Object.freeze({ status: 'conflict', category: 'state' })
  }
  const initialManifest = decodeMemoryExportStableResultWireV1(initial.manifestWire)
  if (initialManifest.status !== 'deliverable') throw new CanonicalExportDataErrorV1()
  const initialPath = artifactPaths(options.artifactDirectory, initial.artifactToken).final
  if (initial.state === 'deliverable' || existsSync(initialPath)) {
    await verifyArtifact(initialPath, initial.artifactToken, initialManifest)
  } else if (initial.state !== 'delivered') {
    throw new CanonicalExportDataErrorV1()
  }
  beginImmediate(options.database)
  try {
    const freshNow = freezeTrustedNow(options.database, options.now)
    assertUsageExact(options.database, command.namespaceRef)
    const denial = authorityDenial(envelope, freshNow, command.operation)
    if (denial !== null) {
      options.database.exec('ROLLBACK')
      return Object.freeze({ status: 'denied', category: denial })
    }
    const namespace = namespaceState(options.database, command.namespaceRef)
    if (namespace === null || namespace.generation !== command.expectedNamespaceGeneration) {
      options.database.exec('ROLLBACK')
      return Object.freeze({ status: 'conflict', category: 'generation' })
    }
    const job = loadJob(options.database, command.exportId)
    if (job === null || job.namespaceRef !== command.namespaceRef ||
      job.namespaceGeneration !== command.expectedNamespaceGeneration ||
      job.manifestWire === null || job.artifactToken === null ||
      job.manifestWire !== initial.manifestWire || job.artifactToken !== initial.artifactToken) {
      throw new CanonicalExportDataErrorV1()
    }
    const manifest = decodeMemoryExportStableResultWireV1(job.manifestWire)
    if (manifest.status !== 'deliverable' ||
      memoryExportStableResultHashV1(manifest) !== command.expectedManifestHash ||
      Date.parse(freshNow) >= job.expiresAtMs) {
      options.database.exec('ROLLBACK')
      return Object.freeze({ status: 'conflict', category: 'state' })
    }
    const deliveryRef = `delivery:${memoryLifecycleDomainHashV1(
      EXPORT_DELIVERY_REF_DOMAIN_V1,
      `${job.exportId}\0${commandHash}`
    )}`
    const deliveryRefHash = memoryExportDeliveryRefHashV1(deliveryRef)
    const claimReceiptHash = memoryExportClaimReceiptHashV1({
      commandHash,
      manifestHash: command.expectedManifestHash,
      deliveryRefHash
    })
    if (job.state === 'delivered') {
      if (job.claimCommandHash !== commandHash || job.deliveryRefHash !== deliveryRefHash ||
        job.claimReceiptHash !== claimReceiptHash) {
        options.database.exec('ROLLBACK')
        return Object.freeze({ status: 'conflict', category: 'idempotency' })
      }
      options.database.exec('COMMIT')
      return Object.freeze({
        status: 'delivery_claimed',
        manifest,
        deliveryRef,
        claimReceiptHash
      })
    }
    if (job.state !== 'deliverable') {
      options.database.exec('ROLLBACK')
      return Object.freeze({ status: 'conflict', category: 'state' })
    }
    const delivered: JobFieldsV1 = Object.freeze({
      ...job,
      state: 'delivered',
      claimCommandHash: commandHash,
      deliveryRefHash,
      claimReceiptHash,
      deliveredAtMs: Date.parse(freshNow)
    })
    requireOneChange(options.database.prepare(`
      UPDATE export_jobs SET state = 'delivered', claim_command_hash = ?,
        delivery_ref_hash = ?, claim_receipt_hash = ?, delivered_at_ms = ?, job_wire_bytes = ?
      WHERE export_id = ? AND state = 'deliverable' AND terminal_command_hash = ?
    `).run(
      commandHash,
      deliveryRefHash,
      claimReceiptHash,
      delivered.deliveredAtMs,
      jobWireBytes(delivered),
      job.exportId,
      job.terminalCommandHash
    ).changes)
    synchronizeUsage(options.database, command.namespaceRef, Date.parse(freshNow))
    if (!capacityAllowed(options.database, command.namespaceRef)) {
      throw new ExportCanonicalCapacityErrorV1()
    }
    options.database.exec('COMMIT')
    return Object.freeze({
      status: 'delivery_claimed',
      manifest,
      deliveryRef,
      claimReceiptHash
    })
  } catch (error) {
    rollbackQuietly(options.database)
    throw error
  }
}

function terminalForOutcome (
  state: AttemptStateV1,
  outcome: MemoryExportGenerateFinalizeOutcomeV1,
  freshNow: string
): Exclude<MemoryExportStableResultV1, MemoryExportPreparedManifestV1> {
  if (state.terminal !== null) {
    if ((outcome === 'deliverable') !== (state.terminal.status === 'deliverable') ||
      (outcome === 'snapshot_changed') !== (state.terminal.status === 'snapshot_changed') ||
      (outcome === 'failed') !== (state.terminal.status === 'failed')) {
      throw new CanonicalExportDataErrorV1()
    }
    return state.terminal
  }
  const category: MemoryExportFailedManifestV1['category'] = outcome === 'aborted'
    ? 'aborted'
    : outcome === 'invalid'
      ? 'corrupt'
      : 'unavailable'
  return failedManifest(state, category, freshNow)
}

async function redeemDelivery (
  options: ParsedOptionsV1,
  delivery: MemoryExportConsumedDeliveryV1
): Promise<{ readonly status: 'delivered' | 'already_consumed' | 'unavailable' }> {
  if (!EXPORT_ID_PATTERN.test(delivery.exportId) ||
    !DELIVERY_REF_PATTERN.test(delivery.deliveryRef) ||
    memoryExportDeliveryRefHashV1(delivery.deliveryRef) !== delivery.deliveryRefHash ||
    !HASH_PATTERN.test(delivery.claimReceiptHash)) throw new CanonicalExportDataErrorV1()
  const job = loadJob(options.database, delivery.exportId)
  if (job === null || job.state !== 'delivered' || job.manifestWire === null ||
    job.artifactToken === null || job.deliveryRefHash !== delivery.deliveryRefHash ||
    job.claimReceiptHash !== delivery.claimReceiptHash) {
    throw new CanonicalExportDataErrorV1()
  }
  const manifest = decodeMemoryExportStableResultWireV1(job.manifestWire)
  if (manifest.status !== 'deliverable') throw new CanonicalExportDataErrorV1()
  const paths = artifactPaths(options.artifactDirectory, job.artifactToken)
  let lock: Awaited<ReturnType<typeof open>> | null = null
  for (let attempt = 0; attempt < 2 && lock === null; attempt += 1) {
    try {
      lock = await open(
        paths.lock,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      )
      await lock.chmod(0o600)
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'EEXIST') {
        return Object.freeze({ status: 'unavailable' as const })
      }
      let lockInfo: Awaited<ReturnType<typeof lstat>>
      try {
        lockInfo = await lstat(paths.lock)
      } catch {
        continue
      }
      const nowMs = Date.parse(canonicalTime(Reflect.apply(options.now, undefined, [])))
      if (!lockInfo.isFile() || lockInfo.isSymbolicLink() ||
        (lockInfo.mode & 0o777) !== 0o600 || lockInfo.mtimeMs > nowMs ||
        nowMs - lockInfo.mtimeMs <= MEMORY_EXPORT_LEASE_TTL_MS_V1) {
        return Object.freeze({ status: 'unavailable' as const })
      }
      if (existsSync(paths.redeeming)) {
        try {
          await unlink(paths.lock)
        } catch {
        }
        return Object.freeze({ status: 'already_consumed' as const })
      }
      try {
        await unlink(paths.lock)
      } catch {
        return Object.freeze({ status: 'unavailable' as const })
      }
    }
  }
  if (lock === null) return Object.freeze({ status: 'unavailable' as const })
  let consumptionStarted = false
  try {
    try {
      await rename(paths.final, paths.redeeming)
      await syncArtifactDirectory(options.artifactDirectory)
    } catch (error) {
      if (!isMissing(error)) throw error
      try {
        const existing = await lstat(paths.redeeming)
        if (!existing.isFile() || existing.isSymbolicLink()) throw new ExportArtifactErrorV1()
      } catch (redeemingError) {
        if (isMissing(redeemingError)) {
          return Object.freeze({ status: 'already_consumed' as const })
        }
        throw redeemingError
      }
      return Object.freeze({ status: 'already_consumed' as const })
    }
    const file = await open(
      paths.redeeming,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    )
    const source = new FileArtifactSourceV1(file)
    try {
      await verifyArtifactFile(file, job.artifactToken, manifest)
      consumptionStarted = true
      await Reflect.apply(options.consumeArtifact, undefined, [source, manifest])
    } catch {
      return Object.freeze({ status: 'unavailable' as const })
    } finally {
      await source.close()
    }
    try {
      await unlink(paths.redeeming)
      await syncArtifactDirectory(options.artifactDirectory)
    } catch {
      // Delivery already completed. Artifact cleanup must not make it redeemable again.
    }
    return Object.freeze({ status: 'delivered' as const })
  } catch {
    try {
      if (!consumptionStarted && !existsSync(paths.final) && existsSync(paths.redeeming)) {
        await rename(paths.redeeming, paths.final)
        await syncArtifactDirectory(options.artifactDirectory)
      }
    } catch {
    }
    return Object.freeze({ status: 'unavailable' as const })
  } finally {
    try {
      await lock.close()
    } catch {
    }
    try {
      await unlink(paths.lock)
    } catch {
    }
  }
}

export function createSqliteMemoryExportAdapterV1 (
  optionsValue: CreateSqliteMemoryExportAdapterOptionsV1
): SqliteMemoryExportAdapterV1 {
  const options = parseOptions(optionsValue)
  ensureArtifactDirectory(options.artifactDirectory)
  const attemptStates = new WeakMap<MemoryExportGenerateAttemptV1, AttemptStateV1>()

  const execute: MemoryExportPortOptionsV1['execute'] = async (
    envelope,
    signal,
    generateAttempt
  ) => {
    if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
    const command = decodeMemoryExportCommandWireV1(envelope.command.wire)
    if (command.operation === 'export.prepare') {
      beginImmediate(options.database)
      try {
        const freshNow = freezeTrustedNow(options.database, options.now)
        assertUsageExact(options.database, command.namespaceRef)
        const denial = authorityDenial(envelope, freshNow, command.operation)
        if (denial !== null) {
          options.database.exec('ROLLBACK')
          return Object.freeze({ status: 'denied' as const, category: denial })
        }
        const result = insertPreparedState(options.database, envelope, freshNow)
        options.database.exec('COMMIT')
        return result
      } catch (error) {
        rollbackQuietly(options.database)
        return mapAdapterError(error)
      }
    }
    if (command.operation === 'export.claimDelivery') {
      try {
        return await claimDelivery(options, envelope)
      } catch (error) {
        return mapAdapterError(error)
      }
    }
    if (generateAttempt === undefined) throw new CanonicalExportDataErrorV1()
    try {
      const acquired = acquireGenerateLease(options, envelope, generateAttempt, attemptStates)
      if (acquired.result !== null) {
        if (acquired.result !== null && typeof acquired.result === 'object' &&
          Object.hasOwn(acquired.result, 'status') &&
          ['deliverable', 'snapshot_changed', 'failed'].includes(
            String((acquired.result as { status: unknown }).status)
          )) {
          const replay = acquired.result as MemoryExportStableResultV1
          if (replay.status === 'deliverable') {
            const job = loadJob(options.database, replay.exportId)
            if (job === null || job.artifactToken === null) throw new CanonicalExportDataErrorV1()
            const finalPath = artifactPaths(options.artifactDirectory, job.artifactToken).final
            if (job.state === 'deliverable' || existsSync(finalPath)) {
              await verifyArtifact(finalPath, job.artifactToken, replay)
            } else if (job.state !== 'delivered') {
              throw new CanonicalExportDataErrorV1()
            }
          }
        }
        return acquired.result
      }
      const state = acquired.state
      if (state === null) throw new CanonicalExportDataErrorV1()
      if (acquired.staleToken !== null && acquired.staleToken !== state.artifactToken) {
        const stale = ARTIFACT_TOKEN_PATTERN.exec(acquired.staleToken)
        if (stale === null) throw new CanonicalExportDataErrorV1()
        cleanArtifactFence(options.artifactDirectory, `export:${stale[1]}`, Number(stale[2]))
      }
      try {
        state.terminal = await generateSnapshot(
          options.database,
          options.artifactDirectory,
          options.artifactCapacityBytes,
          state,
          signal
        )
      } catch (error) {
        state.terminal = failedManifest(
          state,
          error instanceof ExportAbortedErrorV1
            ? 'aborted'
            : error instanceof ExportArtifactCapacityErrorV1
              ? 'capacity'
              : error instanceof CanonicalExportDataErrorV1
                ? 'corrupt'
                : 'unavailable'
        )
      }
      return state.terminal
    } catch (error) {
      return mapAdapterError(error)
    }
  }

  const cleanupPartial: MemoryExportPortOptionsV1['cleanupPartial'] = async attempt => {
    const state = attemptStates.get(attempt)
    if (state === undefined) throw new CanonicalExportDataErrorV1()
    const job = loadJob(options.database, state.exportId)
    if (job !== null && job.terminalCommandHash === state.commandHash &&
      job.state === 'deliverable' && job.artifactToken === state.artifactToken) return
    cleanArtifactFence(options.artifactDirectory, state.exportId, state.fencingToken)
  }

  const finalizeGenerate: MemoryExportPortOptionsV1['finalizeGenerate'] = async (
    attempt,
    outcome
  ): Promise<MemoryExportGenerateFinalizeResultV1> => {
    const state = attemptStates.get(attempt)
    if (state === undefined) throw new CanonicalExportDataErrorV1()
    beginImmediate(options.database)
    try {
      const freshNow = freezeTrustedNow(options.database, options.now)
      assertUsageExact(options.database, state.namespaceRef)
      const existing = loadJob(options.database, state.exportId)
      if (existing === null) throw new CanonicalExportDataErrorV1()
      if (existing.terminalCommandHash !== null) {
        if (existing.terminalCommandHash !== state.commandHash || existing.manifestWire === null) {
          throw new CanonicalExportDataErrorV1()
        }
        const replay = decodeMemoryExportStableResultWireV1(existing.manifestWire)
        if (replay.status === 'prepared') throw new CanonicalExportDataErrorV1()
        options.database.exec('COMMIT')
        attemptStates.delete(attempt)
        return Object.freeze({ status: 'terminal' as const, manifest: replay })
      }
      if (existing.state !== 'writing' || existing.leaseOwnerId !== state.leaseOwnerId ||
        existing.leaseToken !== state.leaseToken ||
        existing.fencingToken !== state.fencingToken) throw new CanonicalExportDataErrorV1()
      const deployment = options.database.prepare(`
        SELECT export_fencing_counter, export_lease_owner_id, export_lease_token
        FROM lifecycle_deployment_state WHERE singleton = 1
      `).get() as Row | undefined
      if (deployment === undefined ||
        positiveInteger(rowValue(deployment, 'export_fencing_counter')) !== state.fencingToken ||
        nullableString(rowValue(deployment, 'export_lease_owner_id')) !== state.leaseOwnerId ||
        nullableString(rowValue(deployment, 'export_lease_token')) !== state.leaseToken) {
        throw new CanonicalExportDataErrorV1()
      }
      const terminal = terminalForOutcome(state, outcome, freshNow)
      const isDeliverable = terminal.status === 'deliverable'
      const paths = artifactPaths(options.artifactDirectory, state.artifactToken)
      if (isDeliverable) {
        await verifyArtifact(paths.final, state.artifactToken, terminal)
      } else if (existsSync(paths.final) || existsSync(paths.partial) ||
        existsSync(paths.redeeming)) {
        throw new ExportArtifactErrorV1()
      }
      const reservation = loadReservation(options.database, state.exportId)
      if (reservation === null) throw new CanonicalExportDataErrorV1()
      requireOneChange(options.database.prepare(`
        DELETE FROM export_audit_reservations WHERE export_id = ? AND command_hash = ?
      `).run(state.exportId, reservation.manifest.commandHash).changes)
      const auditState = terminalAuditOutcome(terminal)
      insertAudit(options.database, createExportAudit(
        auditState.operation,
        state.envelope,
        state.exportId,
        freshNow,
        auditState.outcome,
        terminal.receiptHash
      ))
      const manifestWire = encodeMemoryExportStableResultWireV1(terminal)
      const terminalJob: JobFieldsV1 = Object.freeze({
        ...existing,
        state: isDeliverable ? 'deliverable' : 'failed',
        terminalCommandHash: state.commandHash,
        leaseOwnerId: null,
        leaseToken: null,
        leasedUntilMs: null,
        manifestWire,
        artifactToken: isDeliverable ? state.artifactToken : null,
        terminalAtMs: Date.parse(freshNow)
      })
      requireOneChange(options.database.prepare(`
        UPDATE export_jobs SET state = ?, terminal_command_hash = ?, lease_owner_id = NULL,
          lease_token = NULL, leased_until_ms = NULL, manifest_wire = ?,
          manifest_wire_bytes = ?, artifact_token = ?, terminal_at_ms = ?, job_wire_bytes = ?
        WHERE export_id = ? AND state = 'writing' AND lease_owner_id = ?
          AND lease_token = ? AND fencing_token = ?
      `).run(
        terminalJob.state,
        state.commandHash,
        manifestWire,
        byteLength(manifestWire),
        terminalJob.artifactToken,
        terminalJob.terminalAtMs,
        jobWireBytes(terminalJob),
        state.exportId,
        state.leaseOwnerId,
        state.leaseToken,
        state.fencingToken
      ).changes)
      requireOneChange(options.database.prepare(`
        UPDATE lifecycle_deployment_state SET export_lease_owner_id = NULL,
          export_lease_token = NULL, export_leased_until_ms = NULL
        WHERE singleton = 1 AND export_fencing_counter = ?
          AND export_lease_owner_id = ? AND export_lease_token = ?
      `).run(state.fencingToken, state.leaseOwnerId, state.leaseToken).changes)
      synchronizeUsage(options.database, state.namespaceRef, Date.parse(freshNow))
      if (!capacityAllowed(options.database, state.namespaceRef)) {
        throw new ExportCanonicalCapacityErrorV1()
      }
      options.database.exec('COMMIT')
      attemptStates.delete(attempt)
      return Object.freeze({ status: 'terminal' as const, manifest: terminal })
    } catch (error) {
      rollbackQuietly(options.database)
      throw error
    }
  }

  const persistentDelivery: MemoryExportPersistentDeliveryAdapterV1 = Object.freeze({
    redeemOnce: async (delivery: MemoryExportConsumedDeliveryV1) =>
      redeemDelivery(options, delivery)
  })

  const cleanupExpired = async (limitValue = MEMORY_EXPORT_CLEANUP_BATCH_V1) => {
    if (!Number.isSafeInteger(limitValue) || limitValue <= 0 || limitValue > 64) {
      return invalidMemoryValue()
    }
    beginImmediate(options.database)
    try {
      const freshNow = freezeTrustedNow(options.database, options.now)
      const nowMs = Date.parse(freshNow)
      const rows = options.database.prepare(`
        SELECT export_id FROM export_jobs WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms ASC, export_id ASC LIMIT ?
      `).all(nowMs, limitValue + 1) as Row[]
      const selected = rows.slice(0, limitValue)
      const namespaces = new Set<string>()
      const jobs = selected.map(row => {
        const exportId = exactString(rowValue(row, 'export_id'))
        const job = loadJob(options.database, exportId)
        if (job === null) throw new CanonicalExportDataErrorV1()
        namespaces.add(job.namespaceRef)
        return job
      })
      for (const namespaceRef of namespaces) assertUsageExact(options.database, namespaceRef)
      let deletedArtifacts = 0
      for (const job of jobs) {
        if (job.artifactToken !== null) {
          deletedArtifacts += cleanArtifactPaths(options.artifactDirectory, job.artifactToken)
        }
        deletedArtifacts += cleanArtifactFence(
          options.artifactDirectory,
          job.exportId,
          job.fencingToken
        )
        options.database.prepare(`
          DELETE FROM export_audit_reservations WHERE export_id = ?
        `).run(job.exportId)
        if (job.state === 'writing' && job.leaseOwnerId !== null && job.leaseToken !== null) {
          options.database.prepare(`
            UPDATE lifecycle_deployment_state SET export_lease_owner_id = NULL,
              export_lease_token = NULL, export_leased_until_ms = NULL
            WHERE singleton = 1 AND export_fencing_counter = ?
              AND export_lease_owner_id = ? AND export_lease_token = ?
          `).run(job.fencingToken, job.leaseOwnerId, job.leaseToken)
        }
        requireOneChange(options.database.prepare(`
          DELETE FROM export_jobs WHERE export_id = ? AND expires_at_ms <= ?
        `).run(job.exportId, nowMs).changes)
      }
      for (const namespaceRef of namespaces) {
        synchronizeUsage(options.database, namespaceRef, nowMs)
      }
      if (deletedArtifacts > 0) await syncArtifactDirectory(options.artifactDirectory)
      options.database.exec('COMMIT')
      return Object.freeze({
        deletedJobs: selected.length,
        deletedArtifacts,
        hasMore: rows.length > selected.length
      })
    } catch (error) {
      rollbackQuietly(options.database)
      throw error
    }
  }

  return Object.freeze({
    execute,
    cleanupPartial,
    finalizeGenerate,
    persistentDelivery,
    cleanupExpired
  })
}

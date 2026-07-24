export const MEMORY_RESOURCE_LIMITS = Object.freeze({
  recordWireBytes: 16 * 1_024,
  textUtf8Bytes: 4 * 1_024,
  textCodePoints: 2_000,
  sources: 8,
  sourceExcerptUtf8Bytes: 1_024,
  sourceResourceRefs: 4,
  proposalWireBytes: 24 * 1_024,
  revisionWireBytes: 24 * 1_024,
  tombstoneWireBytes: 4 * 1_024,
  outboxEventWireBytes: 4 * 1_024,
  conflictRefs: 16,
  supersedesRefs: 16,
  listPageRecords: 64,
  listPageWireBytes: 512 * 1_024,
  operationBatchRecords: 32,
  namespaceActiveRecords: 4_096,
  namespacePendingProposals: 256,
  memoryRetainedRevisions: 32,
  namespaceCanonicalLogicalBytes: 64 * 1_024 * 1_024,
  deploymentNamespaces: 4_096,
  deploymentActiveRecords: 32_768,
  deploymentCanonicalLogicalBytes: 256 * 1_024 * 1_024,
  unackedOutboxRecords: 4_096,
  unackedOutboxLogicalBytes: 16 * 1_024 * 1_024,
  sqlitePageCacheBytes: 2 * 1_024 * 1_024,
  sqliteWalJournalLimitBytes: 32 * 1_024 * 1_024,
  sqliteMainFileBytes: 512 * 1_024 * 1_024,
  redisHotRecords: 2_048,
  redisHotLogicalBytes: 16 * 1_024 * 1_024,
  redisHotAbsoluteTtlMs: 24 * 60 * 60 * 1_000,
  tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  identifierCodePoints: 128,
  qqIdDigits: 32,
  opaqueIdAsciiBytes: 128,
  identityTextCodePoints: 256,
  identityTextUtf8Bytes: 1_024,
  reasonTextCodePoints: 512,
  reasonTextUtf8Bytes: 2 * 1_024,
  resourceRefAsciiBytes: 256,
  trustedMemberSnapshotMaxAgeMs: 60_000,
  trustedMemberSnapshotFutureSkewMs: 5_000,
  accessNamespaces: 64,
  trustedMemberUserIds: 4_096
})

export const MEMORY_DERIVATIVE_RESOURCE_LIMITS = Object.freeze({
  personalPolicyWireBytes: 4 * 1_024,
  derivativeJobLogicalBytes: 1 * 1_024,
  derivativeJobRecords: 8_192,
  derivativeJobLogicalBytesTotal: 8 * 1_024 * 1_024,
  extractionJobWireBytes: 8 * 1_024,
  extractionQueueRecords: 1_024,
  extractionQueueLogicalBytes: 8 * 1_024 * 1_024,
  extractionWorkerBatchRecords: 2,
  extractionWorkerMaximumAttempts: 5,
  extractionLeaseDurationMs: 30_000,
  extractionJobMaximumAgeMs: 24 * 60 * 60 * 1_000,
  candidateAuditRecords: 8_192,
  lexicalIndexRecords: 32_768,
  lexicalIndexLogicalBytes: 128 * 1_024 * 1_024,
  lexicalSqliteMainFileBytes: 256 * 1_024 * 1_024
})

export const MEMORY_LIFECYCLE_RESOURCE_LIMITS = Object.freeze({
  lifecycleCapabilityAbsoluteTtlMs: 60_000,
  lifecycleActorActions: 15,
  lifecyclePolicyValues: 16,
  lifecycleCommandWireBytes: 4 * 1_024,
  lifecycleCommandResultWireBytes: 4 * 1_024,
  lifecycleCommandMaterialWireBytes: 64 * 1_024,
  lifecycleCommandLedgerRecordsPerNamespace: 8_192,
  lifecycleCommandLedgerBytesPerNamespace: 8 * 1_024 * 1_024,
  lifecycleCommandLedgerRecordsPerDeployment: 65_536,
  lifecycleCommandLedgerBytesPerDeployment: 64 * 1_024 * 1_024,
  lifecycleCommandLedgerTtlMs: 365 * 24 * 60 * 60 * 1_000,
  lifecycleEvidenceWireBytes: 4 * 1_024,
  lifecycleMigrationManifestWireBytes: 16 * 1_024,
  lifecycleMigrationRevisionBindings: 32,
  lifecycleDeletionCheckpointsPerNamespace: 32,
  lifecycleDeletionCheckpointWireBytes: 4 * 1_024,
  lifecycleDeletionReceiptWireBytes: 4 * 1_024,
  lifecycleDeletionStatusWireBytes: 4 * 1_024,
  lifecycleDeletionCheckpointsPerDeployment: 4_096,
  lifecycleDeletionCheckpointBytesPerDeployment: 16 * 1_024 * 1_024,
  lifecycleExportJobsPerNamespace: 64,
  lifecycleExportJobBytesPerNamespace: 512 * 1_024,
  lifecycleExportJobsPerDeployment: 512,
  lifecycleExportJobBytesPerDeployment: 4 * 1_024 * 1_024,
  lifecycleExportJobWireBytes: 8 * 1_024,
  lifecycleExportTerminalTtlMs: 30 * 60 * 1_000,
  lifecycleAuditTtlMs: 365 * 24 * 60 * 60 * 1_000,
  lifecycleAuditWireBytes: 2 * 1_024,
  lifecycleAuditReservationWireBytes: 2 * 1_024
})

function hasLoneSurrogate (value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function canonicalStringWithinLimits (
  value: unknown,
  maximumUtf8Bytes: number,
  maximumCodePoints: number | null
): value is string {
  if (typeof value !== 'string' || value.length > maximumUtf8Bytes ||
    hasLoneSurrogate(value) || value.normalize('NFC') !== value) {
    return false
  }
  if (Buffer.byteLength(value, 'utf8') > maximumUtf8Bytes) return false
  return maximumCodePoints === null || Array.from(value).length <= maximumCodePoints
}

export function memoryTextWithinLimits (value: unknown): value is string {
  return canonicalStringWithinLimits(
    value,
    MEMORY_RESOURCE_LIMITS.textUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.textCodePoints
  )
}

export function memorySourceExcerptWithinLimits (value: unknown): value is string {
  return canonicalStringWithinLimits(
    value,
    MEMORY_RESOURCE_LIMITS.sourceExcerptUtf8Bytes,
    null
  )
}

export function memoryCanonicalTextWithinLimits (
  value: unknown,
  maximumUtf8Bytes: number,
  maximumCodePoints: number
): value is string {
  return Number.isSafeInteger(maximumUtf8Bytes) && maximumUtf8Bytes >= 0 &&
    Number.isSafeInteger(maximumCodePoints) && maximumCodePoints >= 0 &&
    canonicalStringWithinLimits(value, maximumUtf8Bytes, maximumCodePoints)
}

export function memoryAsciiWithinLimit (value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && Number.isSafeInteger(maximumBytes) && maximumBytes >= 0 &&
    value.length <= maximumBytes && /^[\x21-\x7e]*$/.test(value)
}

export function memoryWireBytesWithinLimit (bytes: unknown, limit: number): boolean {
  return Number.isSafeInteger(bytes) && typeof bytes === 'number' && bytes >= 0 &&
    Number.isSafeInteger(limit) && limit >= 0 && bytes <= limit
}

export function memoryCountWithinLimit (count: unknown, limit: number): boolean {
  return Number.isSafeInteger(count) && typeof count === 'number' && count >= 0 &&
    Number.isSafeInteger(limit) && limit >= 0 && count <= limit
}

export function memoryFixedDurationMatches (durationMs: unknown, expectedMs: number): boolean {
  return Number.isSafeInteger(durationMs) && typeof durationMs === 'number' && durationMs > 0 &&
    Number.isSafeInteger(expectedMs) && expectedMs > 0 && durationMs === expectedMs
}

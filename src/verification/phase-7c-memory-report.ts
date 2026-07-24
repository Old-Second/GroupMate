import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import {
  MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
  MEMORY_EXPORT_MAX_WIRE_BYTES_V1
} from '../agent/memory/memory-export-port.js'
import {
  MEMORY_LIFECYCLE_RESOURCE_LIMITS
} from '../agent/memory/memory-resource-limits.js'
import {
  MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1,
  MEMORY_EXPORT_LEASE_TTL_MS_V1
} from '../agent/memory/sqlite-memory-export.js'
import {
  auditPhase7SecurityBoundaries,
  type Phase7SecurityAuditOptions,
  type Phase7SecurityAuditResult
} from './phase-7-security-audit.js'
import {
  auditPhase7bMemoryWiring,
  phase7bOutboxSurfaceIsBodyFree,
  type Phase7bMemoryWiringAudit
} from './phase-7b-memory-report.js'
import {
  PHASE_7C_MEMORY_RESOURCE_SCENARIOS,
  PHASE_7C_MEMORY_SENSITIVE_SENTINELS,
  runPhase7cMemoryResourceScenario,
  validatePhase7cMemoryResourceSample,
  type Phase7cMemoryResourceSample,
  type Phase7cMemoryResourceScenarioName
} from './phase-7c-memory-scenario.js'

const MIB = 1_024 * 1_024
const MAX_AUDIT_FILE_BYTES = 2 * MIB
const MAX_CHILD_OUTPUT_BYTES = 64 * 1_024
const RESOURCE_CHILD_TIMEOUT_MS = 30_000
const RESOURCE_SAMPLE_ARGUMENT = '--sample'

export const PHASE_7C_MEMORY_RESOURCE_SAMPLES = 5
export const PHASE_7C_MEMORY_RSS_LIMIT_BYTES = 24 * MIB

export const PHASE_7C_EXPECTED_MEMORY_LIFECYCLE_RESOURCE_LIMITS = Object.freeze({
  lifecycleCapabilityAbsoluteTtlMs: 60_000,
  lifecycleActorActions: 15,
  lifecyclePolicyValues: 16,
  lifecycleCommandWireBytes: 4 * 1_024,
  lifecycleCommandResultWireBytes: 4 * 1_024,
  lifecycleCommandMaterialWireBytes: 64 * 1_024,
  lifecycleCommandLedgerRecordsPerNamespace: 8_192,
  lifecycleCommandLedgerBytesPerNamespace: 8 * MIB,
  lifecycleCommandLedgerRecordsPerDeployment: 65_536,
  lifecycleCommandLedgerBytesPerDeployment: 64 * MIB,
  lifecycleCommandLedgerTtlMs: 365 * 24 * 60 * 60 * 1_000,
  lifecycleEvidenceWireBytes: 4 * 1_024,
  lifecycleMigrationManifestWireBytes: 16 * 1_024,
  lifecycleMigrationRevisionBindings: 32,
  lifecycleDeletionCheckpointsPerNamespace: 32,
  lifecycleDeletionCheckpointWireBytes: 4 * 1_024,
  lifecycleDeletionReceiptWireBytes: 4 * 1_024,
  lifecycleDeletionStatusWireBytes: 4 * 1_024,
  lifecycleDeletionCheckpointsPerDeployment: 4_096,
  lifecycleDeletionCheckpointBytesPerDeployment: 16 * MIB,
  lifecycleExportJobsPerNamespace: 64,
  lifecycleExportJobBytesPerNamespace: 512 * 1_024,
  lifecycleExportJobsPerDeployment: 512,
  lifecycleExportJobBytesPerDeployment: 4 * MIB,
  lifecycleExportJobWireBytes: 8 * 1_024,
  lifecycleExportTerminalTtlMs: 30 * 60 * 1_000,
  lifecycleAuditTtlMs: 365 * 24 * 60 * 60 * 1_000,
  lifecycleAuditWireBytes: 2 * 1_024,
  lifecycleAuditReservationWireBytes: 2 * 1_024
})

export const PHASE_7C_EXPECTED_EXPORT_RESOURCE_LIMITS = Object.freeze({
  maximumWireBytes: 80 * MIB,
  maximumChunkBytes: 64 * 1_024,
  artifactCapacityBytes: 256 * MIB,
  leaseTtlMs: 5 * 60 * 1_000
})

export interface Phase7cMemoryProcessSample {
  readonly processId: number
  readonly sample: Phase7cMemoryResourceSample
}

export interface Phase7cMemoryNumericStats {
  readonly median: number
  readonly minimum: number
  readonly maximum: number
  readonly mad: number
}

export interface Phase7cMemoryScenarioReport {
  readonly processIds: readonly number[]
  readonly samples: readonly Phase7cMemoryResourceSample[]
  readonly rss: Readonly<{
    baseline: Phase7cMemoryNumericStats
    retainedDelta: Phase7cMemoryNumericStats
    peakDelta: Phase7cMemoryNumericStats
  }>
  readonly wallTimeMs: Phase7cMemoryNumericStats
  readonly generatedArtifactBytes: Phase7cMemoryNumericStats
  readonly peakCanonicalLogicalBytes: Phase7cMemoryNumericStats
  readonly peakLifecycleLogicalBytes: Phase7cMemoryNumericStats
}

export interface Phase7cMemoryResourceReport {
  readonly schemaVersion: 1
  readonly samplesPerScenario: 5
  readonly totalProcessCount: 15
  readonly processIds: readonly number[]
  readonly scenarios: Readonly<Record<
  Phase7cMemoryResourceScenarioName,
  Phase7cMemoryScenarioReport
  >>
  readonly thresholds: Readonly<{ rssDeltaBytes: number }>
  readonly limitContracts: Readonly<{
    lifecycle: typeof MEMORY_LIFECYCLE_RESOURCE_LIMITS
    expectedLifecycle: typeof PHASE_7C_EXPECTED_MEMORY_LIFECYCLE_RESOURCE_LIMITS
    export: Readonly<{
      maximumWireBytes: number
      maximumChunkBytes: number
      artifactCapacityBytes: number
      leaseTtlMs: number
    }>
    expectedExport: typeof PHASE_7C_EXPECTED_EXPORT_RESOURCE_LIMITS
  }>
  readonly gates: Readonly<{
    everySampleRss: boolean
    cleanupComplete: boolean
    noDerivedLeaks: boolean
    noRedisOrTimerSideEffects: boolean
    lifecycleLimitsExact: boolean
    exportLimitsExact: boolean
  }>
  readonly passed: boolean
}

export interface Phase7cLifecycleSurfaceAudit {
  readonly lifecycleAuditBodyFree: boolean
  readonly deletionReceiptBodyFree: boolean
  readonly lifecycleCommandWireHashOnly: boolean
  readonly lifecycleCommandLedgerBodyFree: boolean
  readonly outboxBodyFree: boolean
  readonly passed: boolean
}

export interface Phase7cMemoryVerificationReport {
  readonly schemaVersion: 1
  readonly resources: Phase7cMemoryResourceReport
  readonly production: Phase7bMemoryWiringAudit
  readonly security: Readonly<{
    phase7Passed: boolean
    phase7FindingCount: number
    lifecycle: Phase7cLifecycleSurfaceAudit
  }>
  readonly passed: boolean
}

type ResourceInput = Readonly<Record<
Phase7cMemoryResourceScenarioName,
readonly Phase7cMemoryProcessSample[]
>>

interface VerifyPhase7cMemoryOptions {
  readonly samples?: unknown
  readonly productionAudit?: (projectRoot: string) => Promise<Phase7bMemoryWiringAudit>
  readonly securityAudit?: (
    projectRoot: string,
    options?: Phase7SecurityAuditOptions
  ) => Promise<Phase7SecurityAuditResult>
  readonly lifecycleAudit?: (projectRoot: string) => Promise<Phase7cLifecycleSurfaceAudit>
}

function safeProjectRoot (value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Phase 7C memory verification project root is invalid')
  }
  return path.resolve(value)
}

function exactRecord (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function sameStrings (left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameNumericRecord (
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>
): boolean {
  return sameStrings(Object.keys(left), Object.keys(right)) &&
    Object.keys(left).every(key => left[key] === right[key])
}

function median (values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('statistics require values')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function statistics (values: readonly number[]): Phase7cMemoryNumericStats {
  if (values.some(value => !Number.isSafeInteger(value))) {
    throw new TypeError('Phase 7C memory statistics require safe integers')
  }
  const center = median(values)
  return Object.freeze({
    median: center,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    mad: median(values.map(value => Math.abs(value - center)))
  })
}

function validateResourceInput (value: unknown): ResourceInput {
  const input = exactRecord(value, 'Phase 7C memory resource samples')
  if (!sameStrings(Object.keys(input).sort(), [...PHASE_7C_MEMORY_RESOURCE_SCENARIOS].sort())) {
    throw new TypeError('Phase 7C memory resource scenarios are incomplete')
  }
  const processIds = new Set<number>()
  const entries = Object.fromEntries(PHASE_7C_MEMORY_RESOURCE_SCENARIOS.map(scenario => {
    const values = input[scenario]
    if (!Array.isArray(values) || values.length !== PHASE_7C_MEMORY_RESOURCE_SAMPLES) {
      throw new TypeError('Phase 7C memory report requires five fresh processes per scenario')
    }
    const samples = values.map((value, index) => {
      const entry = exactRecord(value, `Phase 7C memory sample ${scenario}:${index}`)
      if (!sameStrings(Object.keys(entry).sort(), ['processId', 'sample']) ||
        !Number.isSafeInteger(entry.processId) || Number(entry.processId) <= 0) {
        throw new TypeError('Phase 7C memory process sample is invalid')
      }
      const processId = Number(entry.processId)
      if (processIds.has(processId)) {
        throw new TypeError('Phase 7C memory samples require unique fresh processes')
      }
      processIds.add(processId)
      return Object.freeze({
        processId,
        sample: validatePhase7cMemoryResourceSample(entry.sample, scenario)
      })
    })
    return [scenario, Object.freeze(samples)]
  }))
  if (processIds.size !== PHASE_7C_MEMORY_RESOURCE_SCENARIOS.length *
    PHASE_7C_MEMORY_RESOURCE_SAMPLES) {
    throw new TypeError('Phase 7C memory samples require fifteen fresh processes')
  }
  return Object.freeze(entries) as ResourceInput
}

function scenarioReport (
  entries: readonly Phase7cMemoryProcessSample[]
): Phase7cMemoryScenarioReport {
  const samples = entries.map(entry => entry.sample)
  return Object.freeze({
    processIds: Object.freeze(entries.map(entry => entry.processId)),
    samples: Object.freeze(samples),
    rss: Object.freeze({
      baseline: statistics(samples.map(sample => sample.baselineRssBytes)),
      retainedDelta: statistics(samples.map(sample => (
        sample.retainedRssBytes - sample.baselineRssBytes
      ))),
      peakDelta: statistics(samples.map(sample => (
        sample.peakRssBytes - sample.baselineRssBytes
      )))
    }),
    wallTimeMs: statistics(samples.map(sample => sample.wallTimeMs)),
    generatedArtifactBytes: statistics(samples.map(sample => sample.generatedArtifactBytes)),
    peakCanonicalLogicalBytes: statistics(samples.map(
      sample => sample.peakCanonicalLogicalBytes
    )),
    peakLifecycleLogicalBytes: statistics(samples.map(
      sample => sample.peakLifecycleLogicalBytes
    ))
  })
}

export function buildPhase7cMemoryResourceReport (
  value: unknown
): Phase7cMemoryResourceReport {
  const input = validateResourceInput(value)
  const scenarios = Object.freeze(Object.fromEntries(
    PHASE_7C_MEMORY_RESOURCE_SCENARIOS.map(scenario => [
      scenario,
      scenarioReport(input[scenario])
    ])
  )) as Readonly<Record<Phase7cMemoryResourceScenarioName, Phase7cMemoryScenarioReport>>
  const samples = PHASE_7C_MEMORY_RESOURCE_SCENARIOS.flatMap(
    scenario => input[scenario].map(entry => entry.sample)
  )
  const processIds = Object.freeze(PHASE_7C_MEMORY_RESOURCE_SCENARIOS.flatMap(
    scenario => input[scenario].map(entry => entry.processId)
  ))
  const exportLimits = Object.freeze({
    maximumWireBytes: MEMORY_EXPORT_MAX_WIRE_BYTES_V1,
    maximumChunkBytes: MEMORY_EXPORT_MAX_CHUNK_BYTES_V1,
    artifactCapacityBytes: MEMORY_EXPORT_ARTIFACT_CAPACITY_BYTES_V1,
    leaseTtlMs: MEMORY_EXPORT_LEASE_TTL_MS_V1
  })
  const gates = Object.freeze({
    everySampleRss: samples.every(sample =>
      sample.retainedRssBytes - sample.baselineRssBytes <= PHASE_7C_MEMORY_RSS_LIMIT_BYTES &&
      sample.peakRssBytes - sample.baselineRssBytes <= PHASE_7C_MEMORY_RSS_LIMIT_BYTES
    ),
    cleanupComplete: samples.every(sample =>
      sample.sqliteClosed && sample.directoryRemoved &&
      sample.residualArtifactFiles === 0 &&
      (sample.scenario !== 'deletionCleanup' || sample.residualCarrierRecords === 0)
    ),
    noDerivedLeaks: samples.every(sample => sample.derivedLeakCount === 0),
    noRedisOrTimerSideEffects: samples.every(sample =>
      sample.redisEvalCalls === 0 && sample.timerResourceDelta === 0
    ),
    lifecycleLimitsExact: sameNumericRecord(
      MEMORY_LIFECYCLE_RESOURCE_LIMITS,
      PHASE_7C_EXPECTED_MEMORY_LIFECYCLE_RESOURCE_LIMITS
    ),
    exportLimitsExact: sameNumericRecord(exportLimits, PHASE_7C_EXPECTED_EXPORT_RESOURCE_LIMITS)
  })
  return Object.freeze({
    schemaVersion: 1 as const,
    samplesPerScenario: PHASE_7C_MEMORY_RESOURCE_SAMPLES as 5,
    totalProcessCount: processIds.length as 15,
    processIds,
    scenarios,
    thresholds: Object.freeze({ rssDeltaBytes: PHASE_7C_MEMORY_RSS_LIMIT_BYTES }),
    limitContracts: Object.freeze({
      lifecycle: MEMORY_LIFECYCLE_RESOURCE_LIMITS,
      expectedLifecycle: PHASE_7C_EXPECTED_MEMORY_LIFECYCLE_RESOURCE_LIMITS,
      export: exportLimits,
      expectedExport: PHASE_7C_EXPECTED_EXPORT_RESOURCE_LIMITS
    }),
    gates,
    passed: Object.values(gates).every(Boolean)
  })
}

function sourceHasParseDiagnostics (sourceFile: ts.SourceFile): boolean {
  const diagnostics = (sourceFile as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[]
  }).parseDiagnostics
  return diagnostics === undefined || diagnostics.length !== 0
}

function exactReadonlyInterface (
  source: string,
  interfaceName: string,
  fields: readonly string[],
  forbiddenTypeNames: readonly string[]
): boolean {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_AUDIT_FILE_BYTES) {
    return false
  }
  const sourceFile = ts.createSourceFile(
    `${interfaceName}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  if (sourceHasParseDiagnostics(sourceFile)) return false
  const declarations = sourceFile.statements.filter((node): node is ts.InterfaceDeclaration => (
    ts.isInterfaceDeclaration(node) && node.name.text === interfaceName
  ))
  if (declarations.length !== 1) return false
  const declaration = declarations[0] as ts.InterfaceDeclaration
  if ((declaration.typeParameters?.length ?? 0) !== 0 ||
    (declaration.heritageClauses?.length ?? 0) !== 0 ||
    declaration.members.length !== fields.length) return false
  const actual: string[] = []
  for (const member of declaration.members) {
    if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) ||
      member.questionToken !== undefined || member.type === undefined ||
      member.modifiers?.length !== 1 ||
      member.modifiers[0]?.kind !== ts.SyntaxKind.ReadonlyKeyword) return false
    const typeText = member.type.getText(sourceFile)
    if (forbiddenTypeNames.some(name => new RegExp(`\\b${name}\\b`).test(typeText))) return false
    actual.push(member.name.text)
  }
  return sameStrings(actual, fields)
}

const AUDIT_FIELDS = Object.freeze([
  'schemaVersion', 'auditId', 'namespaceRef', 'namespaceGeneration', 'operation',
  'commandRefHash', 'aggregateKind', 'aggregateRefHash', 'authorizedByActorRefHash',
  'executedByActorRefHash', 'sourceCommittedAt', 'recordedAt', 'outcome',
  'repositoryReceiptHash', 'priorRevision', 'nextRevision', 'exclusionsHash',
  'receiptHash', 'expiresAt'
])

const DELETION_RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'deletionRef', 'commandRefHash', 'operation',
  'repositoryReceiptHash', 'namespaceRef', 'generationBefore', 'generationAfter',
  'deletingGeneration', 'memoryId', 'deletedRevision', 'committedAt', 'tombstoneId',
  'tombstoneReceiptHash', 'tombstoneExpiresAt', 'exclusionsHash', 'receiptHash'
])

const COMMAND_WIRE_FIELDS = Object.freeze([
  'schemaVersion', 'commandRef', 'operation', 'initiatedByActorRef', 'namespaceRef',
  'expectedNamespaceGeneration', 'aggregateRef', 'expectedRevision',
  'expectedAggregateHash', 'occurredAt', 'newValidUntil', 'newPurgeAt',
  'materialKind', 'materialHash'
])

const FORBIDDEN_BODY_TYPE_NAMES = Object.freeze([
  'MemorySourceV1',
  'MemoryProposalV2',
  'MemoryRecordV2',
  'MemoryRevisionV2',
  'MemoryLifecycleCommandMaterialV1',
  'QqIdentitySnapshotV1',
  'QqSceneSnapshotV1'
])

export function phase7cLifecycleAuditSurfaceIsBodyFree (source: unknown): boolean {
  return typeof source === 'string' && exactReadonlyInterface(
    source,
    'MemoryLifecycleAuditV1',
    AUDIT_FIELDS,
    FORBIDDEN_BODY_TYPE_NAMES
  )
}

export function phase7cDeletionReceiptSurfaceIsBodyFree (source: unknown): boolean {
  return typeof source === 'string' && exactReadonlyInterface(
    source,
    'DeletionMutationReceiptV1',
    DELETION_RECEIPT_FIELDS,
    FORBIDDEN_BODY_TYPE_NAMES
  )
}

export function phase7cLifecycleCommandWireIsHashOnly (source: unknown): boolean {
  return typeof source === 'string' && exactReadonlyInterface(
    source,
    'MemoryLifecycleCommandWireV1',
    COMMAND_WIRE_FIELDS,
    FORBIDDEN_BODY_TYPE_NAMES
  )
}

export function phase7cLifecycleCommandLedgerIsBodyFree (source: unknown): boolean {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_AUDIT_FILE_BYTES) {
    return false
  }
  const start = source.indexOf('CREATE TABLE lifecycle_commands(')
  const end = source.indexOf(') STRICT, WITHOUT ROWID`', start)
  if (start < 0 || end <= start) return false
  const section = source.slice(start, end)
  const forbidden = [
    'command_wire', 'material_wire', 'proposal_wire', 'revision_wire', 'payload_wire',
    'source_wire', 'actor_user_id', 'qq', 'message_id', 'group_id'
  ]
  const required = [
    'command_ref TEXT', 'command_hash TEXT', 'aggregate_ref_hash TEXT',
    'result_wire TEXT', 'result_hash TEXT', 'committed_at_ms INTEGER',
    'expires_at_ms INTEGER'
  ]
  return forbidden.every(field => !section.includes(field)) &&
    required.every(field => section.includes(field))
}

export async function auditPhase7cLifecycleSurfaces (
  projectRootValue: string
): Promise<Phase7cLifecycleSurfaceAudit> {
  const root = safeProjectRoot(projectRootValue)
  const [domain, command, migration, memoryDomain] = await Promise.all([
    readFile(path.join(root, 'src/agent/memory/memory-lifecycle-domain.ts'), 'utf8'),
    readFile(path.join(root, 'src/agent/memory/memory-lifecycle-command.ts'), 'utf8'),
    readFile(path.join(root, 'src/agent/memory/sqlite-memory-migrations.ts'), 'utf8'),
    readFile(path.join(root, 'src/agent/memory/memory-domain.ts'), 'utf8')
  ])
  const result = Object.freeze({
    lifecycleAuditBodyFree: phase7cLifecycleAuditSurfaceIsBodyFree(domain),
    deletionReceiptBodyFree: phase7cDeletionReceiptSurfaceIsBodyFree(domain),
    lifecycleCommandWireHashOnly: phase7cLifecycleCommandWireIsHashOnly(command),
    lifecycleCommandLedgerBodyFree: phase7cLifecycleCommandLedgerIsBodyFree(migration),
    outboxBodyFree: phase7bOutboxSurfaceIsBodyFree(memoryDomain),
    passed: false
  })
  return Object.freeze({
    ...result,
    passed: result.lifecycleAuditBodyFree && result.deletionReceiptBodyFree &&
      result.lifecycleCommandWireHashOnly && result.lifecycleCommandLedgerBodyFree &&
      result.outboxBodyFree
  })
}

export function parsePhase7cMemoryChildObservation (
  value: unknown,
  scenario: Phase7cMemoryResourceScenarioName
): Phase7cMemoryProcessSample {
  const fail = (): never => {
    throw new TypeError('Phase 7C memory resource child failed')
  }
  try {
    const input = exactRecord(value, 'Phase 7C memory child observation')
    if (!sameStrings(Object.keys(input).sort(), ['failed', 'processId', 'status', 'stdout']) ||
      input.failed !== false || input.status !== 0 ||
      !Number.isSafeInteger(input.processId) || Number(input.processId) <= 0 ||
      typeof input.stdout !== 'string' || input.stdout.trim() === '' ||
      Buffer.byteLength(input.stdout, 'utf8') > MAX_CHILD_OUTPUT_BYTES ||
      PHASE_7C_MEMORY_SENSITIVE_SENTINELS.some(sentinel =>
        (input.stdout as string).includes(sentinel)
      )) return fail()
    return Object.freeze({
      processId: Number(input.processId),
      sample: validatePhase7cMemoryResourceSample(
        JSON.parse(input.stdout.trim()) as unknown,
        scenario
      )
    })
  } catch {
    return fail()
  }
}

function runFreshMemorySample (
  root: string,
  scenario: Phase7cMemoryResourceScenarioName
): Phase7cMemoryProcessSample {
  const result = spawnSync(process.execPath, [
    '--expose-gc',
    path.join(root, 'scripts', 'verify-phase-7c.mjs'),
    RESOURCE_SAMPLE_ARGUMENT,
    scenario
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: RESOURCE_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return parsePhase7cMemoryChildObservation({
    failed: result.error !== undefined,
    status: result.status,
    processId: Number.isSafeInteger(result.pid) ? Number(result.pid) : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : ''
  }, scenario)
}

function findingCount (value: Phase7SecurityAuditResult): number {
  return Object.entries(value).reduce((total, [key, current]) => (
    key === 'passed' || !Array.isArray(current) ? total : total + current.length
  ), 0)
}

export async function verifyPhase7cMemory (
  projectRootValue: string,
  options: VerifyPhase7cMemoryOptions = {}
): Promise<Phase7cMemoryVerificationReport> {
  const root = safeProjectRoot(projectRootValue)
  const samples = options.samples ?? Object.freeze(Object.fromEntries(
    PHASE_7C_MEMORY_RESOURCE_SCENARIOS.map(scenario => [
      scenario,
      Object.freeze(Array.from(
        { length: PHASE_7C_MEMORY_RESOURCE_SAMPLES },
        () => runFreshMemorySample(root, scenario)
      ))
    ])
  ))
  const resources = buildPhase7cMemoryResourceReport(samples)
  const production = await (options.productionAudit ?? auditPhase7bMemoryWiring)(root)
  const lifecycle = await (options.lifecycleAudit ?? auditPhase7cLifecycleSurfaces)(root)
  let phase7: Phase7SecurityAuditResult | null = null
  try {
    phase7 = await (options.securityAudit ?? auditPhase7SecurityBoundaries)(root, {
      skipSourceDistCheck: true
    })
  } catch {
    phase7 = null
  }
  const phase7FindingCount = phase7 === null ? 1 : findingCount(phase7)
  const security = Object.freeze({
    phase7Passed: phase7?.passed === true,
    phase7FindingCount,
    lifecycle
  })
  return Object.freeze({
    schemaVersion: 1 as const,
    resources,
    production,
    security,
    passed: resources.passed && production.passed && security.phase7Passed &&
      phase7FindingCount === 0 && lifecycle.passed
  })
}

export async function main (): Promise<void> {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length === 2 && arguments_[0] === RESOURCE_SAMPLE_ARGUMENT) {
    const scenario = arguments_[1]
    if (!PHASE_7C_MEMORY_RESOURCE_SCENARIOS.includes(
      scenario as Phase7cMemoryResourceScenarioName
    )) throw new TypeError('Phase 7C memory verification arguments are invalid')
    const sample = await runPhase7cMemoryResourceScenario({
      scenario: scenario as Phase7cMemoryResourceScenarioName
    })
    process.stdout.write(JSON.stringify(sample))
    return
  }
  if (arguments_.length !== 0) {
    throw new TypeError('Phase 7C memory verification arguments are invalid')
  }
  const verification = await verifyPhase7cMemory(process.cwd())
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`)
  if (!verification.passed) process.exitCode = 1
}

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import {
  createManagementToolDefinitions,
  createQueryToolRuntime,
  createVisibleToolDefinitions
} from '../runtime/tools/tool-runtime-factory.js'
import { PolicyFetch } from '../runtime/tools/policy-fetch.js'
import { buildGuobaSchemas } from '../runtime/guoba-schema.js'
import {
  MEMORY_HOT_CACHE_STATIC_BYTES
} from '../agent/memory/redis-memory-hot-cache.js'
import { MEMORY_RESOURCE_LIMITS } from '../agent/memory/memory-resource-limits.js'
import {
  auditPhase7SecurityBoundaries,
  type Phase7SecurityAuditResult
} from './phase-7-security-audit.js'
import {
  PHASE_7B_MEMORY_RESOURCE_OUTCOMES,
  PHASE_7B_MEMORY_RESOURCE_SCENARIOS,
  PHASE_7B_MEMORY_SQLITE_SHM_LIMIT_BYTES,
  runPhase7bMemoryResourceScenario,
  validatePhase7bMemoryResourceSample,
  type Phase7bMemoryResourceSample,
  type Phase7bMemoryResourceScenarioName
} from './phase-7b-memory-scenario.js'

const MIB = 1_024 * 1_024
const MAX_AUDIT_FILE_BYTES = 2 * MIB
const MAX_COLD_IMPORT_OUTPUT_BYTES = 64 * 1_024
const COLD_IMPORT_TIMEOUT_MS = 10_000
const RESOURCE_CHILD_TIMEOUT_MS = 30_000
const RESOURCE_SAMPLE_ARGUMENT = '--sample'

export const PHASE_7B_MEMORY_RESOURCE_SAMPLES = 5
export const PHASE_7B_MEMORY_RSS_LIMIT_BYTES = 16 * MIB

/**
 * Independent review contract. Do not derive this object from the production
 * value: a limit change must make the verification gate fail until reviewed.
 */
export const PHASE_7B_EXPECTED_MEMORY_RESOURCE_LIMITS = Object.freeze({
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
  namespaceCanonicalLogicalBytes: 64 * MIB,
  deploymentNamespaces: 4_096,
  deploymentActiveRecords: 32_768,
  deploymentCanonicalLogicalBytes: 256 * MIB,
  unackedOutboxRecords: 4_096,
  unackedOutboxLogicalBytes: 16 * MIB,
  sqlitePageCacheBytes: 2 * MIB,
  sqliteWalJournalLimitBytes: 32 * MIB,
  sqliteMainFileBytes: 512 * MIB,
  redisHotRecords: 2_048,
  redisHotLogicalBytes: 16 * MIB,
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

export const PHASE_7B_PRODUCTION_TOOL_FACTORIES = Object.freeze([
  'createDrawTool',
  'createProcessPictureTool',
  'createSendPictureTool',
  'createSendVideoTool',
  'createSendAvatarTool',
  'createSendMusicTool',
  'createSendAudioMessageTool',
  'createSendDiceTool',
  'createSendRPSTool',
  'createSendMessageTool',
  'createEditCardTool',
  'createJinyanTool',
  'createKickOutTool',
  'createSetTitleTool',
  'createHandleMessageTool',
  'createSearchTool',
  'createWebsiteTool',
  'createWeatherTool',
  'createGithubTool',
  'createQueryUserinfoTool',
  'createQueryGenshinTool',
  'createQueryStarRailTool',
  'createSearchImageTool',
  'createSearchVideoTool',
  'createSearchMusicTool',
  'createImageCaptionTool'
] as const)

export const PHASE_7B_PRODUCTION_TOOL_NAMES = Object.freeze([
  'draw',
  'processPicture',
  'sendPicture',
  'sendVideo',
  'sendAvatar',
  'sendMusic',
  'sendAudioMessage',
  'sendDice',
  'sendRPS',
  'sendMessage',
  'editCard',
  'jinyan',
  'kickOut',
  'setTitle',
  'handleMsg',
  'search',
  'website',
  'weather',
  'github',
  'queryUserinfo',
  'queryGenshin',
  'queryStarRail',
  'searchImage',
  'searchVideo',
  'searchMusic',
  'imageCaption'
] as const)

export interface Phase7bMemoryProcessSample {
  readonly processId: number
  readonly sample: Phase7bMemoryResourceSample
}

export interface Phase7bMemoryNumericStats {
  readonly median: number
  readonly minimum: number
  readonly maximum: number
  readonly mad: number
}

export interface Phase7bMemoryScenarioReport {
  readonly processIds: readonly number[]
  readonly samples: readonly Phase7bMemoryResourceSample[]
  readonly outcome: Phase7bMemoryResourceSample['outcome']
  readonly rss: Readonly<{
    baseline: Phase7bMemoryNumericStats
    retained: Readonly<{
      absolute: Phase7bMemoryNumericStats
      delta: Phase7bMemoryNumericStats
    }>
    peak: Readonly<{
      absolute: Phase7bMemoryNumericStats
      delta: Phase7bMemoryNumericStats
    }>
  }>
  readonly wallTimeMs: Phase7bMemoryNumericStats
  readonly userCpuMicros: Phase7bMemoryNumericStats
  readonly systemCpuMicros: Phase7bMemoryNumericStats
  readonly sqlite: Readonly<{
    pageSizeBytes: Phase7bMemoryNumericStats
    pageCacheBytes: Phase7bMemoryNumericStats
    mainFileBytes: Phase7bMemoryNumericStats
    walFileBytes: Phase7bMemoryNumericStats
    shmFileBytes: Phase7bMemoryNumericStats
  }>
  readonly canonical: Readonly<{
    activeRecords: Phase7bMemoryNumericStats
    revisionRecords: Phase7bMemoryNumericStats
    logicalBytes: Phase7bMemoryNumericStats
  }>
  readonly outbox: Readonly<{
    records: Phase7bMemoryNumericStats
    logicalBytes: Phase7bMemoryNumericStats
  }>
  readonly redis: Readonly<{
    records: Phase7bMemoryNumericStats
    generations: Phase7bMemoryNumericStats
    recordEntryBytes: Phase7bMemoryNumericStats
    expiryIndexBytes: Phase7bMemoryNumericStats
    lruIndexBytes: Phase7bMemoryNumericStats
    dynamicMetadataBytes: Phase7bMemoryNumericStats
    staticBytes: Phase7bMemoryNumericStats
    logicalBytes: Phase7bMemoryNumericStats
  }>
}

export interface Phase7bMemoryResourceReport {
  readonly schemaVersion: 1
  readonly samplesPerScenario: 5
  readonly totalProcessCount: 5
  readonly processIds: readonly number[]
  readonly scenarios: Readonly<Record<
  Phase7bMemoryResourceScenarioName,
  Phase7bMemoryScenarioReport
  >>
  readonly thresholds: Readonly<{
    rssDeltaBytes: number
    sqliteShmFileBytes: number
  }>
  readonly limitContracts: Readonly<{
    memory: typeof MEMORY_RESOURCE_LIMITS
    expectedMemory: typeof PHASE_7B_EXPECTED_MEMORY_RESOURCE_LIMITS
  }>
  readonly gates: Readonly<{
    everySampleRss: boolean
    sqlitePageSize: boolean
    sqlitePageCache: boolean
    sqliteFileLimits: boolean
    canonicalLimits: boolean
    outboxLimits: boolean
    redisLimits: boolean
    noSensitiveProjection: boolean
    handlesReleased: boolean
    memoryResourceLimits: boolean
  }>
  readonly passed: boolean
}

export interface Phase7bMemoryColdImportAudit {
  readonly passed: boolean
  readonly timerCalls: number
  readonly redisEvalCalls: number
  readonly createdFiles: number
}

export interface Phase7bMemoryWiringAudit {
  readonly schemaVersion: 1
  readonly productionNoopStore: boolean
  readonly productionDependenciesClosed: boolean
  readonly memoryStoreSeamExact: boolean
  readonly runtimeMemoryImports: number
  readonly runtimeMemoryQueries: number
  readonly runtimeMemoryProposals: number
  readonly runtimeContextSourceImports: number
  readonly reachableGraphComplete: boolean
  readonly reachableMemoryModules: number
  readonly reachableContextSourceModules: number
  readonly forbiddenMemoryToolFactories: number
  readonly forbiddenMemoryToolNames: number
  readonly productionToolNamesExact: boolean
  readonly guobaMemoryEnableFields: number
  readonly configMemoryEnableFields: number
  readonly memoryTelemetryEdges: number
  readonly coldImport: Phase7bMemoryColdImportAudit
  readonly passed: boolean
}

export interface Phase7bProductionReachabilityAudit {
  readonly complete: boolean
  readonly reachableFiles: number
  readonly forbiddenMemoryModules: number
  readonly forbiddenContextSourceModules: number
}

export interface Phase7bMemoryChildObservation {
  readonly failed: boolean
  readonly status: number | null
  readonly processId: number | null
  readonly stdout: string
}

export interface Phase7bMemoryVerificationReport {
  readonly schemaVersion: 1
  readonly resources: Phase7bMemoryResourceReport
  readonly wiring: Phase7bMemoryWiringAudit
  readonly security: Readonly<{
    passed: boolean
    findingCount: number
  }>
  readonly passed: boolean
}

type ResourceInput = Readonly<Record<
Phase7bMemoryResourceScenarioName,
readonly Phase7bMemoryProcessSample[]
>>

interface VerifyPhase7bMemoryOptions {
  readonly samples?: unknown
  readonly wiringAudit?: (projectRoot: string) => Promise<Phase7bMemoryWiringAudit>
  readonly securityAudit?: (projectRoot: string) => Promise<Phase7SecurityAuditResult>
}

function exactRecord (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function safeProjectRoot (value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Phase 7B memory verification project root is invalid')
  }
  return path.resolve(value)
}

function median (values: readonly number[]): number {
  if (values.length === 0) throw new TypeError('statistics require at least one value')
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function statistics (values: readonly number[]): Phase7bMemoryNumericStats {
  if (values.some(value => !Number.isSafeInteger(value))) {
    throw new TypeError('Phase 7B memory resource statistics require safe integers')
  }
  const center = median(values)
  return Object.freeze({
    median: center,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    mad: median(values.map(value => Math.abs(value - center)))
  })
}

function sameNumericRecord (
  actual: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>
): boolean {
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every(key => actual[key] === expected[key])
}

function sameStrings (actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
}

function sourceHasParseDiagnostics (sourceFile: ts.SourceFile): boolean {
  const diagnostics = (sourceFile as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[]
  }).parseDiagnostics
  return diagnostics === undefined || diagnostics.length !== 0
}

export function phase7bMemoryControlFieldIsForbidden (value: unknown): boolean {
  if (typeof value !== 'string') return true
  const normalized = value.replace(/[_-]/g, '').toLowerCase()
  return normalized.includes('memory') || normalized.includes('qdrant')
}

export function collectPhase7bProductionToolNames (): readonly string[] {
  const unavailable = async (): Promise<never> => {
    throw new Error('phase7b_verification_tool_unavailable')
  }
  const policyFetch = new PolicyFetch()
  const visible = createVisibleToolDefinitions({
    policyFetch,
    qq: {
      sendText: unavailable,
      sendImage: unavailable,
      sendAudio: unavailable,
      sendVideo: unavailable,
      sendMusic: unavailable,
      sendDice: unavailable,
      sendRps: unavailable
    },
    generateImage: unavailable,
    processImage: unavailable,
    synthesizeAudio: unavailable,
    resolveVideo: unavailable,
    drawingAvailable: false,
    pictureProcessingAvailable: false,
    ttsAvailable: false,
    videoDownloadEnabled: false,
    videoMaxBytes: 1,
    crossChannelAccess: { private: 'disabled', group: 'disabled' }
  } as unknown as Parameters<typeof createVisibleToolDefinitions>[0])
  const management = createManagementToolDefinitions({
    muteMember: unavailable,
    kickMember: unavailable,
    setCard: unavailable,
    setTitle: unavailable,
    recallMessage: unavailable,
    setEssence: unavailable
  } as unknown as Parameters<typeof createManagementToolDefinitions>[0])
  const query = createQueryToolRuntime({
    policyFetch,
    config: {
      searchSource: 'public',
      publicSearchSource: 'bing',
      tavilyApiKey: '',
      bingApiKey: '',
      amapKey: '',
      amapApiBaseUrl: 'https://restapi.amap.com',
      githubApiBaseUrl: 'https://api.github.com',
      githubApiKey: '',
      imageSearchSource: 'public',
      braveSearchApiKey: '',
      extraUrl: 'https://example.invalid'
    },
    currentGroupMembers: async () => new Map(),
    queryGame: unavailable,
    sendGameImage: unavailable
  }).definitions
  return Object.freeze([...visible, ...management, ...query].map(definition => definition.name))
}

function validateResourceInput (value: unknown): ResourceInput {
  const input = exactRecord(value, 'Phase 7B memory resource samples')
  if (Object.keys(input).length !== PHASE_7B_MEMORY_RESOURCE_SCENARIOS.length ||
    PHASE_7B_MEMORY_RESOURCE_SCENARIOS.some(scenario => !Object.hasOwn(input, scenario))) {
    throw new TypeError('Phase 7B memory resource scenarios are incomplete')
  }
  const processIds = new Set<number>()
  const entries = Object.fromEntries(PHASE_7B_MEMORY_RESOURCE_SCENARIOS.map(scenario => {
    const values = input[scenario]
    if (!Array.isArray(values) || values.length !== PHASE_7B_MEMORY_RESOURCE_SAMPLES) {
      throw new TypeError('Phase 7B memory resource report requires five fresh processes')
    }
    const samples = values.map((value, index) => {
      const entry = exactRecord(value, `Phase 7B memory process sample ${scenario}:${index}`)
      if (Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'processId') ||
        !Object.hasOwn(entry, 'sample') || !Number.isSafeInteger(entry.processId) ||
        Number(entry.processId) <= 0) {
        throw new TypeError('Phase 7B memory process sample is invalid')
      }
      const processId = Number(entry.processId)
      if (processIds.has(processId)) {
        throw new TypeError('Phase 7B memory resource samples require unique fresh processes')
      }
      processIds.add(processId)
      return Object.freeze({
        processId,
        sample: validatePhase7bMemoryResourceSample(entry.sample, scenario)
      })
    })
    return [scenario, Object.freeze(samples)]
  }))
  if (processIds.size !== PHASE_7B_MEMORY_RESOURCE_SAMPLES) {
    throw new TypeError('Phase 7B memory resource report requires five unique processes')
  }
  return Object.freeze(entries) as ResourceInput
}

function scenarioReport (
  entries: readonly Phase7bMemoryProcessSample[]
): Phase7bMemoryScenarioReport {
  const samples = entries.map(entry => entry.sample)
  const baselines = samples.map(sample => sample.baselineRssBytes)
  const retained = samples.map(sample => sample.retainedRssBytes)
  const peaks = samples.map(sample => sample.peakRssBytes)
  return Object.freeze({
    processIds: Object.freeze(entries.map(entry => entry.processId)),
    samples: Object.freeze(samples),
    outcome: samples[0]?.outcome as Phase7bMemoryResourceSample['outcome'],
    rss: Object.freeze({
      baseline: statistics(baselines),
      retained: Object.freeze({
        absolute: statistics(retained),
        delta: statistics(retained.map((value, index) => (
          value - (baselines[index] as number)
        )))
      }),
      peak: Object.freeze({
        absolute: statistics(peaks),
        delta: statistics(peaks.map((value, index) => (
          value - (baselines[index] as number)
        )))
      })
    }),
    wallTimeMs: statistics(samples.map(sample => sample.wallTimeMs)),
    userCpuMicros: statistics(samples.map(sample => sample.userCpuMicros)),
    systemCpuMicros: statistics(samples.map(sample => sample.systemCpuMicros)),
    sqlite: Object.freeze({
      pageSizeBytes: statistics(samples.map(sample => sample.sqlitePageSizeBytes)),
      pageCacheBytes: statistics(samples.map(sample => sample.sqlitePageCacheBytes)),
      mainFileBytes: statistics(samples.map(sample => sample.sqliteMainFileBytes)),
      walFileBytes: statistics(samples.map(sample => sample.sqliteWalFileBytes)),
      shmFileBytes: statistics(samples.map(sample => sample.sqliteShmFileBytes))
    }),
    canonical: Object.freeze({
      activeRecords: statistics(samples.map(sample => sample.canonicalActiveRecords)),
      revisionRecords: statistics(samples.map(sample => sample.canonicalRevisionRecords)),
      logicalBytes: statistics(samples.map(sample => sample.canonicalLogicalBytes))
    }),
    outbox: Object.freeze({
      records: statistics(samples.map(sample => sample.outboxRecords)),
      logicalBytes: statistics(samples.map(sample => sample.outboxLogicalBytes))
    }),
    redis: Object.freeze({
      records: statistics(samples.map(sample => sample.redisRecords)),
      generations: statistics(samples.map(sample => sample.redisGenerations)),
      recordEntryBytes: statistics(samples.map(sample => sample.redisRecordEntryBytes)),
      expiryIndexBytes: statistics(samples.map(sample => sample.redisExpiryIndexBytes)),
      lruIndexBytes: statistics(samples.map(sample => sample.redisLruIndexBytes)),
      dynamicMetadataBytes: statistics(samples.map(sample => sample.redisDynamicMetadataBytes)),
      staticBytes: statistics(samples.map(sample => sample.redisStaticBytes)),
      logicalBytes: statistics(samples.map(sample => sample.redisLogicalBytes))
    })
  })
}

export function buildPhase7bMemoryResourceReport (
  value: unknown
): Phase7bMemoryResourceReport {
  const input = validateResourceInput(value)
  const scenarios = Object.freeze(Object.fromEntries(
    PHASE_7B_MEMORY_RESOURCE_SCENARIOS.map(scenario => [
      scenario,
      scenarioReport(input[scenario])
    ])
  )) as Readonly<Record<Phase7bMemoryResourceScenarioName, Phase7bMemoryScenarioReport>>
  const processIds = Object.freeze(PHASE_7B_MEMORY_RESOURCE_SCENARIOS.flatMap(scenario => (
    input[scenario].map(entry => entry.processId)
  )))
  const samples = PHASE_7B_MEMORY_RESOURCE_SCENARIOS.flatMap(scenario => (
    input[scenario].map(entry => entry.sample)
  ))
  const gates = Object.freeze({
    everySampleRss: samples.every(sample =>
      sample.retainedRssBytes - sample.baselineRssBytes <= PHASE_7B_MEMORY_RSS_LIMIT_BYTES &&
      sample.peakRssBytes - sample.baselineRssBytes <= PHASE_7B_MEMORY_RSS_LIMIT_BYTES),
    sqlitePageSize: samples.every(sample => sample.sqlitePageSizeBytes === 4 * 1_024),
    sqlitePageCache: samples.every(sample =>
      sample.sqlitePageCacheBytes === MEMORY_RESOURCE_LIMITS.sqlitePageCacheBytes),
    sqliteFileLimits: samples.every(sample =>
      sample.sqliteMainFileBytes > 0 &&
      sample.sqliteMainFileBytes <= MEMORY_RESOURCE_LIMITS.sqliteMainFileBytes &&
      sample.sqliteWalFileBytes <= MEMORY_RESOURCE_LIMITS.sqliteWalJournalLimitBytes &&
      sample.sqliteShmFileBytes <= PHASE_7B_MEMORY_SQLITE_SHM_LIMIT_BYTES),
    canonicalLimits: samples.every(sample =>
      sample.canonicalActiveRecords > 0 &&
      sample.canonicalActiveRecords <= MEMORY_RESOURCE_LIMITS.namespaceActiveRecords &&
      sample.canonicalRevisionRecords >= sample.canonicalActiveRecords &&
      sample.canonicalRevisionRecords <=
        sample.canonicalActiveRecords * MEMORY_RESOURCE_LIMITS.memoryRetainedRevisions &&
      sample.canonicalLogicalBytes > 0 &&
      sample.canonicalLogicalBytes <= MEMORY_RESOURCE_LIMITS.namespaceCanonicalLogicalBytes),
    outboxLimits: samples.every(sample =>
      sample.outboxRecords > 0 &&
      sample.outboxRecords <= MEMORY_RESOURCE_LIMITS.unackedOutboxRecords &&
      sample.outboxLogicalBytes > 0 &&
      sample.outboxLogicalBytes <= MEMORY_RESOURCE_LIMITS.unackedOutboxLogicalBytes),
    redisLimits: samples.every(sample =>
      sample.redisRecords > 0 &&
      sample.redisRecords <= MEMORY_RESOURCE_LIMITS.redisHotRecords &&
      sample.redisGenerations > 0 &&
      sample.redisGenerations <= MEMORY_RESOURCE_LIMITS.deploymentNamespaces &&
      sample.redisStaticBytes === MEMORY_HOT_CACHE_STATIC_BYTES &&
      sample.redisLogicalBytes === sample.redisRecordEntryBytes +
        sample.redisExpiryIndexBytes + sample.redisLruIndexBytes +
        sample.redisDynamicMetadataBytes + sample.redisStaticBytes &&
      sample.redisLogicalBytes <= MEMORY_RESOURCE_LIMITS.redisHotLogicalBytes),
    noSensitiveProjection: samples.every(sample =>
      sample.contentLeakCount === 0 && sample.identityLeakCount === 0),
    handlesReleased: samples.every(sample =>
      sample.sqliteClosed && sample.redisReleased && sample.timerResourceDelta === 0),
    memoryResourceLimits: sameNumericRecord(
      MEMORY_RESOURCE_LIMITS,
      PHASE_7B_EXPECTED_MEMORY_RESOURCE_LIMITS
    )
  })
  return Object.freeze({
    schemaVersion: 1 as const,
    samplesPerScenario: PHASE_7B_MEMORY_RESOURCE_SAMPLES as 5,
    totalProcessCount: processIds.length as 5,
    processIds,
    scenarios,
    thresholds: Object.freeze({
      rssDeltaBytes: PHASE_7B_MEMORY_RSS_LIMIT_BYTES,
      sqliteShmFileBytes: PHASE_7B_MEMORY_SQLITE_SHM_LIMIT_BYTES
    }),
    limitContracts: Object.freeze({
      memory: MEMORY_RESOURCE_LIMITS,
      expectedMemory: PHASE_7B_EXPECTED_MEMORY_RESOURCE_LIMITS
    }),
    gates,
    passed: Object.values(gates).every(Boolean)
  })
}

async function boundedSource (root: string, relativePath: string): Promise<string | null> {
  try {
    const value = await readFile(path.join(root, relativePath), 'utf8')
    return Buffer.byteLength(value, 'utf8') <= MAX_AUDIT_FILE_BYTES ? value : null
  } catch {
    return null
  }
}

interface BoundedSourceTree {
  readonly complete: boolean
  readonly files: readonly Readonly<{
    relativePath: string
    source: string
  }>[]
}

async function boundedTypeScriptTree (
  root: string,
  relativeDirectory: string,
  maximumFiles: number
): Promise<BoundedSourceTree> {
  const files: Array<{ relativePath: string; source: string }> = []
  let complete = true
  const visit = async (relativePath: string): Promise<void> => {
    if (!complete) return
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(path.join(root, relativePath), { withFileTypes: true })
    } catch {
      complete = false
      return
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        complete = false
        return
      }
      const child = `${relativePath}/${entry.name}`
      if (entry.isDirectory()) {
        await visit(child)
        if (!complete) return
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        if (files.length >= maximumFiles) {
          complete = false
          return
        }
        const source = await boundedSource(root, child)
        if (source === null) {
          complete = false
          return
        }
        files.push({ relativePath: child, source })
      } else {
        complete = false
        return
      }
    }
  }
  await visit(relativeDirectory)
  return Object.freeze({
    complete,
    files: Object.freeze(files.map(value => Object.freeze(value)))
  })
}

interface LocalImportResolution {
  readonly kind: 'external' | 'resolved' | 'invalid'
  readonly relativePath?: string
}

function localImportResolution (
  owner: string,
  specifier: string,
  sources: Readonly<Record<string, string>>
): LocalImportResolution {
  if (!specifier.startsWith('.')) {
    return specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes('\0') ||
      phase7bMemoryControlFieldIsForbidden(specifier)
      ? Object.freeze({ kind: 'invalid' })
      : Object.freeze({ kind: 'external' })
  }
  if (specifier.includes('?') || specifier.includes('#') || specifier.includes('\\')) {
    return Object.freeze({ kind: 'invalid' })
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(owner), specifier))
  if (!joined.startsWith('src/')) return Object.freeze({ kind: 'invalid' })
  const candidates = specifier.endsWith('.js')
    ? [joined.slice(0, -3) + '.ts']
    : specifier.endsWith('.mjs')
      ? [joined.slice(0, -4) + '.mts']
      : specifier.endsWith('.cjs')
        ? [joined.slice(0, -4) + '.cts']
        : path.posix.extname(specifier) === ''
          ? [`${joined}.ts`, `${joined}/index.ts`]
          : [joined]
  const present = candidates.filter(candidate => Object.hasOwn(sources, candidate))
  return present.length === 1
    ? Object.freeze({ kind: 'resolved', relativePath: present[0] })
    : Object.freeze({ kind: 'invalid' })
}

const PHASE_7B_IMPORT_FIRST_SURFACE = `async function importFirst(specifiers: readonly string[]): Promise<YunzaiRecord> {
    for (const specifier of specifiers) {
        try {
            return await import(specifier) as YunzaiRecord;
        }
        catch { }
    }
    throw new Error('external plugin is unavailable');
}`

const PHASE_7B_EXTERNAL_PLUGIN_SPECIFIERS = Object.freeze([
  '../../../../ap-plugin/apps/aiPainting.js',
  '../../../../ap-plugin/apps/ai_painting.js',
  '../../../../miao-plugin/apps/profile/ProfileDetail.js',
  '../../../../miao-plugin/apps/profile/ProfileList.js'
])

function externalPluginSpecifier (value: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(value) || value.name.text !== 'href' ||
    !ts.isNewExpression(value.expression) || !ts.isIdentifier(value.expression.expression) ||
    value.expression.expression.text !== 'URL' || value.expression.arguments?.length !== 2) {
    return null
  }
  const [specifier, base] = value.expression.arguments
  if (specifier === undefined || !ts.isStringLiteralLike(specifier) || base === undefined ||
    !ts.isPropertyAccessExpression(base) || base.name.text !== 'url' ||
    !ts.isMetaProperty(base.expression) ||
    base.expression.keywordToken !== ts.SyntaxKind.ImportKeyword ||
    base.expression.name.text !== 'meta') return null
  return specifier.text
}

function computedImportBoundaryIsClosed (sourceFile: ts.SourceFile): boolean {
  const declarations = sourceFile.statements.filter((node): node is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(node) && node.name?.text === 'importFirst'
  ))
  if (declarations.length !== 1) return false
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
  if (printer.printNode(ts.EmitHint.Unspecified, declarations[0] as ts.Node, sourceFile) !==
    PHASE_7B_IMPORT_FIRST_SURFACE) return false
  const calls: ts.CallExpression[] = []
  const computedImports: ts.CallExpression[] = []
  let identifierCount = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'importFirst') identifierCount += 1
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'importFirst') calls.push(node)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      !(node.arguments.length === 1 && node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0]))) computedImports.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (calls.length !== 3 || identifierCount !== calls.length + 1 ||
    computedImports.length !== 1) return false
  let owner: ts.Node | undefined = (computedImports[0] as ts.CallExpression).parent
  while (owner !== undefined && owner !== sourceFile && owner !== declarations[0]) {
    owner = owner.parent
  }
  if (owner !== declarations[0]) return false
  const specifiers: string[] = []
  for (const call of calls) {
    const argument = call.arguments[0]
    if (call.arguments.length !== 1 || argument === undefined ||
      !ts.isArrayLiteralExpression(argument)) return false
    for (const element of argument.elements) {
      const specifier = externalPluginSpecifier(element)
      if (specifier === null) return false
      specifiers.push(specifier)
    }
  }
  return sameStrings(specifiers, PHASE_7B_EXTERNAL_PLUGIN_SPECIFIERS)
}

export function phase7bComputedImportBoundaryIsClosed (value: unknown): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_AUDIT_FILE_BYTES) {
    return false
  }
  const sourceFile = ts.createSourceFile(
    'src/runtime/tools/yunzai-tool-runtime.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  return !sourceHasParseDiagnostics(sourceFile) && computedImportBoundaryIsClosed(sourceFile)
}

function sourceImportSpecifiers (
  relativePath: string,
  source: string
): Readonly<{ complete: boolean; specifiers: readonly string[] }> {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  if (sourceHasParseDiagnostics(sourceFile)) {
    return Object.freeze({ complete: false, specifiers: Object.freeze([]) })
  }
  const specifiers: string[] = []
  let complete = relativePath !== 'src/runtime/tools/yunzai-tool-runtime.ts' ||
    computedImportBoundaryIsClosed(sourceFile)
  const acceptLiteral = (value: ts.Expression | undefined): void => {
    if (value !== undefined && ts.isStringLiteralLike(value)) {
      specifiers.push(value.text)
    } else {
      complete = false
    }
  }
  const visit = (node: ts.Node): void => {
    if (!complete) return
    if (ts.isImportDeclaration(node)) {
      acceptLiteral(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) acceptLiteral(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        acceptLiteral(node.moduleReference.expression)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (node.arguments.length === 1 && argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      } else if (!(relativePath === 'src/runtime/tools/yunzai-tool-runtime.ts' &&
        node.arguments.length === 1 && argument !== undefined && ts.isIdentifier(argument) &&
        argument.text === 'specifier')) {
        complete = false
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'require') {
      const argument = node.arguments[0]
      if (node.arguments.length === 1) acceptLiteral(argument)
      else complete = false
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        specifiers.push(argument.literal.text)
      } else {
        complete = false
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return Object.freeze({ complete, specifiers: Object.freeze(specifiers) })
}

export function auditPhase7bProductionReachability (
  value: unknown
): Phase7bProductionReachabilityAudit {
  const input = exactRecord(value, 'Phase 7B production source graph')
  const paths = Object.keys(input).sort()
  if (paths.length === 0 || paths.length > 512) {
    throw new TypeError('Phase 7B production source graph is invalid')
  }
  const sources: Record<string, string> = Object.create(null)
  for (const relativePath of paths) {
    if (!/^src\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.ts$/i.test(relativePath) ||
      path.posix.normalize(relativePath) !== relativePath ||
      typeof input[relativePath] !== 'string' ||
      Buffer.byteLength(input[relativePath] as string, 'utf8') > MAX_AUDIT_FILE_BYTES) {
      throw new TypeError('Phase 7B production source graph is invalid')
    }
    sources[relativePath] = input[relativePath] as string
  }
  const root = 'src/runtime/production-yunzai-agent.ts'
  if (!Object.hasOwn(sources, root)) {
    return Object.freeze({
      complete: false,
      reachableFiles: 0,
      forbiddenMemoryModules: 0,
      forbiddenContextSourceModules: 0
    })
  }
  const visited = new Set<string>()
  const pending = [root]
  let complete = true
  while (pending.length > 0 && complete) {
    const current = pending.shift()
    if (current === undefined || visited.has(current)) continue
    if (visited.size >= 512) {
      complete = false
      break
    }
    visited.add(current)
    const imports = sourceImportSpecifiers(current, sources[current] as string)
    if (!imports.complete) {
      complete = false
      break
    }
    for (const specifier of imports.specifiers) {
      const resolved = localImportResolution(current, specifier, sources)
      if (resolved.kind === 'invalid') {
        complete = false
        break
      }
      if (resolved.kind === 'resolved' && resolved.relativePath !== undefined &&
        !visited.has(resolved.relativePath)) pending.push(resolved.relativePath)
    }
  }
  const reachable = [...visited]
  return Object.freeze({
    complete,
    reachableFiles: reachable.length,
    forbiddenMemoryModules: reachable.filter(relativePath => (
      relativePath.startsWith('src/agent/memory/')
    )).length,
    forbiddenContextSourceModules: reachable.filter(relativePath => (
      relativePath === 'src/agent/context/context-source.ts'
    )).length
  })
}

export function phase7bRuntimeMemoryStoreSeamIsClosed (value: unknown): boolean {
  let input: Record<string, unknown>
  try {
    input = exactRecord(value, 'Phase 7B runtime source graph')
  } catch {
    return false
  }
  const paths = Object.keys(input).sort()
  if (paths.length === 0 || paths.length > 512) return false
  let exactSeams = 0
  for (const relativePath of paths) {
    const source = input[relativePath]
    if (!/^src\/runtime\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.ts$/i.test(relativePath) ||
      path.posix.normalize(relativePath) !== relativePath || typeof source !== 'string' ||
      Buffer.byteLength(source, 'utf8') > MAX_AUDIT_FILE_BYTES) return false
    const sourceFile = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    if (sourceHasParseDiagnostics(sourceFile)) return false
    let closed = true
    const visit = (node: ts.Node): void => {
      if (!closed) return
      if ((ts.isStringLiteralLike(node) && node.text === 'memoryStore') ||
        (ts.isPrivateIdentifier(node) && node.text === '#memoryStore')) {
        closed = false
        return
      }
      if (ts.isIdentifier(node) && node.text === 'memoryStore') {
        const parent = node.parent
        const initializer = ts.isPropertyAssignment(parent) && parent.name === node
          ? parent.initializer
          : undefined
        if (initializer === undefined || !ts.isNewExpression(initializer) ||
          !ts.isIdentifier(initializer.expression) ||
          initializer.expression.text !== 'NoopMemoryStore' ||
          (initializer.arguments?.length ?? 0) !== 0 ||
          (initializer.typeArguments?.length ?? 0) !== 0) {
          closed = false
          return
        }
        exactSeams += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (!closed) return false
  }
  return exactSeams === 1
}

interface ExactInterfaceProperty {
  readonly name: string
  readonly optional: boolean
  readonly type: string
}

const PHASE_7B_EXPECTED_BRIDGE_DEPENDENCIES = Object.freeze([
  { name: 'progressPresenter', optional: false, type: 'RunProgressPresenter' },
  { name: 'modelAdapter', optional: false, type: 'ModelAdapter' },
  { name: 'runStore', optional: true, type: 'RedisRunStore' },
  { name: 'admission', optional: true, type: 'RunAdmission' },
  { name: 'contextArtifactStore', optional: true, type: 'ContextArtifactStore' },
  { name: 'contentJournal', optional: true, type: 'GroupMateContentJournal' },
  {
    name: 'providerIsolationIdSourceFactory',
    optional: true,
    type: 'ProviderIsolationIdSourceFactory'
  },
  {
    name: 'observations',
    optional: true,
    type: 'Readonly<{publish(event:ObservationEventV1):void;acceptCommittedTraceCandidate(candidate:TraceCandidateV1):void;acceptTraceProjectionFailure(code:TraceCandidateProjectionFailureCode):void;}>'
  }
] satisfies readonly ExactInterfaceProperty[])

const PHASE_7B_EXPECTED_OUTBOX_FIELDS = Object.freeze([
  { name: 'schemaVersion', optional: false, type: '1' },
  { name: 'eventId', optional: false, type: 'string' },
  { name: 'sequence', optional: false, type: 'number' },
  { name: 'namespaceRef', optional: false, type: 'MemoryNamespaceRefV1' },
  { name: 'namespaceGeneration', optional: false, type: 'number' },
  { name: 'aggregate', optional: false, type: "'proposal'|'record'|'namespace'" },
  { name: 'aggregateId', optional: false, type: 'string' },
  { name: 'revision', optional: false, type: 'number' },
  {
    name: 'eventKind',
    optional: false,
    type: "'proposal_changed'|'record_upserted'|'record_forgotten'|'namespace_deleted'"
  },
  { name: 'occurredAt', optional: false, type: 'string' },
  { name: 'payloadHash', optional: false, type: 'string' }
] satisfies readonly ExactInterfaceProperty[])

function exactInterfaceProperties (
  source: string,
  interfaceName: string,
  expected: readonly ExactInterfaceProperty[]
): boolean {
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
    declaration.members.length !== expected.length) return false
  const printer = ts.createPrinter({ removeComments: true })
  return declaration.members.every((member, index) => {
    const contract = expected[index]
    if (contract === undefined || !ts.isPropertySignature(member) ||
      !ts.isIdentifier(member.name) || member.name.text !== contract.name ||
      (member.questionToken !== undefined) !== contract.optional ||
      member.type === undefined) return false
    const modifiers = member.modifiers?.map(modifier => modifier.kind) ?? []
    if (modifiers.length !== 1 || modifiers[0] !== ts.SyntaxKind.ReadonlyKeyword) return false
    const type = printer.printNode(ts.EmitHint.Unspecified, member.type, sourceFile)
      .replace(/\s+/g, '')
    return type === contract.type
  })
}

export function phase7bBridgeDependenciesAreClosed (value: unknown): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_AUDIT_FILE_BYTES) {
    return false
  }
  return exactInterfaceProperties(
    value,
    'YunzaiAgentServiceBridgeDependencies',
    PHASE_7B_EXPECTED_BRIDGE_DEPENDENCIES
  )
}

export function phase7bBridgeNoopMemoryStoreIsExact (value: unknown): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_AUDIT_FILE_BYTES) {
    return false
  }
  const sourceFile = ts.createSourceFile(
    'src/runtime/agent-service-bridge.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  if (sourceHasParseDiagnostics(sourceFile)) return false
  const imports = sourceFile.statements.filter((node): node is ts.ImportDeclaration => (
    ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) &&
    node.moduleSpecifier.text === '../agent/context/noop-memory-store.js'
  ))
  if (imports.length !== 1) return false
  const importClause = (imports[0] as ts.ImportDeclaration).importClause
  if (importClause === undefined || importClause.isTypeOnly || importClause.name !== undefined ||
    importClause.namedBindings === undefined || !ts.isNamedImports(importClause.namedBindings) ||
    importClause.namedBindings.elements.length !== 1) return false
  const imported = importClause.namedBindings.elements[0]
  if (imported === undefined || imported.isTypeOnly || imported.propertyName !== undefined ||
    imported.name.text !== 'NoopMemoryStore') return false
  let identifierCount = 0
  let exactConstructionCount = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'NoopMemoryStore') identifierCount += 1
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'NoopMemoryStore') {
      const parent = node.parent
      if (ts.isPropertyAssignment(parent) && parent.initializer === node &&
        ts.isIdentifier(parent.name) && parent.name.text === 'memoryStore' &&
        (node.arguments?.length ?? 0) === 0 && (node.typeArguments?.length ?? 0) === 0) {
        exactConstructionCount += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return identifierCount === 2 && exactConstructionCount === 1
}

function matchCount (source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length
}

export type Phase7bTelemetrySourceRole = 'memory' | 'consumer'

function normalizedImportTarget (owner: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(owner), specifier))
  return joined.endsWith('.js') ? `${joined.slice(0, -3)}.ts` : joined
}

export function phase7bMemoryTelemetrySourceFindings (
  relativePath: unknown,
  value: unknown,
  role: Phase7bTelemetrySourceRole
): number {
  if (typeof relativePath !== 'string' ||
    !/^src\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.ts$/i.test(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath || typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_AUDIT_FILE_BYTES ||
    (role !== 'memory' && role !== 'consumer')) return 1
  const imports = sourceImportSpecifiers(relativePath, value)
  if (!imports.complete) return 1
  let findings = imports.specifiers.filter(specifier => {
    const target = normalizedImportTarget(relativePath, specifier).toLowerCase()
    return role === 'memory'
      ? /(?:runtime\/(?:observability|logging)|safe-chat-logging|request-observation|metrics|content-journal)/.test(
        target
      )
      : target.includes('agent/memory/')
  }).length
  if (role === 'memory') {
    const sourceFile = ts.createSourceFile(
      relativePath,
      value,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && (node.text === 'logger' || node.text === 'console')) {
        findings += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return findings
}

async function memoryTelemetryEdges (root: string): Promise<number> {
  const memoryTree = await boundedTypeScriptTree(root, 'src/agent/memory', 128)
  if (!memoryTree.complete) return 1
  let findings = 0
  for (const file of memoryTree.files) {
    findings += phase7bMemoryTelemetrySourceFindings(
      file.relativePath,
      file.source,
      'memory'
    )
  }
  const observationTree = await boundedTypeScriptTree(root, 'src/runtime/observability', 128)
  if (!observationTree.complete) {
    findings += 1
  } else {
    for (const file of observationTree.files) {
      findings += phase7bMemoryTelemetrySourceFindings(
        file.relativePath,
        file.source,
        'consumer'
      )
    }
  }
  const loggingTree = await boundedTypeScriptTree(root, 'src/runtime/logging', 128)
  if (!loggingTree.complete) {
    findings += 1
  } else {
    for (const file of loggingTree.files) {
      findings += phase7bMemoryTelemetrySourceFindings(
        file.relativePath,
        file.source,
        'consumer'
      )
    }
  }
  const contentJournal = await boundedSource(root, 'src/agent/run/run-content-journal.ts')
  if (contentJournal === null) {
    findings += 1
  } else {
    findings += phase7bMemoryTelemetrySourceFindings(
      'src/agent/run/run-content-journal.ts',
      contentJournal,
      'consumer'
    )
  }
  const memoryDomain = await boundedSource(root, 'src/agent/memory/memory-domain.ts')
  if (!phase7bOutboxSurfaceIsBodyFree(memoryDomain)) findings += 1
  return findings
}

export function phase7bOutboxSurfaceIsBodyFree (value: unknown): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_AUDIT_FILE_BYTES) {
    return false
  }
  return exactInterfaceProperties(
    value,
    'MemoryOutboxEventV1',
    PHASE_7B_EXPECTED_OUTBOX_FIELDS
  )
}

async function runColdImportAudit (root: string): Promise<Phase7bMemoryColdImportAudit> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'groupmate-phase7b-cold-import-'))
  const memoryTree = await boundedTypeScriptTree(root, 'src/agent/memory', 128)
  const memoryModules = memoryTree.files.map(file => {
    const relativePath = file.relativePath.slice('src/agent/memory/'.length, -3)
    return new URL(`../agent/memory/${relativePath}.js`, import.meta.url).href
  })
  const productionModule = new URL(
    '../runtime/production-yunzai-agent.js',
    import.meta.url
  ).href
  const verificationModules = [
    new URL('./phase-7b-memory-scenario.js', import.meta.url).href,
    new URL('./phase-7b-memory-report.js', import.meta.url).href
  ]
  const modules = memoryTree.complete && memoryModules.length > 0 && memoryModules.length <= 128
    ? [productionModule, ...memoryModules, ...verificationModules]
    : []
  const probe = `
import { readdir } from 'node:fs/promises'
const before = new Set(await readdir('.'))
let timerCalls = 0
let redisEvalCalls = 0
const originalTimeout = globalThis.setTimeout
const originalInterval = globalThis.setInterval
globalThis.setTimeout = function (...args) {
  timerCalls += 1
  return Reflect.apply(originalTimeout, globalThis, args)
}
globalThis.setInterval = function (...args) {
  timerCalls += 1
  return Reflect.apply(originalInterval, globalThis, args)
}
let RedisMemoryHotCache
for (const target of process.argv.slice(1)) {
  const imported = await import(target)
  if (target.endsWith('/redis-memory-hot-cache.js')) {
    RedisMemoryHotCache = imported.RedisMemoryHotCache
  }
}
if (typeof RedisMemoryHotCache !== 'function') throw new TypeError('memory hot cache missing')
const client = {
  async eval () {
    redisEvalCalls += 1
    return null
  }
}
void new RedisMemoryHotCache({ client })
globalThis.setTimeout = originalTimeout
globalThis.setInterval = originalInterval
const after = await readdir('.')
const createdFiles = after.filter(value => !before.has(value)).length
process.stdout.write(JSON.stringify({ timerCalls, redisEvalCalls, createdFiles }))
`
  try {
    if (modules.length === 0) throw new TypeError('cold import modules are unavailable')
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      probe,
      ...modules
    ], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: COLD_IMPORT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_COLD_IMPORT_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (result.error !== undefined || result.status !== 0) {
      return Object.freeze({
        passed: false,
        timerCalls: 0,
        redisEvalCalls: 0,
        createdFiles: 0
      })
    }
    const value = exactRecord(JSON.parse(result.stdout.trim()) as unknown, 'cold import result')
    const timerCalls = Number(value.timerCalls)
    const redisEvalCalls = Number(value.redisEvalCalls)
    const childCreatedFiles = Number(value.createdFiles)
    const parentCreatedFiles = (await readdir(temporary)).length
    const createdFiles = Math.max(childCreatedFiles, parentCreatedFiles)
    if (![timerCalls, redisEvalCalls, createdFiles].every(current =>
      Number.isSafeInteger(current) && current >= 0)) {
      throw new TypeError('cold import result is invalid')
    }
    return Object.freeze({
      passed: timerCalls === 0 && redisEvalCalls === 0 && createdFiles === 0,
      timerCalls,
      redisEvalCalls,
      createdFiles
    })
  } catch {
    return Object.freeze({
      passed: false,
      timerCalls: 0,
      redisEvalCalls: 0,
      createdFiles: 0
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function auditPhase7bMemoryWiring (
  projectRootValue: string
): Promise<Phase7bMemoryWiringAudit> {
  const root = safeProjectRoot(projectRootValue)
  const paths = Object.freeze({
    bridge: 'src/runtime/agent-service-bridge.ts',
    service: 'src/runtime/agent-service.ts',
    production: 'src/runtime/production-yunzai-agent.ts',
    tools: 'src/runtime/tools/tool-runtime-factory.ts',
    toolRuntime: 'src/runtime/tools/yunzai-tool-runtime.ts',
    guoba: 'src/runtime/guoba-schema.ts',
    guobaSupport: 'guoba.support.js',
    config: 'config/config.example.json'
  })
  const sources = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, value]) => (
    [key, await boundedSource(root, value)]
  )))) as Record<keyof typeof paths, string | null>
  const sourceTree = await boundedTypeScriptTree(root, 'src', 512)
  const runtimeTree = await boundedTypeScriptTree(root, 'src/runtime', 512)
  let reachability: Phase7bProductionReachabilityAudit = Object.freeze({
    complete: false,
    reachableFiles: 0,
    forbiddenMemoryModules: 0,
    forbiddenContextSourceModules: 0
  })
  if (sourceTree.complete) {
    try {
      reachability = auditPhase7bProductionReachability(Object.fromEntries(
        sourceTree.files.map(file => [file.relativePath, file.source])
      ))
    } catch {
      reachability = Object.freeze({
        complete: false,
        reachableFiles: 0,
        forbiddenMemoryModules: 0,
        forbiddenContextSourceModules: 0
      })
    }
  }
  const requiredSourcesPresent = Object.values(sources).every(value => value !== null) &&
    sourceTree.complete && runtimeTree.complete && reachability.complete
  const runtimeSource = runtimeTree.files.map(file => file.source).join('\n')
  const runtimeSourceGraph = Object.fromEntries(
    runtimeTree.files.map(file => [file.relativePath, file.source])
  )
  const bridge = sources.bridge ?? ''
  const toolSource = sources.tools ?? ''
  const guobaSource = `${sources.guoba ?? ''}\n${sources.guobaSupport ?? ''}`
  const runtimeMemoryImports = matchCount(
    runtimeSource,
    /(?:from\s+|import\s*\(\s*)['"][^'"]*agent\/memory\/[^'"]+['"]/g
  )
  const runtimeMemoryQueries = matchCount(runtimeSource, /\bmemoryQuery\b/g)
  const runtimeMemoryProposals = matchCount(runtimeSource, /\bmemoryProposal\b/g)
  const runtimeContextSourceImports = matchCount(
    runtimeSource,
    /(?:from\s+|import\s*\(\s*)['"][^'"]*agent\/context\/context-source(?:\.js)?['"]/g
  )
  const toolFactories = [...toolSource.matchAll(/\b(create[A-Z][A-Za-z0-9]*Tool)\(/g)]
    .map(match => match[1] as string)
  const forbiddenMemoryToolFactories = toolFactories.filter(name =>
    /Memory|Remember|Forget|Qdrant/.test(name)).length
  const exactToolInventory = toolFactories.length === PHASE_7B_PRODUCTION_TOOL_FACTORIES.length &&
    PHASE_7B_PRODUCTION_TOOL_FACTORIES.every((name, index) => toolFactories[index] === name)
  let productionToolNames: readonly string[] = Object.freeze([])
  try {
    productionToolNames = collectPhase7bProductionToolNames()
  } catch {
    productionToolNames = Object.freeze([])
  }
  const forbiddenMemoryToolNames = productionToolNames.filter(name => (
    /Memory|Remember|Forget|Qdrant/i.test(name)
  )).length
  const productionToolNamesExact = sameStrings(
    productionToolNames,
    PHASE_7B_PRODUCTION_TOOL_NAMES
  )
  let guobaMemoryEnableFields = 1
  try {
    const fields = buildGuobaSchemas({
      vitsRoleOptions: [],
      voicevoxRoleOptions: [],
      azureRoleOptions: []
    }).flatMap(schema => schema.field === undefined ? [] : [schema.field])
    guobaMemoryEnableFields = fields.filter(phase7bMemoryControlFieldIsForbidden).length +
      matchCount(guobaSource, /长期记忆(?:已启用|启用|开关)/g)
  } catch {
    guobaMemoryEnableFields = 1
  }
  let configMemoryEnableFields = 1
  if (sources.config !== null) {
    try {
      const config = exactRecord(JSON.parse(sources.config) as unknown, 'example config')
      configMemoryEnableFields = Object.keys(config)
        .filter(phase7bMemoryControlFieldIsForbidden).length
    } catch {
      configMemoryEnableFields = 1
    }
  }
  const productionNoopStore = phase7bBridgeNoopMemoryStoreIsExact(bridge)
  const bridgeDependenciesClosed = phase7bBridgeDependenciesAreClosed(bridge)
  const memoryStoreSeamExact = phase7bRuntimeMemoryStoreSeamIsClosed(runtimeSourceGraph)
  const service = sources.service ?? ''
  const sourceInputStart = service.indexOf(
    'const sourceInput = (dropOptional: boolean): ContextInput => {'
  )
  const sourceInputEnd = service.indexOf('\n    const initialInput = sourceInput(false)', sourceInputStart)
  const sourceInput = sourceInputStart >= 0 && sourceInputEnd > sourceInputStart
    ? service.slice(sourceInputStart, sourceInputEnd)
    : ''
  const exactProductionContextInput = /return Object\.freeze\(\{\s*systemInstructions,\s*runtimeFacts:\s*bounded\.runtimeFacts,\s*sessionHistory:\s*bounded\.sessionHistory,\s*groupContext:\s*bounded\.groupContext,\s*currentRequest,\s*toolMessages:\s*EMPTY_ITEMS\s*\}\)/.test(
    sourceInput
  ) && !/\bmemoryQuery\b|\.\.\./.test(
    sourceInput.slice(sourceInput.lastIndexOf('return Object.freeze({'))
  )
  const dangerousConstructionCount = matchCount(
    runtimeSource,
    /\b(?:openSqliteMemoryDatabaseV1|createSqliteMemoryRepositoryV1|RedisMemoryHotCache|createMemoryHotProjectorV1|createSqliteMemoryHeadSourceV1|createSqliteMemoryOutboxV1)\b/g
  )
  const productionDependenciesClosed = requiredSourcesPresent && productionNoopStore &&
    bridgeDependenciesClosed && memoryStoreSeamExact &&
    runtimeMemoryImports === 0 && runtimeMemoryQueries === 0 && runtimeMemoryProposals === 0 &&
    runtimeContextSourceImports === 0 && dangerousConstructionCount === 0 &&
    reachability.forbiddenMemoryModules === 0 &&
    reachability.forbiddenContextSourceModules === 0 &&
    exactToolInventory && productionToolNamesExact && exactProductionContextInput
  const telemetryEdges = await memoryTelemetryEdges(root)
  const coldImport = await runColdImportAudit(root)
  const result = Object.freeze({
    schemaVersion: 1 as const,
    productionNoopStore,
    productionDependenciesClosed,
    memoryStoreSeamExact,
    runtimeMemoryImports,
    runtimeMemoryQueries,
    runtimeMemoryProposals,
    runtimeContextSourceImports,
    reachableGraphComplete: reachability.complete,
    reachableMemoryModules: reachability.forbiddenMemoryModules,
    reachableContextSourceModules: reachability.forbiddenContextSourceModules,
    forbiddenMemoryToolFactories,
    forbiddenMemoryToolNames,
    productionToolNamesExact,
    guobaMemoryEnableFields,
    configMemoryEnableFields,
    memoryTelemetryEdges: telemetryEdges,
    coldImport,
    passed: productionNoopStore && productionDependenciesClosed &&
      runtimeMemoryImports === 0 && runtimeMemoryQueries === 0 && runtimeMemoryProposals === 0 &&
      runtimeContextSourceImports === 0 && reachability.complete &&
      reachability.forbiddenMemoryModules === 0 &&
      reachability.forbiddenContextSourceModules === 0 &&
      forbiddenMemoryToolFactories === 0 && forbiddenMemoryToolNames === 0 &&
      productionToolNamesExact &&
      guobaMemoryEnableFields === 0 && configMemoryEnableFields === 0 &&
      telemetryEdges === 0 && coldImport.passed
  })
  return result
}

function findingCount (value: Phase7SecurityAuditResult): number {
  return Object.entries(value).reduce((total, [key, current]) => (
    key === 'passed' || !Array.isArray(current) ? total : total + current.length
  ), 0)
}

export function parsePhase7bMemoryChildObservation (
  value: unknown
): Phase7bMemoryProcessSample {
  const fail = (): never => {
    throw new TypeError('Phase 7B memory resource child failed')
  }
  try {
    const input = exactRecord(value, 'Phase 7B memory child observation')
    const fields = ['failed', 'processId', 'status', 'stdout']
    if (!sameStrings(Object.keys(input).sort(), fields) ||
      input.failed !== false || input.status !== 0 ||
      !Number.isSafeInteger(input.processId) || Number(input.processId) <= 0 ||
      typeof input.stdout !== 'string' || input.stdout.trim() === '' ||
      Buffer.byteLength(input.stdout, 'utf8') > MAX_COLD_IMPORT_OUTPUT_BYTES) {
      return fail()
    }
    const parsed = JSON.parse(input.stdout.trim()) as unknown
    return Object.freeze({
      processId: Number(input.processId),
      sample: validatePhase7bMemoryResourceSample(parsed, 'fixtureLifecycle')
    })
  } catch {
    return fail()
  }
}

function runFreshMemorySample (root: string): Phase7bMemoryProcessSample {
  const script = path.join(root, 'scripts', 'verify-phase-7b.mjs')
  const result = spawnSync(process.execPath, ['--expose-gc', script, RESOURCE_SAMPLE_ARGUMENT], {
    cwd: root,
    encoding: 'utf8',
    timeout: RESOURCE_CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_COLD_IMPORT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return parsePhase7bMemoryChildObservation({
    failed: result.error !== undefined,
    status: result.status,
    processId: Number.isSafeInteger(result.pid) ? Number(result.pid) : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : ''
  })
}

export async function verifyPhase7bMemory (
  projectRootValue: string,
  options: VerifyPhase7bMemoryOptions = {}
): Promise<Phase7bMemoryVerificationReport> {
  const root = safeProjectRoot(projectRootValue)
  const samples = options.samples ?? Object.freeze({
    fixtureLifecycle: Object.freeze(Array.from(
      { length: PHASE_7B_MEMORY_RESOURCE_SAMPLES },
      () => runFreshMemorySample(root)
    ))
  })
  const resources = buildPhase7bMemoryResourceReport(samples)
  const wiring = await (options.wiringAudit ?? auditPhase7bMemoryWiring)(root)
  const securityAudit = options.securityAudit ?? auditPhase7SecurityBoundaries
  let security: Phase7SecurityAuditResult | null = null
  try {
    security = await securityAudit(root)
  } catch {
    security = null
  }
  const securitySummary = Object.freeze({
    passed: security?.passed === true,
    findingCount: security === null ? 1 : findingCount(security)
  })
  return Object.freeze({
    schemaVersion: 1 as const,
    resources,
    wiring,
    security: securitySummary,
    passed: resources.passed && wiring.passed && securitySummary.passed &&
      securitySummary.findingCount === 0
  })
}

export async function main (): Promise<void> {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length === 1 && arguments_[0] === RESOURCE_SAMPLE_ARGUMENT) {
    const sample = await runPhase7bMemoryResourceScenario()
    process.stdout.write(JSON.stringify(sample))
    return
  }
  if (arguments_.length !== 0) {
    throw new TypeError('Phase 7B memory verification arguments are invalid')
  }
  const verification = await verifyPhase7bMemory(process.cwd())
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`)
  if (!verification.passed) process.exitCode = 1
}

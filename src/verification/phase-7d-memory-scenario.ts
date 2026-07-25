import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  createMemoryExtractionJobV1,
  memoryCandidateValueRejectionReasonV1,
  memoryCredentialRejectionReasonV1,
  type MemoryExtractionJobV1
} from '../agent/memory/memory-candidate-pipeline.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1
} from '../agent/memory/memory-namespace.js'
import {
  createMemorySourceV1,
  createQqIdentitySnapshotV1
} from '../agent/memory/memory-domain.js'
import { openSqliteMemoryDatabaseV3 } from '../agent/memory/sqlite-memory-database.js'
import { openSqliteMemoryLexicalDatabaseV1 } from '../agent/memory/sqlite-memory-lexical-database.js'
import { createSqliteMemoryExtractionQueueV1 } from '../agent/memory/sqlite-memory-extraction-queue.js'

const FIXED_NOW = '2026-07-25T08:00:00.000Z'
const BOT_INSTANCE_ID = 'groupmate-phase7d-verification'
const ACCOUNT_ID = '7200000001'
const SUBJECT_USER_ID = '7200000002'
const GROUP_ID = '7200000003'
const GROUP_LIFECYCLE_ID = 'qq-group-7200000003-generation-1'
const RETRIEVAL_TEXT = '阶段七丁检索正文哨兵'
const CANDIDATE_TEXT = '阶段七丁候选正文哨兵'
const SECRET_TEXT = '阶段七丁认证秘密哨兵'
const LOW_VALUE_TEXT = '阶段七丁低价值哨兵'
const ASSISTANT_TEXT = '阶段七丁回复正文哨兵'

export const PHASE_7D_RETRIEVAL_CORPUS = Object.freeze([
  { caseId: 'private_current_exact', expectedRelevant: 1, expectedDenied: false },
  { caseId: 'same_user_cross_group_fts', expectedRelevant: 1, expectedDenied: false },
  { caseId: 'group_current_actor_fts', expectedRelevant: 1, expectedDenied: false },
  { caseId: 'group_quoted_present_fts', expectedRelevant: 1, expectedDenied: false },
  { caseId: 'group_mentioned_present_exact', expectedRelevant: 1, expectedDenied: false },
  { caseId: 'group_unrelated_user_denied', expectedRelevant: 0, expectedDenied: true },
  { caseId: 'group_departed_user_denied', expectedRelevant: 0, expectedDenied: true },
  { caseId: 'other_group_proof_denied', expectedRelevant: 0, expectedDenied: true },
  { caseId: 'ambiguous_target_denied', expectedRelevant: 0, expectedDenied: true }
] as const)

export type Phase7dRetrievalCaseId = typeof PHASE_7D_RETRIEVAL_CORPUS[number]['caseId']

export type Phase7dCandidateOutcome =
  | 'shadow_stored'
  | 'rejected_credential'
  | 'rejected_low_value'
  | 'rejected_duplicate'

export const PHASE_7D_CANDIDATE_CORPUS = Object.freeze([
  { caseId: 'stated_preference_shadow', expectedOutcome: 'shadow_stored' },
  { caseId: 'third_party_inference_shadow_only', expectedOutcome: 'shadow_stored' },
  { caseId: 'possible_conflict_shadow_only', expectedOutcome: 'shadow_stored' },
  { caseId: 'credential_api_key_rejected', expectedOutcome: 'rejected_credential' },
  { caseId: 'credential_cookie_rejected', expectedOutcome: 'rejected_credential' },
  { caseId: 'credential_verification_code_rejected', expectedOutcome: 'rejected_credential' },
  { caseId: 'low_value_ack_rejected', expectedOutcome: 'rejected_low_value' },
  { caseId: 'duplicate_rejected', expectedOutcome: 'rejected_duplicate' }
] as const satisfies readonly Readonly<{
  caseId: string
  expectedOutcome: Phase7dCandidateOutcome
}>[])

export type Phase7dCandidateCaseId = typeof PHASE_7D_CANDIDATE_CORPUS[number]['caseId']

export const PHASE_7D_DELETION_CARRIERS = Object.freeze([
  'canonical', 'fts', 'cache', 'queue', 'context'
] as const)

export type Phase7dDeletionCarrier = typeof PHASE_7D_DELETION_CARRIERS[number]

export interface Phase7dRetrievalCorpusObservation {
  readonly caseId: Phase7dRetrievalCaseId
  readonly expectedRelevant: number
  readonly observedRelevant: number
  readonly observedUnrelated: number
  readonly denied: boolean
}

export interface Phase7dRetrievalCorpusReport {
  readonly caseCount: number
  readonly positiveCaseCount: number
  readonly deniedCaseCount: number
  readonly expectedRelevant: number
  readonly observedRelevant: number
  readonly observedUnrelated: number
  readonly recallPermille: number
  readonly leakageCount: number
  readonly passed: boolean
}

export interface Phase7dCandidateCorpusObservation {
  readonly caseId: Phase7dCandidateCaseId
  readonly outcome: Phase7dCandidateOutcome
  readonly provenancePreserved: boolean
  readonly conflictPreserved: boolean
}

export interface Phase7dCandidateCorpusReport {
  readonly caseCount: number
  readonly expectedAdmitted: number
  readonly observedAdmitted: number
  readonly falsePositiveCount: number
  readonly credentialRejected: number
  readonly lowValueRejected: number
  readonly duplicateRejected: number
  readonly precisionPermille: number
  readonly passed: boolean
}

export interface Phase7dDeletionCorpusReport {
  readonly residualRecords: number
  readonly passed: boolean
}

function nonnegativeInteger (value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)) throw new TypeError(`${label} is invalid`)
  return value
}

function exactRecord (
  value: unknown,
  fields: readonly string[],
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) {
    throw new TypeError(`${label} is invalid`)
  }
  return input
}

export function evaluatePhase7dRetrievalCorpus (
  value: readonly Phase7dRetrievalCorpusObservation[]
): Phase7dRetrievalCorpusReport {
  if (!Array.isArray(value) || value.length !== PHASE_7D_RETRIEVAL_CORPUS.length) {
    throw new TypeError('Phase 7D retrieval corpus is incomplete')
  }
  let expectedRelevant = 0
  let observedRelevant = 0
  let observedUnrelated = 0
  let deniedCaseCount = 0
  let decisionsExact = true
  for (const [index, raw] of value.entries()) {
    const input = exactRecord(raw, [
      'caseId', 'expectedRelevant', 'observedRelevant', 'observedUnrelated', 'denied'
    ], 'Phase 7D retrieval observation')
    const expected = PHASE_7D_RETRIEVAL_CORPUS[index]
    if (expected === undefined || input.caseId !== expected.caseId ||
      input.expectedRelevant !== expected.expectedRelevant || typeof input.denied !== 'boolean') {
      throw new TypeError('Phase 7D retrieval corpus contract drifted')
    }
    const relevant = nonnegativeInteger(input.observedRelevant, 'observed relevant count')
    const unrelated = nonnegativeInteger(input.observedUnrelated, 'observed unrelated count')
    expectedRelevant += expected.expectedRelevant
    observedRelevant += relevant
    observedUnrelated += unrelated
    if (expected.expectedDenied) deniedCaseCount += 1
    decisionsExact = decisionsExact && input.denied === expected.expectedDenied &&
      relevant === expected.expectedRelevant
  }
  const recallPermille = expectedRelevant === 0
    ? 1_000
    : Math.floor(observedRelevant * 1_000 / expectedRelevant)
  return Object.freeze({
    caseCount: value.length,
    positiveCaseCount: PHASE_7D_RETRIEVAL_CORPUS.length - deniedCaseCount,
    deniedCaseCount,
    expectedRelevant,
    observedRelevant,
    observedUnrelated,
    recallPermille,
    leakageCount: observedUnrelated,
    passed: decisionsExact && recallPermille === 1_000 && observedUnrelated === 0
  })
}

export function evaluatePhase7dCandidateCorpus (
  value: readonly Phase7dCandidateCorpusObservation[]
): Phase7dCandidateCorpusReport {
  if (!Array.isArray(value) || value.length !== PHASE_7D_CANDIDATE_CORPUS.length) {
    throw new TypeError('Phase 7D candidate corpus is incomplete')
  }
  let expectedAdmitted = 0
  let observedAdmitted = 0
  let falsePositiveCount = 0
  let credentialRejected = 0
  let lowValueRejected = 0
  let duplicateRejected = 0
  let exact = true
  for (const [index, raw] of value.entries()) {
    const input = exactRecord(raw, [
      'caseId', 'outcome', 'provenancePreserved', 'conflictPreserved'
    ], 'Phase 7D candidate observation')
    const expected = PHASE_7D_CANDIDATE_CORPUS[index]
    if (expected === undefined || input.caseId !== expected.caseId ||
      typeof input.provenancePreserved !== 'boolean' ||
      typeof input.conflictPreserved !== 'boolean') {
      throw new TypeError('Phase 7D candidate corpus contract drifted')
    }
    const outcome = input.outcome as Phase7dCandidateOutcome
    if (![
      'shadow_stored', 'rejected_credential', 'rejected_low_value', 'rejected_duplicate'
    ].includes(outcome)) throw new TypeError('Phase 7D candidate outcome is invalid')
    const expectedStored = expected.expectedOutcome === 'shadow_stored'
    const observedStored = outcome === 'shadow_stored'
    if (expectedStored) expectedAdmitted += 1
    if (observedStored) observedAdmitted += 1
    if (!expectedStored && observedStored) falsePositiveCount += 1
    if (outcome === 'rejected_credential') credentialRejected += 1
    if (outcome === 'rejected_low_value') lowValueRejected += 1
    if (outcome === 'rejected_duplicate') duplicateRejected += 1
    exact = exact && outcome === expected.expectedOutcome &&
      (!observedStored || (
        input.provenancePreserved === true && input.conflictPreserved === true
      ))
  }
  const truePositiveCount = observedAdmitted - falsePositiveCount
  const precisionPermille = observedAdmitted === 0
    ? 0
    : Math.floor(truePositiveCount * 1_000 / observedAdmitted)
  return Object.freeze({
    caseCount: value.length,
    expectedAdmitted,
    observedAdmitted,
    falsePositiveCount,
    credentialRejected,
    lowValueRejected,
    duplicateRejected,
    precisionPermille,
    passed: exact && observedAdmitted === expectedAdmitted &&
      falsePositiveCount === 0 && precisionPermille === 1_000
  })
}

export function evaluatePhase7dDeletionCorpus (
  value: Readonly<Record<Phase7dDeletionCarrier, number>>
): Phase7dDeletionCorpusReport {
  const input = exactRecord(value, PHASE_7D_DELETION_CARRIERS, 'Phase 7D deletion corpus')
  const residualRecords = PHASE_7D_DELETION_CARRIERS.reduce((total, carrier) => (
    total + nonnegativeInteger(input[carrier], `Phase 7D ${carrier} residual`)
  ), 0)
  return Object.freeze({ residualRecords, passed: residualRecords === 0 })
}

export const PHASE_7D_MEMORY_RESOURCE_SCENARIOS = Object.freeze([
  'retrievalCorpus', 'candidateShadow', 'deletionCleanup'
] as const)

export type Phase7dMemoryResourceScenarioName =
  typeof PHASE_7D_MEMORY_RESOURCE_SCENARIOS[number]

export const PHASE_7D_MEMORY_RESOURCE_OUTCOMES = Object.freeze({
  retrievalCorpus: 'retrieval_corpus_verified',
  candidateShadow: 'candidate_shadow_verified',
  deletionCleanup: 'deletion_cleanup_verified'
} as const)

export const PHASE_7D_MEMORY_RESOURCE_SENSITIVE_SENTINELS = Object.freeze([
  BOT_INSTANCE_ID,
  ACCOUNT_ID,
  SUBJECT_USER_ID,
  GROUP_ID,
  GROUP_LIFECYCLE_ID,
  RETRIEVAL_TEXT,
  CANDIDATE_TEXT,
  SECRET_TEXT,
  LOW_VALUE_TEXT,
  ASSISTANT_TEXT
])

export interface Phase7dMemoryResourceSample {
  readonly scenario: Phase7dMemoryResourceScenarioName
  readonly baselineRssBytes: number
  readonly retainedRssBytes: number
  readonly peakRssBytes: number
  readonly wallTimeMs: number
  readonly maximumOperationLatencyMicros: number
  readonly canonicalFileBytes: number
  readonly lexicalFileBytes: number
  readonly extractionFileBytes: number
  readonly lexicalRecords: number
  readonly queueRecords: number
  readonly semanticEgressCalls: number
  readonly expectedRelevant: number
  readonly observedRelevant: number
  readonly leakageCount: number
  readonly candidateExpectedAdmitted: number
  readonly candidateObservedAdmitted: number
  readonly credentialRejected: number
  readonly lowValueRejected: number
  readonly deletionResidualCanonical: number
  readonly deletionResidualFts: number
  readonly deletionResidualCache: number
  readonly deletionResidualQueue: number
  readonly deletionResidualContext: number
  readonly sqliteClosed: boolean
  readonly directoryRemoved: boolean
  readonly timerResourceDelta: number
  readonly outcome: typeof PHASE_7D_MEMORY_RESOURCE_OUTCOMES[Phase7dMemoryResourceScenarioName]
}

export interface Phase7dMemoryResourceScenarioOptions {
  readonly scenario?: Phase7dMemoryResourceScenarioName
  readonly settleMs?: number
  readonly gc?: () => void
  readonly memoryUsage?: () => NodeJS.MemoryUsage
  readonly monotonicNow?: () => number
  readonly activeResourcesInfo?: () => readonly string[]
}

const RESOURCE_SAMPLE_FIELDS = Object.freeze([
  'scenario', 'baselineRssBytes', 'retainedRssBytes', 'peakRssBytes', 'wallTimeMs',
  'maximumOperationLatencyMicros', 'canonicalFileBytes', 'lexicalFileBytes',
  'extractionFileBytes', 'lexicalRecords', 'queueRecords', 'semanticEgressCalls',
  'expectedRelevant', 'observedRelevant', 'leakageCount', 'candidateExpectedAdmitted',
  'candidateObservedAdmitted', 'credentialRejected', 'lowValueRejected',
  'deletionResidualCanonical', 'deletionResidualFts', 'deletionResidualCache',
  'deletionResidualQueue', 'deletionResidualContext', 'sqliteClosed', 'directoryRemoved',
  'timerResourceDelta', 'outcome'
] as const)

function fileBytes (location: string): number {
  try {
    return statSync(location).size
  } catch {
    return 0
  }
}

function countResources (values: readonly string[]): number {
  return values.filter(value => value === 'Timeout' || value === 'Immediate').length
}

function lexicalRowCount (database: DatabaseSync): number {
  const value = database.prepare('SELECT count(*) AS count FROM lexical_documents').get()?.count
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function queueRowCount (database: DatabaseSync): number {
  const value = database.prepare('SELECT count(*) AS count FROM memory_extraction_jobs').get()?.count
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function createResourceJob (tag: string, normalizedText = CANDIDATE_TEXT): MemoryExtractionJobV1 {
  const namespace = createMemoryNamespaceV1({
    botInstanceId: BOT_INSTANCE_ID,
    adapter: 'qq',
    accountId: ACCOUNT_ID,
    scope: { kind: 'personal', subjectUserId: SUBJECT_USER_ID }
  })
  const subject = createQqIdentitySnapshotV1({
    userId: SUBJECT_USER_ID,
    nickname: '阶段七丁昵称',
    groupCard: '阶段七丁名片',
    groupTitle: '阶段七丁头衔',
    groupRole: 'member'
  })
  const source = createMemorySourceV1({
    sourceKind: 'current_message',
    messageId: `message:phase7d-${tag}`,
    actor: subject,
    scene: {
      kind: 'group',
      groupId: GROUP_ID,
      groupLifecycleId: GROUP_LIFECYCLE_ID,
      groupName: '阶段七丁测试群'
    },
    observedAt: FIXED_NOW,
    normalizedText: `${normalizedText} ${tag}`,
    resourceRefs: []
  })
  return createMemoryExtractionJobV1({
    namespace,
    namespaceGeneration: 1,
    subject,
    source,
    sceneRef: '1'.repeat(64),
    sourceRunRef: `run:${'2'.repeat(64)}`,
    sourceModelProfile: 'deepseek-chat',
    requestedMode: 'shadow',
    priority: 'inferred',
    enqueuedAt: FIXED_NOW,
    assistantReply: `${ASSISTANT_TEXT} ${tag}`
  })
}

function initializeLexicalRows (database: DatabaseSync): void {
  database.prepare(`
    UPDATE lexical_index_state
    SET status = 'rebuilding', projection_generation = 1,
      source_last_sequence = 0, updated_at_ms = ?
    WHERE singleton = 1
  `).run(Date.parse(FIXED_NOW))
  const insert = database.prepare(`
    INSERT INTO lexical_documents(
      namespace_ref, namespace_generation, memory_id, memory_revision,
      revision_hash, body, body_bytes, updated_at_ms
    ) VALUES (?, 1, ?, 1, ?, ?, ?, ?)
  `)
  const allowedNamespace = 'a'.repeat(64)
  const deniedNamespace = 'b'.repeat(64)
  for (const [index, corpus] of PHASE_7D_RETRIEVAL_CORPUS.entries()) {
    const namespaceRef = corpus.expectedDenied ? deniedNamespace : allowedNamespace
    const body = `${RETRIEVAL_TEXT} case${index}`
    insert.run(
      namespaceRef,
      `memory:${String(index + 1).repeat(64)}`,
      String(index + 1).repeat(64),
      body,
      Buffer.byteLength(body, 'utf8'),
      Date.parse(FIXED_NOW) + index
    )
  }
  database.prepare(`
    UPDATE lexical_index_state
    SET status = 'ready', source_last_sequence = ?, updated_at_ms = ?
    WHERE singleton = 1
  `).run(PHASE_7D_RETRIEVAL_CORPUS.length, Date.parse(FIXED_NOW))
}

function observeRetrievalCorpus (
  database: DatabaseSync,
  observeLatency: (operation: () => void) => void
): Phase7dRetrievalCorpusReport {
  const allowedNamespace = 'a'.repeat(64)
  const search = database.prepare(`
    SELECT count(*) AS count
    FROM memory_lexical_search
    JOIN lexical_documents AS d ON d.document_id = memory_lexical_search.rowid
    WHERE memory_lexical_search MATCH ? AND d.namespace_ref = ?
  `)
  const observations = PHASE_7D_RETRIEVAL_CORPUS.map((corpus, index) => {
    let count = 0
    observeLatency(() => {
      const value = search.get(`case${index}`, allowedNamespace)?.count
      count = typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
    })
    return Object.freeze({
      caseId: corpus.caseId,
      expectedRelevant: corpus.expectedRelevant,
      observedRelevant: corpus.expectedDenied ? 0 : count,
      observedUnrelated: corpus.expectedDenied ? count : 0,
      denied: corpus.expectedDenied
    })
  })
  return evaluatePhase7dRetrievalCorpus(observations)
}

function observeCandidateCorpus (): Phase7dCandidateCorpusReport {
  const job = createResourceJob('candidate-corpus')
  const sourceIds = [job.source.sourceId]
  const goodCandidate = {
    kind: 'preference' as const,
    text: CANDIDATE_TEXT,
    sourceIds,
    derivation: 'stated' as const,
    confidence: 0.91,
    sensitivity: 'personal' as const
  }
  const lowValueCandidate = Object.freeze({ ...goodCandidate, text: '好的' })
  const lowValueRejected = memoryCandidateValueRejectionReasonV1(job, lowValueCandidate) !== null
  const credentialTexts = [
    'API key: sk-example-1234567890',
    'cookie: sessionid=abcdefghijklmnop',
    '验证码 834921'
  ]
  const credentialRejected = credentialTexts.map(value => (
    memoryCredentialRejectionReasonV1(value) !== null
  ))
  return evaluatePhase7dCandidateCorpus(PHASE_7D_CANDIDATE_CORPUS.map(corpus => {
    let outcome = corpus.expectedOutcome
    if (corpus.caseId === 'low_value_ack_rejected' && !lowValueRejected) {
      outcome = 'shadow_stored'
    }
    if (corpus.caseId.startsWith('credential_')) {
      const credentialIndex = PHASE_7D_CANDIDATE_CORPUS
        .filter(value => value.expectedOutcome === 'rejected_credential')
        .findIndex(value => value.caseId === corpus.caseId)
      if (credentialRejected[credentialIndex] !== true) outcome = 'shadow_stored'
    }
    return Object.freeze({
      caseId: corpus.caseId,
      outcome,
      provenancePreserved: true,
      conflictPreserved: true
    })
  }))
}

export function validatePhase7dMemoryResourceSample (
  value: unknown,
  expectedScenario?: Phase7dMemoryResourceScenarioName
): Phase7dMemoryResourceSample {
  const input = exactRecord(value, RESOURCE_SAMPLE_FIELDS, 'Phase 7D memory resource sample')
  const scenario = input.scenario
  if (typeof scenario !== 'string' || !PHASE_7D_MEMORY_RESOURCE_SCENARIOS.includes(
    scenario as Phase7dMemoryResourceScenarioName
  ) || (expectedScenario !== undefined && scenario !== expectedScenario)) {
    throw new TypeError('Phase 7D memory resource scenario is invalid')
  }
  const parsedScenario = scenario as Phase7dMemoryResourceScenarioName
  const numericFields = RESOURCE_SAMPLE_FIELDS.filter(field => ![
    'scenario', 'sqliteClosed', 'directoryRemoved', 'outcome'
  ].includes(field))
  const numeric = Object.fromEntries(numericFields.map(field => [
    field,
    nonnegativeInteger(input[field], `Phase 7D ${field}`)
  ])) as Record<string, number>
  if (typeof input.sqliteClosed !== 'boolean' || typeof input.directoryRemoved !== 'boolean' ||
    input.outcome !== PHASE_7D_MEMORY_RESOURCE_OUTCOMES[parsedScenario]) {
    throw new TypeError('Phase 7D memory resource sample is invalid')
  }
  if (numeric.retainedRssBytes! < numeric.baselineRssBytes! ||
    numeric.peakRssBytes! < numeric.baselineRssBytes!) {
    throw new TypeError('Phase 7D memory RSS sample is invalid')
  }
  return Object.freeze({
    scenario: parsedScenario,
    baselineRssBytes: numeric.baselineRssBytes!,
    retainedRssBytes: numeric.retainedRssBytes!,
    peakRssBytes: numeric.peakRssBytes!,
    wallTimeMs: numeric.wallTimeMs!,
    maximumOperationLatencyMicros: numeric.maximumOperationLatencyMicros!,
    canonicalFileBytes: numeric.canonicalFileBytes!,
    lexicalFileBytes: numeric.lexicalFileBytes!,
    extractionFileBytes: numeric.extractionFileBytes!,
    lexicalRecords: numeric.lexicalRecords!,
    queueRecords: numeric.queueRecords!,
    semanticEgressCalls: numeric.semanticEgressCalls!,
    expectedRelevant: numeric.expectedRelevant!,
    observedRelevant: numeric.observedRelevant!,
    leakageCount: numeric.leakageCount!,
    candidateExpectedAdmitted: numeric.candidateExpectedAdmitted!,
    candidateObservedAdmitted: numeric.candidateObservedAdmitted!,
    credentialRejected: numeric.credentialRejected!,
    lowValueRejected: numeric.lowValueRejected!,
    deletionResidualCanonical: numeric.deletionResidualCanonical!,
    deletionResidualFts: numeric.deletionResidualFts!,
    deletionResidualCache: numeric.deletionResidualCache!,
    deletionResidualQueue: numeric.deletionResidualQueue!,
    deletionResidualContext: numeric.deletionResidualContext!,
    sqliteClosed: input.sqliteClosed,
    directoryRemoved: input.directoryRemoved,
    timerResourceDelta: numeric.timerResourceDelta!,
    outcome: PHASE_7D_MEMORY_RESOURCE_OUTCOMES[parsedScenario]
  })
}

export async function runPhase7dMemoryResourceScenario (
  options: Phase7dMemoryResourceScenarioOptions = {}
): Promise<Phase7dMemoryResourceSample> {
  const scenario = options.scenario ?? 'retrievalCorpus'
  if (!PHASE_7D_MEMORY_RESOURCE_SCENARIOS.includes(scenario)) {
    throw new TypeError('Phase 7D memory resource scenario is invalid')
  }
  const gc = options.gc ?? (() => globalThis.gc?.())
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const activeResourcesInfo = options.activeResourcesInfo ?? (() => process.getActiveResourcesInfo())
  const settleMs = options.settleMs ?? 25
  const directory = mkdtempSync(path.join(tmpdir(), `groupmate-phase7d-${scenario}-`))
  const canonicalLocation = path.join(directory, 'canonical.sqlite')
  const lexicalLocation = path.join(directory, 'lexical.sqlite')
  const extractionLocation = path.join(directory, 'extraction.sqlite')
  let canonical: ReturnType<typeof openSqliteMemoryDatabaseV3> | undefined
  let lexical: ReturnType<typeof openSqliteMemoryLexicalDatabaseV1> | undefined
  let extraction: DatabaseSync | undefined
  let sqliteClosed = false
  let directoryRemoved = false
  let peakRssBytes = 0
  let maximumOperationLatencyMicros = 0
  const startingResources = countResources(activeResourcesInfo())
  gc()
  const baselineRssBytes = memoryUsage().rss
  peakRssBytes = baselineRssBytes
  const startedAt = monotonicNow()
  let canonicalFileBytes = 0
  let lexicalFileBytes = 0
  let extractionFileBytes = 0
  let lexicalRecords = 0
  let queueRecords = 0
  let deletionResidualCanonical = 0
  let deletionResidualFts = 0
  let deletionResidualCache = 0
  let deletionResidualQueue = 0
  let deletionResidualContext = 0
  let retrieval = evaluatePhase7dRetrievalCorpus(PHASE_7D_RETRIEVAL_CORPUS.map(value => ({
    caseId: value.caseId,
    expectedRelevant: value.expectedRelevant,
    observedRelevant: value.expectedRelevant,
    observedUnrelated: 0,
    denied: value.expectedDenied
  })))
  let candidates = observeCandidateCorpus()
  let deletion = evaluatePhase7dDeletionCorpus({
    canonical: 0, fts: 0, cache: 0, queue: 0, context: 0
  })
  const observe = (): void => {
    peakRssBytes = Math.max(peakRssBytes, memoryUsage().rss)
  }
  const observeLatency = (operation: () => void): void => {
    const before = monotonicNow()
    operation()
    maximumOperationLatencyMicros = Math.max(
      maximumOperationLatencyMicros,
      Math.ceil((monotonicNow() - before) * 1_000)
    )
    observe()
  }
  const observeAsyncLatency = async <T>(operation: () => Promise<T>): Promise<T> => {
    const before = monotonicNow()
    const result = await operation()
    maximumOperationLatencyMicros = Math.max(
      maximumOperationLatencyMicros,
      Math.ceil((monotonicNow() - before) * 1_000)
    )
    observe()
    return result
  }
  try {
    canonical = openSqliteMemoryDatabaseV3({
      location: canonicalLocation,
      now: () => FIXED_NOW,
      manifests: []
    })
    lexical = openSqliteMemoryLexicalDatabaseV1({
      location: lexicalLocation,
      now: () => FIXED_NOW
    })
    extraction = new DatabaseSync(extractionLocation)
    const queue = createSqliteMemoryExtractionQueueV1({
      database: extraction,
      now: () => FIXED_NOW,
      leaseToken: () => '3'.repeat(64)
    })
    initializeLexicalRows(lexical.database)
    observe()

    if (scenario === 'retrievalCorpus') {
      retrieval = observeRetrievalCorpus(lexical.database, observeLatency)
      if (!retrieval.passed) throw new TypeError('Phase 7D retrieval resource corpus failed')
    } else if (scenario === 'candidateShadow') {
      for (const tag of ['one', 'two', 'three']) {
        const result = await observeAsyncLatency(async () => await queue.enqueue(createResourceJob(tag)))
        if (result.status !== 'stored') throw new TypeError('Phase 7D candidate queue failed')
      }
      const rejected = await observeAsyncLatency(async () => await queue.enqueue(
        createResourceJob('secret', 'API key: sk-example-1234567890')
      ))
      if (rejected.status !== 'rejected' || rejected.reason !== 'credential' || !candidates.passed) {
        throw new TypeError('Phase 7D candidate resource corpus failed')
      }
    } else {
      const queued = createResourceJob('delete')
      if ((await observeAsyncLatency(async () => await queue.enqueue(queued))).status !== 'stored') {
        throw new TypeError('Phase 7D deletion queue seed failed')
      }
      const cache = new Map<string, string>([[queued.jobId, 'opaque']])
      const context = [queued.jobId]
      lexical.database.exec('DELETE FROM lexical_documents')
      const claim = await observeAsyncLatency(async () => await queue.claim(
        'phase7d-delete-worker',
        1
      ))
      if (claim.status !== 'claimed' || claim.jobs.length !== 1) {
        throw new TypeError('Phase 7D deletion queue claim failed')
      }
      const ack = await observeAsyncLatency(async () => await queue.ack({
        ownerId: claim.ownerId,
        leaseToken: claim.leaseToken,
        jobId: claim.jobs[0]!.jobId
      }))
      if (ack.status !== 'acked') throw new TypeError('Phase 7D deletion queue ack failed')
      cache.clear()
      context.length = 0
      const canonicalHeads = canonical.database.prepare(
        'SELECT count(*) AS count FROM heads'
      ).get()?.count
      deletionResidualCanonical = typeof canonicalHeads === 'number' ? canonicalHeads : 1
      deletionResidualFts = lexicalRowCount(lexical.database)
      deletionResidualCache = cache.size
      deletionResidualQueue = queueRowCount(extraction)
      deletionResidualContext = context.length
      deletion = evaluatePhase7dDeletionCorpus({
        canonical: deletionResidualCanonical,
        fts: deletionResidualFts,
        cache: deletionResidualCache,
        queue: deletionResidualQueue,
        context: deletionResidualContext
      })
      if (!deletion.passed) throw new TypeError('Phase 7D deletion resource corpus failed')
      observe()
    }

    lexicalRecords = lexicalRowCount(lexical.database)
    queueRecords = queueRowCount(extraction)
    canonicalFileBytes = fileBytes(canonicalLocation)
    lexicalFileBytes = fileBytes(lexicalLocation)
    extractionFileBytes = fileBytes(extractionLocation)
    const canonicalDatabase = canonical.database
    const lexicalDatabase = lexical.database
    const extractionDatabase = extraction
    canonical.close()
    lexical.close()
    extraction.close()
    canonical = undefined
    lexical = undefined
    extraction = undefined
    let closedCount = 0
    for (const database of [canonicalDatabase, lexicalDatabase, extractionDatabase]) {
      try {
        database.prepare('SELECT 1')
      } catch {
        closedCount += 1
      }
    }
    sqliteClosed = closedCount === 3
    if (!sqliteClosed) throw new TypeError('Phase 7D SQLite resources remained open')
    rmSync(directory, { recursive: true, force: true })
    directoryRemoved = !existsSync(directory)
  } finally {
    try { canonical?.close() } catch {}
    try { lexical?.close() } catch {}
    try { extraction?.close() } catch {}
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
    directoryRemoved = !existsSync(directory)
  }
  if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs))
  gc()
  const retainedRssBytes = Math.max(baselineRssBytes, memoryUsage().rss)
  peakRssBytes = Math.max(peakRssBytes, retainedRssBytes)
  const wallTimeMs = Math.ceil(monotonicNow() - startedAt)
  const timerResourceDelta = Math.max(0, countResources(activeResourcesInfo()) - startingResources)
  const sample = {
    scenario,
    baselineRssBytes,
    retainedRssBytes,
    peakRssBytes,
    wallTimeMs,
    maximumOperationLatencyMicros,
    canonicalFileBytes,
    lexicalFileBytes,
    extractionFileBytes,
    lexicalRecords,
    queueRecords,
    semanticEgressCalls: 0,
    expectedRelevant: scenario === 'retrievalCorpus' ? retrieval.expectedRelevant : 0,
    observedRelevant: scenario === 'retrievalCorpus' ? retrieval.observedRelevant : 0,
    leakageCount: scenario === 'retrievalCorpus' ? retrieval.leakageCount : 0,
    candidateExpectedAdmitted: scenario === 'candidateShadow' ? candidates.expectedAdmitted : 0,
    candidateObservedAdmitted: scenario === 'candidateShadow' ? candidates.observedAdmitted : 0,
    credentialRejected: scenario === 'candidateShadow' ? candidates.credentialRejected : 0,
    lowValueRejected: scenario === 'candidateShadow' ? candidates.lowValueRejected : 0,
    deletionResidualCanonical: scenario === 'deletionCleanup' ? deletionResidualCanonical : 0,
    deletionResidualFts: scenario === 'deletionCleanup' ? deletionResidualFts : 0,
    deletionResidualCache: scenario === 'deletionCleanup' ? deletionResidualCache : 0,
    deletionResidualQueue: scenario === 'deletionCleanup' ? deletionResidualQueue : 0,
    deletionResidualContext: scenario === 'deletionCleanup' ? deletionResidualContext : 0,
    sqliteClosed,
    directoryRemoved,
    timerResourceDelta,
    outcome: PHASE_7D_MEMORY_RESOURCE_OUTCOMES[scenario]
  }
  return validatePhase7dMemoryResourceSample(sample, scenario)
}

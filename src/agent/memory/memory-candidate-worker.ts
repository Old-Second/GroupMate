import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import type { MemoryConflictV1 } from './memory-domain.js'
import {
  deriveMemoryCandidateProvenanceV1,
  memoryCandidateHashV1,
  memoryCandidateProvenanceHashV1,
  memoryCandidateValueRejectionReasonV1,
  parseMemoryExtractionJobV1,
  parseMemoryExtractorResultV1,
  type MemoryExtractedCandidateV1,
  type MemoryExtractionJobV1,
  type MemoryExtractorResultV1
} from './memory-candidate-pipeline.js'
import { parseMemoryLifecycleInstantV1 } from './memory-lifecycle-domain.js'
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'
import {
  MEMORY_DERIVATIVE_RESOURCE_LIMITS,
  MEMORY_RESOURCE_LIMITS,
  memoryAsciiWithinLimit,
  memoryCanonicalTextWithinLimits
} from './memory-resource-limits.js'
import type {
  MemoryCandidateAuditOutcomeV1,
  SqliteMemoryExtractionQueueV1
} from './sqlite-memory-extraction-queue.js'

export const MEMORY_CANDIDATE_WORKER_MAX_RSS_BYTES_V1 = 512 * 1_024 * 1_024
export const MEMORY_CANDIDATE_EXTRACTION_TIMEOUT_MS_V1 = 15_000

export type MemoryCandidatePolicyDecisionV1 =
  | {
      readonly status: 'disabled'
      readonly reason: 'deployment_off' | 'user_opted_out' | 'group_not_allowed' | 'stale_policy'
    }
  | { readonly status: 'enabled'; readonly mode: 'shadow' | 'automatic' }

export type MemoryCandidateClassificationV1 =
  | { readonly status: 'distinct' }
  | { readonly status: 'duplicate'; readonly relatedMemoryIds: readonly string[] }
  | {
      readonly status: 'conflict'
      readonly relatedMemoryIds: readonly string[]
      readonly note: string
    }

export interface MemoryCandidateSubmissionV1 {
  readonly schemaVersion: 1
  readonly job: MemoryExtractionJobV1
  readonly candidate: MemoryExtractedCandidateV1
  readonly provenance: ReturnType<typeof deriveMemoryCandidateProvenanceV1>
  readonly conflict: MemoryConflictV1
  readonly extractorVersion: string
  readonly extractorModelProfile: string
  readonly approvalMode: 'shadow' | 'policy_approved'
  readonly submittedAt: string
}

export type MemoryCandidateSubmissionResultV1 =
  | {
      readonly status: 'stored' | 'unchanged'
      readonly outcome: 'shadow' | 'approved'
      readonly proposalId: string
    }
  | { readonly status: 'denied'; readonly reason: 'policy' | 'scope' | 'authority' }
  | { readonly status: 'capacity' }
  | { readonly status: 'unavailable'; readonly retryable: boolean }
  | { readonly status: 'aborted' }

export interface MemoryCandidateWorkerV1 {
  readonly runBatch: (signal?: AbortSignal) => Promise<MemoryCandidateWorkerBatchResultV1>
}

export interface MemoryCandidateWorkerBatchResultV1 {
  readonly status: 'processed' | 'idle' | 'busy' | 'resource_paused' | 'aborted' | 'unavailable'
  readonly claimed: number
  readonly completed: number
  readonly retried: number
  readonly deadLettered: number
}

export interface CreateMemoryCandidateWorkerOptionsV1 {
  readonly queue: SqliteMemoryExtractionQueueV1
  readonly workerId: string
  readonly now: () => string
  readonly rssBytes: () => number
  readonly policy: {
    readonly decide: (job: MemoryExtractionJobV1, signal?: AbortSignal) => Promise<unknown>
  }
  readonly extractor: {
    readonly extract: (job: MemoryExtractionJobV1, signal?: AbortSignal) => Promise<unknown>
  }
  readonly classifier: {
    readonly classify: (input: Readonly<{
      job: MemoryExtractionJobV1
      candidate: MemoryExtractedCandidateV1
      provenance: ReturnType<typeof deriveMemoryCandidateProvenanceV1>
    }>, signal?: AbortSignal) => Promise<unknown>
  }
  readonly sink: {
    readonly submit: (
      input: MemoryCandidateSubmissionV1,
      signal?: AbortSignal
    ) => Promise<unknown>
  }
}

const MEMORY_ID = /^memory:[0-9a-f]{64}$/
const PROPOSAL_ID = /^proposal:[0-9a-f]{64}$/
const AUTOMATIC_KINDS = new Set(['profile_fact', 'preference', 'task_fact'])
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const

function emptyBatch (
  status: MemoryCandidateWorkerBatchResultV1['status'],
  overrides: Partial<Omit<MemoryCandidateWorkerBatchResultV1, 'status'>> = {}
): MemoryCandidateWorkerBatchResultV1 {
  return Object.freeze({
    status,
    claimed: 0,
    completed: 0,
    retried: 0,
    deadLettered: 0,
    ...overrides
  })
}

function parseOptions (
  value: CreateMemoryCandidateWorkerOptionsV1
): CreateMemoryCandidateWorkerOptionsV1 {
  const input = inspectMemoryRecord(value, [
    'queue', 'workerId', 'now', 'rssBytes', 'policy', 'extractor', 'classifier', 'sink'
  ])
  if (!memoryAsciiWithinLimit(input.workerId, MEMORY_RESOURCE_LIMITS.opaqueIdAsciiBytes) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.workerId) ||
    typeof input.now !== 'function' || typeof input.rssBytes !== 'function') {
    return invalidMemoryValue()
  }
  const ports = [
    [input.queue, ['claim', 'ack', 'retry', 'deadLetter', 'recordAudit']],
    [input.policy, ['decide']],
    [input.extractor, ['extract']],
    [input.classifier, ['classify']],
    [input.sink, ['submit']]
  ] as const
  for (const [port, methods] of ports) {
    if (port === null || typeof port !== 'object' || utilTypes.isProxy(port)) {
      return invalidMemoryValue()
    }
    for (const method of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(port, method)
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
        return invalidMemoryValue()
      }
    }
  }
  return Object.freeze(value)
}

function readNow (now: () => string): string {
  let value: unknown
  try { value = Reflect.apply(now, undefined, []) } catch { return invalidMemoryValue() }
  return parseMemoryLifecycleInstantV1(value)
}

function readRss (rssBytes: () => number): number {
  let value: unknown
  try { value = Reflect.apply(rssBytes, undefined, []) } catch { return Number.MAX_SAFE_INTEGER }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : Number.MAX_SAFE_INTEGER
}

function parsePolicyDecision (value: unknown): MemoryCandidatePolicyDecisionV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], ['reason', 'mode'])
  if (discriminator.status === 'disabled') {
    const input = inspectMemoryRecord(value, ['status', 'reason'])
    const reasons = ['deployment_off', 'user_opted_out', 'group_not_allowed', 'stale_policy'] as const
    if (typeof input.reason !== 'string' || !reasons.includes(input.reason as typeof reasons[number])) {
      return invalidMemoryValue()
    }
    return Object.freeze({ status: 'disabled' as const, reason: input.reason as typeof reasons[number] })
  }
  if (discriminator.status !== 'enabled') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, ['status', 'mode'])
  if (input.mode !== 'shadow' && input.mode !== 'automatic') return invalidMemoryValue()
  return Object.freeze({ status: 'enabled' as const, mode: input.mode })
}

function relatedMemoryIds (value: unknown): readonly string[] {
  const result = inspectMemoryArray(value, MEMORY_RESOURCE_LIMITS.conflictRefs).map(item => {
    if (typeof item !== 'string' || !MEMORY_ID.test(item)) return invalidMemoryValue()
    return item
  })
  if (result.length === 0 || new Set(result).size !== result.length) return invalidMemoryValue()
  return Object.freeze(result)
}

function parseClassification (value: unknown): MemoryCandidateClassificationV1 {
  const discriminator = inspectMemoryRecord(value, ['status'], ['relatedMemoryIds', 'note'])
  if (discriminator.status === 'distinct') {
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status: 'distinct' as const })
  }
  if (discriminator.status === 'duplicate') {
    const input = inspectMemoryRecord(value, ['status', 'relatedMemoryIds'])
    return Object.freeze({
      status: 'duplicate' as const,
      relatedMemoryIds: relatedMemoryIds(input.relatedMemoryIds)
    })
  }
  if (discriminator.status !== 'conflict') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, ['status', 'relatedMemoryIds', 'note'])
  if (!memoryCanonicalTextWithinLimits(
    input.note,
    MEMORY_RESOURCE_LIMITS.reasonTextUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.reasonTextCodePoints
  ) || input.note.trim() === '') return invalidMemoryValue()
  return Object.freeze({
    status: 'conflict' as const,
    relatedMemoryIds: relatedMemoryIds(input.relatedMemoryIds),
    note: input.note
  })
}

function parseSubmissionResult (value: unknown): MemoryCandidateSubmissionResultV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['status'],
    ['outcome', 'proposalId', 'reason', 'retryable']
  )
  if (discriminator.status === 'stored' || discriminator.status === 'unchanged') {
    const input = inspectMemoryRecord(value, ['status', 'outcome', 'proposalId'])
    if ((input.outcome !== 'shadow' && input.outcome !== 'approved') ||
      typeof input.proposalId !== 'string' || !PROPOSAL_ID.test(input.proposalId)) {
      return invalidMemoryValue()
    }
    return Object.freeze({
      status: discriminator.status,
      outcome: input.outcome,
      proposalId: input.proposalId
    })
  }
  if (discriminator.status === 'denied') {
    const input = inspectMemoryRecord(value, ['status', 'reason'])
    if (input.reason !== 'policy' && input.reason !== 'scope' && input.reason !== 'authority') {
      return invalidMemoryValue()
    }
    return Object.freeze({ status: 'denied' as const, reason: input.reason })
  }
  if (discriminator.status === 'capacity') {
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status: 'capacity' as const })
  }
  if (discriminator.status === 'aborted') {
    inspectMemoryRecord(value, ['status'])
    return Object.freeze({ status: 'aborted' as const })
  }
  if (discriminator.status !== 'unavailable') return invalidMemoryValue()
  const input = inspectMemoryRecord(value, ['status', 'retryable'])
  if (typeof input.retryable !== 'boolean') return invalidMemoryValue()
  return Object.freeze({ status: 'unavailable' as const, retryable: input.retryable })
}

function parseSubmissionConflict (value: unknown): MemoryConflictV1 {
  const input = inspectMemoryRecord(value, ['state', 'relatedMemoryIds', 'note'])
  if (input.state !== 'none' && input.state !== 'possible') return invalidMemoryValue()
  const relatedMemoryIds = inspectMemoryArray(
    input.relatedMemoryIds,
    MEMORY_RESOURCE_LIMITS.conflictRefs
  ).map(item => {
    if (typeof item !== 'string' || !MEMORY_ID.test(item)) return invalidMemoryValue()
    return item
  })
  if (new Set(relatedMemoryIds).size !== relatedMemoryIds.length) return invalidMemoryValue()
  if (input.state === 'none') {
    if (relatedMemoryIds.length !== 0 || input.note !== null) return invalidMemoryValue()
    return Object.freeze({
      state: 'none' as const,
      relatedMemoryIds: Object.freeze([]),
      note: null
    })
  }
  if (relatedMemoryIds.length === 0 || !memoryCanonicalTextWithinLimits(
    input.note,
    MEMORY_RESOURCE_LIMITS.reasonTextUtf8Bytes,
    MEMORY_RESOURCE_LIMITS.reasonTextCodePoints
  ) || input.note.trim() === '') return invalidMemoryValue()
  return Object.freeze({
    state: 'possible' as const,
    relatedMemoryIds: Object.freeze(relatedMemoryIds),
    note: input.note
  })
}

export function parseMemoryCandidateSubmissionV1 (
  value: unknown
): MemoryCandidateSubmissionV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'job', 'candidate', 'provenance', 'conflict', 'extractorVersion',
    'extractorModelProfile', 'approvalMode', 'submittedAt'
  ])
  if (input.schemaVersion !== 1 ||
    (input.approvalMode !== 'shadow' && input.approvalMode !== 'policy_approved')) {
    return invalidMemoryValue()
  }
  const job = parseMemoryExtractionJobV1(input.job)
  const extracted = parseMemoryExtractorResultV1({
    schemaVersion: 1,
    status: 'candidates',
    extractorVersion: input.extractorVersion,
    modelProfile: input.extractorModelProfile,
    candidates: [input.candidate]
  }, job)
  if (extracted.status !== 'candidates') return invalidMemoryValue()
  const candidate = extracted.candidates[0]!
  const provenance = deriveMemoryCandidateProvenanceV1(job, candidate)
  if (memoryCandidateProvenanceHashV1(provenance) !==
    memoryCandidateProvenanceHashV1(input.provenance)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    job,
    candidate,
    provenance,
    conflict: parseSubmissionConflict(input.conflict),
    extractorVersion: extracted.extractorVersion,
    extractorModelProfile: extracted.modelProfile,
    approvalMode: input.approvalMode,
    submittedAt: parseMemoryLifecycleInstantV1(input.submittedAt)
  })
}

function conflictFor (classification: MemoryCandidateClassificationV1): MemoryConflictV1 {
  return classification.status === 'conflict'
    ? Object.freeze({
        state: 'possible' as const,
        relatedMemoryIds: classification.relatedMemoryIds,
        note: classification.note
      })
    : Object.freeze({ state: 'none' as const, relatedMemoryIds: Object.freeze([]), note: null })
}

function canAutomaticallyApprove (
  job: MemoryExtractionJobV1,
  candidate: MemoryExtractedCandidateV1,
  policy: Extract<MemoryCandidatePolicyDecisionV1, { readonly status: 'enabled' }>,
  classification: MemoryCandidateClassificationV1
): boolean {
  return job.requestedMode === 'automatic' && policy.mode === 'automatic' &&
    job.source.actor.userId === job.subject.userId && candidate.derivation === 'stated' &&
    candidate.confidence >= 0.85 && candidate.sensitivity !== 'sensitive' &&
    AUTOMATIC_KINDS.has(candidate.kind) && classification.status === 'distinct'
}

export function memoryCandidateSubmissionAllowsPolicyApprovalV1 (
  value: unknown
): boolean {
  const input = parseMemoryCandidateSubmissionV1(value)
  return input.job.requestedMode === 'automatic' &&
    input.job.source.actor.userId === input.job.subject.userId &&
    input.provenance.speakerRelation === 'self' &&
    input.candidate.derivation === 'stated' && input.provenance.derivation === 'stated' &&
    input.candidate.confidence >= 0.85 && input.candidate.sensitivity !== 'sensitive' &&
    AUTOMATIC_KINDS.has(input.candidate.kind) && input.conflict.state === 'none'
}

function auditId (
  jobId: string,
  candidateHash: string | null,
  outcome: MemoryCandidateAuditOutcomeV1,
  reasonCode: string,
  proposalId: string | null
): string {
  return createHash('sha256')
    .update('groupmate.memory.candidate-audit.v1', 'utf8')
    .update('\0')
    .update(JSON.stringify({ jobId, candidateHash, outcome, reasonCode, proposalId }), 'utf8')
    .digest('hex')
}

class CandidateRetryErrorV1 extends Error {
  readonly reasonCode: string

  constructor (reasonCode: string) {
    super(reasonCode)
    this.reasonCode = reasonCode
  }
}

class CandidateAbortErrorV1 extends Error {}
class CandidateTimeoutErrorV1 extends CandidateRetryErrorV1 {
  constructor () { super('extraction_timeout') }
}

function isAborted (signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function withTimeout<T> (
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal
): Promise<T> {
  if (isAborted(callerSignal)) throw new CandidateAbortErrorV1()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', onAbort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new CandidateTimeoutErrorV1())
      reject(new CandidateTimeoutErrorV1())
    }, MEMORY_CANDIDATE_EXTRACTION_TIMEOUT_MS_V1)
  })
  const operationPromise = Promise.resolve().then(async () => await operation(controller.signal))
  void operationPromise.catch(() => undefined)
  try {
    return await Promise.race([operationPromise, timeoutPromise])
  } catch (error) {
    if (isAborted(callerSignal)) throw new CandidateAbortErrorV1()
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', onAbort)
  }
}

function retryAt (now: string, attemptCount: number): string {
  const delay = RETRY_DELAYS_MS[attemptCount] ?? RETRY_DELAYS_MS.at(-1)!
  return new Date(Date.parse(now) + delay).toISOString()
}

export function createMemoryCandidateWorkerV1 (
  optionsValue: CreateMemoryCandidateWorkerOptionsV1
): MemoryCandidateWorkerV1 {
  const options = parseOptions(optionsValue)
  let running = false

  const recordAudit = async (input: {
    readonly job: MemoryExtractionJobV1
    readonly candidate: MemoryExtractedCandidateV1 | null
    readonly outcome: MemoryCandidateAuditOutcomeV1
    readonly reasonCode: string
    readonly proposalId: string | null
    readonly recordedAt: string
    readonly signal?: AbortSignal
  }): Promise<void> => {
    const provenance = input.candidate === null
      ? null
      : deriveMemoryCandidateProvenanceV1(input.job, input.candidate)
    const candidateHash = input.candidate === null
      ? null
      : memoryCandidateHashV1(input.job, input.candidate)
    const result = await options.queue.recordAudit({
      auditId: auditId(
        input.job.jobId,
        candidateHash,
        input.outcome,
        input.reasonCode,
        input.proposalId
      ),
      jobId: input.job.jobId,
      candidateHash,
      provenanceHash: provenance === null ? null : memoryCandidateProvenanceHashV1(provenance),
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      proposalId: input.proposalId,
      recordedAt: input.recordedAt
    }, input.signal)
    if (result.status === 'aborted') throw new CandidateAbortErrorV1()
    if (result.status === 'unavailable') throw new CandidateRetryErrorV1('audit_unavailable')
  }

  const processJob = async (
    jobValue: unknown,
    signal?: AbortSignal
  ): Promise<void> => {
    const job = parseMemoryExtractionJobV1(jobValue)
    await withTimeout(async boundedSignal => {
      const policy = parsePolicyDecision(await options.policy.decide(job, boundedSignal))
      const now = readNow(options.now)
      if (policy.status === 'disabled') {
        await recordAudit({
          job,
          candidate: null,
          outcome: 'no_op',
          reasonCode: `policy_${policy.reason}`,
          proposalId: null,
          recordedAt: now,
          signal: boundedSignal
        })
        return
      }
      const extracted = parseMemoryExtractorResultV1(
        await options.extractor.extract(job, boundedSignal),
        job
      )
      if (extracted.status === 'no_op') {
        await recordAudit({
          job,
          candidate: null,
          outcome: 'no_op',
          reasonCode: `extractor_${extracted.reason}`,
          proposalId: null,
          recordedAt: now,
          signal: boundedSignal
        })
        return
      }
      for (const candidate of extracted.candidates) {
        const valueRejection = memoryCandidateValueRejectionReasonV1(job, candidate)
        if (valueRejection !== null) {
          await recordAudit({
            job,
            candidate,
            outcome: 'rejected',
            reasonCode: valueRejection,
            proposalId: null,
            recordedAt: now,
            signal: boundedSignal
          })
          continue
        }
        const provenance = deriveMemoryCandidateProvenanceV1(job, candidate)
        const classification = parseClassification(await options.classifier.classify(
          Object.freeze({ job, candidate, provenance }),
          boundedSignal
        ))
        if (classification.status === 'duplicate') {
          await recordAudit({
            job,
            candidate,
            outcome: 'duplicate',
            reasonCode: 'existing_equivalent',
            proposalId: null,
            recordedAt: now,
            signal: boundedSignal
          })
          continue
        }
        const approvalMode = canAutomaticallyApprove(job, candidate, policy, classification)
          ? 'policy_approved' as const
          : 'shadow' as const
        const submission = Object.freeze({
          schemaVersion: 1 as const,
          job,
          candidate,
          provenance,
          conflict: conflictFor(classification),
          extractorVersion: extracted.extractorVersion,
          extractorModelProfile: extracted.modelProfile,
          approvalMode,
          submittedAt: now
        })
        const result = parseSubmissionResult(await options.sink.submit(submission, boundedSignal))
        if (result.status === 'aborted') throw new CandidateAbortErrorV1()
        if (result.status === 'capacity' || result.status === 'unavailable') {
          throw new CandidateRetryErrorV1(
            result.status === 'capacity' ? 'proposal_capacity' : 'proposal_unavailable'
          )
        }
        if (result.status === 'denied') {
          await recordAudit({
            job,
            candidate,
            outcome: 'rejected',
            reasonCode: `sink_${result.reason}`,
            proposalId: null,
            recordedAt: now,
            signal: boundedSignal
          })
          continue
        }
        const expectedOutcome = approvalMode === 'policy_approved' ? 'approved' : 'shadow'
        if (result.outcome !== expectedOutcome) {
          throw new CandidateRetryErrorV1('sink_contract')
        }
        await recordAudit({
          job,
          candidate,
          outcome: result.outcome === 'approved' ? 'approved' : 'shadow_stored',
          reasonCode: classification.status === 'conflict'
            ? 'possible_conflict'
            : 'admitted',
          proposalId: result.proposalId,
          recordedAt: now,
          signal: boundedSignal
        })
      }
    }, signal)
  }

  return Object.freeze({
    async runBatch (signal?: AbortSignal): Promise<MemoryCandidateWorkerBatchResultV1> {
      if (running) return emptyBatch('busy')
      if (isAborted(signal)) return emptyBatch('aborted')
      if (readRss(options.rssBytes) > MEMORY_CANDIDATE_WORKER_MAX_RSS_BYTES_V1) {
        return emptyBatch('resource_paused')
      }
      running = true
      try {
        const claim = await options.queue.claim(
          options.workerId,
          MEMORY_DERIVATIVE_RESOURCE_LIMITS.extractionWorkerBatchRecords,
          signal
        )
        if (claim.status === 'empty') return emptyBatch('idle')
        if (claim.status === 'aborted') return emptyBatch('aborted')
        if (claim.status === 'unavailable') return emptyBatch('unavailable')

        let completed = 0
        let retried = 0
        let deadLettered = 0
        for (let index = 0; index < claim.jobs.length; index += 1) {
          const job = claim.jobs[index]!
          const attemptCount = claim.attemptCounts[index]!
          const mutation = Object.freeze({
            ownerId: claim.ownerId,
            leaseToken: claim.leaseToken,
            jobId: job.jobId
          })
          try {
            if (isAborted(signal)) return emptyBatch('aborted', {
              claimed: claim.jobs.length, completed, retried, deadLettered
            })
            if (readRss(options.rssBytes) > MEMORY_CANDIDATE_WORKER_MAX_RSS_BYTES_V1) {
              throw new CandidateRetryErrorV1('rss_pressure')
            }
            await processJob(job, signal)
            const ack = await options.queue.ack(mutation, signal)
            if (ack.status !== 'acked') {
              if (ack.status === 'aborted') throw new CandidateAbortErrorV1()
              throw new CandidateRetryErrorV1('ack_unavailable')
            }
            completed += 1
          } catch (error) {
            if (error instanceof CandidateAbortErrorV1 || isAborted(signal)) {
              return emptyBatch('aborted', {
                claimed: claim.jobs.length, completed, retried, deadLettered
              })
            }
            const reasonCode = error instanceof CandidateRetryErrorV1
              ? error.reasonCode
              : 'adapter_contract'
            const now = readNow(options.now)
            const retry = await options.queue.retry({
              ...mutation,
              retryAt: retryAt(now, attemptCount),
              reasonCode
            })
            if (retry.status === 'retried') {
              retried += 1
              continue
            }
            if (retry.status === 'attempts_exhausted') {
              try {
                await recordAudit({
                  job,
                  candidate: null,
                  outcome: 'dead_letter',
                  reasonCode,
                  proposalId: null,
                  recordedAt: now
                })
              } catch (auditError) {
                if (auditError instanceof CandidateAbortErrorV1 || isAborted(signal)) {
                  return emptyBatch('aborted', {
                    claimed: claim.jobs.length, completed, retried, deadLettered
                  })
                }
                continue
              }
              const dead = await options.queue.deadLetter(mutation)
              if (dead.status === 'dead_lettered') deadLettered += 1
            }
          }
        }
        return emptyBatch('processed', {
          claimed: claim.jobs.length,
          completed,
          retried,
          deadLettered
        })
      } finally {
        running = false
      }
    }
  })
}

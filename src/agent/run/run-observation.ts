import { createHash } from 'node:crypto'
import { isAgentErrorCode, type AgentErrorCode } from '../contracts/error.js'
import type { CompletionDisposition } from '../contracts/completion.js'
import type { RunCheckpoint } from './run-checkpoint.js'
import { RUN_REF_PATTERN } from './run-reference.js'
import { isTerminalRunStatus, type TerminalRunStatus } from './run-state.js'
import type { ToolAttemptOutcome } from './tool-scheduler.js'

export type ObservationCount = number | 'unavailable' | 'not_attempted'

export const DURATION_BUCKET_BOUNDS_MS = Object.freeze([
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
  10_000,
  30_000,
  60_000,
  120_000,
  'inf'
] as const)

export interface DurationBucketCountsV1 {
  readonly count: number
  readonly sumMs: number
  readonly unavailableCount: number
  readonly le10: number
  readonly le25: number
  readonly le50: number
  readonly le100: number
  readonly le250: number
  readonly le500: number
  readonly le1000: number
  readonly le2500: number
  readonly le5000: number
  readonly le10000: number
  readonly le30000: number
  readonly le60000: number
  readonly le120000: number
  readonly inf: number
}

export interface RunTraceMetricSummaryV1 {
  readonly schemaVersion: 1
  readonly providerRequests: readonly {
    readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
    readonly attemptKind: 'primary' | 'retry' | 'recovery' | 'correction'
    readonly count: number
    readonly duration: DurationBucketCountsV1
  }[]
  readonly toolExecutions: readonly {
    readonly outcome: ToolAttemptOutcome
    readonly count: number
    readonly duration: DurationBucketCountsV1
  }[]
  readonly approvals: readonly {
    readonly decision: 'requested' | 'approved' | 'denied' | 'expired'
    readonly count: number
  }[]
}

export interface FrozenObservationPolicyV1 {
  readonly schemaVersion: 1
  readonly levelAtStart: 'off' | 'basic' | 'diagnostic'
  readonly sampledSuccess: boolean
}

export interface RunObservationCountersV1 {
  readonly schemaVersion: 1
  readonly providerAttempts: ObservationCount
  readonly modelTurns: ObservationCount
  readonly toolAttempts: ObservationCount
  readonly providerRetries: ObservationCount
  readonly recoveryAttempts: ObservationCount
  readonly correctionTurns: ObservationCount
  readonly toolCalls: ObservationCount
  readonly approvalRequests: ObservationCount
  readonly toolDenied: ObservationCount
  readonly toolExpired: ObservationCount
  readonly toolIndeterminate: ObservationCount
  readonly estimatedTokens: ObservationCount
  readonly providerInputTokens: ObservationCount
  readonly providerOutputTokens: ObservationCount
  readonly providerTotalTokens: ObservationCount
  readonly providerActiveDurationMs: ObservationCount
  readonly engineActiveDurationMs: ObservationCount
}

export type TextLengthBucket =
  | '1_40'
  | '41_200'
  | '201_1000'
  | '1001_4000'
  | 'over_4000'

export type CompletionObservation =
  | { readonly kind: 'reply_text'; readonly lengthBucket: TextLengthBucket }
  | { readonly kind: 'already_visible'; readonly source: 'tool_output' }
  | {
      readonly kind: 'allowed_silence'
      readonly reason: 'proactive_empty_directive'
    }
  | { readonly kind: 'none' }

export interface RunTerminalSnapshotV2 {
  readonly schemaVersion: 2
  readonly observationId: string
  readonly runRef: string
  readonly revision: number
  readonly status: TerminalRunStatus
  readonly finishedAt: string
  readonly completion: CompletionObservation
  readonly errorCode: AgentErrorCode | null
  readonly cancellationReason: string | null
  readonly counters: RunObservationCountersV1
  readonly engineDurationMs: ObservationCount
}

export type ProviderDispatchObservationV1 =
  | { readonly state: 'idle' }
  | { readonly state: 'reserved' }

export type EngineActivityObservationV1 =
  | { readonly state: 'idle' }
  | { readonly state: 'reserved' }

const COUNTER_KEYS = Object.freeze([
  'schemaVersion',
  'providerAttempts',
  'modelTurns',
  'toolAttempts',
  'providerRetries',
  'recoveryAttempts',
  'correctionTurns',
  'toolCalls',
  'approvalRequests',
  'toolDenied',
  'toolExpired',
  'toolIndeterminate',
  'estimatedTokens',
  'providerInputTokens',
  'providerOutputTokens',
  'providerTotalTokens',
  'providerActiveDurationMs',
  'engineActiveDurationMs'
])

const PROVIDER_USAGE_KEYS = new Set([
  'providerInputTokens',
  'providerOutputTokens',
  'providerTotalTokens'
])

const COMPLETION_BUCKETS: readonly TextLengthBucket[] = Object.freeze([
  '1_40', '41_200', '201_1000', '1001_4000', 'over_4000'
])
const TERMINAL_SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'observationId',
  'runRef',
  'revision',
  'status',
  'finishedAt',
  'completion',
  'errorCode',
  'cancellationReason',
  'counters',
  'engineDurationMs'
])
const TERMINAL_CANCELLATION_REASONS = new Set([
  'user_cancelled',
  'deadline_exceeded',
  'process_shutdown',
  'approval_delivery_failed',
  'service_failure',
  'fatal_error',
  'other'
])
const DURATION_BUCKET_KEYS = Object.freeze([
  'count',
  'sumMs',
  'unavailableCount',
  'le10',
  'le25',
  'le50',
  'le100',
  'le250',
  'le500',
  'le1000',
  'le2500',
  'le5000',
  'le10000',
  'le30000',
  'le60000',
  'le120000',
  'inf'
])
const DURATION_CUMULATIVE_KEYS = Object.freeze([
  'le10',
  'le25',
  'le50',
  'le100',
  'le250',
  'le500',
  'le1000',
  'le2500',
  'le5000',
  'le10000',
  'le30000',
  'le60000',
  'le120000',
  'inf'
] as const)
const METRIC_SUMMARY_KEYS = Object.freeze([
  'schemaVersion', 'providerRequests', 'toolExecutions', 'approvals'
])
const PROVIDER_METRIC_ROW_KEYS = Object.freeze([
  'outcome', 'attemptKind', 'count', 'duration'
])
const TOOL_METRIC_ROW_KEYS = Object.freeze([
  'outcome', 'count', 'duration'
])
const APPROVAL_METRIC_ROW_KEYS = Object.freeze([
  'decision', 'count'
])
const PROVIDER_METRIC_OUTCOMES = new Set([
  'succeeded', 'failed', 'cancelled', 'unknown'
])
const PROVIDER_ATTEMPT_KINDS = new Set([
  'primary', 'retry', 'recovery', 'correction'
])
const TOOL_METRIC_OUTCOMES = new Set<ToolAttemptOutcome>([
  'succeeded', 'failed', 'denied', 'indeterminate'
])
const APPROVAL_METRIC_DECISIONS = new Set([
  'requested', 'approved', 'denied', 'expired'
])

function record (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactOwnData (
  value: unknown,
  keys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const input = value as Record<PropertyKey, unknown>
  let actual: readonly PropertyKey[]
  try {
    actual = Reflect.ownKeys(input)
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  if (actual.length !== keys.length || actual.some(key => (
    typeof key !== 'string' || !keys.includes(key)
  ))) {
    throw new TypeError(`${label} keys are invalid`)
  }
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key)
    } catch {
      throw new TypeError(`${label} is invalid`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      throw new TypeError(`${label} field is invalid`)
    }
    output[key] = descriptor.value
  }
  return output
}

function exactKeys (
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  const missing = keys.find(key => !Object.hasOwn(value, key))
  if (unknown !== undefined) throw new TypeError(`${label} contains unknown key: ${unknown}`)
  if (missing !== undefined) throw new TypeError(`${label} key is missing: ${missing}`)
}

function exactOwnKeys (
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Reflect.ownKeys(value)
  const unknown = actual.find(key => typeof key !== 'string' || !keys.includes(key))
  const missing = keys.find(key => !Object.hasOwn(value, key))
  if (unknown !== undefined) throw new TypeError(`${label} contains unknown key`)
  if (missing !== undefined || actual.length !== keys.length) {
    throw new TypeError(`${label} key is missing`)
  }
}

function parseCount (
  value: unknown,
  key: string,
  allowNotAttempted: boolean
): ObservationCount {
  if (value === 'unavailable') return value
  if (allowNotAttempted && value === 'not_attempted') return value
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${key} observation count is invalid`)
  }
  return Number(value)
}

function nonNegativeSafeInteger (value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} is invalid`)
  }
  return Number(value)
}

function positiveSafeInteger (value: unknown, label: string): number {
  const parsed = nonNegativeSafeInteger(value, label)
  if (parsed === 0) throw new TypeError(`${label} is invalid`)
  return parsed
}

function exactArray (
  value: unknown,
  maximum: number,
  label: string
): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is invalid`)
  let keys: readonly PropertyKey[]
  let lengthDescriptor: PropertyDescriptor | undefined
  try {
    keys = Reflect.ownKeys(value)
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  const length = lengthDescriptor?.value
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum ||
    keys.length !== Number(length) + 1 || !keys.includes('length')) {
    throw new TypeError(`${label} is invalid`)
  }
  return Object.freeze(Array.from({ length: Number(length) }, (_, index) => {
    const key = String(index)
    if (!keys.includes(key)) throw new TypeError(`${label} is sparse`)
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new TypeError(`${label} is invalid`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      throw new TypeError(`${label} item is invalid`)
    }
    return descriptor.value
  }))
}

function assertSortedUnique (
  values: readonly string[],
  label: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] ?? '') >= (values[index] ?? '')) {
      throw new TypeError(`${label} order is invalid`)
    }
  }
}

export function parseDurationBucketCounts (
  value: unknown
): DurationBucketCountsV1 {
  const input = exactOwnData(value, DURATION_BUCKET_KEYS, 'duration bucket counts')
  const count = nonNegativeSafeInteger(input.count, 'duration count')
  const sumMs = nonNegativeSafeInteger(input.sumMs, 'duration sum')
  const unavailableCount = nonNegativeSafeInteger(
    input.unavailableCount,
    'duration unavailable count'
  )
  if (count === 0 && sumMs !== 0) {
    throw new TypeError('duration sum requires a measured sample')
  }
  let previous = 0
  const cumulative = Object.fromEntries(DURATION_CUMULATIVE_KEYS.map(key => {
    const current = nonNegativeSafeInteger(input[key], `duration ${key}`)
    if (current < previous || current > count) {
      throw new TypeError('duration cumulative buckets are invalid')
    }
    previous = current
    return [key, current]
  })) as Pick<DurationBucketCountsV1, typeof DURATION_CUMULATIVE_KEYS[number]>
  if (cumulative.inf !== count) {
    throw new TypeError('duration infinity bucket is invalid')
  }
  return Object.freeze({
    count,
    sumMs,
    unavailableCount,
    ...cumulative
  })
}

export function parseRunTraceMetricSummary (
  value: unknown
): RunTraceMetricSummaryV1 {
  const input = exactOwnData(value, METRIC_SUMMARY_KEYS, 'run trace metric summary')
  if (input.schemaVersion !== 1) {
    throw new TypeError('run trace metric summary schema is invalid')
  }

  const providerRequests = Object.freeze(exactArray(
    input.providerRequests,
    16,
    'provider metric rows'
  ).map(value => {
    const row = exactOwnData(value, PROVIDER_METRIC_ROW_KEYS, 'provider metric row')
    if (typeof row.outcome !== 'string' || !PROVIDER_METRIC_OUTCOMES.has(row.outcome) ||
      typeof row.attemptKind !== 'string' || !PROVIDER_ATTEMPT_KINDS.has(row.attemptKind)) {
      throw new TypeError('provider metric row fields are invalid')
    }
    const count = positiveSafeInteger(row.count, 'provider metric count')
    const duration = parseDurationBucketCounts(row.duration)
    if (duration.count + duration.unavailableCount !== count) {
      throw new TypeError('provider metric duration count is invalid')
    }
    return Object.freeze({
      outcome: row.outcome as RunTraceMetricSummaryV1['providerRequests'][number]['outcome'],
      attemptKind: row.attemptKind as RunTraceMetricSummaryV1['providerRequests'][number]['attemptKind'],
      count,
      duration
    })
  }))
  assertSortedUnique(
    providerRequests.map(row => `${row.outcome}\0${row.attemptKind}`),
    'provider metric rows'
  )

  const toolExecutions = Object.freeze(exactArray(
    input.toolExecutions,
    4,
    'tool metric rows'
  ).map(value => {
    const row = exactOwnData(value, TOOL_METRIC_ROW_KEYS, 'tool metric row')
    if (typeof row.outcome !== 'string' ||
      !TOOL_METRIC_OUTCOMES.has(row.outcome as ToolAttemptOutcome)) {
      throw new TypeError('tool metric row fields are invalid')
    }
    const count = positiveSafeInteger(row.count, 'tool metric count')
    const duration = parseDurationBucketCounts(row.duration)
    if (duration.count + duration.unavailableCount !== count) {
      throw new TypeError('tool metric duration count is invalid')
    }
    return Object.freeze({
      outcome: row.outcome as ToolAttemptOutcome,
      count,
      duration
    })
  }))
  assertSortedUnique(
    toolExecutions.map(row => row.outcome),
    'tool metric rows'
  )

  const approvals = Object.freeze(exactArray(
    input.approvals,
    4,
    'approval metric rows'
  ).map(value => {
    const row = exactOwnData(value, APPROVAL_METRIC_ROW_KEYS, 'approval metric row')
    if (typeof row.decision !== 'string' || !APPROVAL_METRIC_DECISIONS.has(row.decision)) {
      throw new TypeError('approval metric row fields are invalid')
    }
    return Object.freeze({
      decision: row.decision as RunTraceMetricSummaryV1['approvals'][number]['decision'],
      count: positiveSafeInteger(row.count, 'approval metric count')
    })
  }))
  assertSortedUnique(
    approvals.map(row => row.decision),
    'approval metric rows'
  )

  return Object.freeze({
    schemaVersion: 1,
    providerRequests,
    toolExecutions,
    approvals
  })
}

export function createFrozenObservationPolicy (input: {
  readonly levelAtStart: 'off' | 'basic' | 'diagnostic'
  readonly runRef: string
}): FrozenObservationPolicyV1 {
  if (!['off', 'basic', 'diagnostic'].includes(input.levelAtStart)) {
    throw new TypeError('observation level is invalid')
  }
  if (typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef)) {
    throw new TypeError('run reference is invalid')
  }
  let sampledSuccess = false
  if (input.levelAtStart !== 'off') {
    const hash = createHash('sha256')
      .update(`groupmate:success:v1:${input.runRef}`, 'ascii')
      .digest()
    sampledSuccess = hash.readUInt32BE(0) % 100 < 5
  }
  return Object.freeze({
    schemaVersion: 1,
    levelAtStart: input.levelAtStart,
    sampledSuccess
  })
}

export function parseFrozenObservationPolicy (
  value: unknown
): FrozenObservationPolicyV1 {
  const policy = record(value, 'observation policy')
  exactKeys(
    policy,
    ['schemaVersion', 'levelAtStart', 'sampledSuccess'],
    'observation policy'
  )
  if (policy.schemaVersion !== 1 ||
    (policy.levelAtStart !== 'off' && policy.levelAtStart !== 'basic' &&
      policy.levelAtStart !== 'diagnostic') ||
    typeof policy.sampledSuccess !== 'boolean' ||
    (policy.levelAtStart === 'off' && policy.sampledSuccess)) {
    throw new TypeError('observation policy is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    levelAtStart: policy.levelAtStart as FrozenObservationPolicyV1['levelAtStart'],
    sampledSuccess: policy.sampledSuccess
  })
}

export function createInitialRunObservationCounters (): RunObservationCountersV1 {
  return Object.freeze({
    schemaVersion: 1,
    providerAttempts: 0,
    modelTurns: 0,
    toolAttempts: 0,
    providerRetries: 0,
    recoveryAttempts: 0,
    correctionTurns: 0,
    toolCalls: 0,
    approvalRequests: 0,
    toolDenied: 0,
    toolExpired: 0,
    toolIndeterminate: 0,
    estimatedTokens: 0,
    providerInputTokens: 'not_attempted',
    providerOutputTokens: 'not_attempted',
    providerTotalTokens: 'not_attempted',
    providerActiveDurationMs: 0,
    engineActiveDurationMs: 0
  })
}

export function parseRunObservationCounters (
  value: unknown
): RunObservationCountersV1 {
  const counters = record(value, 'run observation counters')
  exactKeys(counters, COUNTER_KEYS, 'run observation counters')
  if (counters.schemaVersion !== 1) {
    throw new TypeError('run observation counters schema version is invalid')
  }
  const parsed: Record<string, ObservationCount> = {}
  for (const key of COUNTER_KEYS.slice(1)) {
    parsed[key] = parseCount(counters[key], key, PROVIDER_USAGE_KEYS.has(key))
  }
  return Object.freeze({
    schemaVersion: 1,
    providerAttempts: parsed.providerAttempts,
    modelTurns: parsed.modelTurns,
    toolAttempts: parsed.toolAttempts,
    providerRetries: parsed.providerRetries,
    recoveryAttempts: parsed.recoveryAttempts,
    correctionTurns: parsed.correctionTurns,
    toolCalls: parsed.toolCalls,
    approvalRequests: parsed.approvalRequests,
    toolDenied: parsed.toolDenied,
    toolExpired: parsed.toolExpired,
    toolIndeterminate: parsed.toolIndeterminate,
    estimatedTokens: parsed.estimatedTokens,
    providerInputTokens: parsed.providerInputTokens,
    providerOutputTokens: parsed.providerOutputTokens,
    providerTotalTokens: parsed.providerTotalTokens,
    providerActiveDurationMs: parsed.providerActiveDurationMs,
    engineActiveDurationMs: parsed.engineActiveDurationMs
  }) as RunObservationCountersV1
}

export function terminalObservationId (
  runRef: string,
  revision: number
): string {
  if (typeof runRef !== 'string' || !RUN_REF_PATTERN.test(runRef)) {
    throw new TypeError('terminal observation run reference is invalid')
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('terminal observation revision is invalid')
  }
  return createHash('sha256')
    .update(`groupmate:terminal:v2\0${runRef}\0${revision}`, 'utf8')
    .digest('hex')
}

export function parseCompletionObservation (
  value: unknown
): CompletionObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('completion observation is invalid')
  }
  const input = value as Record<PropertyKey, unknown>
  if (input.kind === 'reply_text') {
    exactOwnKeys(input, ['kind', 'lengthBucket'], 'completion observation')
    if (!COMPLETION_BUCKETS.includes(input.lengthBucket as TextLengthBucket)) {
      throw new TypeError('completion observation length bucket is invalid')
    }
    return Object.freeze({
      kind: 'reply_text',
      lengthBucket: input.lengthBucket as TextLengthBucket
    })
  }
  if (input.kind === 'already_visible') {
    exactOwnKeys(input, ['kind', 'source'], 'completion observation')
    if (input.source !== 'tool_output') {
      throw new TypeError('completion observation source is invalid')
    }
    return Object.freeze({ kind: 'already_visible', source: 'tool_output' })
  }
  if (input.kind === 'allowed_silence') {
    exactOwnKeys(input, ['kind', 'reason'], 'completion observation')
    if (input.reason !== 'proactive_empty_directive') {
      throw new TypeError('completion observation reason is invalid')
    }
    return Object.freeze({
      kind: 'allowed_silence',
      reason: 'proactive_empty_directive'
    })
  }
  if (input.kind === 'none') {
    exactOwnKeys(input, ['kind'], 'completion observation')
    return Object.freeze({ kind: 'none' })
  }
  throw new TypeError('completion observation kind is invalid')
}

function textLengthBucket (text: string): TextLengthBucket {
  const length = [...text].length
  if (length <= 40) return '1_40'
  if (length <= 200) return '41_200'
  if (length <= 1_000) return '201_1000'
  if (length <= 4_000) return '1001_4000'
  return 'over_4000'
}

function completionObservation (
  completion: CompletionDisposition | null
): CompletionObservation {
  if (completion === null) return Object.freeze({ kind: 'none' })
  if (completion.kind === 'reply_text') {
    return Object.freeze({
      kind: 'reply_text',
      lengthBucket: textLengthBucket(completion.text)
    })
  }
  if (completion.kind === 'already_visible') {
    return Object.freeze({ kind: 'already_visible', source: 'tool_output' })
  }
  return Object.freeze({
    kind: 'allowed_silence',
    reason: 'proactive_empty_directive'
  })
}

function terminalCancellationReason (value: string | null): string | null {
  if (value === null) return null
  return TERMINAL_CANCELLATION_REASONS.has(value) ? value : 'other'
}

export function parseRunTerminalSnapshot (
  value: unknown
): RunTerminalSnapshotV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('run terminal snapshot is invalid')
  }
  const input = value as Record<PropertyKey, unknown>
  exactOwnKeys(input, TERMINAL_SNAPSHOT_KEYS, 'run terminal snapshot')
  if (input.schemaVersion !== 2 ||
    typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef) ||
    !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 ||
    typeof input.status !== 'string' ||
    !isTerminalRunStatus(input.status as TerminalRunStatus) ||
    typeof input.finishedAt !== 'string') {
    throw new TypeError('run terminal snapshot fields are invalid')
  }
  try {
    if (new Date(input.finishedAt).toISOString() !== input.finishedAt) {
      throw new TypeError('run terminal snapshot timestamp is invalid')
    }
  } catch {
    throw new TypeError('run terminal snapshot timestamp is invalid')
  }
  const revision = Number(input.revision)
  if (input.observationId !== terminalObservationId(input.runRef, revision)) {
    throw new TypeError('run terminal snapshot observation ID is invalid')
  }
  const completion = parseCompletionObservation(input.completion)
  if (input.errorCode !== null && !isAgentErrorCode(input.errorCode)) {
    throw new TypeError('run terminal snapshot error code is invalid')
  }
  if (input.cancellationReason !== null &&
    (typeof input.cancellationReason !== 'string' ||
      !TERMINAL_CANCELLATION_REASONS.has(input.cancellationReason))) {
    throw new TypeError('run terminal snapshot cancellation reason is invalid')
  }
  if (input.status === 'completed') {
    if (completion.kind === 'none' || input.errorCode !== null ||
      input.cancellationReason !== null) {
      throw new TypeError('run terminal snapshot completed matrix is invalid')
    }
  } else if (input.status === 'failed') {
    if (completion.kind !== 'none' || input.errorCode === null ||
      input.cancellationReason !== null) {
      throw new TypeError('run terminal snapshot failed matrix is invalid')
    }
  } else if (completion.kind !== 'none' || input.errorCode !== null ||
    input.cancellationReason === null) {
    throw new TypeError('run terminal snapshot cancelled matrix is invalid')
  }
  const counters = parseRunObservationCounters(input.counters)
  if (input.engineDurationMs === 'not_attempted' ||
    input.engineDurationMs !== counters.engineActiveDurationMs) {
    throw new TypeError('run terminal snapshot engine duration is invalid')
  }
  return Object.freeze({
    schemaVersion: 2,
    observationId: input.observationId as string,
    runRef: input.runRef,
    revision,
    status: input.status as TerminalRunStatus,
    finishedAt: input.finishedAt,
    completion,
    errorCode: input.errorCode as AgentErrorCode | null,
    cancellationReason: input.cancellationReason as string | null,
    counters,
    engineDurationMs: input.engineDurationMs as ObservationCount
  })
}

export function createRunTerminalSnapshot (
  checkpoint: RunCheckpoint
): RunTerminalSnapshotV2 {
  if (!isTerminalRunStatus(checkpoint.status)) {
    throw new TypeError('terminal checkpoint is required')
  }
  if (checkpoint.providerDispatch.state !== 'idle' ||
    checkpoint.engineActivity.state !== 'idle') {
    throw new TypeError('terminal checkpoint contains a reservation')
  }
  return parseRunTerminalSnapshot({
    schemaVersion: 2,
    observationId: terminalObservationId(checkpoint.runRef, checkpoint.revision),
    runRef: checkpoint.runRef,
    revision: checkpoint.revision,
    status: checkpoint.status,
    finishedAt: checkpoint.updatedAt,
    completion: completionObservation(checkpoint.completion),
    errorCode: checkpoint.error?.code ?? null,
    cancellationReason: terminalCancellationReason(checkpoint.cancellationReason),
    counters: checkpoint.observationCounters,
    engineDurationMs: checkpoint.observationCounters.engineActiveDurationMs
  })
}

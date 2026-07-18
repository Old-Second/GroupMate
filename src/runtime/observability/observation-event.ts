import { randomBytes as nodeRandomBytes } from 'node:crypto'
import type { TrustedRequestKind } from '../../agent/contracts/interaction.js'
import {
  parseRunTerminalSnapshot,
  type ObservationCount,
  type RunTerminalSnapshotV2,
  type TextLengthBucket
} from '../../agent/run/run-observation.js'
import {
  parseTerminalCommitReceipt,
  type TerminalCommitReceiptV1
} from '../../agent/run/run-store.js'
import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js'
import {
  type DeliveryErrorCode,
  type PresentationDeliveryMedia,
  type PresentationResult
} from '../presentation/presentation-result.js'
import {
  parseRequestObservation,
  type RequestObservationV1
} from '../request-observation.js'

type UnknownRecord = Record<PropertyKey, unknown>

export type PresentationFallbackReasonV1 =
  | 'none'
  | 'profile_restricted'
  | 'postprocess_empty'
  | 'media_disabled'
  | 'media_unsupported'
  | 'content_too_large'
  | 'render_failed'
  | 'synthesis_failed'
  | 'delivery_definite_failure'
  | 'delivery_unknown'

export interface PresentationReducerInputV1 {
  readonly schemaVersion: 1
  readonly reducerVersion: 1
  readonly requestKind: TrustedRequestKind | 'recovered_legacy_plain_text'
  readonly profile: 'ordinary' | 'proactive' | 'recovered_legacy_plain_text' | 'progress'
  readonly textLengthBucket: TextLengthBucket | 'none'
  readonly hasReasoning: boolean
  readonly hasCitation: boolean
  readonly buttonsEligible: boolean
  readonly ttsEligibility: 'eligible' | 'disabled' | 'unsupported'
  readonly pictureEligibility: 'eligible' | 'disabled' | 'unsupported'
  readonly quotePolicy: 'none' | 'current_request' | 'citation_forward'
  readonly selectedMode: 'text' | 'picture' | 'tts' | 'forward' | 'silent'
  readonly fallbackReason: PresentationFallbackReasonV1
  readonly configEnumVersion: 1
}

export type SafeDeliveryObservationV1 =
  | {
      readonly schemaVersion: 1
      readonly media: PresentationDeliveryMedia
      readonly attempt: 1 | 2
      readonly outcome: 'sent'
      readonly code: null
    }
  | {
      readonly schemaVersion: 1
      readonly media: PresentationDeliveryMedia
      readonly attempt: 1 | 2
      readonly outcome: 'failed_definite'
      readonly code: DeliveryErrorCode
    }
  | {
      readonly schemaVersion: 1
      readonly media: PresentationDeliveryMedia
      readonly attempt: 1 | 2
      readonly outcome: 'outcome_unknown'
      readonly code: DeliveryErrorCode
    }

export interface PresentationObservationV1 {
  readonly schemaVersion: 1
  readonly presentationObservationId: string
  readonly runRef: string | 'unavailable'
  readonly terminalObservationId: string | 'unavailable' | 'not_attempted'
  readonly profile: PresentationReducerInputV1['profile']
  readonly outcome: PresentationResult['outcome']
  readonly postprocessAnomaly: boolean
  readonly deliveries: readonly SafeDeliveryObservationV1[]
  readonly totalDurationMs: ObservationCount
  readonly reducerInput: PresentationReducerInputV1
}

export type ObservationEventV1 =
  | { readonly schemaVersion: 1; readonly type: 'request'; readonly value: RequestObservationV1 }
  | { readonly schemaVersion: 1; readonly type: 'terminal_snapshot'; readonly value: RunTerminalSnapshotV2 }
  | { readonly schemaVersion: 1; readonly type: 'terminal_commit'; readonly value: TerminalCommitReceiptV1 }
  | { readonly schemaVersion: 1; readonly type: 'presentation'; readonly value: PresentationObservationV1 }

export const MAX_PRESENTATION_DELIVERY_OBSERVATIONS = 12

const OBSERVATION_ID_PATTERN = /^[0-9a-f]{64}$/
const EVENT_KEYS = Object.freeze(['schemaVersion', 'type', 'value'])
const REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'runRef',
  'requestRef',
  'requestKind',
  'outcome',
  'admissionRejectionReason',
  'queueDurationMs',
  'sessionLoadDurationMs',
  'sessionSaveDurationMs',
  'requestDurationMs',
  'terminalObservationId'
])
const SNAPSHOT_KEYS = Object.freeze([
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
const SNAPSHOT_COUNTER_KEYS = Object.freeze([
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
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'observationId',
  'runRef',
  'revision',
  'deletedKeyCount',
  'createdKeyCount',
  'checkpointBytesDeleted',
  'eventBytesDeleted',
  'tombstoneBytes'
])
const PRESENTATION_KEYS = Object.freeze([
  'schemaVersion',
  'presentationObservationId',
  'runRef',
  'terminalObservationId',
  'profile',
  'outcome',
  'postprocessAnomaly',
  'deliveries',
  'totalDurationMs',
  'reducerInput'
])
const REDUCER_KEYS = Object.freeze([
  'schemaVersion',
  'reducerVersion',
  'requestKind',
  'profile',
  'textLengthBucket',
  'hasReasoning',
  'hasCitation',
  'buttonsEligible',
  'ttsEligibility',
  'pictureEligibility',
  'quotePolicy',
  'selectedMode',
  'fallbackReason',
  'configEnumVersion'
])
const DELIVERY_KEYS = Object.freeze([
  'schemaVersion', 'media', 'attempt', 'outcome', 'code'
])
const PRESENTATION_PROFILES = new Set<PresentationReducerInputV1['profile']>([
  'ordinary', 'proactive', 'recovered_legacy_plain_text', 'progress'
])
const PRESENTATION_OUTCOMES = new Set<PresentationResult['outcome']>([
  'complete', 'partial', 'failed', 'unknown', 'skipped'
])
const REQUEST_KINDS = new Set<PresentationReducerInputV1['requestKind']>([
  'ordinary_chat', 'proactive_chat', 'recovered_legacy_plain_text'
])
const TEXT_LENGTH_BUCKETS = new Set<PresentationReducerInputV1['textLengthBucket']>([
  'none', '1_40', '41_200', '201_1000', '1001_4000', 'over_4000'
])
const ELIGIBILITY = new Set<PresentationReducerInputV1['ttsEligibility']>([
  'eligible', 'disabled', 'unsupported'
])
const QUOTE_POLICIES = new Set<PresentationReducerInputV1['quotePolicy']>([
  'none', 'current_request', 'citation_forward'
])
const SELECTED_MODES = new Set<PresentationReducerInputV1['selectedMode']>([
  'text', 'picture', 'tts', 'forward', 'silent'
])
const FALLBACK_REASONS = new Set<PresentationFallbackReasonV1>([
  'none',
  'profile_restricted',
  'postprocess_empty',
  'media_disabled',
  'media_unsupported',
  'content_too_large',
  'render_failed',
  'synthesis_failed',
  'delivery_definite_failure',
  'delivery_unknown'
])
const DELIVERY_MEDIA = new Set<PresentationDeliveryMedia>([
  'text', 'picture', 'voice', 'forward'
])
const DELIVERY_OUTCOMES = new Set<SafeDeliveryObservationV1['outcome']>([
  'sent', 'failed_definite', 'outcome_unknown'
])
const DELIVERY_ERROR_CODES = new Set<DeliveryErrorCode>([
  'invalid_target',
  'invalid_part',
  'aborted_before_dispatch',
  'host_rejected',
  'host_exception_after_dispatch',
  'host_timeout_after_dispatch',
  'host_abort_after_dispatch',
  'unknown_host_result'
])

function record (value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as UnknownRecord
}

function exactData (
  value: unknown,
  keys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  const input = record(value, label)
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
      throw new TypeError(`${label} property is invalid`)
    }
    output[key] = descriptor.value
  }
  return output
}

function exactDataArray (
  value: unknown,
  maxLength: number,
  label: string
): readonly unknown[] {
  let array: unknown[]
  try {
    if (!Array.isArray(value)) throw new TypeError(`${label} is invalid`)
    array = value
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  let actual: readonly PropertyKey[]
  let lengthDescriptor: PropertyDescriptor | undefined
  try {
    actual = Reflect.ownKeys(array)
    lengthDescriptor = Object.getOwnPropertyDescriptor(array, 'length')
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maxLength) {
    throw new TypeError(`${label} length is invalid`)
  }
  const length = Number(lengthDescriptor.value)
  const expected = Object.freeze([
    ...Array.from({ length }, (_, index) => String(index)),
    'length'
  ])
  if (actual.length !== expected.length || actual.some(key => (
    typeof key !== 'string' || !expected.includes(key)
  ))) {
    throw new TypeError(`${label} keys are invalid`)
  }
  const output: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(array, String(index))
    } catch {
      throw new TypeError(`${label} is invalid`)
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      throw new TypeError(`${label} item is invalid`)
    }
    output.push(descriptor.value)
  }
  return Object.freeze(output)
}

function safeCompletion (value: unknown): Readonly<Record<string, unknown>> {
  const base = exactDataByDiscriminator(value, 'kind', [
    ['reply_text', ['kind', 'lengthBucket']],
    ['already_visible', ['kind', 'source']],
    ['allowed_silence', ['kind', 'reason']],
    ['none', ['kind']]
  ], 'completion observation')
  return base
}

function exactDataByDiscriminator (
  value: unknown,
  discriminator: string,
  variants: readonly (readonly [string, readonly string[]])[],
  label: string
): Readonly<Record<string, unknown>> {
  const input = record(value, label)
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, discriminator)
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${label} discriminator is invalid`)
  }
  const variant = variants.find(([kind]) => descriptor?.value === kind)
  if (variant === undefined) throw new TypeError(`${label} discriminator is invalid`)
  return exactData(value, variant[1], label)
}

function safeRequest (value: unknown): RequestObservationV1 {
  return parseRequestObservation(exactData(value, REQUEST_KEYS, 'request observation'))
}

function safeSnapshot (value: unknown): RunTerminalSnapshotV2 {
  const input = exactData(value, SNAPSHOT_KEYS, 'run terminal snapshot')
  return parseRunTerminalSnapshot({
    ...input,
    completion: safeCompletion(input.completion),
    counters: exactData(
      input.counters,
      SNAPSHOT_COUNTER_KEYS,
      'run observation counters'
    )
  })
}

function safeReceipt (value: unknown): TerminalCommitReceiptV1 {
  return parseTerminalCommitReceipt(exactData(
    value,
    RECEIPT_KEYS,
    'terminal commit receipt'
  ))
}

function parseObservationCount (value: unknown): ObservationCount {
  if (value === 'unavailable') return value
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError('presentation duration is invalid')
  }
  return Number(value)
}

function parseReducerInput (value: unknown): PresentationReducerInputV1 {
  const input = exactData(value, REDUCER_KEYS, 'presentation reducer input')
  if (input.schemaVersion !== 1 || input.reducerVersion !== 1 ||
    input.configEnumVersion !== 1 ||
    typeof input.requestKind !== 'string' ||
    !REQUEST_KINDS.has(input.requestKind as PresentationReducerInputV1['requestKind']) ||
    typeof input.profile !== 'string' ||
    !PRESENTATION_PROFILES.has(input.profile as PresentationReducerInputV1['profile']) ||
    typeof input.textLengthBucket !== 'string' ||
    !TEXT_LENGTH_BUCKETS.has(input.textLengthBucket as PresentationReducerInputV1['textLengthBucket']) ||
    typeof input.hasReasoning !== 'boolean' ||
    typeof input.hasCitation !== 'boolean' ||
    typeof input.buttonsEligible !== 'boolean' ||
    typeof input.ttsEligibility !== 'string' ||
    !ELIGIBILITY.has(input.ttsEligibility as PresentationReducerInputV1['ttsEligibility']) ||
    typeof input.pictureEligibility !== 'string' ||
    !ELIGIBILITY.has(input.pictureEligibility as PresentationReducerInputV1['pictureEligibility']) ||
    typeof input.quotePolicy !== 'string' ||
    !QUOTE_POLICIES.has(input.quotePolicy as PresentationReducerInputV1['quotePolicy']) ||
    typeof input.selectedMode !== 'string' ||
    !SELECTED_MODES.has(input.selectedMode as PresentationReducerInputV1['selectedMode']) ||
    typeof input.fallbackReason !== 'string' ||
    !FALLBACK_REASONS.has(input.fallbackReason as PresentationFallbackReasonV1)) {
    throw new TypeError('presentation reducer input fields are invalid')
  }
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    reducerVersion: 1 as const,
    requestKind: input.requestKind as PresentationReducerInputV1['requestKind'],
    profile: input.profile as PresentationReducerInputV1['profile'],
    textLengthBucket: input.textLengthBucket as PresentationReducerInputV1['textLengthBucket'],
    hasReasoning: input.hasReasoning,
    hasCitation: input.hasCitation,
    buttonsEligible: input.buttonsEligible,
    ttsEligibility: input.ttsEligibility as PresentationReducerInputV1['ttsEligibility'],
    pictureEligibility: input.pictureEligibility as PresentationReducerInputV1['pictureEligibility'],
    quotePolicy: input.quotePolicy as PresentationReducerInputV1['quotePolicy'],
    selectedMode: input.selectedMode as PresentationReducerInputV1['selectedMode'],
    fallbackReason: input.fallbackReason as PresentationFallbackReasonV1,
    configEnumVersion: 1 as const
  })
  validateReducerMatrix(parsed)
  return parsed
}

function validateReducerMatrix (value: PresentationReducerInputV1): void {
  const profileMatches = value.profile === 'ordinary'
    ? value.requestKind === 'ordinary_chat'
    : value.profile === 'proactive'
      ? value.requestKind === 'proactive_chat'
      : value.profile === 'recovered_legacy_plain_text'
        ? value.requestKind === 'recovered_legacy_plain_text'
        : true
  if (!profileMatches) throw new TypeError('presentation reducer profile matrix is invalid')
  if (value.profile !== 'progress') return
  if ((value.textLengthBucket !== '1_40' && value.textLengthBucket !== '41_200') ||
    value.hasReasoning || value.hasCitation || value.buttonsEligible ||
    value.ttsEligibility !== 'disabled' || value.pictureEligibility !== 'disabled' ||
    value.quotePolicy !== 'none' || value.selectedMode !== 'text' ||
    value.fallbackReason !== 'none') {
    throw new TypeError('progress presentation reducer matrix is invalid')
  }
}

function parseDelivery (value: unknown): SafeDeliveryObservationV1 {
  const input = exactData(value, DELIVERY_KEYS, 'safe delivery observation')
  if (input.schemaVersion !== 1 || typeof input.media !== 'string' ||
    !DELIVERY_MEDIA.has(input.media as PresentationDeliveryMedia) ||
    (input.attempt !== 1 && input.attempt !== 2) ||
    typeof input.outcome !== 'string' ||
    !DELIVERY_OUTCOMES.has(input.outcome as SafeDeliveryObservationV1['outcome'])) {
    throw new TypeError('safe delivery observation fields are invalid')
  }
  if (input.outcome === 'sent') {
    if (input.code !== null) throw new TypeError('sent delivery code is invalid')
    return Object.freeze({
      schemaVersion: 1,
      media: input.media as PresentationDeliveryMedia,
      attempt: input.attempt,
      outcome: 'sent',
      code: null
    })
  }
  if (typeof input.code !== 'string' ||
    !DELIVERY_ERROR_CODES.has(input.code as DeliveryErrorCode)) {
    throw new TypeError('failed delivery code is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    media: input.media as PresentationDeliveryMedia,
    attempt: input.attempt,
    outcome: input.outcome as 'failed_definite' | 'outcome_unknown',
    code: input.code as DeliveryErrorCode
  })
}

function validatePresentationCorrelation (
  runRef: PresentationObservationV1['runRef'],
  terminalObservationId: PresentationObservationV1['terminalObservationId'],
  profile: PresentationObservationV1['profile']
): void {
  const hasRun = runRef !== 'unavailable'
  if (hasRun && !RUN_REF_PATTERN.test(runRef)) {
    throw new TypeError('presentation run reference is invalid')
  }
  const hasTerminal = terminalObservationId !== 'unavailable' &&
    terminalObservationId !== 'not_attempted'
  if (hasTerminal && !OBSERVATION_ID_PATTERN.test(terminalObservationId)) {
    throw new TypeError('presentation terminal observation ID is invalid')
  }
  if (profile === 'progress') {
    if (!hasRun || terminalObservationId !== 'not_attempted') {
      throw new TypeError('progress presentation correlation is invalid')
    }
    return
  }
  if ((!hasRun && terminalObservationId !== 'not_attempted') ||
    (hasRun && terminalObservationId === 'not_attempted')) {
    throw new TypeError('final presentation correlation is invalid')
  }
}

function hasPreDispatchTtsDeliveryShape (
  deliveries: readonly SafeDeliveryObservationV1[]
): boolean {
  let index = 0
  if (deliveries[index]?.media === 'forward') index += 1
  if (deliveries[index]?.media !== 'text') return false
  index += 1
  if (deliveries[index]?.media === 'forward') index += 1
  let trailingTexts = 0
  while (deliveries[index]?.media === 'text' && trailingTexts < 2) {
    trailingTexts += 1
    index += 1
  }
  return index === deliveries.length && deliveries.every(delivery => delivery.outcome === 'sent')
}

function isPreDispatchTtsSynthesisPartial (
  deliveries: readonly SafeDeliveryObservationV1[],
  reducerInput: PresentationReducerInputV1
): boolean {
  return reducerInput.requestKind === 'ordinary_chat' &&
    reducerInput.profile === 'ordinary' &&
    reducerInput.ttsEligibility === 'eligible' &&
    reducerInput.selectedMode === 'text' &&
    reducerInput.fallbackReason === 'synthesis_failed' &&
    hasPreDispatchTtsDeliveryShape(deliveries)
}

function validatePresentationOutcome (
  outcome: PresentationResult['outcome'],
  deliveries: readonly SafeDeliveryObservationV1[],
  reducerInput: PresentationReducerInputV1
): void {
  const sent = deliveries.some(delivery => delivery.outcome === 'sent')
  const failed = deliveries.some(delivery => delivery.outcome === 'failed_definite')
  const unknown = deliveries.some(delivery => delivery.outcome === 'outcome_unknown')
  const valid = outcome === 'complete'
    ? !failed && !unknown
    : outcome === 'partial'
      ? sent && (failed || unknown ||
        isPreDispatchTtsSynthesisPartial(deliveries, reducerInput))
      : outcome === 'failed'
        ? !sent && !unknown
        : outcome === 'unknown'
          ? !sent && unknown
          : deliveries.length === 0
  if (!valid) throw new TypeError('presentation observation outcome matrix is invalid')
}

export function createPresentationObservationId (
  random: (size: number) => Buffer = nodeRandomBytes
): string {
  const bytes = random(32)
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new TypeError('presentation observation random bytes are invalid')
  }
  return bytes.toString('hex')
}

export function createProgressPresentationReducerInput (input: {
  readonly requestKind: PresentationReducerInputV1['requestKind']
  readonly text: string
}): PresentationReducerInputV1 {
  if (!REQUEST_KINDS.has(input.requestKind) || typeof input.text !== 'string') {
    throw new TypeError('progress presentation input is invalid')
  }
  const length = [...input.text].length
  if (length < 1 || length > 200) {
    throw new TypeError('progress presentation text length is invalid')
  }
  return parseReducerInput({
    schemaVersion: 1,
    reducerVersion: 1,
    requestKind: input.requestKind,
    profile: 'progress',
    textLengthBucket: length <= 40 ? '1_40' : '41_200',
    hasReasoning: false,
    hasCitation: false,
    buttonsEligible: false,
    ttsEligibility: 'disabled',
    pictureEligibility: 'disabled',
    quotePolicy: 'none',
    selectedMode: 'text',
    fallbackReason: 'none',
    configEnumVersion: 1
  })
}

export function parsePresentationObservation (
  value: unknown
): PresentationObservationV1 {
  const input = exactData(value, PRESENTATION_KEYS, 'presentation observation')
  if (input.schemaVersion !== 1 ||
    typeof input.presentationObservationId !== 'string' ||
    !OBSERVATION_ID_PATTERN.test(input.presentationObservationId) ||
    (input.runRef !== 'unavailable' && typeof input.runRef !== 'string') ||
    (input.terminalObservationId !== 'unavailable' &&
      input.terminalObservationId !== 'not_attempted' &&
      typeof input.terminalObservationId !== 'string') ||
    typeof input.profile !== 'string' ||
    !PRESENTATION_PROFILES.has(input.profile as PresentationReducerInputV1['profile']) ||
    typeof input.outcome !== 'string' ||
    !PRESENTATION_OUTCOMES.has(input.outcome as PresentationResult['outcome']) ||
    typeof input.postprocessAnomaly !== 'boolean') {
    throw new TypeError('presentation observation fields are invalid')
  }
  const deliveryValues = exactDataArray(
    input.deliveries,
    MAX_PRESENTATION_DELIVERY_OBSERVATIONS,
    'presentation deliveries'
  )
  const profile = input.profile as PresentationReducerInputV1['profile']
  const runRef = input.runRef as PresentationObservationV1['runRef']
  const terminalId = input.terminalObservationId as PresentationObservationV1['terminalObservationId']
  validatePresentationCorrelation(runRef, terminalId, profile)
  const reducerInput = parseReducerInput(input.reducerInput)
  if (reducerInput.profile !== profile) {
    throw new TypeError('presentation observation profile matrix is invalid')
  }
  const deliveries = Object.freeze(deliveryValues.map(parseDelivery))
  const outcome = input.outcome as PresentationResult['outcome']
  validatePresentationOutcome(outcome, deliveries, reducerInput)
  return Object.freeze({
    schemaVersion: 1,
    presentationObservationId: input.presentationObservationId,
    runRef,
    terminalObservationId: terminalId,
    profile,
    outcome,
    postprocessAnomaly: input.postprocessAnomaly,
    deliveries,
    totalDurationMs: parseObservationCount(input.totalDurationMs),
    reducerInput
  })
}

export function parseObservationEvent (value: unknown): ObservationEventV1 {
  const input = exactData(value, EVENT_KEYS, 'observation event')
  if (input.schemaVersion !== 1) throw new TypeError('observation event schema is invalid')
  if (input.type === 'request') {
    return Object.freeze({ schemaVersion: 1, type: 'request', value: safeRequest(input.value) })
  }
  if (input.type === 'terminal_snapshot') {
    return Object.freeze({
      schemaVersion: 1,
      type: 'terminal_snapshot',
      value: safeSnapshot(input.value)
    })
  }
  if (input.type === 'terminal_commit') {
    return Object.freeze({
      schemaVersion: 1,
      type: 'terminal_commit',
      value: safeReceipt(input.value)
    })
  }
  if (input.type === 'presentation') {
    return Object.freeze({
      schemaVersion: 1,
      type: 'presentation',
      value: parsePresentationObservation(input.value)
    })
  }
  throw new TypeError('observation event type is invalid')
}

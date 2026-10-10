import type { ModelUsage } from '../model/model-adapter.js'
import { parsePresentationCost, type PresentationModelCostV1 } from '../contracts/presentation-trace.js'
import type { ModelCost } from '../model/model-cost.js'

export interface RunUsageSummaryV1 {
  readonly schemaVersion: 1
  readonly availability: 'complete' | 'partial' | 'unavailable'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheHitTokens: number
  readonly cacheMissTokens: number
  readonly turnsWithUsage: number
  readonly turnsWithoutUsage: number
  readonly cacheUsageComplete: boolean
  /** Per-request accounting. Absent on historical checkpoints; never reprice them. */
  readonly cost?: PresentationModelCostV1
}

const USAGE_KEYS = Object.freeze([
  'schemaVersion',
  'availability',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheHitTokens',
  'cacheMissTokens',
  'turnsWithUsage',
  'turnsWithoutUsage',
  'cacheUsageComplete'
])

function record (value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('run usage is invalid')
  }
  return value as Record<string, unknown>
}

function nonNegativeSafeInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeSum (left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new TypeError('run usage overflow')
  return sum
}

export function parseRunUsageSummary (value: unknown): RunUsageSummaryV1 {
  const input = record(value)
  const keys = Object.keys(input)
  if (USAGE_KEYS.some(key => !keys.includes(key)) ||
    keys.some(key => !USAGE_KEYS.includes(key) && key !== 'cost') ||
    input.schemaVersion !== 1 ||
    (input.availability !== 'complete' && input.availability !== 'partial' &&
      input.availability !== 'unavailable') ||
    !nonNegativeSafeInteger(input.inputTokens) ||
    !nonNegativeSafeInteger(input.outputTokens) ||
    !nonNegativeSafeInteger(input.totalTokens) ||
    !nonNegativeSafeInteger(input.cacheHitTokens) ||
    !nonNegativeSafeInteger(input.cacheMissTokens) ||
    !nonNegativeSafeInteger(input.turnsWithUsage) ||
    !nonNegativeSafeInteger(input.turnsWithoutUsage) ||
    typeof input.cacheUsageComplete !== 'boolean') {
    throw new TypeError('run usage is invalid')
  }
  if (safeSum(input.inputTokens, input.outputTokens) !== input.totalTokens ||
    safeSum(input.cacheHitTokens, input.cacheMissTokens) > input.inputTokens ||
    (input.availability === 'unavailable' && input.cacheUsageComplete) ||
    (input.availability === 'complete' && !input.cacheUsageComplete &&
      input.inputTokens === 0 && input.outputTokens === 0 && input.totalTokens === 0 &&
      input.cacheHitTokens === 0 && input.cacheMissTokens === 0 &&
      input.turnsWithUsage === 0 && input.turnsWithoutUsage === 0) ||
    (input.cacheUsageComplete &&
      (input.cacheHitTokens + input.cacheMissTokens !== input.inputTokens ||
        input.turnsWithoutUsage !== 0)) ||
    (input.availability === 'complete' && input.turnsWithoutUsage !== 0) ||
    (input.availability === 'partial' && input.turnsWithoutUsage === 0)) {
    throw new TypeError('run usage is inconsistent')
  }
  return Object.freeze({
    schemaVersion: 1,
    availability: input.availability,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    cacheHitTokens: input.cacheHitTokens,
    cacheMissTokens: input.cacheMissTokens,
    turnsWithUsage: input.turnsWithUsage,
    turnsWithoutUsage: input.turnsWithoutUsage,
    cacheUsageComplete: input.cacheUsageComplete,
    ...(input.cost === undefined ? {} : { cost: parsePresentationCost(input.cost) })
  })
}

export function createInitialRunUsageSummary (): RunUsageSummaryV1 {
  return parseRunUsageSummary({
    schemaVersion: 1,
    availability: 'complete',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    turnsWithUsage: 0,
    turnsWithoutUsage: 0,
    cacheUsageComplete: true
  })
}

export function createUnavailableRunUsageSummary (): RunUsageSummaryV1 {
  return parseRunUsageSummary({
    ...createInitialRunUsageSummary(),
    availability: 'unavailable',
    cacheUsageComplete: false
  })
}

function parseTurnUsage (value: ModelUsage): ModelUsage {
  if (!nonNegativeSafeInteger(value.inputTokens) ||
    !nonNegativeSafeInteger(value.outputTokens) ||
    !nonNegativeSafeInteger(value.totalTokens) ||
    safeSum(value.inputTokens, value.outputTokens) !== value.totalTokens) {
    throw new TypeError('model usage is invalid')
  }
  if (value.inputCache === undefined) return value
  if (!nonNegativeSafeInteger(value.inputCache.hitTokens) ||
    !nonNegativeSafeInteger(value.inputCache.missTokens) ||
    safeSum(value.inputCache.hitTokens, value.inputCache.missTokens) !== value.inputTokens) {
    throw new TypeError('model cache usage is invalid')
  }
  return value
}

export function recordRunUsage (
  current: RunUsageSummaryV1,
  usage: ModelUsage | undefined,
  requestCost?: ModelCost
): RunUsageSummaryV1 {
  const parsed = parseRunUsageSummary(current)
  const cost = requestCost === undefined ? parsed.cost : accumulateCost(parsed, requestCost)
  if (usage === undefined) {
    return parseRunUsageSummary({
      ...parsed,
      availability: parsed.availability === 'unavailable' ? 'unavailable' : 'partial',
      turnsWithoutUsage: safeSum(parsed.turnsWithoutUsage, 1),
      cacheUsageComplete: false,
      ...(cost === undefined ? {} : { cost })
    })
  }
  const turn = parseTurnUsage(usage)
  return parseRunUsageSummary({
    ...parsed,
    inputTokens: safeSum(parsed.inputTokens, turn.inputTokens),
    outputTokens: safeSum(parsed.outputTokens, turn.outputTokens),
    totalTokens: safeSum(parsed.totalTokens, turn.totalTokens),
    cacheHitTokens: safeSum(parsed.cacheHitTokens, turn.inputCache?.hitTokens ?? 0),
    cacheMissTokens: safeSum(parsed.cacheMissTokens, turn.inputCache?.missTokens ?? 0),
    turnsWithUsage: safeSum(parsed.turnsWithUsage, 1),
    cacheUsageComplete: parsed.cacheUsageComplete && turn.inputCache !== undefined,
    ...(cost === undefined ? {} : { cost })
  })
}

function accumulateCost (current: RunUsageSummaryV1, next: ModelCost): PresentationModelCostV1 {
  const prior = current.cost
  if (next.kind === 'unavailable' || prior?.kind === 'unavailable' ||
    (prior === undefined && current.turnsWithUsage + current.turnsWithoutUsage > 0)) {
    return Object.freeze({ kind: 'unavailable', catalogVersion: null, billingAuthority: false })
  }
  const version = (value: string): string => value.replace(/-(peak|offpeak)$/, '')
  if (prior !== undefined && version(prior.catalogVersion) !== version(next.catalogVersion)) {
    return Object.freeze({ kind: 'unavailable', catalogVersion: null, billingAuthority: false })
  }
  return parsePresentationCost({
    kind: next.kind === 'upper_bound' || prior?.kind === 'upper_bound' ? 'upper_bound' : 'exact',
    currency: 'CNY', billingAuthority: false,
    catalogVersion: version(next.catalogVersion),
    picoYuan: (BigInt(prior?.picoYuan ?? '0') + next.picoYuan).toString(10)
  })
}

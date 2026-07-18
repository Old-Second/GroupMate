import { createHash } from 'node:crypto'
import type {
  ModelMessage
} from '../agent/model/model-adapter.js'
import { parseModelCapabilitySnapshot } from '../agent/model/model-capability.js'
import type {
  OpenAIFetch,
  OpenAIFetchInit,
  OpenAIResponseLike
} from '../agent/model/openai-wire.js'
import { createDefaultRunBudget } from '../agent/run/run-budget.js'
import {
  createInitialRunCheckpoint,
  RunCheckpointCodec
} from '../agent/run/run-checkpoint.js'
import { createRunEvent } from '../agent/run/run-events.js'
import {
  createOpenAICompatibleCompletionFacade,
  type CompletionFacade
} from '../runtime/completion-facade.js'

export const PHASE_5_MEMORY_SCENARIOS = Object.freeze([
  'idle', 'singleRun', 'dualRun', 'checkpointRecovery'
] as const)

const FIXTURE_MODEL_CAPABILITY = parseModelCapabilitySnapshot({
  schemaVersion: 1,
  source: 'safe_default',
  contextWindowTokens: 32_768,
  maxOutputTokens: 8_192,
  promptCaching: 'unknown',
  usageExtensions: [],
  priceCatalogVersion: null
})

export type Phase5MemoryScenarioName = typeof PHASE_5_MEMORY_SCENARIOS[number]

export interface Phase5MemorySample {
  readonly scenario: Phase5MemoryScenarioName
  readonly requestCount: number
  readonly maxConcurrentRequests: number
  readonly baselineRssBytes: number
  readonly retainedRssBytes: number
  readonly observedPeakRssBytes: number
}

export interface Phase5MemoryScenarioOptions {
  readonly settleMs?: number
  readonly baselineRssBytes?: number
  readonly gc?: () => void
  readonly memoryUsage?: () => NodeJS.MemoryUsage
  readonly resourceUsage?: () => NodeJS.ResourceUsage
}

const FIXTURE_MESSAGES: readonly ModelMessage[] = Object.freeze([
  Object.freeze({ role: 'system', content: 'Return one fixture answer.' }),
  Object.freeze({ role: 'user', content: 'fixture prompt' })
])

function fixtureResponse (requestNumber: number): OpenAIResponseLike {
  const raw = JSON.stringify({
    id: `fixture-response-${requestNumber}`,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: `fixture answer ${requestNumber}` }
    }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  })
  return Object.freeze({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => raw
  })
}

function deferred (): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve
  })
  return Object.freeze({
    promise,
    resolve: () => resolvePromise?.()
  })
}

function checkpointFixture (): ReturnType<RunCheckpointCodec['decode']> {
  const createdAt = '2026-07-14T00:00:00.000Z'
  const runId = 'memory-recovery-run'
  const sessionId = 'memory-recovery-session'
  const budget = createDefaultRunBudget({
    providerTimeoutMs: 120_000,
    outputTokens: 64
  })
  const event = createRunEvent({
    eventId: 'memory-recovery-event',
    runId,
    sessionId,
    sequence: 0,
    occurredAt: createdAt,
    type: 'run.created',
    payload: Object.freeze({})
  })
  const checkpoint = createInitialRunCheckpoint({
    profileId: 'standard',
    profileVersion: 1,
    runId,
    sessionId,
    sessionAddress: Object.freeze({
      botId: 'memory-bot',
      scope: Object.freeze({ kind: 'private', userId: 'memory-user' })
    }),
    model: Object.freeze({
      model: 'fixture-model',
      streaming: false,
      maxOutputTokens: 64,
      reasoning: Object.freeze({ enabled: false })
    }),
    modelCapability: FIXTURE_MODEL_CAPABILITY,
    modelPrice: null,
    toolSnapshot: Object.freeze({
      id: 'memory-snapshot',
      fingerprint: createHash('sha256').update('[]').digest('hex'),
      manifest: Object.freeze([])
    }),
    budgetLimits: budget.limits,
    budgetCounters: budget.initialCounters,
    deadlineAt: '2026-07-14T00:02:00.000Z',
    createdAt,
    event
  })
  const codec = new RunCheckpointCodec()
  const encoded = codec.encode(checkpoint)
  return codec.decode(encoded.checkpoint, encoded.events)
}

function positiveSettleMs (value: number | undefined): number {
  const settleMs = value ?? 25
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 1_000) {
    throw new TypeError('memory scenario settle time is invalid')
  }
  return settleMs
}

export async function runPhase5MemoryScenario (
  scenario: Phase5MemoryScenarioName,
  options: Phase5MemoryScenarioOptions = {}
): Promise<Phase5MemorySample> {
  if (!PHASE_5_MEMORY_SCENARIOS.includes(scenario)) {
    throw new TypeError(`unknown Phase 5 memory scenario: ${String(scenario)}`)
  }
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  const resourceUsage = options.resourceUsage ?? (() => process.resourceUsage())
  const collect = options.gc ?? (globalThis as typeof globalThis & {
    gc?: () => void
  }).gc
  collect?.()
  const observations: number[] = []
  const retained: unknown[] = []
  const baselineRssBytes = options.baselineRssBytes ?? memoryUsage().rss
  if (!Number.isSafeInteger(baselineRssBytes) || baselineRssBytes <= 0) {
    throw new TypeError('memory scenario baseline RSS is invalid')
  }
  observations.push(baselineRssBytes)
  let requestCount = 0
  let concurrentRequests = 0
  let maxConcurrentRequests = 0
  const bothArrived = deferred()
  const releaseDual = deferred()

  const fetch: OpenAIFetch = async (
    _url: string,
    _init: OpenAIFetchInit
  ): Promise<OpenAIResponseLike> => {
    requestCount += 1
    const requestNumber = requestCount
    concurrentRequests += 1
    maxConcurrentRequests = Math.max(maxConcurrentRequests, concurrentRequests)
    observations.push(memoryUsage().rss)
    if (scenario === 'dualRun' && requestCount === 2) bothArrived.resolve()
    try {
      if (scenario === 'dualRun') await releaseDual.promise
      return fixtureResponse(requestNumber)
    } finally {
      concurrentRequests -= 1
    }
  }
  const createFacade = (): CompletionFacade => createOpenAICompatibleCompletionFacade({
    endpoint: 'https://fixture.invalid/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model',
    openAiCompatibilityProfile: 'standard',
    fetch
  })
  const facade = createFacade()
  retained.push(facade)
  observations.push(memoryUsage().rss)

  // Fixture fetch keeps the scenario offline; retaining the production default
  // transport module still accounts for its first-use memory footprint.
  if (scenario !== 'idle') {
    retained.push(await import('node-fetch'))
    observations.push(memoryUsage().rss)
  }

  if (scenario === 'singleRun' || scenario === 'checkpointRecovery') {
    if (scenario === 'checkpointRecovery') retained.push(checkpointFixture())
    retained.push(await facade.completeText({
      purpose: 'smoke', messages: FIXTURE_MESSAGES, maxOutputTokens: 64
    }, new AbortController().signal))
    observations.push(memoryUsage().rss)
  }
  if (scenario === 'dualRun') {
    const runs = Promise.all([
      facade.completeText({ purpose: 'smoke', messages: FIXTURE_MESSAGES }, new AbortController().signal),
      facade.completeText({ purpose: 'smoke', messages: FIXTURE_MESSAGES }, new AbortController().signal)
    ])
    let barrierTimer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        bothArrived.promise,
        new Promise<never>((_resolve, reject) => {
          barrierTimer = setTimeout(() => reject(new Error(
            'timed out waiting for two fixture requests'
          )), 1_000)
          barrierTimer.unref?.()
        })
      ])
      observations.push(memoryUsage().rss)
    } finally {
      if (barrierTimer !== undefined) clearTimeout(barrierTimer)
      releaseDual.resolve()
    }
    retained.push(...await runs)
    observations.push(memoryUsage().rss)
  }

  if (concurrentRequests !== 0) {
    throw new Error('fixture requests remained active after the memory scenario')
  }
  collect?.()
  const settleMs = positiveSettleMs(options.settleMs)
  if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs))
  const retainedRssBytes = memoryUsage().rss
  observations.push(retainedRssBytes)
  const rawPeak = resourceUsage().maxRSS
  const peakScale = rawPeak >= retainedRssBytes ? 1 : 1_024
  const observedPeakRssBytes = Math.max(...observations, rawPeak * peakScale)
  if (retained.length === 0 || !Number.isSafeInteger(baselineRssBytes) ||
    baselineRssBytes <= 0 || !Number.isSafeInteger(retainedRssBytes) ||
    retainedRssBytes <= 0 || !Number.isSafeInteger(observedPeakRssBytes) ||
    observedPeakRssBytes < retainedRssBytes || observedPeakRssBytes < baselineRssBytes) {
    throw new Error('memory scenario produced invalid RSS observations')
  }
  return Object.freeze({
    scenario,
    requestCount,
    maxConcurrentRequests,
    baselineRssBytes,
    retainedRssBytes,
    observedPeakRssBytes
  })
}

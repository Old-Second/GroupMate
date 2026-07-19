import { AgentError } from '../agent/contracts/error.js'
import {
  contextArtifactToSpan,
  encodeContextArtifactV1,
  parseContextArtifactV1,
  type ContextArtifactV1
} from '../agent/context/context-artifact.js'
import type { ContextArtifactStore } from '../agent/context/context-artifact-store.js'
import { contextArtifactRefsRetainedOrCleared } from '../agent/context/context-artifact-ref-transition.js'
import { contextWireHash } from '../agent/context/context-plan.js'
import {
  MAX_CONTEXT_PLANNER_INPUT_BYTES,
  planModelTurn as planContextModelTurn,
  type ContextCompactionRequestV1,
  type ContextPlannerResult
} from '../agent/context/context-planner.js'
import {
  createContextSpanV1,
  domainSeparatedContextHash,
  MAX_CONTEXT_SPANS,
  parseContextSpanV1,
  type ContextSpanV1
} from '../agent/context/context-span.js'
import { CONTEXT_TOKEN_ESTIMATOR_VERSION } from '../agent/context/context-token-estimator.js'
import type { ModelMessage } from '../agent/model/model-adapter.js'
import { modelCapabilityStableHash } from '../agent/model/model-capability.js'
import type { RunCheckpoint } from '../agent/run/run-checkpoint.js'
import type {
  PlannedRunContext,
  RunContextPlanningRequest
} from '../agent/run/run-engine.js'
import { MODEL_TURN_CAPACITY_LIMITS } from '../agent/run/model-turn-capacity.js'
import { RUN_RESOURCE_LIMITS } from '../agent/run/run-limits.js'
import {
  toolLedgerIsTerminal,
  type TerminalToolLedgerStatus,
  type ToolExecutionLedger
} from '../agent/run/tool-ledger.js'
import {
  compactConsumedToolSpan,
  type ConsumedToolDigestEvidenceV1
} from '../agent/context/tool-digest-compactor.js'

const TOOL_SPAN_ID_HASH_DOMAIN = 'groupmate.runtime.tool-span-id.v1'
const TOOL_SPAN_PROVENANCE_HASH_DOMAIN = 'groupmate.runtime.tool-span-provenance.v1'
const CORRECTION_SPAN_ID_HASH_DOMAIN = 'groupmate.runtime.correction-span-id.v1'
const CORRECTION_SPAN_CONTENT_HASH_DOMAIN = 'groupmate.runtime.correction-span-content.v1'
const RECOVERY_BASELINE_ID_HASH_DOMAIN = 'groupmate.runtime.recovery-baseline-id.v1'
const CORRECTION_INSTRUCTION = '请根据以上上下文直接给出最终答复，不要调用工具。'

export interface RunContextPlannerOptions {
  readonly namespaceRef: string
  readonly initialSpans: readonly ContextSpanV1[] | null
  readonly artifactPolicy?: 'disabled' | 'enabled'
  readonly artifacts?: readonly ContextArtifactV1[]
  readonly artifactStore?: ContextArtifactStore
}

export interface RunContextPlanner {
  planModelTurn(
    checkpoint: RunCheckpoint,
    request: RunContextPlanningRequest,
    signal: AbortSignal
  ): Promise<PlannedRunContext>
}

function cancelledError (): AgentError {
  return new AgentError({
    code: 'cancelled',
    stage: 'context.plan',
    retryable: false,
    userMessage: '操作已取消。'
  })
}

function assertNotAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw cancelledError()
}

function checkpointError (reason: string): AgentError {
  return new AgentError({
    code: 'checkpoint_invalid',
    stage: 'context.plan',
    retryable: false,
    userMessage: '任务上下文已失效，请重新发起。',
    details: { reason }
  })
}

function contextBudgetError (reason: string): AgentError {
  return new AgentError({
    code: 'context_budget_exceeded',
    stage: 'context.plan',
    retryable: false,
    userMessage: '当前请求超出可用上下文范围，请缩短内容后重试。',
    details: { reason }
  })
}

function sameCallIds (
  message: ModelMessage | undefined,
  ledger: ToolExecutionLedger
): boolean {
  if (message?.role !== 'assistant' || message.toolCalls === undefined ||
    message.toolCalls.length !== ledger.calls.length) return false
  return message.toolCalls.every((call, index) => call.callId === ledger.calls[index]?.callId)
}

function protocolMessages (
  messages: readonly ModelMessage[],
  ledger: ToolExecutionLedger
): readonly ModelMessage[] | null {
  for (const [index, message] of messages.entries()) {
    if (!sameCallIds(message, ledger)) continue
    const protocol = messages.slice(index, index + ledger.calls.length + 1)
    if (protocol.length !== ledger.calls.length + 1 || protocol.slice(1).some((result, offset) => (
      result.role !== 'tool' || result.toolCallId !== ledger.calls[offset]?.callId
    ))) continue
    return Object.freeze(protocol)
  }
  return null
}

function toolSpan (
  checkpoint: RunCheckpoint,
  ledger: ToolExecutionLedger,
  messages: readonly ModelMessage[],
  phase: 'ready' | 'consumed',
  originGeneration: number
): ContextSpanV1 {
  const callIds = Object.freeze(ledger.calls.map(call => call.callId))
  const identity = `${ledger.step}\0${callIds.join('\0')}`
  const spanHash = domainSeparatedContextHash(TOOL_SPAN_ID_HASH_DOMAIN, identity)
  const wireHash = contextWireHash(messages)
  const ref = `tool-ledger:${spanHash}`
  return createContextSpanV1(Object.freeze({
    spanId: `tool-span:${spanHash}`,
    namespaceRef: checkpoint.runRef,
    kind: 'tool_protocol' as const,
    source: 'tool_chain' as const,
    trust: 'trusted' as const,
    requirement: phase === 'ready' ? 'mandatory' as const : 'optional' as const,
    priority: phase === 'ready' ? 'critical' as const : 'normal' as const,
    semanticOrder: MAX_CONTEXT_SPANS + ledger.step + 1,
    originGeneration,
    provenance: Object.freeze({
      kind: 'tool_ledger' as const,
      ref,
      revision: ledger.step,
      contentHash: domainSeparatedContextHash(
        TOOL_SPAN_PROVENANCE_HASH_DOMAIN,
        `${identity}\0${wireHash}`
      )
    }),
    supersedes: null,
    messages,
    sourceRefs: Object.freeze([Object.freeze({ ref, contentHash: wireHash })]),
    toolProtocol: Object.freeze({
      phase,
      step: ledger.step,
      callIds
    })
  }))
}

export function projectRunToolProtocolSpans (
  checkpoint: RunCheckpoint,
  namespaceRef: string,
  signal?: AbortSignal,
  originGenerations?: Map<number, number>
): readonly ContextSpanV1[] {
  assertNotAborted(signal)
  if (checkpoint.runRef !== namespaceRef) throw checkpointError('namespace_mismatch')
  const pendingAssistant = checkpoint.pendingContextMessages[0]
  const combined = Object.freeze([
    ...checkpoint.messages,
    ...checkpoint.pendingContextMessages
  ])
  const spans: ContextSpanV1[] = []
  for (const [index, ledger] of checkpoint.toolLedgers.entries()) {
    const ready = sameCallIds(pendingAssistant, ledger)
    if (!toolLedgerIsTerminal(ledger)) {
      if (ready) throw checkpointError('pending_tool_ledger_not_terminal')
      continue
    }
    const messages = protocolMessages(combined, ledger)
    if (messages === null) {
      if (ready) throw checkpointError('pending_tool_protocol_incomplete')
      continue
    }
    const planGeneration = checkpoint.contextPlan?.generation ?? 0
    const generationsSinceLedger = checkpoint.toolLedgers.length - index - 1
    const inferredOriginGeneration = Math.max(
      ledger.step + 1,
      ready ? planGeneration : planGeneration - generationsSinceLedger
    )
    const originGeneration = originGenerations?.get(ledger.step) ??
      inferredOriginGeneration
    originGenerations?.set(ledger.step, originGeneration)
    spans.push(toolSpan(
      checkpoint,
      ledger,
      messages,
      ready ? 'ready' : 'consumed',
      originGeneration
    ))
  }
  if (checkpoint.pendingContextMessages.length > 0 &&
    !spans.some(span => span.toolProtocol?.phase === 'ready')) {
    throw checkpointError('pending_tool_ledger_missing')
  }
  return Object.freeze(spans)
}

function recoveryBaselineSpan (checkpoint: RunCheckpoint): ContextSpanV1 {
  const previous = checkpoint.contextPlan
  if (previous === null || checkpoint.messages.length === 0) {
    throw checkpointError('recovery_baseline_unavailable')
  }
  const ref = `plan:${previous.planHash}`
  return createContextSpanV1(Object.freeze({
    spanId: `recovery-baseline:${domainSeparatedContextHash(
      RECOVERY_BASELINE_ID_HASH_DOMAIN,
      previous.planHash
    )}`,
    namespaceRef: checkpoint.runRef,
    kind: 'message' as const,
    source: 'recovery_baseline' as const,
    trust: 'trusted' as const,
    requirement: 'mandatory' as const,
    priority: 'critical' as const,
    semanticOrder: 0,
    originGeneration: previous.generation,
    provenance: Object.freeze({
      kind: 'run' as const,
      ref,
      revision: previous.generation,
      contentHash: previous.planHash
    }),
    supersedes: null,
    messages: checkpoint.messages,
    sourceRefs: Object.freeze([Object.freeze({
      ref,
      contentHash: previous.planHash
    })]),
    toolProtocol: null
  }))
}

function correctionSpan (
  checkpoint: RunCheckpoint,
  generation: number,
  semanticOrder: number
): ContextSpanV1 {
  const previousHash = checkpoint.contextPlan?.planHash ?? 'initial'
  const identity = `${checkpoint.runRef}\0${previousHash}\0${generation}`
  const spanHash = domainSeparatedContextHash(CORRECTION_SPAN_ID_HASH_DOMAIN, identity)
  const ref = `run-correction:${spanHash}`
  const contentHash = domainSeparatedContextHash(
    CORRECTION_SPAN_CONTENT_HASH_DOMAIN,
    CORRECTION_INSTRUCTION
  )
  return createContextSpanV1(Object.freeze({
    spanId: `correction:${spanHash}`,
    namespaceRef: checkpoint.runRef,
    kind: 'message' as const,
    source: 'runtime_fact' as const,
    trust: 'trusted' as const,
    requirement: 'mandatory' as const,
    priority: 'critical' as const,
    semanticOrder,
    originGeneration: generation,
    provenance: Object.freeze({
      kind: 'run' as const,
      ref,
      revision: generation,
      contentHash
    }),
    supersedes: null,
    messages: Object.freeze([Object.freeze({
      role: 'user' as const,
      content: CORRECTION_INSTRUCTION
    })]),
    sourceRefs: Object.freeze([Object.freeze({ ref, contentHash })]),
    toolProtocol: null
  }))
}

function plannerBudget (
  checkpoint: RunCheckpoint,
  request: RunContextPlanningRequest
) {
  const estimatedToolTokens = request.kind === 'correction'
    ? 0
    : checkpoint.toolWireSnapshot?.estimatedTokens ??
      MODEL_TURN_CAPACITY_LIMITS.toolSchemaTokens
  const reservedOutputTokens = Math.min(
    checkpoint.model.maxOutputTokens,
    checkpoint.modelCapability.maxOutputTokens
  )
  const maxInputTokens = checkpoint.modelCapability.contextWindowTokens -
    estimatedToolTokens - reservedOutputTokens -
    MODEL_TURN_CAPACITY_LIMITS.safetyMarginTokens
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) {
    throw contextBudgetError('reserved_capacity_exhausted')
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    maxInputTokens,
    maxSerializedMessageBytes: Math.min(
      MAX_CONTEXT_PLANNER_INPUT_BYTES,
      RUN_RESOURCE_LIMITS.providerProtocolChainBytes
    ),
    maxMessages: 128,
    estimatedToolTokens,
    reservedOutputTokens
  })
}

function plannerResultError (code: 'context_budget_exceeded' | 'tool_protocol_incomplete'): AgentError {
  if (code === 'context_budget_exceeded') return contextBudgetError(code)
  return new AgentError({
    code: 'invalid_request',
    stage: 'context.plan',
    retryable: false,
    userMessage: '上下文中的工具调用状态无效。',
    details: { reason: code }
  })
}

function sameArtifact (left: ContextArtifactV1, right: ContextArtifactV1): boolean {
  try {
    return encodeContextArtifactV1(left) === encodeContextArtifactV1(right)
  } catch {
    return false
  }
}

function evidenceFor (
  checkpoint: RunCheckpoint,
  span: ContextSpanV1
): ConsumedToolDigestEvidenceV1 | null {
  const protocol = span.toolProtocol
  if (protocol === null || protocol.phase !== 'consumed') return null
  const ledger = checkpoint.toolLedgers.find(candidate => candidate.step === protocol.step)
  if (ledger === undefined || !toolLedgerIsTerminal(ledger) ||
    ledger.calls.length !== protocol.callIds.length) return null
  const calls = ledger.calls.map((call, index) => {
    if (call.callId !== protocol.callIds[index] || call.result === null) return null
    return Object.freeze({
      callId: call.callId,
      terminalStatus: call.status as TerminalToolLedgerStatus,
      result: call.result
    })
  })
  if (calls.some(call => call === null)) return null
  return Object.freeze({
    schemaVersion: 1 as const,
    step: ledger.step,
    calls: Object.freeze(calls as NonNullable<(typeof calls)[number]>[])
  })
}

function sourceSpanForRequest (
  spans: readonly ContextSpanV1[],
  request: ContextCompactionRequestV1
): ContextSpanV1 | null {
  if (request.sourceSpanIds.length !== 1) return null
  const span = spans.find(candidate => candidate.spanId === request.sourceSpanIds[0])
  return span?.toolProtocol?.phase === 'consumed' ? span : null
}

async function storeArtifact (
  store: ContextArtifactStore,
  artifact: ContextArtifactV1,
  minimumExpiresAtMs: number
): Promise<ContextArtifactV1 | null> {
  try {
    const result = await store.putIfAbsent(artifact, minimumExpiresAtMs)
    if (result.status !== 'ready') return null
    if (!sameArtifact(result.artifact, artifact)) {
      throw checkpointError('artifact_store_identity_mismatch')
    }
    return result.artifact
  } catch (error) {
    if (error instanceof AgentError) throw error
    return null
  }
}

async function hydrateCommittedArtifacts (
  refs: readonly string[],
  artifacts: Map<string, ContextArtifactV1>,
  store: ContextArtifactStore | undefined
): Promise<'ready' | 'rebase'> {
  for (const ref of refs) {
    if (artifacts.has(ref)) continue
    if (store === undefined) return 'rebase'
    let result: Awaited<ReturnType<ContextArtifactStore['get']>>
    try {
      result = await store.get(ref)
    } catch {
      return 'rebase'
    }
    if (result.status === 'ready') {
      let artifact: ContextArtifactV1
      try {
        artifact = parseContextArtifactV1(result.artifact)
      } catch {
        throw checkpointError('artifact_corrupt')
      }
      if (artifact.artifactId !== ref) throw checkpointError('artifact_identity_mismatch')
      artifacts.set(ref, artifact)
      continue
    }
    if (result.status === 'unavailable' &&
      (result.code === 'artifact_corrupt' || result.code === 'metadata_corrupt')) {
      throw checkpointError(`artifact_${result.code}`)
    }
    return 'rebase'
  }
  return 'ready'
}

export function createRunContextPlanner (
  options: RunContextPlannerOptions
): RunContextPlanner {
  const initialSpans = options.initialSpans === null
    ? null
    : Object.freeze(options.initialSpans.map(parseContextSpanV1))
  const artifactStore = options.artifactStore
  const artifactPolicy = options.artifactPolicy ?? (
    artifactStore === undefined ? 'disabled' : 'enabled'
  )
  const artifacts = new Map<string, ContextArtifactV1>()
  const artifactSpans = new Map<string, ContextSpanV1>()
  for (const value of options.artifacts ?? []) {
    const artifact = parseContextArtifactV1(value)
    if (artifacts.has(artifact.artifactId)) throw new TypeError('duplicate context artifact')
    artifacts.set(artifact.artifactId, artifact)
  }
  const toolOriginGenerations = new Map<number, number>()
  let fixedRecoveryBaseline: ContextSpanV1 | null = null
  let baselineCallIds: ReadonlySet<string> = new Set()
  return Object.freeze({
    async planModelTurn (
      checkpoint: RunCheckpoint,
      request: RunContextPlanningRequest,
      signal: AbortSignal
    ): Promise<PlannedRunContext> {
      assertNotAborted(signal)
      if (checkpoint.runRef !== options.namespaceRef) {
        throw checkpointError('namespace_mismatch')
      }
      const previousPlan = checkpoint.contextPlan
      const generation = (previousPlan?.generation ?? 0) + 1
      const hydration = await hydrateCommittedArtifacts(
        checkpoint.contextArtifactRefs ?? Object.freeze([]),
        artifacts,
        artifactStore
      )
      assertNotAborted(signal)
      const needsRecoveryBaseline = initialSpans === null || hydration === 'rebase'
      if (needsRecoveryBaseline && fixedRecoveryBaseline === null) {
        fixedRecoveryBaseline = recoveryBaselineSpan(checkpoint)
        baselineCallIds = new Set(fixedRecoveryBaseline.messages.flatMap(message => (
          message.role === 'assistant' && message.toolCalls !== undefined
            ? message.toolCalls.map(call => call.callId)
            : []
        )))
      }
      const useRecoveryBaseline = fixedRecoveryBaseline !== null
      const projectedToolSpans = projectRunToolProtocolSpans(
        checkpoint,
        options.namespaceRef,
        signal,
        toolOriginGenerations
      )
      let spans: ContextSpanV1[]
      if (useRecoveryBaseline) {
        if (request.transition === 'recovery_prefix_reset') {
          throw checkpointError('recovery_prefix_reset_unavailable_after_restart')
        }
        spans = [
          fixedRecoveryBaseline as ContextSpanV1,
          ...projectedToolSpans.filter(span => span.toolProtocol?.callIds.every(
            callId => !baselineCallIds.has(callId)
          ))
        ]
      } else {
        if (initialSpans === null) throw checkpointError('initial_spans_unavailable')
        const sourceSpans = request.transition === 'recovery_prefix_reset'
          ? initialSpans.filter(span => span.requirement === 'mandatory')
          : initialSpans
        const retainedArtifacts = (checkpoint.contextArtifactRefs ?? []).map(ref => {
          const artifact = artifacts.get(ref)
          if (artifact === undefined) throw checkpointError('artifact_not_hydrated')
          const cached = artifactSpans.get(ref)
          if (cached !== undefined) return cached
          const covered = [...sourceSpans, ...projectedToolSpans]
            .filter(span => artifact.sourceSpanIds.includes(span.spanId))
          if (covered.length !== artifact.sourceSpanIds.length) {
            throw checkpointError('artifact_source_span_unavailable')
          }
          const materialized = contextArtifactToSpan(
            artifact,
            Math.min(...covered.map(span => span.semanticOrder))
          )
          artifactSpans.set(ref, materialized)
          return materialized
        })
        const coveredSpanIds = new Set(retainedArtifacts.flatMap(span => (
          artifacts.get(span.spanId)?.sourceSpanIds ?? []
        )))
        spans = [
          ...sourceSpans.filter(span => !coveredSpanIds.has(span.spanId)),
          ...retainedArtifacts,
          ...projectedToolSpans.filter(span => !coveredSpanIds.has(span.spanId))
        ]
      }
      if (request.kind === 'correction') {
        const semanticOrder = spans.reduce(
          (maximum, span) => Math.max(maximum, span.semanticOrder),
          0
        ) + 1
        spans.push(correctionSpan(checkpoint, generation, semanticOrder))
      }
      if (spans.length > MAX_CONTEXT_SPANS) throw contextBudgetError('span_limit_exceeded')
      const frozenSpans = Object.freeze(spans)
      const spanIds = new Set(frozenSpans.map(span => span.spanId))
      const relevantArtifacts = (): readonly ContextArtifactV1[] => Object.freeze(
        [...artifacts.values()].filter(artifact => (
          spanIds.has(artifact.artifactId) ||
          artifact.sourceSpanIds.every(spanId => spanIds.has(spanId))
        ))
      )
      const invoke = (
        policy: 'disabled' | 'enabled',
        suppliedArtifacts: readonly ContextArtifactV1[] = relevantArtifacts()
      ): ContextPlannerResult => {
        try {
          return planContextModelTurn(Object.freeze({
            schemaVersion: 1 as const,
            namespaceRef: options.namespaceRef,
            generation,
            transition: request.transition,
            previousPlan,
            estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
            capabilityHash: modelCapabilityStableHash(checkpoint.modelCapability),
            artifactPolicy: policy,
            budget: plannerBudget(checkpoint, request),
            spans: frozenSpans,
            artifacts: suppliedArtifacts
          }))
        } catch (error) {
          if (error instanceof AgentError) throw error
          throw checkpointError('planner_contract_invalid')
        }
      }
      let result = invoke(artifactPolicy)
      const minimumExpiresAtMs = Date.parse(checkpoint.deadlineAt)
      if (!Number.isSafeInteger(minimumExpiresAtMs) || minimumExpiresAtMs <= 0) {
        throw checkpointError('artifact_expiry_invalid')
      }
      if (result.status === 'requires_artifacts') {
        assertNotAborted(signal)
        if (artifactPolicy !== 'enabled' || artifactStore === undefined) {
          result = invoke('disabled')
        } else {
          let storedAll = true
          for (const compactionRequest of result.compactionRequests) {
            const span = sourceSpanForRequest(frozenSpans, compactionRequest)
            const evidence = span === null ? null : evidenceFor(checkpoint, span)
            if (span === null || evidence === null) {
              storedAll = false
              break
            }
            const compacted = compactConsumedToolSpan(compactionRequest, span, evidence)
            if (compacted.status !== 'ready') {
              throw checkpointError(`compaction_${compacted.code}`)
            }
            const stored = await storeArtifact(
              artifactStore,
              compacted.artifact,
              minimumExpiresAtMs
            )
            assertNotAborted(signal)
            if (stored === null) {
              storedAll = false
              break
            }
            artifacts.set(stored.artifactId, stored)
            artifactSpans.set(stored.artifactId, contextArtifactToSpan(
              stored,
              span.semanticOrder
            ))
          }
          result = storedAll ? invoke('enabled') : invoke('disabled')
        }
      }
      if (result.status === 'requires_artifacts') {
        throw contextBudgetError('context_artifact_reentry_limit')
      }
      assertNotAborted(signal)
      if (result.status === 'blocked') throw plannerResultError(result.code)
      if (request.kind === 'correction') {
        const expectedPrefix = Object.freeze([
          ...checkpoint.messages,
          ...checkpoint.pendingContextMessages
        ])
        const prefix = Object.freeze(result.messages.slice(0, expectedPrefix.length))
        const appended = result.messages.at(-1)
        if (result.messages.length !== expectedPrefix.length + 1 ||
          contextWireHash(prefix) !== contextWireHash(expectedPrefix) ||
          result.plan.prefixMessageCount !== checkpoint.messages.length ||
          appended?.role !== 'user' || !contextArtifactRefsRetainedOrCleared(
            checkpoint.contextArtifactRefs ?? Object.freeze([]),
            result.plan.artifactRefs
          )) {
          throw contextBudgetError('correction_append_only_unavailable')
        }
      }
      return Object.freeze({
        messages: result.messages,
        estimatedInputTokens: result.plan.estimatedInputTokens,
        plan: result.plan,
        artifactRefs: result.plan.artifactRefs
      })
    }
  })
}

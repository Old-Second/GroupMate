import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from './memory-access-gate.js'
import { memoryNamespaceRefV1 } from './memory-namespace.js'
import type { PersonalMemoryEnrollmentPortV1 } from './personal-memory-enrollment.js'
import {
  MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2,
  parseMemoryRetrievalRequestV2,
  retrieveMemoryV2,
  type MemoryRetrievalAdapterV2,
  type MemoryRetrievalResultV2
} from './memory-retrieval.js'
import {
  buildPersonalMemoryAccessScopeV1,
  selectPersonalMemorySubjectsV1,
  type PersonalMemorySubjectV1,
  type SceneParticipantSceneV1,
  type SceneParticipantV1
} from './scene-participant.js'
import {
  decidePersonalMemoryPilotV1,
  type PersonalMemoryDeploymentModeV1
} from './personal-memory-pilot-policy.js'

export interface PersonalMemoryParticipantSnapshotV1 {
  readonly scene: SceneParticipantSceneV1
  readonly current: SceneParticipantV1
  readonly references: readonly Readonly<{
    readonly reason: 'quoted_actor' | 'mentioned_actor' | 'explicit_target'
    readonly participant: SceneParticipantV1
  }>[]
}

export interface PersonalMemoryParticipantDirectoryV1<TInput> {
  resolve(input: TInput, signal: AbortSignal): Promise<PersonalMemoryParticipantSnapshotV1 | null>
}

export interface PersonalMemoryRecallInputV1<TParticipantInput> {
  readonly botInstanceId: string
  readonly accountId: string
  readonly participantInput: TParticipantInput
  readonly query: Readonly<{
    readonly text: string
    readonly languageHint: string | null
  }>
}

export interface PersonalMemoryRecallSourceV1<TParticipantInput> {
  recall(
    input: PersonalMemoryRecallInputV1<TParticipantInput>,
    signal?: AbortSignal
  ): Promise<MemoryRetrievalResultV2>
}

export interface CreatePersonalMemoryRecallSourceOptionsV1<TParticipantInput> {
  readonly deploymentMode: () => PersonalMemoryDeploymentModeV1
  readonly groupAllowlist: () => readonly string[]
  readonly participants: PersonalMemoryParticipantDirectoryV1<TParticipantInput>
  readonly enrollment: PersonalMemoryEnrollmentPortV1
  readonly retriever: MemoryRetrievalAdapterV2
  readonly now?: () => Date
  readonly timeoutMs?: number
  readonly limits?: Readonly<{
    readonly maxCandidates: number
    readonly maxTokens: number
    readonly maxBytes: number
  }>
}

interface PersonalMemoryRecallLimitsV1 {
  readonly maxCandidates: number
  readonly maxTokens: number
  readonly maxBytes: number
}

const DEFAULT_LIMITS: PersonalMemoryRecallLimitsV1 = Object.freeze({
  maxCandidates: 6,
  maxTokens: 1_200,
  maxBytes: 32 * 1_024
})

function unavailable (
  reason: Extract<MemoryRetrievalResultV2, { status: 'unavailable' }>['reason']
): MemoryRetrievalResultV2 {
  return Object.freeze({ schemaVersion: 2 as const, status: 'unavailable' as const, reason })
}

function abortError (): DOMException {
  return new DOMException('operation was aborted', 'AbortError')
}

function throwIfAborted (signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
}

function trustedNow (source: () => Date): Date | null {
  let value: unknown
  try {
    value = source()
  } catch {
    return null
  }
  return value instanceof Date && Number.isFinite(value.getTime())
    ? new Date(value.getTime())
    : null
}

function deploymentMode (
  source: () => PersonalMemoryDeploymentModeV1
): PersonalMemoryDeploymentModeV1 | null {
  let value: unknown
  try {
    value = source()
  } catch {
    return null
  }
  return value === 'off' || value === 'explicit' || value === 'shadow' || value === 'automatic'
    ? value
    : null
}

function boundedQueryText (value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) return null
  let result = ''
  let bytes = 0
  let codePoints = 0
  for (const codePoint of normalized) {
    const nextBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + nextBytes > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.queryTextUtf8Bytes ||
      codePoints + 1 > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.queryTextCodePoints) break
    result += codePoint
    bytes += nextBytes
    codePoints += 1
  }
  return result.length === 0 ? null : result
}

function checkedTimeout (value: number | undefined): number {
  const timeout = value ?? MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxDurationMs
  if (!Number.isSafeInteger(timeout) || timeout <= 0 ||
    timeout > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxDurationMs) {
    throw new TypeError('personal memory recall timeout is invalid')
  }
  return timeout
}

function checkedLimits (
  value: CreatePersonalMemoryRecallSourceOptionsV1<unknown>['limits']
): PersonalMemoryRecallLimitsV1 {
  const limits = value ?? DEFAULT_LIMITS
  if (!Number.isSafeInteger(limits.maxCandidates) || limits.maxCandidates <= 0 ||
    limits.maxCandidates > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxCandidates ||
    !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens <= 0 ||
    limits.maxTokens > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxTokens ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 ||
    limits.maxBytes > MEMORY_RETRIEVAL_RESOURCE_LIMITS_V2.maxBytes) {
    throw new TypeError('personal memory recall limits are invalid')
  }
  return Object.freeze({ ...limits })
}

function policyScene (scene: SceneParticipantSceneV1) {
  return scene.kind === 'private'
    ? Object.freeze({ kind: 'private' as const })
    : Object.freeze({ kind: 'group' as const, groupId: scene.groupId })
}

async function withinDeadline<T> (
  operation: (signal: AbortSignal, deadline: Date) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  now: () => Date,
  timeoutMs: number
): Promise<T | MemoryRetrievalResultV2> {
  throwIfAborted(callerSignal)
  const startedAt = trustedNow(now)
  if (startedAt === null) return unavailable('policy_unavailable')
  const deadline = new Date(startedAt.getTime() + timeoutMs)
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = (): void => { controller.abort(callerSignal?.reason) }
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const pending = operation(controller.signal, deadline)
  const timeout = new Promise<MemoryRetrievalResultV2>(resolve => {
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort('personal_memory_recall_timeout')
      resolve(unavailable('deadline_exceeded'))
    }, timeoutMs)
    void pending.finally(() => { clearTimeout(timer) }).catch(() => undefined)
  })
  try {
    return await Promise.race([pending, timeout])
  } catch (error) {
    if (callerSignal?.aborted === true) throw abortError()
    if (timedOut || controller.signal.aborted) return unavailable('deadline_exceeded')
    throw error
  } finally {
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

export function createPersonalMemoryRecallSourceV1<TParticipantInput> (
  options: CreatePersonalMemoryRecallSourceOptionsV1<TParticipantInput>
): PersonalMemoryRecallSourceV1<TParticipantInput> {
  const now = options.now ?? (() => new Date())
  const timeoutMs = checkedTimeout(options.timeoutMs)
  const limits = checkedLimits(options.limits)
  const issuer = createMemoryAccessCapabilityIssuerV1(() => true)

  return Object.freeze({
    async recall (
      input: PersonalMemoryRecallInputV1<TParticipantInput>,
      callerSignal?: AbortSignal
    ) {
      throwIfAborted(callerSignal)
      const mode = deploymentMode(options.deploymentMode)
      if (mode === null) return unavailable('policy_unavailable')
      if (mode === 'off') return unavailable('disabled')

      let result: MemoryRetrievalResultV2
      try {
        result = await withinDeadline(async (signal, deadline) => {
          const observed = trustedNow(now)
          if (observed === null) return unavailable('policy_unavailable')
          const snapshot = await options.participants.resolve(input.participantInput, signal)
          throwIfAborted(signal)
          if (snapshot === null) return unavailable('policy_unavailable')

          let subjects: readonly PersonalMemorySubjectV1[]
          let scope: ReturnType<typeof buildPersonalMemoryAccessScopeV1>
          try {
            subjects = selectPersonalMemorySubjectsV1(Object.freeze({
              scene: snapshot.scene,
              current: snapshot.current,
              references: snapshot.references,
              now: observed.toISOString()
            }))
            scope = buildPersonalMemoryAccessScopeV1(Object.freeze({
              botInstanceId: input.botInstanceId,
              accountId: input.accountId,
              scene: snapshot.scene,
              subjects,
              now: observed.toISOString()
            }))
          } catch {
            return unavailable('policy_unavailable')
          }

          let access: ReturnType<typeof issueMemoryAccessCapabilityV1>
          try {
            access = issueMemoryAccessCapabilityV1(
              issuer,
              scope.context,
              scope.namespaces,
              observed.toISOString()
            )
          } catch {
            return unavailable('policy_unavailable')
          }

          const selected: Array<{
            subject: PersonalMemorySubjectV1
            namespace: typeof scope.namespaces[number]
          }> = []
          let canaryDenied = false
          let allowlist: readonly string[]
          try {
            allowlist = options.groupAllowlist()
          } catch {
            return unavailable('policy_unavailable')
          }
          for (const [index, subject] of subjects.entries()) {
            const namespace = scope.namespaces[index]
            if (namespace === undefined) return unavailable('policy_unavailable')
            const enrollment = await options.enrollment.read(Object.freeze({
              schemaVersion: 1 as const,
              namespace,
              access
            }), signal)
            throwIfAborted(signal)
            if (enrollment.status !== 'found') continue
            let decision: ReturnType<typeof decidePersonalMemoryPilotV1>
            try {
              decision = decidePersonalMemoryPilotV1(Object.freeze({
                deploymentMode: mode,
                enrollment: Object.freeze({
                  status: enrollment.policy.state,
                  candidateMode: enrollment.policy.candidateMode
                }),
                scene: policyScene(snapshot.scene),
                groupAllowlist: allowlist
              }))
            } catch {
              return unavailable('policy_unavailable')
            }
            if (decision.recall) selected.push({ subject, namespace })
            else if (decision.reason === 'group_not_allowed') canaryDenied = true
          }
          if (selected.length === 0) {
            return unavailable(canaryDenied ? 'not_in_canary' : 'not_opted_in')
          }

          const requestedAt = trustedNow(now)
          const queryText = boundedQueryText(input.query.text)
          if (requestedAt === null || queryText === null || requestedAt >= deadline) {
            return unavailable('deadline_exceeded')
          }
          let request: ReturnType<typeof parseMemoryRetrievalRequestV2>
          try {
            request = parseMemoryRetrievalRequestV2(Object.freeze({
              schemaVersion: 2 as const,
              capability: access,
              subjects: Object.freeze(selected.map(value => Object.freeze({
                namespaceRef: memoryNamespaceRefV1(value.namespace),
                reason: value.subject.reason
              }))),
              query: Object.freeze({
                text: queryText,
                languageHint: input.query.languageHint
              }),
              limits,
              requestedAt: requestedAt.toISOString(),
              deadlineAt: deadline.toISOString()
            }))
          } catch {
            return unavailable('policy_unavailable')
          }
          return await retrieveMemoryV2(options.retriever, request, { signal, now })
        }, callerSignal, now, timeoutMs) as MemoryRetrievalResultV2
      } catch {
        if (callerSignal?.aborted === true) throw abortError()
        return unavailable('policy_unavailable')
      }
      return result
    }
  })
}

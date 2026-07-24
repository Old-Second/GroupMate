import { types as utilTypes } from 'node:util'
import type {
  MemoryControlRepositoryPortV1,
  MemoryControlRepositoryResultV1
} from './memory-control-repository.js'
import {
  decodeMemoryExportCommandWireV1,
  type MemoryExportPortResultV1,
  type MemoryExportPortV1
} from './memory-export-port.js'
import type { MemoryLifecycleActorCapabilityV1 } from './memory-lifecycle-authority.js'
import {
  decodeMemoryLifecycleCommandWireV1,
  parseMemoryLifecycleCommandV1,
  type MemoryProposalApprovalMaterialV1,
  type MemoryRevisionChangeMaterialV1
} from './memory-lifecycle-command.js'
import type {
  MemoryLifecyclePortV1
} from './memory-lifecycle-port.js'
import type { MemoryLifecycleResultV1 } from './memory-lifecycle-result.js'
import {
  inspectMemoryRecord,
  invalidMemoryValue,
  memoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import {
  decodePersonalMemoryEnrollmentCommandWireV1,
  personalMemoryEnrollmentSourceSceneRefV1,
  type PersonalMemoryEnrollmentDecisionResultV1,
  type PersonalMemoryEnrollmentPortV1,
  type PersonalMemoryEnrollmentReadResultV1
} from './personal-memory-enrollment.js'
import { createMemoryPortSignalScopeV1 } from './memory-port-signal.js'

export const PERSONAL_MEMORY_OPT_OUT_NOTICE_ZH_V1 =
  '关闭个人长期记忆后会立即停止召回和新写入，但不会删除已经保存的长期记忆。'
export const PERSONAL_MEMORY_JOURNAL_BOUNDARY_NOTICE_ZH_V1 =
  '遗忘或删除长期记忆不会删除 GroupMate 的独立诊断日志；诊断日志按单独的保留策略清理。'
export const PERSONAL_MEMORY_EXPORT_BOUNDARY_NOTICE_ZH_V1 =
  '长期记忆导出不包含 GroupMate 的独立诊断日志、QQ 服务端历史或 Provider 日志。'

export type PersonalMemoryLifecycleFacadeOperationV1 =
  | 'enrollment.read'
  | 'enrollment.optIn'
  | 'enrollment.optOut'
  | 'remember'
  | 'list'
  | 'correct'
  | 'renew'
  | 'forget'
  | 'export'
  | 'delete'

export interface PersonalMemoryLifecycleFacadeRequestV1 {
  readonly schemaVersion: 1
  readonly operation: PersonalMemoryLifecycleFacadeOperationV1
  readonly namespace: MemoryNamespaceV1
  readonly payload: unknown
}

export type PersonalMemoryLifecycleFacadeDelegateResultV1 =
  | PersonalMemoryEnrollmentReadResultV1
  | PersonalMemoryEnrollmentDecisionResultV1
  | MemoryLifecycleResultV1
  | MemoryControlRepositoryResultV1
  | MemoryExportPortResultV1
  | { readonly status: 'enrollment_required' }
  | {
      readonly status: 'enrollment_unavailable'
      readonly category: 'denied' | 'corrupt' | 'unavailable'
    }

export interface PersonalMemoryLifecycleFacadeResultV1 {
  readonly schemaVersion: 1
  readonly operation: PersonalMemoryLifecycleFacadeOperationV1
  readonly result: PersonalMemoryLifecycleFacadeDelegateResultV1
  readonly notices: readonly string[]
}

export interface PersonalMemoryLifecycleFacadeV1 {
  readonly execute: (
    request: unknown,
    signal?: AbortSignal
  ) => Promise<PersonalMemoryLifecycleFacadeResultV1>
}

export interface CreatePersonalMemoryLifecycleFacadeOptionsV1 {
  readonly enrollment: PersonalMemoryEnrollmentPortV1
  readonly lifecycle: MemoryLifecyclePortV1
  readonly control: MemoryControlRepositoryPortV1
  readonly export: MemoryExportPortV1
}

const OPERATIONS = Object.freeze([
  'enrollment.read', 'enrollment.optIn', 'enrollment.optOut', 'remember', 'list',
  'correct', 'renew', 'forget', 'export', 'delete'
] as const)

function dataRecord (
  value: unknown,
  allowSymbols: boolean
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value)) return invalidMemoryValue()
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    return invalidMemoryValue()
  }
  if (prototype !== Object.prototype || (!allowSymbols &&
    keys.some(key => typeof key !== 'string'))) {
    return invalidMemoryValue()
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) return invalidMemoryValue()
    if (typeof key === 'string') result[key] = descriptor.value
  }
  return result
}

function plainDataRecord (value: unknown): Readonly<Record<string, unknown>> {
  return dataRecord(value, false)
}

function capabilityDataRecord (value: unknown): Readonly<Record<string, unknown>> {
  return dataRecord(value, true)
}

function dataField (value: unknown, field: string): unknown {
  const record = plainDataRecord(value)
  if (!Object.hasOwn(record, field)) return invalidMemoryValue()
  return record[field]
}

function capabilityField (value: unknown, field: string): unknown {
  const record = capabilityDataRecord(value)
  if (!Object.hasOwn(record, field)) return invalidMemoryValue()
  return record[field]
}

function enumOperation (value: unknown): PersonalMemoryLifecycleFacadeOperationV1 {
  if (typeof value !== 'string' || !OPERATIONS.includes(
    value as PersonalMemoryLifecycleFacadeOperationV1
  )) return invalidMemoryValue()
  return value as PersonalMemoryLifecycleFacadeOperationV1
}

function parseRequest (value: unknown): PersonalMemoryLifecycleFacadeRequestV1 {
  const input = inspectMemoryRecord(value, [
    'schemaVersion', 'operation', 'namespace', 'payload'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const namespace = parseMemoryNamespaceV1(input.namespace)
  if (namespace.scope.kind !== 'personal') return invalidMemoryValue()
  plainDataRecord(input.payload)
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: enumOperation(input.operation),
    namespace,
    payload: input.payload
  })
}

function actorIsPersonalSubject (value: unknown): value is MemoryLifecycleActorCapabilityV1 {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) return false
  const record = capabilityDataRecord(value)
  return record.role === 'personal_subject'
}

function requirePersonalLifecyclePayload (
  payload: unknown,
  namespace: MemoryNamespaceV1,
  operation:
    | 'proposal.createAndApprove'
    | 'record.correct'
    | 'record.renew'
    | 'record.forget'
    | 'namespace.delete'
): {
    readonly access: Readonly<Record<string, unknown>>
    readonly command: ReturnType<typeof parseMemoryLifecycleCommandV1>
  } {
  const input = inspectMemoryRecord(payload, [
    'schemaVersion', 'command', 'access', 'authority'
  ])
  if (input.schemaVersion !== 1) return invalidMemoryValue()
  const command = parseMemoryLifecycleCommandV1(input.command)
  const wire = decodeMemoryLifecycleCommandWireV1(command.wire)
  const authority = inspectMemoryRecord(input.authority, ['kind', 'capability'])
  const access = capabilityDataRecord(input.access)
  if (wire.operation !== operation || wire.namespaceRef !== memoryNamespaceRefV1(namespace) ||
    authority.kind !== 'actor' || !actorIsPersonalSubject(authority.capability) ||
    capabilityField(authority.capability, 'namespaceRef') !== wire.namespaceRef ||
    capabilityField(authority.capability, 'generation') !== wire.expectedNamespaceGeneration ||
    capabilityField(authority.capability, 'actorRef') !== wire.initiatedByActorRef ||
    capabilityField(input.access, 'botInstanceId') !== namespace.botInstanceId ||
    capabilityField(input.access, 'accountId') !== namespace.accountId) return invalidMemoryValue()
  return Object.freeze({ access, command })
}

function requireSelfCurrentSource (
  source: unknown,
  namespace: MemoryNamespaceV1,
  access: Readonly<Record<string, unknown>>
): void {
  if (source === null || typeof source !== 'object') return invalidMemoryValue()
  const sourceRecord = plainDataRecord(source)
  const actor = plainDataRecord(sourceRecord.actor)
  if (namespace.scope.kind !== 'personal' || sourceRecord.sourceKind !== 'current_message' ||
    actor.userId !== namespace.scope.subjectUserId ||
    personalMemoryEnrollmentSourceSceneRefV1(source) !== access.sceneRef) {
    return invalidMemoryValue()
  }
}

function validateRememberPayload (payload: unknown, namespace: MemoryNamespaceV1): void {
  const bound = requirePersonalLifecyclePayload(
    payload,
    namespace,
    'proposal.createAndApprove'
  )
  const material = bound.command.material as MemoryProposalApprovalMaterialV1
  if (material === null || material.kind !== 'proposal_approval_v1' ||
    material.proposal.namespaceRef !== memoryNamespaceRefV1(namespace) ||
    material.proposal.proposedBy.kind !== 'user') return invalidMemoryValue()
  requireSelfCurrentSource(material.proposal.sources[0], namespace, bound.access)
  requireSelfCurrentSource(material.consentEvidence.source, namespace, bound.access)
}

function validateRevisionPayload (
  payload: unknown,
  namespace: MemoryNamespaceV1,
  operation: 'record.correct' | 'record.renew'
): void {
  const bound = requirePersonalLifecyclePayload(payload, namespace, operation)
  const material = bound.command.material as MemoryRevisionChangeMaterialV1
  if (material === null || material.kind !== 'revision_change_v1' ||
    material.evidence.evidenceKind !== 'explicit') return invalidMemoryValue()
  requireSelfCurrentSource(material.evidence.source, namespace, bound.access)
}

function validateListPayload (payload: unknown, namespace: MemoryNamespaceV1): void {
  const operation = dataField(payload, 'operation')
  if (operation !== 'record.inspectList' ||
    dataField(payload, 'namespaceRef') !== memoryNamespaceRefV1(namespace) ||
    !actorIsPersonalSubject(dataField(payload, 'actor'))) return invalidMemoryValue()
}

function validateExportPayload (payload: unknown, namespace: MemoryNamespaceV1): void {
  const input = inspectMemoryRecord(payload, ['schemaVersion', 'command', 'access', 'actor'])
  if (input.schemaVersion !== 1 || !actorIsPersonalSubject(input.actor)) {
    return invalidMemoryValue()
  }
  const command = inspectMemoryRecord(input.command, ['wire'])
  const wire = decodeMemoryExportCommandWireV1(command.wire)
  if (wire.namespaceRef !== memoryNamespaceRefV1(namespace) ||
    capabilityField(input.actor, 'namespaceRef') !== wire.namespaceRef ||
    capabilityField(input.actor, 'generation') !== wire.expectedNamespaceGeneration ||
    capabilityField(input.actor, 'actorRef') !== wire.initiatedByActorRef) {
    return invalidMemoryValue()
  }
}

function noticesFor (
  operation: PersonalMemoryLifecycleFacadeOperationV1
): readonly string[] {
  if (operation === 'enrollment.optOut') {
    return Object.freeze([PERSONAL_MEMORY_OPT_OUT_NOTICE_ZH_V1])
  }
  if (operation === 'forget' || operation === 'delete') {
    return Object.freeze([PERSONAL_MEMORY_JOURNAL_BOUNDARY_NOTICE_ZH_V1])
  }
  if (operation === 'export') {
    return Object.freeze([PERSONAL_MEMORY_EXPORT_BOUNDARY_NOTICE_ZH_V1])
  }
  return Object.freeze([])
}

function result (
  operation: PersonalMemoryLifecycleFacadeOperationV1,
  delegateResult: PersonalMemoryLifecycleFacadeDelegateResultV1
): PersonalMemoryLifecycleFacadeResultV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation,
    result: delegateResult,
    notices: noticesFor(operation)
  })
}

function parseOptions (
  value: CreatePersonalMemoryLifecycleFacadeOptionsV1
): CreatePersonalMemoryLifecycleFacadeOptionsV1 {
  const input = inspectMemoryRecord(value, [
    'enrollment', 'lifecycle', 'control', 'export'
  ])
  for (const [port, methods] of [
    [input.enrollment, ['read', 'decide']],
    [input.lifecycle, ['execute']],
    [input.control, ['execute']],
    [input.export, ['execute']]
  ] as const) {
    const record = plainDataRecord(port)
    for (const method of methods) {
      if (typeof record[method] !== 'function' || utilTypes.isProxy(record[method])) {
        return invalidMemoryValue()
      }
    }
  }
  return Object.freeze({
    enrollment: input.enrollment as PersonalMemoryEnrollmentPortV1,
    lifecycle: input.lifecycle as MemoryLifecyclePortV1,
    control: input.control as MemoryControlRepositoryPortV1,
    export: input.export as MemoryExportPortV1
  })
}

export function createPersonalMemoryLifecycleFacadeV1 (
  optionsValue: CreatePersonalMemoryLifecycleFacadeOptionsV1
): PersonalMemoryLifecycleFacadeV1 {
  const options = parseOptions(optionsValue)

  const execute = async (
    requestValue: unknown,
    signal?: AbortSignal
  ): Promise<PersonalMemoryLifecycleFacadeResultV1> => {
    const signalScope = createMemoryPortSignalScopeV1(signal)
    try {
      const request = parseRequest(requestValue)
      const payload = request.payload
      if (request.operation === 'enrollment.read') {
        return result(request.operation, await options.enrollment.read(payload, signalScope.signal))
      }
      if (request.operation === 'enrollment.optIn' ||
        request.operation === 'enrollment.optOut') {
        const command = dataField(payload, 'command')
        const wire = decodePersonalMemoryEnrollmentCommandWireV1(dataField(command, 'wire'))
        const expected = request.operation === 'enrollment.optIn'
          ? 'enrollment.optIn'
          : 'enrollment.optOut'
        if (wire.operation !== expected || wire.namespaceRef !==
          memoryNamespaceRefV1(request.namespace)) return invalidMemoryValue()
        return result(
          request.operation,
          await options.enrollment.decide(payload, signalScope.signal)
        )
      }
      if (request.operation === 'remember') {
        validateRememberPayload(payload, request.namespace)
        const enrollmentRead = await options.enrollment.read({
          schemaVersion: 1,
          namespace: request.namespace,
          access: dataField(payload, 'access')
        }, signalScope.signal)
        if (enrollmentRead.status === 'not_enrolled') {
          return result(request.operation, Object.freeze({ status: 'enrollment_required' as const }))
        }
        if (enrollmentRead.status !== 'found' || enrollmentRead.policy.state !== 'opted_in') {
          const category = enrollmentRead.status === 'denied'
            ? 'denied' as const
            : enrollmentRead.status === 'corrupt'
              ? 'corrupt' as const
              : 'unavailable' as const
          return result(request.operation, Object.freeze({
            status: 'enrollment_unavailable' as const,
            category
          }))
        }
        return result(
          request.operation,
          await options.lifecycle.execute(payload, signalScope.signal)
        )
      }
      if (request.operation === 'list') {
        validateListPayload(payload, request.namespace)
        return result(request.operation, await options.control.execute(payload, signalScope.signal))
      }
      if (request.operation === 'correct' || request.operation === 'renew') {
        validateRevisionPayload(
          payload,
          request.namespace,
          request.operation === 'correct' ? 'record.correct' : 'record.renew'
        )
        return result(request.operation, await options.lifecycle.execute(payload, signalScope.signal))
      }
      if (request.operation === 'forget' || request.operation === 'delete') {
        requirePersonalLifecyclePayload(
          payload,
          request.namespace,
          request.operation === 'forget' ? 'record.forget' : 'namespace.delete'
        )
        return result(request.operation, await options.lifecycle.execute(payload, signalScope.signal))
      }
      validateExportPayload(payload, request.namespace)
      return result(request.operation, await options.export.execute(payload, signalScope.signal))
    } finally {
      signalScope.close()
    }
  }

  return Object.freeze({ execute })
}

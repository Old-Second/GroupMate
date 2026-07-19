import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { MEMORY_RESOURCE_LIMITS } from './memory-resource-limits.js'

export const MEMORY_NAMESPACE_HASH_DOMAIN = 'groupmate.memory.namespace.v1'

declare const memoryNamespaceRefBrand: unique symbol
export type MemoryNamespaceRefV1 = string & {
  readonly [memoryNamespaceRefBrand]: 'MemoryNamespaceRefV1'
}

declare const runScopedContextRefBrand: unique symbol
export type RunScopedContextRefV1 = string & {
  readonly [runScopedContextRefBrand]: 'RunScopedContextRefV1'
}

export type MemoryScopeV1 =
  | {
      readonly kind: 'personal'
      readonly subjectUserId: string
    }
  | {
      readonly kind: 'group'
      readonly groupId: string
      readonly groupLifecycleId: string
    }

export interface MemoryNamespaceV1 {
  readonly schemaVersion: 1
  readonly botInstanceId: string
  readonly adapter: 'qq'
  readonly accountId: string
  readonly scope: MemoryScopeV1
}

const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const CANONICAL_QQ_ID = /^[1-9][0-9]*$/
const MEMORY_NAMESPACE_REF = /^[0-9a-f]{64}$/

export function invalidMemoryValue (): never {
  throw new TypeError('invalid canonical memory value')
}

export function inspectMemoryRecord (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value)) return invalidMemoryValue()
  let prototype: object | null
  let descriptors: Record<string, PropertyDescriptor>
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    descriptors = Object.getOwnPropertyDescriptors(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return invalidMemoryValue()
  }
  if (prototype !== Object.prototype || keys.some(key => typeof key !== 'string')) {
    return invalidMemoryValue()
  }
  const allowed = new Set([...required, ...optional])
  if (keys.some(key => !allowed.has(key as string)) ||
    required.some(key => !Object.hasOwn(descriptors, key))) return invalidMemoryValue()
  const result: Record<string, unknown> = {}
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) return invalidMemoryValue()
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

export function inspectMemoryArray (value: unknown, maximumLength: number): readonly unknown[] {
  if (value === null || typeof value !== 'object' || !Array.isArray(value) ||
    utilTypes.isProxy(value) || !Number.isSafeInteger(maximumLength) || maximumLength < 0) {
    return invalidMemoryValue()
  }
  let prototype: object | null
  let descriptors: Record<string, PropertyDescriptor>
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    descriptors = Object.getOwnPropertyDescriptors(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return invalidMemoryValue()
  }
  const lengthDescriptor = descriptors.length
  if (prototype !== Array.prototype || lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength || keys.some(key => typeof key !== 'string')) {
    return invalidMemoryValue()
  }
  const length = lengthDescriptor.value as number
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))])
  if (keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key as string))) {
    return invalidMemoryValue()
  }
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) return invalidMemoryValue()
    result.push(descriptor.value)
  }
  return result
}

function codePoints (value: string): number {
  return Array.from(value).length
}

export function parseMemoryBotInstanceIdV1 (value: unknown): string {
  if (typeof value !== 'string' || value.length > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
    value.normalize('NFC') !== value ||
    codePoints(value) > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
    !CANONICAL_IDENTIFIER.test(value)) return invalidMemoryValue()
  return value
}

export function parseMemoryGroupLifecycleIdV1 (value: unknown): string {
  if (typeof value !== 'string' || value.length > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
    value.normalize('NFC') !== value ||
    codePoints(value) > MEMORY_RESOURCE_LIMITS.identifierCodePoints ||
    !CANONICAL_IDENTIFIER.test(value)) return invalidMemoryValue()
  return value
}

export function parseMemoryQqIdV1 (value: unknown): string {
  if (typeof value !== 'string' || value.length > MEMORY_RESOURCE_LIMITS.qqIdDigits ||
    !CANONICAL_QQ_ID.test(value)) return invalidMemoryValue()
  return value
}

function parseMemoryScopeV1 (value: unknown): MemoryScopeV1 {
  const discriminator = inspectMemoryRecord(
    value,
    ['kind'],
    ['subjectUserId', 'groupId', 'groupLifecycleId']
  )
  if (discriminator.kind === 'personal') {
    const input = inspectMemoryRecord(value, ['kind', 'subjectUserId'])
    return Object.freeze({
      kind: 'personal' as const,
      subjectUserId: parseMemoryQqIdV1(input.subjectUserId)
    })
  }
  if (discriminator.kind === 'group') {
    const input = inspectMemoryRecord(value, ['kind', 'groupId', 'groupLifecycleId'])
    return Object.freeze({
      kind: 'group' as const,
      groupId: parseMemoryQqIdV1(input.groupId),
      groupLifecycleId: parseMemoryGroupLifecycleIdV1(input.groupLifecycleId)
    })
  }
  return invalidMemoryValue()
}

function parseMemoryNamespaceFields (
  value: unknown,
  includeSchemaVersion: boolean
): MemoryNamespaceV1 {
  const keys = ['botInstanceId', 'adapter', 'accountId', 'scope']
  const input = inspectMemoryRecord(
    value,
    includeSchemaVersion ? ['schemaVersion', ...keys] : keys
  )
  if (includeSchemaVersion && input.schemaVersion !== 1) return invalidMemoryValue()
  if (input.adapter !== 'qq') return invalidMemoryValue()
  return Object.freeze({
    schemaVersion: 1 as const,
    botInstanceId: parseMemoryBotInstanceIdV1(input.botInstanceId),
    adapter: 'qq' as const,
    accountId: parseMemoryQqIdV1(input.accountId),
    scope: parseMemoryScopeV1(input.scope)
  })
}

export function createMemoryNamespaceV1 (value: unknown): MemoryNamespaceV1 {
  return parseMemoryNamespaceFields(value, false)
}

export function parseMemoryNamespaceV1 (value: unknown): MemoryNamespaceV1 {
  return parseMemoryNamespaceFields(value, true)
}

export function memoryNamespaceWireV1 (value: MemoryNamespaceV1): string {
  const namespace = parseMemoryNamespaceV1(value)
  const scope = namespace.scope.kind === 'personal'
    ? `{"kind":"personal","subjectUserId":${JSON.stringify(namespace.scope.subjectUserId)}}`
    : `{"kind":"group","groupId":${JSON.stringify(namespace.scope.groupId)},"groupLifecycleId":${JSON.stringify(namespace.scope.groupLifecycleId)}}`
  return `{"schemaVersion":1,"botInstanceId":${JSON.stringify(namespace.botInstanceId)},"adapter":"qq","accountId":${JSON.stringify(namespace.accountId)},"scope":${scope}}`
}

export function memoryNamespaceRefV1 (value: MemoryNamespaceV1): MemoryNamespaceRefV1 {
  return createHash('sha256')
    .update(MEMORY_NAMESPACE_HASH_DOMAIN, 'utf8')
    .update('\0')
    .update(memoryNamespaceWireV1(value), 'utf8')
    .digest('hex') as MemoryNamespaceRefV1
}

export function parseMemoryNamespaceRefV1 (value: unknown): MemoryNamespaceRefV1 {
  if (typeof value !== 'string' || !MEMORY_NAMESPACE_REF.test(value)) {
    return invalidMemoryValue()
  }
  return value as MemoryNamespaceRefV1
}

export function parseRunScopedContextRefV1 (value: unknown): RunScopedContextRefV1 {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
    return invalidMemoryValue()
  }
  return value as RunScopedContextRefV1
}

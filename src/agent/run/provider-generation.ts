import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  parseProviderRequestMetadata,
  type ProviderRequestMetadata
} from '../model/model-adapter.js'
import { parseJsonValue, type JsonObject } from '../model/json-value.js'
import { RUN_RESOURCE_LIMITS } from './run-limits.js'

export const PROVIDER_REQUEST_PROTOCOL_VERSION = 'openai-chat-completions-v1'
export const PROVIDER_REQUEST_SCOPE_HASH_DOMAIN = 'groupmate.provider-request-scope.v1'

export type ProviderGenerationKindV1 = 'normal' | 'correction' | 'context_recovery'

export interface ProviderRequestWireIdentityV1 {
  readonly requestHash: string
  readonly requestBytes: number
  readonly requestProtocolVersion: typeof PROVIDER_REQUEST_PROTOCOL_VERSION
}

export interface FrozenProviderGenerationV1 {
  readonly schemaVersion: 1
  readonly generation: number
  readonly kind: ProviderGenerationKindV1
  readonly planHash: string
  readonly requestHash: string
  readonly requestBytes: number
  readonly requestProtocolVersion: typeof PROVIDER_REQUEST_PROTOCOL_VERSION
  readonly scopeFingerprint: string
  readonly ambiguityRecoveryUsed: boolean
}

export type FrozenProviderGenerationDraftV1 = Omit<
FrozenProviderGenerationV1,
'schemaVersion'
>

const HASH = /^[0-9a-f]{64}$/
const KINDS: readonly ProviderGenerationKindV1[] = [
  'normal', 'correction', 'context_recovery'
]
const KEYS = Object.freeze([
  'schemaVersion', 'generation', 'kind', 'planHash', 'requestHash', 'requestBytes',
  'requestProtocolVersion', 'scopeFingerprint', 'ambiguityRecoveryUsed'
])

function record (value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value)) throw new TypeError('provider generation is invalid')
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) {
      throw new TypeError()
    }
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.some(key => typeof key !== 'string')) throw new TypeError()
    const output: Record<string, unknown> = {}
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true) throw new TypeError()
      output[key] = descriptor.value
    }
    return output
  } catch {
    throw new TypeError('provider generation is invalid')
  }
}

function parseFields (value: unknown, includeSchemaVersion: boolean): FrozenProviderGenerationV1 {
  const input = record(value)
  const expected = includeSchemaVersion ? KEYS : KEYS.slice(1)
  const actual = Object.keys(input)
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key)) ||
    (includeSchemaVersion && input.schemaVersion !== 1) ||
    !Number.isSafeInteger(input.generation) || Number(input.generation) <= 0 ||
    typeof input.kind !== 'string' || !KINDS.includes(input.kind as ProviderGenerationKindV1) ||
    typeof input.planHash !== 'string' || !HASH.test(input.planHash) ||
    typeof input.requestHash !== 'string' || !HASH.test(input.requestHash) ||
    !Number.isSafeInteger(input.requestBytes) || Number(input.requestBytes) <= 0 ||
    Number(input.requestBytes) > RUN_RESOURCE_LIMITS.requestBytes ||
    input.requestProtocolVersion !== PROVIDER_REQUEST_PROTOCOL_VERSION ||
    typeof input.scopeFingerprint !== 'string' || !HASH.test(input.scopeFingerprint) ||
    typeof input.ambiguityRecoveryUsed !== 'boolean') {
    throw new TypeError('provider generation is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    generation: Number(input.generation),
    kind: input.kind as ProviderGenerationKindV1,
    planHash: input.planHash,
    requestHash: input.requestHash,
    requestBytes: Number(input.requestBytes),
    requestProtocolVersion: PROVIDER_REQUEST_PROTOCOL_VERSION,
    scopeFingerprint: input.scopeFingerprint,
    ambiguityRecoveryUsed: input.ambiguityRecoveryUsed
  })
}

export function createFrozenProviderGenerationV1 (
  value: FrozenProviderGenerationDraftV1
): FrozenProviderGenerationV1 {
  return parseFields(value, false)
}

export function parseFrozenProviderGenerationV1 (
  value: unknown
): FrozenProviderGenerationV1 {
  return parseFields(value, true)
}

export function providerRequestScopeFingerprint (
  metadata: ProviderRequestMetadata | undefined
): string {
  const isolationId = metadata === undefined
    ? 'absent'
    : parseProviderRequestMetadata(metadata).cacheIsolationId
  return createHash('sha256')
    .update(PROVIDER_REQUEST_SCOPE_HASH_DOMAIN, 'ascii')
    .update('\0', 'ascii')
    .update(isolationId, 'utf8')
    .digest('hex')
}

export function providerRequestWireIdentity (
  value: JsonObject
): ProviderRequestWireIdentityV1 {
  let encoded: string
  try {
    const body = parseJsonValue(value, {
      maxBytes: RUN_RESOURCE_LIMITS.requestBytes,
      maxDepth: 32,
      maxNodes: 32_768
    })
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new TypeError()
    encoded = JSON.stringify(body)
  } catch {
    throw new TypeError('provider request wire identity is invalid')
  }
  const requestBytes = Buffer.byteLength(encoded, 'utf8')
  if (requestBytes <= 0 || requestBytes > RUN_RESOURCE_LIMITS.requestBytes) {
    throw new TypeError('provider request wire identity is invalid')
  }
  return Object.freeze({
    requestHash: createHash('sha256')
      .update(PROVIDER_REQUEST_PROTOCOL_VERSION, 'ascii')
      .update('\0', 'ascii')
      .update(encoded, 'utf8')
      .digest('hex'),
    requestBytes,
    requestProtocolVersion: PROVIDER_REQUEST_PROTOCOL_VERSION
  })
}

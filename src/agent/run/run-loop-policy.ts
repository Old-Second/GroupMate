import { types as utilTypes } from 'node:util'

export type RunModelLoopPolicyV1 = Readonly<
  | {
      schemaVersion: 1
      kind: 'legacy_fixed'
      maxModelTurns: 6
      maxEstimatedTokens: 49_152 | 196_608
    }
  | {
      schemaVersion: 1
      kind: 'adaptive_context'
    }
>

export const ADAPTIVE_CONTEXT_LOOP_POLICY: RunModelLoopPolicyV1 = Object.freeze({
  schemaVersion: 1,
  kind: 'adaptive_context'
})

export function parseRunModelLoopPolicyV1 (value: unknown): RunModelLoopPolicyV1 {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) ||
    Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('run model loop policy is invalid')
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (input.schemaVersion !== 1) throw new TypeError('run model loop policy is invalid')
  if (input.kind === 'adaptive_context') {
    if (keys.length !== 2 || !keys.includes('schemaVersion') || !keys.includes('kind')) {
      throw new TypeError('run model loop policy is invalid')
    }
    return ADAPTIVE_CONTEXT_LOOP_POLICY
  }
  if (input.kind !== 'legacy_fixed' || keys.length !== 4 ||
    !['schemaVersion', 'kind', 'maxModelTurns', 'maxEstimatedTokens']
      .every(key => keys.includes(key)) || input.maxModelTurns !== 6 ||
    (input.maxEstimatedTokens !== 49_152 && input.maxEstimatedTokens !== 196_608)) {
    throw new TypeError('run model loop policy is invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'legacy_fixed',
    maxModelTurns: 6,
    maxEstimatedTokens: input.maxEstimatedTokens
  })
}

export function legacyFixedLoopPolicy (
  maxEstimatedTokens: 49_152 | 196_608
): RunModelLoopPolicyV1 {
  return parseRunModelLoopPolicyV1({
    schemaVersion: 1,
    kind: 'legacy_fixed',
    maxModelTurns: 6,
    maxEstimatedTokens
  })
}

import { parseJsonValue, type JsonObject, type JsonValue } from './json-value.js'
import { RUN_RESOURCE_LIMITS } from '../run/run-limits.js'

function hasLoneSurrogate (value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function jsonEqual (left: JsonValue, right: JsonValue): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return Object.is(left, right)
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index] as JsonValue))
  }
  const leftObject = left as JsonObject
  const rightObject = right as JsonObject
  const leftKeys = Object.keys(leftObject).sort()
  const rightKeys = Object.keys(rightObject).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => (
    key === rightKeys[index] && jsonEqual(
      leftObject[key] as JsonValue,
      rightObject[key] as JsonValue
    )
  ))
}

export function parseExactToolArgumentsText (
  value: unknown,
  expectedArguments: JsonObject
): string {
  if (typeof value !== 'string' || hasLoneSurrogate(value) ||
    Buffer.byteLength(value, 'utf8') > RUN_RESOURCE_LIMITS.toolArgumentsBytes) {
    throw new TypeError('tool arguments text is invalid')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new TypeError('tool arguments text is invalid')
  }
  const parsed = parseJsonValue(decoded, {
    maxBytes: RUN_RESOURCE_LIMITS.toolArgumentsBytes,
    maxDepth: 8,
    maxNodes: 512
  })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
    !jsonEqual(parsed, expectedArguments)) {
    throw new TypeError('tool arguments text does not match arguments')
  }
  return value
}

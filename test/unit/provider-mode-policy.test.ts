import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveProviderMode,
  unsupportedProviderMessage
} from '../../src/runtime/provider-mode-policy.js'

const nonMigratedCases = [
  undefined,
  null,
  '',
  'default',
  'api'
] as const

for (const value of nonMigratedCases) {
  test(`resolves the supported default mode without migration: ${String(value)}`, () => {
    assert.deepEqual(resolveProviderMode(value), {
      mode: 'api',
      migrated: false
    })
  })
}

const migratedCases = [
  'api3',
  'bing',
  'browser',
  'claude',
  'claude2',
  'gemini',
  'qwen',
  'chatglm',
  'chatglm4',
  'xh',
  'azure',
  'API',
  ' api ',
  'arbitrary-provider',
  0,
  false,
  {},
  []
] as const

for (const value of migratedCases) {
  test(`migrates an unsupported provider value without coercion: ${typeof value}`, () => {
    assert.deepEqual(resolveProviderMode(value), {
      mode: 'api',
      migrated: true
    })
  })
}

test('does not invoke hostile conversion hooks while resolving a provider mode', () => {
  let calls = 0
  const hostile = Object.create(null)
  for (const key of ['toString', 'valueOf', Symbol.toPrimitive]) {
    Object.defineProperty(hostile, key, {
      get () {
        calls += 1
        throw new Error('hostile provider mode conversion')
      }
    })
  }

  assert.deepEqual(resolveProviderMode(hostile), {
    mode: 'api',
    migrated: true
  })
  assert.equal(calls, 0)
})

test('exports the fixed unsupported provider message', () => {
  assert.equal(
    unsupportedProviderMessage,
    '该模型模式已不再支持，GroupMate 当前仅支持 OpenAI-compatible API'
  )
})

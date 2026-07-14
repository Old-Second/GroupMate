import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  formatOnlineSmokeFailure,
  readOnlineOpenAIConfig,
  runOnlineOpenAISmoke
} from '../../scripts/smoke-openai-compatible.mjs'

const execFileAsync = promisify(execFile)
const completeEnv = {
  GROUPMATE_RUN_ONLINE_OPENAI: '1',
  GROUPMATE_OPENAI_BASE_URL: 'https://fixture.invalid/v1',
  GROUPMATE_OPENAI_API_KEY: 'fixture-key',
  GROUPMATE_OPENAI_MODEL: 'fixture-model',
  GROUPMATE_OPENAI_PROFILE: 'deepseek'
}
const sensitiveValues = [
  'fixture-key',
  'https://fixture.invalid/v1',
  'fixture-model',
  'fixture online response'
]

function assertContainsNoSensitiveValues (output) {
  for (const secret of sensitiveValues) {
    assert.doesNotMatch(
      output,
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
  }
}

function failureOutput (errorCode) {
  return JSON.stringify({
    ok: false,
    selectedProfile: 'unknown',
    selectionSource: 'unknown',
    status: 'failed',
    errorCode,
    latencyMs: 0,
    responseCharacters: 0
  })
}

test('online smoke requires opt-in and complete configuration before facade creation', async t => {
  assert.throws(() => readOnlineOpenAIConfig({}), error => (
    error.code === 'ONLINE_OPENAI_DISABLED'
  ))
  for (const missing of [
    'GROUPMATE_OPENAI_BASE_URL',
    'GROUPMATE_OPENAI_API_KEY',
    'GROUPMATE_OPENAI_MODEL'
  ]) {
    await t.test(missing, () => {
      const env = { ...completeEnv }
      delete env[missing]
      assert.throws(() => readOnlineOpenAIConfig(env), error => (
        error.code === 'ONLINE_OPENAI_CONFIG_MISSING' &&
        error.missingVariables.length === 1 && error.missingVariables[0] === missing
      ))
    })
  }
  assert.deepEqual(readOnlineOpenAIConfig({
    ...completeEnv,
    GROUPMATE_OPENAI_PROFILE: undefined
  }), {
    endpoint: completeEnv.GROUPMATE_OPENAI_BASE_URL,
    apiKey: completeEnv.GROUPMATE_OPENAI_API_KEY,
    model: completeEnv.GROUPMATE_OPENAI_MODEL,
    profile: 'standard',
    selectionSource: 'default'
  })
  assert.throws(() => readOnlineOpenAIConfig({
    ...completeEnv,
    GROUPMATE_OPENAI_PROFILE: 'auto'
  }), error => error.code === 'ONLINE_OPENAI_PROFILE_INVALID')
})

test('disabled online smoke never constructs a facade or writes output', async () => {
  let createCalls = 0
  const writes = []
  await assert.rejects(runOnlineOpenAISmoke({
    env: {},
    createFacade: () => {
      createCalls += 1
      throw new Error('forbidden')
    },
    write: value => writes.push(value)
  }), error => error.code === 'ONLINE_OPENAI_DISABLED')
  assert.equal(createCalls, 0)
  assert.deepEqual(writes, [])
})

test('online smoke uses one restricted completion and emits redacted fixed metadata', async () => {
  const createOptions = []
  const completionCalls = []
  const writes = []
  const ticks = [100, 125]
  const result = await runOnlineOpenAISmoke({
    env: completeEnv,
    createFacade: options => {
      createOptions.push(options)
      return {
        async completeText (input, signal) {
          completionCalls.push({ input, signal })
          return 'fixture online response'
        }
      }
    },
    write: value => writes.push(value),
    now: () => ticks.shift()
  })
  assert.deepEqual(createOptions, [{
    endpoint: completeEnv.GROUPMATE_OPENAI_BASE_URL,
    apiKey: completeEnv.GROUPMATE_OPENAI_API_KEY,
    model: completeEnv.GROUPMATE_OPENAI_MODEL,
    openAiCompatibilityProfile: 'deepseek',
    timeoutMs: 20_000,
    temperature: 0
  }])
  assert.equal(completionCalls.length, 1)
  assert.deepEqual(completionCalls[0].input, {
    purpose: 'smoke',
    messages: [
      { role: 'system', content: 'Reply briefly.' },
      { role: 'user', content: 'Reply with OK.' }
    ],
    maxOutputTokens: 32
  })
  assert.equal(completionCalls[0].signal instanceof AbortSignal, true)
  assert.deepEqual(result, {
    ok: true,
    selectedProfile: 'deepseek',
    selectionSource: 'explicit',
    status: 'completed',
    errorCode: null,
    latencyMs: 25,
    responseCharacters: 23
  })
  assert.deepEqual(writes, [JSON.stringify(result)])
  assertContainsNoSensitiveValues(writes.join(''))
})

test('online smoke classifies empty and provider failures without leaking details', async () => {
  const writes = []
  let providerFailure
  const ticks = [10, 17]
  await assert.rejects(runOnlineOpenAISmoke({
    env: completeEnv,
    createFacade: () => ({ completeText: async () => '   ' }),
    write: value => writes.push(value)
  }), error => error.code === 'ONLINE_OPENAI_EMPTY_RESPONSE')
  await assert.rejects(runOnlineOpenAISmoke({
    env: completeEnv,
    createFacade: () => ({
      completeText: async () => {
        throw new Error(sensitiveValues.join(' '))
      }
    }),
    write: value => writes.push(value),
    now: () => ticks.shift()
  }), error => {
    providerFailure = error
    return error.code === 'ONLINE_OPENAI_REQUEST_FAILED'
  })
  assert.deepEqual(writes, [])
  assert.deepEqual(formatOnlineSmokeFailure(providerFailure), {
    ok: false,
    selectedProfile: 'deepseek',
    selectionSource: 'explicit',
    status: 'failed',
    errorCode: 'ONLINE_OPENAI_REQUEST_FAILED',
    latencyMs: 7,
    responseCharacters: 0
  })
})

test('failure formatting whitelists own fixed codes without executing accessors', () => {
  assert.equal(
    JSON.stringify(formatOnlineSmokeFailure({ code: 'ONLINE_OPENAI_DISABLED' })),
    failureOutput('ONLINE_OPENAI_DISABLED')
  )
  assert.equal(
    JSON.stringify(formatOnlineSmokeFailure({
      code: 'ATTACKER_fixture-key',
      cause: completeEnv,
      response: sensitiveValues
    })),
    failureOutput('ONLINE_OPENAI_FAILED')
  )
  let reads = 0
  const hostile = {}
  Object.defineProperty(hostile, 'code', {
    get () {
      reads += 1
      return 'ONLINE_OPENAI_DISABLED'
    }
  })
  assert.equal(
    JSON.stringify(formatOnlineSmokeFailure(hostile)),
    failureOutput('ONLINE_OPENAI_FAILED')
  )
  assert.equal(reads, 0)
  assertContainsNoSensitiveValues(JSON.stringify(formatOnlineSmokeFailure(hostile)))
})

test('disabled online smoke runs through a symlinked process entry point', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'groupmate-smoke-'))
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }))
  const scriptPath = fileURLToPath(new URL(
    '../../scripts/smoke-openai-compatible.mjs',
    import.meta.url
  ))
  const symlinkPath = join(temporaryDirectory, 'smoke-openai-compatible.mjs')
  await symlink(scriptPath, symlinkPath)
  const env = { ...process.env, GROUPMATE_RUN_ONLINE_OPENAI: '0' }
  for (const name of [
    'GROUPMATE_OPENAI_BASE_URL', 'GROUPMATE_OPENAI_API_KEY',
    'GROUPMATE_OPENAI_MODEL', 'GROUPMATE_OPENAI_PROFILE'
  ]) delete env[name]

  await assert.rejects(
    execFileAsync(process.execPath, [symlinkPath], { env, encoding: 'utf8' }),
    error => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, `${failureOutput('ONLINE_OPENAI_DISABLED')}\n`)
      assert.equal(error.stderr, '')
      return true
    }
  )
})

test('entry point resolution failures emit only a generic fixed failure', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'groupmate-smoke-'))
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }))
  const missingEntryPoint = join(temporaryDirectory, 'missing-entry.mjs')
  const scriptUrl = pathToFileURL(fileURLToPath(new URL(
    '../../scripts/smoke-openai-compatible.mjs',
    import.meta.url
  ))).href
  const source = `process.argv[1] = ${JSON.stringify(missingEntryPoint)}; await import(${JSON.stringify(scriptUrl)})`
  const env = { ...process.env, GROUPMATE_RUN_ONLINE_OPENAI: '0' }
  await assert.rejects(execFileAsync(process.execPath, [
    '--input-type=module', '--eval', source
  ], { env, encoding: 'utf8' }), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, `${failureOutput('ONLINE_OPENAI_FAILED')}\n`)
    assert.equal(error.stderr, '')
    return true
  })
})

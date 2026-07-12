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
  GROUPMATE_OPENAI_MODEL: 'fixture-model'
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

function createDeferred () {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test('online smoke checks explicit opt-in before configuration', () => {
  assert.throws(
    () => readOnlineOpenAIConfig({}),
    error => {
      assert.equal(error.code, 'ONLINE_OPENAI_DISABLED')
      assert.equal(error.missingVariables, undefined)
      return true
    }
  )
})

test('disabled online smoke never constructs a client or writes output', async () => {
  let createClientCalls = 0
  const writes = []

  await assert.rejects(
    runOnlineOpenAISmoke({
      env: {},
      createClient: () => {
        createClientCalls++
        throw new Error('client must not be constructed')
      },
      write: value => writes.push(value)
    }),
    error => error.code === 'ONLINE_OPENAI_DISABLED'
  )

  assert.equal(createClientCalls, 0)
  assert.deepEqual(writes, [])
})

test('missing online configuration never constructs a client', async t => {
  const requiredVariables = [
    'GROUPMATE_OPENAI_BASE_URL',
    'GROUPMATE_OPENAI_API_KEY',
    'GROUPMATE_OPENAI_MODEL'
  ]

  for (const missingVariable of requiredVariables) {
    await t.test(missingVariable, async () => {
      const env = { ...completeEnv }
      delete env[missingVariable]
      let createClientCalls = 0
      const writes = []

      await assert.rejects(
        runOnlineOpenAISmoke({
          env,
          createClient: () => {
            createClientCalls++
            throw new Error('client must not be constructed')
          },
          write: value => writes.push(value)
        }),
        error => {
          assert.equal(error.code, 'ONLINE_OPENAI_CONFIG_MISSING')
          assert.deepEqual(error.missingVariables, [missingVariable])
          return true
        }
      )

      assert.equal(createClientCalls, 0)
      assert.deepEqual(writes, [])
    })
  }
})

test('complete online configuration makes one bounded non-streaming call', async () => {
  const createOptions = []
  const sendCalls = []
  const writes = []

  await runOnlineOpenAISmoke({
    env: completeEnv,
    createClient: async options => {
      createOptions.push(options)
      await Promise.resolve()
      return {
        async sendMessage (prompt, options) {
          sendCalls.push({ prompt, options })
          return { text: 'fixture online response' }
        }
      }
    },
    write: value => writes.push(value)
  })

  assert.equal(createOptions.length, 1)
  assert.equal(createOptions[0].apiKey, completeEnv.GROUPMATE_OPENAI_API_KEY)
  assert.equal(createOptions[0].apiBaseUrl, completeEnv.GROUPMATE_OPENAI_BASE_URL)
  assert.deepEqual(createOptions[0].completionParams, {
    model: completeEnv.GROUPMATE_OPENAI_MODEL,
    temperature: 0
  })
  assert.equal(createOptions[0].debug, false)
  assert.equal(createOptions[0].systemMessage, 'Reply briefly.')
  assert.equal(createOptions[0].maxModelTokens, 256)
  assert.equal(createOptions[0].maxResponseTokens, 32)
  assert.equal(createOptions[0].messageStore, undefined)
  assert.equal(await createOptions[0].getMessageById('fixture-message'), undefined)
  assert.equal(await createOptions[0].upsertMessage({ text: 'fixture' }), undefined)
  assert.deepEqual(sendCalls, [{
    prompt: 'Reply with OK.',
    options: { stream: false, timeoutMs: 20_000 }
  }])
  assert.deepEqual(writes, ['{"ok":true,"responseCharacters":23}'])
  assertContainsNoSensitiveValues(writes.join(''))
})

test('overlapping online smoke calls serialize the client console lifecycle', async t => {
  const firstEntered = createDeferred()
  const firstRelease = createDeferred()
  const secondEntered = createDeferred()
  const secondRelease = createDeferred()
  const writes = [[], []]
  const createCalls = [0, 0]
  const logged = []
  const errored = []
  const warned = []
  let activeClientLifecycles = 0
  let maxActiveClientLifecycles = 0

  t.mock.method(console, 'log', value => logged.push(value))
  t.mock.method(console, 'error', value => errored.push(value))
  t.mock.method(console, 'warn', value => warned.push(value))
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn
  }

  function createLifecycle (index, entered, release, text) {
    return () => {
      createCalls[index]++
      activeClientLifecycles++
      maxActiveClientLifecycles = Math.max(
        maxActiveClientLifecycles,
        activeClientLifecycles
      )
      console.log(sensitiveValues.join(' '))

      return {
        async sendMessage () {
          entered.resolve()
          try {
            await release.promise
            console.error(sensitiveValues.join(' '))
            return { text }
          } finally {
            activeClientLifecycles--
          }
        }
      }
    }
  }

  const firstRun = runOnlineOpenAISmoke({
    env: completeEnv,
    createClient: createLifecycle(
      0,
      firstEntered,
      firstRelease,
      'first safe response'
    ),
    write: value => writes[0].push(value)
  })
  await firstEntered.promise

  const secondRun = runOnlineOpenAISmoke({
    env: completeEnv,
    createClient: createLifecycle(
      1,
      secondEntered,
      secondRelease,
      'second safe response'
    ),
    write: value => writes[1].push(value)
  })
  const secondCreateCallsBeforeFirstRelease = createCalls[1]

  firstRelease.resolve()
  const firstResult = await firstRun
  await secondEntered.promise
  console.warn(sensitiveValues.join(' '))
  secondRelease.resolve()
  const secondResult = await secondRun

  assert.equal(secondCreateCallsBeforeFirstRelease, 0)
  assert.equal(maxActiveClientLifecycles, 1)
  assert.equal(activeClientLifecycles, 0)
  assert.deepEqual(createCalls, [1, 1])
  assert.deepEqual(firstResult, {
    ok: true,
    responseCharacters: 'first safe response'.length
  })
  assert.deepEqual(secondResult, {
    ok: true,
    responseCharacters: 'second safe response'.length
  })
  assert.deepEqual(writes, [[
    `{"ok":true,"responseCharacters":${'first safe response'.length}}`
  ], [
    `{"ok":true,"responseCharacters":${'second safe response'.length}}`
  ]])
  assert.deepEqual(logged, [])
  assert.deepEqual(errored, [])
  assert.deepEqual(warned, [])
  assert.equal(console.log, originalConsole.log)
  assert.equal(console.error, originalConsole.error)
  assert.equal(console.warn, originalConsole.warn)

  console.log('restored concurrent log')
  console.error('restored concurrent error')
  console.warn('restored concurrent warn')
  assert.deepEqual(logged, ['restored concurrent log'])
  assert.deepEqual(errored, ['restored concurrent error'])
  assert.deepEqual(warned, ['restored concurrent warn'])
  assertContainsNoSensitiveValues([
    ...writes.flat(),
    ...logged,
    ...errored,
    ...warned
  ].join('\n'))
})

test('online response text is read once while client console is suppressed', async t => {
  const errored = []
  const writes = []
  let textReads = 0
  t.mock.method(console, 'error', value => errored.push(value))
  const originalConsoleError = console.error
  const response = {}
  Object.defineProperty(response, 'text', {
    get () {
      textReads++
      console.error(sensitiveValues.join(' '))
      return textReads === 1 ? 'safe response' : 'fixture online response'
    }
  })

  const result = await runOnlineOpenAISmoke({
    env: completeEnv,
    createClient: () => ({
      async sendMessage () {
        return response
      }
    }),
    write: value => writes.push(value)
  })

  assert.equal(textReads, 1)
  assert.deepEqual(result, {
    ok: true,
    responseCharacters: 'safe response'.length
  })
  assert.deepEqual(writes, [
    `{"ok":true,"responseCharacters":${'safe response'.length}}`
  ])
  assert.deepEqual(errored, [])
  assert.equal(console.error, originalConsoleError)

  console.error('restored getter error')
  assert.deepEqual(errored, ['restored getter error'])
  assertContainsNoSensitiveValues([...writes, ...errored].join('\n'))
})

test('provider failures are redacted and client console methods are restored', async t => {
  const providerError = new Error(
    `provider failed for ${sensitiveValues.join(' ')}`,
    { cause: { apiKey: 'fixture-key', prompt: 'fixture online response' } }
  )
  providerError.code = 'ATTACKER_fixture-key'
  providerError.response = {
    config: completeEnv,
    data: {
      body: 'fixture online response',
      url: 'https://fixture.invalid/v1',
      model: 'fixture-model'
    }
  }
  const writes = []
  const logged = []
  const errored = []
  const warned = []
  t.mock.method(console, 'log', value => logged.push(value))
  t.mock.method(console, 'error', value => errored.push(value))
  t.mock.method(console, 'warn', value => warned.push(value))
  const restoredConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn
  }

  let failure
  try {
    await runOnlineOpenAISmoke({
      env: completeEnv,
      createClient: () => {
        console.log(sensitiveValues.join(' '))
        return {
          async sendMessage () {
            console.error(sensitiveValues.join(' '))
            console.warn(sensitiveValues.join(' '))
            throw providerError
          }
        }
      },
      write: value => writes.push(value)
    })
  } catch (error) {
    failure = error
  }

  assert.notEqual(failure, providerError)
  assert.equal(failure.code, 'ONLINE_OPENAI_REQUEST_FAILED')
  assert.equal(failure.message, 'ONLINE_OPENAI_REQUEST_FAILED')
  assert.equal(failure.cause, undefined)
  assert.equal(failure.response, undefined)
  assert.deepEqual(writes, [])
  assert.equal(console.log, restoredConsole.log)
  assert.equal(console.error, restoredConsole.error)
  assert.equal(console.warn, restoredConsole.warn)

  console.log('restored log')
  console.error('restored error')
  console.warn('restored warn')
  assert.deepEqual(logged, ['restored log'])
  assert.deepEqual(errored, ['restored error'])
  assert.deepEqual(warned, ['restored warn'])

  const output = JSON.stringify(formatOnlineSmokeFailure(failure))
  assert.equal(output, '{"ok":false,"code":"ONLINE_OPENAI_REQUEST_FAILED"}')
  assertContainsNoSensitiveValues(output)
})

test('client construction failures are replaced with a fixed redacted code', async () => {
  const constructionError = new Error(sensitiveValues.join(' '), {
    cause: { response: { data: completeEnv } }
  })

  await assert.rejects(
    runOnlineOpenAISmoke({
      env: completeEnv,
      createClient: () => {
        throw constructionError
      },
      write: () => assert.fail('failure must not write success output')
    }),
    error => {
      assert.notEqual(error, constructionError)
      assert.equal(error.code, 'ONLINE_OPENAI_REQUEST_FAILED')
      assertContainsNoSensitiveValues(JSON.stringify(formatOnlineSmokeFailure(error)))
      return true
    }
  )
})

test('empty online responses fail without writing response content', async () => {
  const writes = []

  await assert.rejects(
    runOnlineOpenAISmoke({
      env: completeEnv,
      createClient: () => ({
        async sendMessage () {
          return { text: '   ' }
        }
      }),
      write: value => writes.push(value)
    }),
    error => error.code === 'ONLINE_OPENAI_EMPTY_RESPONSE'
  )

  assert.deepEqual(writes, [])
})

test('failure formatting whitelists only fixed online smoke codes', () => {
  const fixedCodes = [
    'ONLINE_OPENAI_DISABLED',
    'ONLINE_OPENAI_CONFIG_MISSING',
    'ONLINE_OPENAI_REQUEST_FAILED',
    'ONLINE_OPENAI_EMPTY_RESPONSE'
  ]

  for (const code of fixedCodes) {
    assert.deepEqual(formatOnlineSmokeFailure({ code }), { ok: false, code })
  }

  const attackerControlledError = {
    code: 'ATTACKER_fixture-key_fixture online response',
    message: sensitiveValues.join(' '),
    cause: { config: completeEnv },
    response: { data: sensitiveValues }
  }
  const output = JSON.stringify(formatOnlineSmokeFailure(attackerControlledError))

  assert.equal(output, '{"ok":false,"code":"ONLINE_OPENAI_FAILED"}')
  assertContainsNoSensitiveValues(output)
})

test('failure formatting handles a throwing code getter with a fixed code', () => {
  const attackerControlledError = {}
  Object.defineProperty(attackerControlledError, 'code', {
    get () {
      throw new Error(sensitiveValues.join(' '))
    }
  })

  const output = JSON.stringify(formatOnlineSmokeFailure(attackerControlledError))

  assert.equal(output, '{"ok":false,"code":"ONLINE_OPENAI_FAILED"}')
  assertContainsNoSensitiveValues(output)
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
  const env = {
    ...process.env,
    GROUPMATE_RUN_ONLINE_OPENAI: '0'
  }
  delete env.GROUPMATE_OPENAI_BASE_URL
  delete env.GROUPMATE_OPENAI_API_KEY
  delete env.GROUPMATE_OPENAI_MODEL

  await assert.rejects(
    execFileAsync(process.execPath, [symlinkPath], { env, encoding: 'utf8' }),
    error => {
      assert.equal(error.code, 1)
      assert.equal(
        error.stdout,
        '{"ok":false,"code":"ONLINE_OPENAI_DISABLED"}\n'
      )
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
  const env = {
    ...process.env,
    GROUPMATE_RUN_ONLINE_OPENAI: '0'
  }
  delete env.GROUPMATE_OPENAI_BASE_URL
  delete env.GROUPMATE_OPENAI_API_KEY
  delete env.GROUPMATE_OPENAI_MODEL

  await assert.rejects(
    execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      source
    ], { env, encoding: 'utf8' }),
    error => {
      assert.equal(error.code, 1)
      assert.equal(
        error.stdout,
        '{"ok":false,"code":"ONLINE_OPENAI_FAILED"}\n'
      )
      assert.equal(error.stderr, '')
      return true
    }
  )
})

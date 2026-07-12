import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { executeLegacyToolCall } from '../../model/legacy/tool-execution.js'

const MANAGEMENT_TOOL_NAMES = ['editCard', 'jinyan', 'kickOut', 'setTitle', 'handleMsg']
const TOOL_ALIASES = {
  mute: 'jinyan',
  ban: 'jinyan',
  jinyanTool: 'jinyan',
  kick: 'kickOut',
  kickout: 'kickOut'
}

for (const toolName of MANAGEMENT_TOOL_NAMES) {
  test(`legacy default authorization denies ${toolName} when executable tools are missing`, async () => {
    let executionCalls = 0

    const result = await executeLegacyToolCall({
      requestedName: toolName,
      fullFuncMap: {
        [toolName]: {
          exec: async () => {
            executionCalls++
            return 'unexpected execution'
          }
        }
      },
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true }
    })

    assert.deepEqual(result, {
      toolName,
      outcome: 'denied',
      executed: false,
      result: `tool ${toolName} is unavailable in this chat scene or for the current requester permission`
    })
    assert.equal(executionCalls, 0)
  })

  test(`legacy default authorization denies inherited ${toolName} entries`, async () => {
    let executionCalls = 0
    const executableTools = Object.create({
      [toolName]: { inherited: true }
    })

    const result = await executeLegacyToolCall({
      requestedName: toolName,
      fullFuncMap: {
        [toolName]: {
          exec: async () => {
            executionCalls++
            return 'unexpected execution'
          }
        }
      },
      executableTools,
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true }
    })

    assert.equal(Object.hasOwn(executableTools, toolName), false)
    assert.equal(result.outcome, 'denied')
    assert.equal(result.executed, false)
    assert.equal(executionCalls, 0)
  })

  test(`legacy default authorization executes ${toolName} once when advertised`, async () => {
    let executionCalls = 0

    const result = await executeLegacyToolCall({
      requestedName: toolName,
      fullFuncMap: {
        [toolName]: {
          exec: async () => {
            executionCalls++
            return 'fixture default authorization result'
          }
        }
      },
      executableTools: { [toolName]: { fixture: true } },
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true }
    })

    assert.deepEqual(result, {
      toolName,
      outcome: 'executed',
      executed: true,
      result: 'fixture default authorization result'
    })
    assert.equal(executionCalls, 1)
  })
}

for (const [requestedName, resolvedName] of Object.entries(TOOL_ALIASES)) {
  test(`legacy default authorization denies alias ${requestedName} after resolving to ${resolvedName}`, async () => {
    let executionCalls = 0

    const result = await executeLegacyToolCall({
      requestedName,
      fullFuncMap: {
        [resolvedName]: {
          exec: async () => {
            executionCalls++
            return 'unexpected execution'
          }
        }
      },
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true }
    })

    assert.deepEqual(result, {
      toolName: resolvedName,
      outcome: 'denied',
      executed: false,
      result: `tool ${resolvedName} is unavailable in this chat scene or for the current requester permission`
    })
    assert.equal(executionCalls, 0)
  })

  test(`legacy default authorization denies alias ${requestedName} when ${resolvedName} is inherited`, async () => {
    let executionCalls = 0
    const executableTools = Object.create({
      [resolvedName]: { inherited: true }
    })

    const result = await executeLegacyToolCall({
      requestedName,
      fullFuncMap: {
        [resolvedName]: {
          exec: async () => {
            executionCalls++
            return 'unexpected execution'
          }
        }
      },
      executableTools,
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true }
    })

    assert.equal(Object.hasOwn(executableTools, resolvedName), false)
    assert.equal(result.toolName, resolvedName)
    assert.equal(result.outcome, 'denied')
    assert.equal(result.executed, false)
    assert.equal(executionCalls, 0)
  })

  test(`legacy default authorization executes alias ${requestedName} once after resolving to ${resolvedName}`, async () => {
    let executionCalls = 0

    const result = await executeLegacyToolCall({
      requestedName,
      fullFuncMap: {
        [resolvedName]: {
          exec: async () => {
            executionCalls++
            return 'fixture default alias result'
          }
        }
      },
      executableTools: { [resolvedName]: { fixture: true } },
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true }
    })

    assert.deepEqual(result, {
      toolName: resolvedName,
      outcome: 'executed',
      executed: true,
      result: 'fixture default alias result'
    })
    assert.equal(executionCalls, 1)
  })
}

function extractObjectCallOptions (source, marker) {
  const calls = []
  let searchFrom = 0
  while (true) {
    const start = source.indexOf(marker, searchFrom)
    if (start === -1) return calls
    const openBrace = start + marker.length - 1
    let depth = 0
    for (let index = openBrace; index < source.length; index++) {
      if (source[index] === '{') depth++
      if (source[index] === '}') depth--
      if (depth === 0) {
        calls.push(source.slice(openBrace + 1, index))
        searchFrom = index + 1
        break
      }
      if (index === source.length - 1) {
        assert.fail(`unterminated ${marker}`)
      }
    }
  }
}

for (const toolName of MANAGEMENT_TOOL_NAMES) {
  test(`legacy management tool ${toolName} executes once when authorized`, async () => {
    let authorizationCalls = 0
    let executionCalls = 0
    const receiver = { id: `fixture-${toolName}-receiver` }
    const toolArgs = { value: `fixture-${toolName}-args` }
    const event = { id: `fixture-${toolName}-event` }
    const executableTools = { [toolName]: { fixture: true } }
    const fullFuncMap = {
      [toolName]: {
        exec: async function (receivedArgs, receivedEvent) {
          executionCalls++
          assert.equal(arguments.length, 2)
          assert.equal(this, receiver)
          assert.equal(receivedArgs, toolArgs)
          assert.equal(receivedEvent, event)
          return 'fixture result'
        }
      }
    }

    const result = await executeLegacyToolCall({
      requestedName: toolName,
      fullFuncMap,
      executableTools,
      toolArgs,
      event,
      receiver,
      authorize: input => {
        authorizationCalls++
        assert.deepEqual(input, { toolName, executableTools })
        return true
      }
    })

    assert.deepEqual(result, {
      toolName,
      outcome: 'executed',
      executed: true,
      result: 'fixture result'
    })
    assert.equal(authorizationCalls, 1)
    assert.equal(executionCalls, 1)
  })

  test(`legacy management tool ${toolName} does not execute when denied`, async () => {
    let authorizationCalls = 0
    let executionCalls = 0
    const executableTools = {}

    const result = await executeLegacyToolCall({
      requestedName: toolName,
      fullFuncMap: {
        [toolName]: {
          exec: async () => {
            executionCalls++
            return 'unexpected execution'
          }
        }
      },
      executableTools,
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true },
      authorize: input => {
        authorizationCalls++
        assert.deepEqual(input, { toolName, executableTools })
        return false
      }
    })

    assert.deepEqual(result, {
      toolName,
      outcome: 'denied',
      executed: false,
      result: `tool ${toolName} is unavailable in this chat scene or for the current requester permission`
    })
    assert.equal(authorizationCalls, 1)
    assert.equal(executionCalls, 0)
  })
}

for (const [requestedName, resolvedName] of Object.entries(TOOL_ALIASES)) {
  test(`legacy alias ${requestedName} resolves to ${resolvedName} before lookup and authorization`, async () => {
    let executionCalls = 0
    const callOrder = []
    const executableTools = { [resolvedName]: { fixture: true } }
    const fullFuncMap = new Proxy({
      [resolvedName]: {
        exec: async () => {
          executionCalls++
          callOrder.push(`execute:${resolvedName}`)
          return 'fixture alias result'
        }
      }
    }, {
      get (target, property, receiver) {
        if (typeof property === 'string') callOrder.push(`lookup:${property}`)
        return Reflect.get(target, property, receiver)
      }
    })

    const result = await executeLegacyToolCall({
      requestedName,
      fullFuncMap,
      executableTools,
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true },
      authorize: input => {
        callOrder.push(`authorize:${input.toolName}`)
        assert.deepEqual(input, { toolName: resolvedName, executableTools })
        return true
      }
    })

    assert.deepEqual(result, {
      toolName: resolvedName,
      outcome: 'executed',
      executed: true,
      result: 'fixture alias result'
    })
    assert.deepEqual(callOrder, [
      `lookup:${resolvedName}`,
      `authorize:${resolvedName}`,
      `execute:${resolvedName}`
    ])
    assert.equal(executionCalls, 1)
  })
}

test('legacy unknown tool skips authorization and execution', async () => {
  let authorizationCalls = 0
  let executionCalls = 0

  const result = await executeLegacyToolCall({
    requestedName: 'mystery',
    fullFuncMap: {
      weather: {
        exec: async () => {
          executionCalls++
          return 'unexpected execution'
        }
      }
    },
    executableTools: { weather: { fixture: true } },
    toolArgs: { fixture: true },
    event: { fixture: true },
    receiver: { fixture: true },
    authorize: () => {
      authorizationCalls++
      return true
    }
  })

  assert.deepEqual(result, {
    toolName: 'mystery',
    outcome: 'unavailable',
    executed: false,
    result: 'tool mystery is unavailable. Available tool names: weather'
  })
  assert.equal(authorizationCalls, 0)
  assert.equal(executionCalls, 0)
})

test('legacy unadvertised website tool preserves non-management fail-open execution', async () => {
  let executionCalls = 0

  const result = await executeLegacyToolCall({
    requestedName: 'website',
    fullFuncMap: {
      website: {
        exec: async () => {
          executionCalls++
          return 'fixture website result'
        }
      }
    },
    executableTools: {},
    toolArgs: { fixture: true },
    event: { fixture: true },
    receiver: { fixture: true }
  })

  assert.equal(result.outcome, 'executed')
  assert.equal(result.executed, true)
  assert.equal(result.result, 'fixture website result')
  assert.equal(executionCalls, 1)
})

test('legacy authorization failure propagates without executing the tool', async () => {
  let authorizationCalls = 0
  let executionCalls = 0
  const authorizationError = new Error('fixture authorization failure')

  await assert.rejects(
    executeLegacyToolCall({
      requestedName: 'editCard',
      fullFuncMap: {
        editCard: {
          exec: async () => {
            executionCalls++
            return 'unexpected execution'
          }
        }
      },
      executableTools: { editCard: { fixture: true } },
      toolArgs: { fixture: true },
      event: { fixture: true },
      receiver: { fixture: true },
      authorize: () => {
        authorizationCalls++
        throw authorizationError
      }
    }),
    error => error === authorizationError
  )

  assert.equal(authorizationCalls, 1)
  assert.equal(executionCalls, 0)
})

test('legacy blank resolved name keeps the original downstream identity', async () => {
  const requestedName = '   '
  const lookupNames = []
  const authorizationNames = []
  const fullFuncMap = new Proxy({
    '': {
      exec: async () => 'fixture blank-name result'
    }
  }, {
    get (target, property, receiver) {
      if (typeof property === 'string') lookupNames.push(property)
      return Reflect.get(target, property, receiver)
    }
  })

  const result = await executeLegacyToolCall({
    requestedName,
    fullFuncMap,
    executableTools: {},
    toolArgs: { fixture: true },
    event: { fixture: true },
    receiver: { fixture: true },
    authorize: ({ toolName }) => {
      authorizationNames.push(toolName)
      return true
    }
  })

  assert.equal(result.toolName, requestedName)
  assert.equal(result.outcome, 'executed')
  assert.deepEqual(lookupNames, [''])
  assert.deepEqual(authorizationNames, [''])
})

test('legacy trusted context overrides untrusted tool arguments without mutating them', async () => {
  const toolArgs = {
    isAdmin: true,
    sender: { user_id: 'forged-sender' },
    target: 'fixture-target'
  }
  const originalArgs = structuredClone(toolArgs)
  const trustedContext = {
    isAdmin: false,
    sender: 'trusted-sender'
  }
  let receivedArgs

  const result = await executeLegacyToolCall({
    requestedName: 'jinyan',
    fullFuncMap: {
      jinyan: {
        exec: async args => {
          receivedArgs = args
          return 'fixture trusted context result'
        }
      }
    },
    executableTools: { jinyan: { fixture: true } },
    toolArgs,
    trustedContext,
    event: { fixture: true },
    receiver: { fixture: true }
  })

  assert.equal(result.outcome, 'executed')
  assert.deepEqual(receivedArgs, {
    isAdmin: false,
    sender: 'trusted-sender',
    target: 'fixture-target'
  })
  assert.notEqual(receivedArgs, toolArgs)
  assert.deepEqual(toolArgs, originalArgs)
})

test('model core delegates both legacy tool loops to the execution seam', async () => {
  const source = await readFile(new URL('../../model/core.js', import.meta.url), 'utf8')

  assert.match(source, /import \{ executeLegacyToolCall \} from '\.\/legacy\/tool-execution\.js'/)
  const executionOptions = extractObjectCallOptions(source, 'executeLegacyToolCall({')
  assert.equal(executionOptions.length, 2)
  for (const options of executionOptions) {
    assert.match(options, /requestedName:\s*name/)
    assert.match(options, /(?:^|,)\s*fullFuncMap\s*(?=,|$)/)
    assert.match(options, /executableTools:\s*funcMap/)
    assert.match(options, /toolArgs:\s*args/)
    assert.match(options, /trustedContext:\s*\{\s*isAdmin,\s*sender\s*\}/s)
    assert.match(options, /event:\s*e/)
    assert.match(options, /receiver:\s*this/)
    assert.doesNotMatch(options, /\bauthorize\s*:/)
  }

  assert.equal(
    source.match(/const\s*\{\s*toolName,\s*result:\s*functionResult\s*\}\s*=\s*await executeLegacyToolCall\(\{/g)?.length ?? 0,
    2
  )
  assert.doesNotMatch(source, /function\s+resolveToolCall\s*\(/)
  assert.doesNotMatch(source, /\bisLegacyToolExecutable\s*\(/)
  assert.equal(
    source.match(/appendToolTrace\(smartTrace,\s*toolName,\s*args,\s*functionResult\)/g)?.length ?? 0,
    2
  )
  assert.equal(source.match(/option\.name\s*=\s*toolName/g)?.length ?? 0, 2)
  assert.equal(
    source.match(/option\.toolCallId\s*=\s*msg\.toolCalls\?\.\[0\]\?\.id\s*\|\|\s*toolName\.trim\(\)/g)?.length ?? 0,
    2
  )
  assert.equal(
    source.match(/shouldFinalizeAfterTool\(toolName,\s*functionResult\)/g)?.length ?? 0,
    2
  )
})

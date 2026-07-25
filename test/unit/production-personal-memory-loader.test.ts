import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  productionPersonalMemoryCommandGatewayV1
} from '../../src/runtime/personal-memory-command.js'
import {
  initializeProductionPersonalMemoryRuntimeV1,
  type ProductionPersonalMemoryRuntimeOptionsV1,
  type ProductionPersonalMemoryRuntimeModuleV1
} from '../../src/runtime/production-personal-memory-loader.js'

const ENABLED_OPTIONS = Object.freeze({
  botInstanceId: 'groupmate-production',
  storageDirectory: '/tmp/groupmate-personal-memory-test',
  deploymentMode: () => 'explicit' as const,
  groupAllowlist: () => Object.freeze(['10001']),
  recallMaxItems: () => 6,
  recallMaxTokens: () => 1_200,
  recallTimeoutMs: () => 150
})

test('real entry and command shell preserve the default-off lazy boundary', async () => {
  const [entry, loader, app] = await Promise.all([
    readFile('index.js', 'utf8'),
    readFile('src/runtime/production-personal-memory-loader.ts', 'utf8'),
    readFile('apps/memory.js', 'utf8')
  ])
  assert.match(entry, /from '\.\/dist\/runtime\/production-personal-memory-loader\.js'/)
  assert.doesNotMatch(entry, /from '\.\/dist\/runtime\/production-personal-memory-runtime\.js'/)
  assert.match(entry, /deploymentMode: \(\) => Config\.personalMemoryMode/)
  assert.match(entry, /if \(personalMemoryRuntime !== null\) \{[\s\S]*configureProductionPersonalMemoryCommandPortV1/)
  assert.match(loader, /if \(mode === null \|\| mode === 'off'\) return null[\s\S]*await import\('\.\/production-personal-memory-runtime\.js'\)/)
  assert.match(app, /from '\.\.\/dist\/runtime\/personal-memory-command\.js'/)
  assert.doesNotMatch(app, /production-personal-memory-(?:loader|runtime)\.js/)

  const replies: string[] = []
  const handled = await productionPersonalMemoryCommandGatewayV1().handle(Object.freeze({
    event: Object.freeze({}),
    text: '#长期记忆 状态',
    replyText: async (text: string) => { replies.push(text) },
    sendPrivateFile: async () => undefined
  }))
  assert.equal(handled, true)
  assert.deepEqual(replies, [
    '个人长期记忆当前未启用。请先由机器人主人在锅巴中开启试点模式。'
  ])
})

test('production personal memory loader has zero module side effects while disabled', async () => {
  let loads = 0
  const runtime = await initializeProductionPersonalMemoryRuntimeV1({
    ...ENABLED_OPTIONS,
    deploymentMode: () => 'off',
    loadModule: async () => {
      loads += 1
      throw new Error('disabled mode must not load the SQLite composition module')
    }
  })

  assert.equal(runtime, null)
  assert.equal(loads, 0)
})

test('production personal memory loader composes enabled runtime exactly once', async () => {
  const calls: unknown[] = []
  const expected = Object.freeze({
    recallSource: Object.freeze({ recall: async () => ({ status: 'completed' }) }),
    operations: Object.freeze({
      inspect: async () => ({ status: 'ready' }),
      execute: async () => ({ status: 'completed' })
    }),
    commands: Object.freeze({ handle: async () => true }),
    close: async () => undefined
  })
  const module: ProductionPersonalMemoryRuntimeModuleV1 = Object.freeze({
    createProductionPersonalMemoryRuntimeV1: async (
      options: ProductionPersonalMemoryRuntimeOptionsV1
    ) => {
      calls.push(options)
      return expected
    }
  })

  const runtime = await initializeProductionPersonalMemoryRuntimeV1({
    ...ENABLED_OPTIONS,
    loadModule: async () => module
  })

  assert.equal(runtime, expected)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ENABLED_OPTIONS)
})

test('production personal memory loader fails closed on invalid mode before module import', async () => {
  let loads = 0
  const runtime = await initializeProductionPersonalMemoryRuntimeV1({
    ...ENABLED_OPTIONS,
    deploymentMode: () => 'unexpected' as never,
    loadModule: async () => {
      loads += 1
      throw new Error('invalid mode must not load the composition module')
    }
  })

  assert.equal(runtime, null)
  assert.equal(loads, 0)
})

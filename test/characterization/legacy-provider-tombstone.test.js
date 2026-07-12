import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

async function loadProviderAdapter () {
  const source = await readFile(new URL('../../apps/provider.js', import.meta.url), 'utf8')
  const pluginStubUrl = `data:text/javascript,${encodeURIComponent(`
    export default class plugin {
      constructor (options) {
        this.options = options
      }
    }
  `)}`
  const policyUrl = pathToFileURL(
    `${projectRoot}/dist/runtime/provider-mode-policy.js`
  ).href
  const transformed = source
    .replace('../../../lib/plugins/plugin.js', pluginStubUrl)
    .replace('../dist/runtime/provider-mode-policy.js', policyUrl)

  assert.notEqual(transformed, source, 'provider adapter imports must be replaced by the test seam')
  return import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`)
}

const removedProviderCommands = [
  '#gemini 请介绍自己',
  '#chatgpt切换Claude',
  '#chatgpt设置GeminiKey',
  '#chatgpt设置星火模型',
  '#chatgpt设置Bing设定',
  '#chatgpt必应禁用搜索',
  '#chatgpt设置翻译来源qwen'
]

const retainedCommands = [
  '#chat 你好',
  '#chat1 你好',
  '#chatgpt切换API',
  '#chatgpt设置APIKey',
  '#chatgpt设置API模型',
  '#chatgpt设置API设定',
  '#chatgpt设置azure语音角色晓晓',
  '#azure语音角色列表',
  '普通群聊消息'
]

test('legacy provider commands return one fixed tombstone without side effects', async (t) => {
  let redisWrites = 0
  let configWrites = 0
  let networkCalls = 0
  const previousRedis = globalThis.redis
  const previousConfig = globalThis.Config
  const previousFetch = globalThis.fetch
  globalThis.redis = {
    set () { redisWrites += 1 },
    del () { redisWrites += 1 }
  }
  globalThis.Config = new Proxy({}, {
    set () {
      configWrites += 1
      return true
    }
  })
  globalThis.fetch = async () => {
    networkCalls += 1
    throw new Error('unexpected network call')
  }
  t.after(() => {
    globalThis.redis = previousRedis
    globalThis.Config = previousConfig
    globalThis.fetch = previousFetch
  })

  const { ProviderCompatibility } = await loadProviderAdapter()
  const handler = new ProviderCompatibility()
  assert.ok(handler.options.priority < 500)
  assert.equal(handler.options.rule.length, 1)
  const [{ reg, fnc }] = handler.options.rule
  assert.equal(fnc, 'unsupportedProvider')

  for (const command of removedProviderCommands) {
    assert.match(command, reg, `${command} must be intercepted`)
    const replies = []
    let recalls = 0
    const event = {
      reply (...args) {
        replies.push(args)
      },
      recallMsg () {
        recalls += 1
      }
    }

    const result = await handler.unsupportedProvider(event)

    assert.equal(result, true)
    assert.deepEqual(replies, [[
      '该模型模式已不再支持，GroupMate 当前仅支持 OpenAI-compatible API'
    ]])
    assert.equal(recalls, 0)
  }

  for (const command of retainedCommands) {
    assert.doesNotMatch(command, reg, `${command} must remain available to its normal handler`)
  }
  assert.equal(redisWrites, 0)
  assert.equal(configWrites, 0)
  assert.equal(networkCalls, 0)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const graphKey = '__groupmateButtonTestGraph'
const configKey = '__groupmateButtonTestConfig'

async function loadButtonHandler () {
  const source = await readFile(new URL('../../apps/button.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /utils\/config|\bConfig\b/)
  assert.match(source, /getProductionYunzaiAgent/)
  assert.match(source, /buildChatButtonContent/)
  assert.match(source, /buildChatSuggestionButtonRequest/)

  const moduleUrl = value => pathToFileURL(`${projectRoot}/${value}`).href
  const pluginStubUrl = `data:text/javascript,${encodeURIComponent(`
    export default class plugin {
      constructor (options) { this.options = options }
    }
  `)}`
  const graphStubUrl = `data:text/javascript,${encodeURIComponent(`
    export function getProductionYunzaiAgent () {
      return globalThis.${graphKey}
    }
  `)}`
  const configStubUrl = `data:text/javascript,${encodeURIComponent(`
    export const Config = globalThis.${configKey}
  `)}`
  const transformed = source
    .replace('../../../lib/plugins/plugin.js', pluginStubUrl)
    .replace('../utils/config.js', configStubUrl)
    .replace('../dist/runtime/production-yunzai-agent.js', graphStubUrl)
    .replace('../dist/runtime/yunzai-button-content.js', moduleUrl('dist/runtime/yunzai-button-content.js'))
    .replace('../dist/runtime/presentation/reply-content.js', moduleUrl('dist/runtime/presentation/reply-content.js'))
    .replace('../dist/runtime/plugin-context.js', moduleUrl('dist/runtime/plugin-context.js'))
  return await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`)
}

function setPolicy ({ markdownEnabled = true, openAiConfigured = true } = {}) {
  globalThis[graphKey] = Object.freeze({
    buttonPolicy: Object.freeze({
      snapshot: () => Object.freeze({ markdownEnabled, openAiConfigured })
    })
  })
  globalThis[configKey] = { enableMd: markdownEnabled, apiKey: openAiConfigured ? 'fixture' : '' }
}

function rows (content) {
  return content?.rows.map(row => row.buttons.map(button => (
    `${button.render_data.label}|${button.action.data}|${String(button.action.enter)}`
  ))) ?? null
}

function assertCompleteButtonShape (content, expectedRows) {
  assert.deepEqual(Reflect.ownKeys(content), ['appid', 'rows'])
  assert.equal(content.appid, 1)
  assert.deepEqual(rows(content), expectedRows)
  for (const row of content.rows) {
    assert.deepEqual(Reflect.ownKeys(row), ['buttons'])
    for (const button of row.buttons) {
      assert.deepEqual(Reflect.ownKeys(button), ['id', 'render_data', 'action'])
      assert.equal(button.id, '')
      assert.deepEqual(Reflect.ownKeys(button.render_data), [
        'label', 'style', 'visited_label'
      ])
      assert.equal(button.render_data.style, 1)
      assert.equal(button.render_data.visited_label, button.render_data.label)
      assert.deepEqual(Reflect.ownKeys(button.action), [
        'type', 'permission', 'data', 'enter', 'unsupport_tips'
      ])
      assert.equal(button.action.type, 2)
      assert.deepEqual(button.action.permission, { type: 2 })
      assert.equal(button.action.unsupport_tips, '')
    }
  }
}

test('button handler preserves every existing function-to-builder mapping', async (t) => {
  setPolicy()
  t.after(() => {
    delete globalThis[graphKey]
    delete globalThis[configKey]
  })
  const { ChatGPTButtonHandler } = await loadButtonHandler()
  const handler = new ChatGPTButtonHandler()

  assert.equal(ChatGPTButtonHandler.name, 'ChatGPTButtonHandler')
  assert.equal(handler.options.name, 'chatgpt按钮处理器')
  assert.equal(handler.options.priority, -100)
  assert.equal(handler.options.namespace, 'groupmate')
  assert.deepEqual(Reflect.ownKeys(handler.options.handler[0]), ['key', 'fn'])
  assert.equal(handler.options.handler[0].key, 'chatgpt.button.post')
  assert.equal(handler.options.handler[0].fn, 'btnHandler')
  assert.deepEqual(
    ['makeButtonChat', 'makeButtonEnd', 'makeButtonMode', 'makeButtonConfirm', 'makeButtonEntertainment']
      .filter(name => typeof handler[name] === 'function'),
    ['makeButtonChat', 'makeButtonEnd', 'makeButtonMode', 'makeButtonConfirm', 'makeButtonEntertainment']
  )

  const matrix = new Map([
    ['chat', ['[ChatGpt 对话][chatgpt]', '[ChatGpt 对话][chatgpt1]']],
    ['end', ['[ChatGpt 对话][destroyConversations]', '[ChatGpt 对话][endAllConversations]']],
    ['mode', ['[ChatGpt 对话][switch2Picture]', '[ChatGpt 对话][switch2Text]', '[ChatGpt 对话][switch2Audio]']],
    ['confirm', [
      '[ChatGPT-Plugin 管理][versionChatGPTPlugin]', '[ChatGPT-Plugin 管理][shutUp]',
      '[ChatGPT-Plugin 管理][openMouth]', '[ChatGPT-Plugin 管理][queryConfig]',
      '[ChatGPT-Plugin 管理][enableGroupContext]', '[ChatGPT-Plugin 管理][viewAPIModel]',
      '[ChatGPT-Plugin 管理][turnOnConfirm]', '[ChatGPT-Plugin 管理][turnOffConfirm]'
    ]],
    ['entertainment', [
      '[ChatGPT-Plugin 娱乐小功能][wordcloud]', '[ChatGPT-Plugin 娱乐小功能][wordcloud_latest]',
      '[ChatGPT-Plugin 娱乐小功能][wordcloud_new]', '[ChatGPT-Plugin 娱乐小功能][translate]',
      '[ChatGPT-Plugin 娱乐小功能][ocr]', '[ChatGPT-Plugin 娱乐小功能][screenshotUrl]'
    ]]
  ])
  const expected = {
    chat: handler.makeButtonChat(),
    end: handler.makeButtonEnd(),
    mode: handler.makeButtonMode(),
    confirm: handler.makeButtonConfirm(),
    entertainment: handler.makeButtonEntertainment()
  }
  for (const [kind, values] of matrix) {
    for (const logFnc of values) {
      assert.deepEqual(await handler.btnHandler({ logFnc }, {}), expected[kind], logFnc)
    }
  }
  assert.equal(await handler.btnHandler({ logFnc: '[unknown][unknown]' }, {}), null)

  assertCompleteButtonShape(handler.makeButtonChat(), [
    ['结束对话|#毁灭对话|true', '结束当前对话|#api结束对话|true', 'at我对话||false'],
    ['OpenAI-compatible|#chat1|false']
  ])
  assertCompleteButtonShape(handler.makeButtonEnd(), [[
    '重新开始|#摧毁对话|true', '全部结束|#摧毁全部对话|true', '开始对话|#chat1|false'
  ]])
  assertCompleteButtonShape(handler.makeButtonMode(), [[
    '以文字回复|#chatgpt文本模式|true',
    '以图片回复|#chatgpt图片模式|true',
    '以语音回复|#chatgpt语音模式|true'
  ]])
  assertCompleteButtonShape(handler.makeButtonConfirm(), [
    ['开启确认|#chatgpt开启确认|true', '关闭确认|#chatgpt关闭确认|true', '暂停本群回复|#chatgpt本群闭嘴|false'],
    ['恢复本群回复|#chatgpt本群张嘴|false', '开启上下文|#打开群聊上下文|true', '关闭上下文 |#关闭群聊上下文|true'],
    ['查看指令表|#chatgpt指令表|false', '查看帮助|#chatgpt帮助|true', '查看配置|#chatgpt查看当前配置|true'],
    ['查看模型列表|#chatgpt模型列表|true', '版本信息|#chatgpt版本信息|true']
  ])
  assertCompleteButtonShape(handler.makeButtonEntertainment(), [
    ['今日词云|#今日词云|true', '最新词云|#最新词云|false', '我的词云|#我的今日词云|true'],
    ['翻译|#翻译|false', 'OCR|#ocr|false', '截图|#url:|false']
  ])
})

test('legacy and trusted suggestions produce the same bounded chat buttons', async (t) => {
  setPolicy()
  t.after(() => {
    delete globalThis[graphKey]
    delete globalThis[configKey]
  })
  const { ChatGPTButtonHandler } = await loadButtonHandler()
  const handler = new ChatGPTButtonHandler()
  const legacy = handler.makeButtonChat({ suggested: '继续聊聊\n#chat1\n换个话题\n继续聊聊' })
  const trusted = handler.makeButtonChat(Object.freeze({
    schemaVersion: 1,
    kind: 'chat_suggestions',
    suggestions: Object.freeze(['继续聊聊', '换个话题'])
  }))
  const reordered = handler.makeButtonChat(Object.freeze({
    suggestions: Object.freeze(['继续聊聊', '换个话题']),
    kind: 'chat_suggestions',
    schemaVersion: 1
  }))

  assert.deepEqual(legacy, trusted)
  assert.deepEqual(reordered, trusted)
  assert.deepEqual(rows(legacy)[0], [
    '继续聊聊|继续聊聊|true', '换个话题|换个话题|true'
  ])

  const overCount = handler.makeButtonChat({
    suggested: '一\n二\n三\n四\n五\n六\n七'
  })
  assert.deepEqual(rows(overCount)[0], [
    '一|一|true', '二|二|true', '三|三|true',
    '四|四|true', '五|五|true', '六|六|true'
  ])

  const overInputLimit = handler.makeButtonChat({
    suggested: `${'边'.repeat(4_095)}\n越界建议`
  })
  assert.deepEqual(rows(overInputLimit)[0], [
    `${'边'.repeat(80)}|${'边'.repeat(80)}|true`
  ])
  assert.doesNotMatch(JSON.stringify(overInputLimit), /越界建议/u)
})

test('legacy suggestion callback rejects getters extra keys and control commands', async (t) => {
  setPolicy()
  t.after(() => {
    delete globalThis[graphKey]
    delete globalThis[configKey]
  })
  const { ChatGPTButtonHandler } = await loadButtonHandler()
  const handler = new ChatGPTButtonHandler()
  let getterCalls = 0
  const hostile = {}
  Object.defineProperty(hostile, 'suggested', {
    enumerable: true,
    get () {
      getterCalls += 1
      return '不得读取'
    }
  })
  const base = handler.makeButtonChat()

  assert.deepEqual(handler.makeButtonChat(hostile), base)
  assert.equal(getterCalls, 0)
  assert.deepEqual(handler.makeButtonChat(Object.create({ suggested: '原型值' })), base)
  assert.deepEqual(handler.makeButtonChat({ suggested: '合法建议', extra: true }), base)
  assert.deepEqual(handler.makeButtonChat({ suggested: '#chat1\n确认\n摧毁对话' }), base)

  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  assert.deepEqual(await handler.btnHandler(
    { logFnc: '[ChatGpt 对话][chatgpt]' },
    proxy
  ), base)
})

test('button policy disables markdown and hides unconfigured OpenAI entry', async (t) => {
  setPolicy({ markdownEnabled: false, openAiConfigured: true })
  t.after(() => {
    delete globalThis[graphKey]
    delete globalThis[configKey]
  })
  const { ChatGPTButtonHandler } = await loadButtonHandler()
  const handler = new ChatGPTButtonHandler()
  assert.equal(await handler.btnHandler({ logFnc: '[ChatGpt 对话][chatgpt]' }, {}), null)
  assert.equal(handler.makeButtonChat(), null)
  assert.equal(handler.makeButtonEnd(), null)

  setPolicy({ markdownEnabled: true, openAiConfigured: false })
  const chat = await handler.btnHandler({ logFnc: '[ChatGpt 对话][chatgpt]' }, {})
  assert.doesNotMatch(JSON.stringify(chat), /OpenAI-compatible|#chat1.*OpenAI/)
  assert.equal(rows(chat).length, 1)
})

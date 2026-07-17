import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildChatSuggestionButtonRequest } from '../../src/runtime/presentation/reply-content.js'
import {
  buildChatButtonContent,
  buildConfirmButtonContent,
  buildEndButtonContent,
  buildEntertainmentButtonContent,
  buildModeButtonContent
} from '../../src/runtime/yunzai-button-content.js'

function rows (content: ReturnType<typeof buildEndButtonContent>): readonly (readonly string[])[] {
  return content.rows.map(row => row.buttons.map(button => (
    `${button.render_data.label}|${button.action.data}|${String(button.action.enter)}`
  )))
}

test('typed button content preserves chat management mode and entertainment rows', () => {
  assert.equal(buildChatButtonContent(undefined, {
    markdownEnabled: false,
    openAiConfigured: true
  }), null)

  const withoutOpenAi = buildChatButtonContent(undefined, {
    markdownEnabled: true,
    openAiConfigured: false
  })
  assert.deepEqual(rows(withoutOpenAi as NonNullable<typeof withoutOpenAi>), [[
    '结束对话|#毁灭对话|true',
    '结束当前对话|#api结束对话|true',
    'at我对话||false'
  ]])
  const withOpenAi = buildChatButtonContent(undefined, {
    markdownEnabled: true,
    openAiConfigured: true
  })
  assert.deepEqual(rows(withOpenAi as NonNullable<typeof withOpenAi>), [
    [
      '结束对话|#毁灭对话|true',
      '结束当前对话|#api结束对话|true',
      'at我对话||false'
    ],
    ['OpenAI-compatible|#chat1|false']
  ])

  assert.deepEqual(rows(buildEndButtonContent()), [[
    '重新开始|#摧毁对话|true',
    '全部结束|#摧毁全部对话|true',
    '开始对话|#chat1|false'
  ]])
  assert.deepEqual(rows(buildModeButtonContent()), [[
    '以文字回复|#chatgpt文本模式|true',
    '以图片回复|#chatgpt图片模式|true',
    '以语音回复|#chatgpt语音模式|true'
  ]])
  assert.deepEqual(rows(buildConfirmButtonContent()), [
    ['开启确认|#chatgpt开启确认|true', '关闭确认|#chatgpt关闭确认|true', '暂停本群回复|#chatgpt本群闭嘴|false'],
    ['恢复本群回复|#chatgpt本群张嘴|false', '开启上下文|#打开群聊上下文|true', '关闭上下文 |#关闭群聊上下文|true'],
    ['查看指令表|#chatgpt指令表|false', '查看帮助|#chatgpt帮助|true', '查看配置|#chatgpt查看当前配置|true'],
    ['查看模型列表|#chatgpt模型列表|true', '版本信息|#chatgpt版本信息|true']
  ])
  assert.deepEqual(rows(buildEntertainmentButtonContent()), [
    ['今日词云|#今日词云|true', '最新词云|#最新词云|false', '我的词云|#我的今日词云|true'],
    ['翻译|#翻译|false', 'OCR|#ocr|false', '截图|#url:|false']
  ])
})

test('typed button content cannot promote suggestion text into control commands', () => {
  const request = buildChatSuggestionButtonRequest([
    ' 继续聊聊 ',
    '#chat1',
    '结束对话',
    '换个话题',
    '继续聊聊'
  ])
  const content = buildChatButtonContent(request, {
    markdownEnabled: true,
    openAiConfigured: false
  })
  assert.ok(content !== null)
  assert.deepEqual(rows(content), [
    ['继续聊聊|继续聊聊|true', '换个话题|换个话题|true'],
    [
      '结束对话|#毁灭对话|true',
      '结束当前对话|#api结束对话|true',
      'at我对话||false'
    ]
  ])
  for (const row of content.rows) {
    for (const button of row.buttons) {
      assert.deepEqual(Reflect.ownKeys(button), ['id', 'render_data', 'action'])
      assert.equal(button.id, '')
      assert.equal(button.render_data.style, 1)
      assert.equal(button.render_data.visited_label, button.render_data.label)
      assert.deepEqual(button.action.permission, { type: 2 })
      assert.equal(button.action.type, 2)
      assert.equal(button.action.unsupport_tips, '')
    }
  }
  assert.equal(Object.isFrozen(content), true)
  assert.equal(Object.isFrozen(content.rows), true)
})
